import { v4 as uuidv4 } from "uuid";
import { getTradeQueueForBroker, type TradeJob } from "../utils/tradeQueue";
import { logExecutionContext } from "../utils/executionLogger";
import log from "../utils/logger";

export type EnqueueUserTradeInput = {
  userId: string;
  clientCode: string;
  signalId: string;
  broker?: string;
  correlationId?: string;
  clientOrderId?: string;
  outgoingIp?: string;
  agentUrl?: string;
  dedicatedIpEnabled?: boolean;
  orderData: TradeJob["orderData"];
};

/**
 * Enqueues user-isolated trade jobs. Signal/strategy layers should use this
 * instead of calling OrderService or Angel adapters directly.
 */
export class SignalExecutionQueueService {
  static async enqueueUserExecution(input: EnqueueUserTradeInput) {
    if (!input.userId?.trim()) {
      throw new Error("QUEUE_VALIDATION: userId is required");
    }
    if (!input.clientCode?.trim()) {
      throw new Error("QUEUE_VALIDATION: clientCode is required");
    }
    if (!input.signalId?.trim()) {
      throw new Error("QUEUE_VALIDATION: signalId is required");
    }

    const correlationId = input.correlationId || uuidv4();
    const clientOrderId = input.clientOrderId || `AUTO-${input.signalId}-${input.userId}-${Date.now()}`;
    const broker = (input.broker || "ANGELONE").toUpperCase();

    const job: TradeJob = {
      userId: input.userId,
      signalId: input.signalId,
      clientCode: input.clientCode,
      clientOrderId,
      correlationId,
      outgoingIp: input.outgoingIp,
      agentUrl: input.agentUrl,
      dedicatedIpEnabled: input.dedicatedIpEnabled,
      orderData: input.orderData,
      timestamp: Date.now(),
    };

    logExecutionContext(
      {
        userId: input.userId,
        clientCode: input.clientCode,
        purpose: "signal_execution_enqueue",
        correlationId,
        clientOrderId,
        signalId: input.signalId,
      },
      "QUEUE_ENQUEUE",
      { broker, tradingsymbol: input.orderData.tradingsymbol }
    );

    const queue = getTradeQueueForBroker(broker);
    const added = await queue.add(`trade-${correlationId}`, job, {
      jobId: `exec-${clientOrderId}`,
    });

    log.info("[SignalExecutionQueue] Job enqueued", {
      queueName: queue.name,
      bullJobId: added.id,
      clientOrderId,
      userId: input.userId,
    });

    return { clientOrderId, correlationId, queueJobId: added.id };
  }
}
