// src/services/OutboxService.ts
import { TradeOutbox } from "../models/TradeOutbox";
import { getTradeQueueForBroker, getTotalTradeQueueWaitingCount } from "../utils/tradeQueue";
import log from "../utils/logger";
import redlock from "../utils/redlock";
import { AlertService } from "./AlertService";

export class OutboxService {
    static async processPending() {
        const lock = await redlock.acquire(["lock:outbox-processor"], 5000).catch(() => null);
        if (!lock) return;

        try {
            // 🛡️ 1. FETCH & ATOMICALLY LOCK (PENDING -> PROCESSING)
            const items = await TradeOutbox.find({ status: "PENDING" }).limit(50);
            
            for (const item of items) {
                // Use findOneAndUpdate to ensure no other instance picks this up
                const outbox = await TradeOutbox.findOneAndUpdate(
                    { _id: item._id, status: "PENDING" },
                    { $set: { status: "PROCESSING" } },
                    { new: true }
                );

                if (!outbox) continue;

                try {
                    // 🛡️ 2. CHECK QUEUE SIZE (Backpressure)
                    const queueSize = await getTotalTradeQueueWaitingCount();
                    if (queueSize > 5000) {
                        await AlertService.trigger("QUEUE_OVERFLOW", "Trade queue exceeding 5000 jobs. Throttling outbox.", "HIGH");
                        outbox.status = "PENDING"; // Back off
                        await outbox.save();
                        break;
                    }

                    // 🛡️ 3. PUSH TO QUEUE
                    const broker = outbox.payload?.orderData?.broker;
                    const queue = getTradeQueueForBroker(broker);
                    await queue.add(`trade-${outbox.correlationId}`, outbox.payload, {
                        jobId: `outbox-${outbox._id.toString()}`
                    });

                    // 🛡️ 4. MARK AS PROCESSED
                    outbox.status = "PROCESSED";
                    outbox.processedAt = new Date();
                    await outbox.save();

                } catch (err: any) {
                    log.error(`Failed to process outbox ${outbox._id}:`, err.message);
                    outbox.attempts += 1;
                    outbox.status = outbox.attempts >= 5 ? "FAILED" : "PENDING";
                    outbox.error = err.message;
                    await outbox.save();
                    
                    if (outbox.status === "FAILED") {
                        await AlertService.trigger("OUTBOX_FAILED", `Outbox ${outbox._id} reached max retries.`, "CRITICAL");
                    }
                }
            }
        } finally {
            await lock.release();
        }
    }
}
