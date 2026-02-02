import { Request, Response } from "express";
import { Position } from "../models/Position.model";
// import { checkAngelOrderStatus } from "../services/angel.service";
import { placeAngelOrder } from "../services/angel.service";

export const getOrderStatus = async (req: Request, res: Response) => {
  const { orderid } = req.params;

  const order = await Position.findOne({ orderid });

  if (!order) return res.json({ ok: false });

  return res.json({
    ok: true,
    status: order.status, // PENDING | COMPLETE | REJECTED
  });
};
export const savePlacedOrder = async (req: Request, res: Response) => {
  try {
    const {
      clientcode,
      orderid,
      tradingsymbol,
      exchange,
      side,
      quantity,
      price,
    } = req.body;

    await Position.create({
      clientcode,
      orderid,
      tradingsymbol,
      exchange,
      side,
      quantity,
      entryPrice: price,
     status: "PENDING", 
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, message: "Save order failed" });
  }
};
export const closeOrder = async (req: Request, res: Response) => {
  try {
    const { clientcode, orderid } = req.body;

    const position = await Position.findOne({
      clientcode,
      orderid,
      status: "OPEN",
    });

    if (!position) {
      return res.status(404).json({
        ok: false,
        message: "Open position not found",
      });
    }

    const exitSide = position.side === "BUY" ? "SELL" : "BUY";

    // 🔥 EXIT = NEW ORDER PLACE
    const angelResp = await placeAngelOrder({
      clientcode,
      tradingsymbol: position.tradingsymbol,
      exchange: position.exchange,
      side: exitSide,
      quantity: position.quantity,
      ordertype: "MARKET",
    });

    if (!angelResp?.ok) {
      return res.status(400).json({
        ok: false,
        message: "Angel exit order failed",
      });
    }

    // ✅ DB UPDATE
    position.status = "CLOSED";
    position.exitOrderId = angelResp.resp.data.orderid;
    position.exitAt = new Date();

    await position.save();

    res.json({
      ok: true,
      message: "Position squared off successfully",
    });
  } catch (err) {
    console.error("Close order error:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to close position",
    });
  }
};

