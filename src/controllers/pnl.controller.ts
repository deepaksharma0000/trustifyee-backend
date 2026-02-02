import { Request, Response } from "express";
import { Position } from "../models/Position.model";
import { getLTP } from "../services/market.service";

export const getLivePnL = async (req: Request, res: Response) => {
  try {
    
    const { clientcode } = req.params;

    const positions = await Position.find({
      clientcode,
      status: "OPEN",
    });
    type LivePnLRow = {
        orderid: string;
        tradingsymbol: string;
        side: "BUY" | "SELL";
        quantity: number;
        entryPrice: number;
        ltp: number;
        pnl: number;
        };

    const result: LivePnLRow[] = [];

    for (const pos of positions) {
      // 🔥 current market price
      const ltp = await getLTP(pos.tradingsymbol);

      let pnl = 0;
      if (pos.side === "BUY") {
        pnl = (ltp - pos.entryPrice) * pos.quantity;
      } else {
        pnl = (pos.entryPrice - ltp) * pos.quantity;
      }

      result.push({
        orderid: pos.orderid,
        tradingsymbol: pos.tradingsymbol,
        side: pos.side,
        quantity: pos.quantity,
        entryPrice: pos.entryPrice,
        ltp,
        pnl: Number(pnl.toFixed(2)),
      });
    }

    res.json({
      ok: true,
      data: result,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      message: "Live PnL fetch failed",
    });
  }
};
