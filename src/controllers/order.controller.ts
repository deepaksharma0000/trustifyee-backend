import { Request, Response } from "express";
import { Position } from "../models/Position.model";
import { placeAngelOrder } from "../services/angel.service";
import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import AngelTokensModel from "../models/AngelTokens";
import InstrumentModel from "../models/Instrument";

export const getOrderStatus = async (req: Request, res: Response) => {
  const { orderid, clientcode } = req.params;
  const user = (req as any).user;
  const userType = (req as any).userType;

  // Security check: If user, must match clientcode
  if (userType === 'user' && user.client_key !== clientcode) {
    return res.status(403).json({ ok: false, message: "Unauthorized access to these orders" });
  }

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
      symboltoken
    } = req.body;

    await Position.create({
      clientcode,
      orderid,
      tradingsymbol,
      exchange,
      side,
      quantity,
      entryPrice: price || 0,
      symboltoken,
      stopLossPrice: (req.body as any).stopLossPrice,
      targetPrice: (req.body as any).targetPrice,
      status: "OPEN",
    });

    res.json({ ok: true });
  } catch (err: any) {
    console.error("Save order error:", err);
    res.status(500).json({ ok: false, message: "Save order failed", error: err.message });
  }
};
export const getActivePositions = async (req: Request, res: Response) => {
  try {
    const { clientcode } = req.params;
    const user = (req as any).user;
    const userType = (req as any).userType;

    // Security check: If user, must match clientcode
    if (userType === 'user' && user.client_key !== clientcode) {
      return res.status(403).json({ ok: false, message: "Unauthorized access to these positions" });
    }

    const positions = await Position.find({ clientcode, status: "OPEN" }).sort({ createdAt: -1 }).lean();

    if (positions.length === 0) {
      return res.json({ ok: true, data: [] });
    }

    const tokens = await AngelTokensModel.findOne({ clientcode });
    if (!tokens?.jwtToken) {
      return res.status(401).json({ ok: false, message: "No active session for client" });
    }

    const adapter = new AngelOneAdapter();
    const positionsWithLtp = await Promise.all(positions.map(async (p) => {
      try {
        let currentSymbolToken = p.symboltoken;
        if (!currentSymbolToken) {
          const inst = await InstrumentModel.findOne({ tradingsymbol: p.tradingsymbol, exchange: p.exchange });
          currentSymbolToken = inst?.symboltoken;
        }

        if (currentSymbolToken) {
          const ltpResp = await adapter.getLtp(tokens.jwtToken, p.exchange, p.tradingsymbol, currentSymbolToken);
          const ltp = ltpResp?.data?.ltp || 0;
          const pnl = p.side === "BUY"
            ? (ltp - p.entryPrice) * p.quantity
            : (p.entryPrice - ltp) * p.quantity;

          return { ...p, ltp, pnl };
        }
        return { ...p, ltp: 0, pnl: 0 };
      } catch (err) {
        return { ...p, ltp: 0, pnl: 0 };
      }
    }));

    res.json({ ok: true, data: positionsWithLtp });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message });
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
      // Check if it's already closed or failed
      return res.status(400).json({
        ok: false,
        message: angelResp?.error || "Angel exit order failed",
      });
    }

    // ✅ DB UPDATE
    position.status = "CLOSED";
    position.exitOrderId = angelResp.resp?.data?.orderid || "MANUAL";
    position.exitAt = new Date();

    await position.save();

    res.json({
      ok: true,
      message: "Position squared off successfully",
      orderid: position.exitOrderId
    });
  } catch (err: any) {
    console.error("Close order error:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to close position: " + err.message,
    });
  }
};

export const getTradeHistory = async (req: Request, res: Response) => {
  try {
    const { clientcode } = req.params;
    const user = (req as any).user;
    const userType = (req as any).userType;

    // Security check: If user, must match clientcode
    if (userType === 'user' && user.client_key !== clientcode) {
      return res.status(403).json({ ok: false, message: "Unauthorized access to trade history" });
    }

    // Fetch closed positions, latest first
    const history = await Position.find({ clientcode, status: "CLOSED" }).sort({ exitAt: -1 }).lean();

    // In a real scenario, you might also want to fetch exit LTP to show P&L 
    // but since they are closed, entryPrice and exitPrice (which we should store) are enough.
    // Note: Our model currently doesn't have 'exitPrice'. Let's assume we use entryPrice of the exit order or just the P&L at close.
    // For now, let's just return what we have.

    res.json({ ok: true, data: history });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message });
  }
};

