import { Position } from "../models/Position.model";
import { checkAngelOrderStatus } from "../services/angel.service";

/**
 * Background job:
 * - OPEN orders ko AngelOne se check karta hai
 * - fill hone par CLOSED mark karta hai
 */
export const syncPendingOrders = async () => {
  try {
    // 🔥 Sirf OPEN positions check karo
    const openOrders = await Position.find({
      status: "OPEN",
    });

    for (const order of openOrders) {
      // AngelOne se sirf TRUE / FALSE milta hai
      const isFilled = await checkAngelOrderStatus(
        order.clientcode,
        order.orderid
      );

      // Agar order fill ho gaya
      if (isFilled) {
        order.status = "CLOSED";
        await order.save();
      }
    }
  } catch (err) {
    console.error("Order sync failed:", err);
  }
};
