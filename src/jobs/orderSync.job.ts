import { Position } from "../models/Position.model";
import log from "../utils/logger";
import axios from "axios";
import { config } from "../config";

/**
 * Background job: Runs every 5 seconds
 * - Triggers Auto-Exit (Square Off) using the /close route
 */
export const syncPendingOrders = async () => {
  try {
    const now = new Date();
    const openPositions = await Position.find({
      status: "OPEN",
      autoSquareOffEnabled: true,
      autoSquareOffStatus: "PENDING",
      autoSquareOffTime: { $ne: null }
    });

    if (openPositions.length === 0) return;

    for (const pos of openPositions) {
      const exitTime = new Date(pos.autoSquareOffTime!);

      if (now >= exitTime) {
        log.info(`[Job:AutoExit] !!! TIME REACHED !!! Triggering square-off for ${pos.orderid} (${pos.tradingsymbol})`);

        try {
          // Call the existing /close route with system bypass
          const response = await axios.post(`${config.appBaseUrl}/api/orders/close`, {
            clientcode: pos.clientcode,
            orderid: pos.orderid
          }, {
            headers: {
              'x-system-secret': 'INTERNAL_JOB_SECRET',
              'Content-Type': 'application/json'
            },
            timeout: 10000
          });

          const result = response.data;

          if (result?.ok) {
            log.info(`[Job:AutoExit] SUCCESS: Position ${pos.orderid} squared off via system job.`);
            // Note: The /close route already updates the position in DB, 
            // so we don't need to do it here.
          } else {
            log.error(`[Job:AutoExit] FAILED: Broker refused square-off for ${pos.orderid}:`, result?.message || result);
            pos.autoSquareOffStatus = "FAILED";
            await pos.save();
          }
        } catch (err: any) {
          log.error(`[Job:AutoExit] EXCEPTION during square-off for ${pos.orderid}:`, err.message);
          // 403 error would hit here if internal auth/adminOnly fails
        }
      }
    }
  } catch (err: any) {
    log.error("[Job] syncPendingOrders failure:", err.message);
  }
};
