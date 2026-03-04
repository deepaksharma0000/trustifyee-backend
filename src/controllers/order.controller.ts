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
      symboltoken,
      autoSquareOffEnabled,  // [NEW]
      autoSquareOffTime      // [NEW]
    } = req.body;

    // [NEW] Check Market Status
    const MarketStatusService = require("../services/MarketStatusService").MarketStatusService;
    try {
      MarketStatusService.validateOrderRequest();
    } catch (err: any) {
      return res.status(400).json({ ok: false, message: err.message });
    }

    // Validate if Enabled
    let autoExitJobId = undefined;
    let autoExitStatus = "PENDING";

    if (autoSquareOffEnabled && autoSquareOffTime) {
      // Basic validation (optional)
      const exitDate = new Date(autoSquareOffTime);
      if (isNaN(exitDate.getTime())) {
        throw new Error("Invalid auto square-off time");
      }
    }

    const newPosition = await Position.create({
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
      autoSquareOffEnabled: autoSquareOffEnabled || false,
      autoSquareOffTime: autoSquareOffTime ? new Date(autoSquareOffTime) : undefined,
      autoSquareOffStatus: autoSquareOffEnabled ? "PENDING" : undefined
    });

    // Schedule Job if enabled
    if (autoSquareOffEnabled && autoSquareOffTime) {
      const AutoExitService = require("../services/AutoExitService").AutoExitService; // Lazy load to avoid circular deps if any
      const jobId = await AutoExitService.scheduleExit(orderid, new Date(autoSquareOffTime));

      newPosition.autoSquareOffJobId = jobId;
      await newPosition.save();
    }


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
          const ltpResp = await adapter.getLtp(tokens.jwtToken!, p.exchange, p.tradingsymbol, currentSymbolToken);
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

    // [NEW] Check Market Status (Allow force close if needed? Usually NO for live market)
    // admin might want to force close internally, but broker will reject anyway if market is closed.
    // Let's block it for consistency unless extended hours are supported.
    const MarketStatusService = require("../services/MarketStatusService").MarketStatusService;
    try {
      MarketStatusService.validateOrderRequest();
    } catch (err: any) {
      return res.status(400).json({ ok: false, message: err.message });
    }

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

    // [NEW] Cancel Auto Exit Job if exists
    if (position.autoSquareOffEnabled && position.autoSquareOffJobId) {
      const AutoExitService = require("../services/AutoExitService").AutoExitService;
      await AutoExitService.cancelExit(position.orderid);
      position.autoSquareOffStatus = "CANCELLED";
      await position.save();
    }
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

export const getGlobalTradeHistory = async (req: Request, res: Response) => {
  try {
    const { fromDate, toDate, indexSymbol, strategy, status, lots, clientcode, userId } = req.query;
    let query: any = {};

    if (userId) {
      query.userId = userId;
    } else if (clientcode) {
      query.clientcode = clientcode;
    }

    if (fromDate && toDate) {
      const start = new Date(fromDate as string);
      start.setHours(0, 0, 0, 0);
      const end = new Date(toDate as string);
      end.setHours(23, 59, 59, 999);
      query.createdAt = { $gte: start, $lte: end };
    }

    if (indexSymbol && indexSymbol !== 'All') {
      query.tradingsymbol = { $regex: `^${indexSymbol}`, $options: 'i' };
    }

    if (strategy && strategy !== 'All') {
      query.strategy = strategy;
    }

    if (status && status !== 'All') {
      query.status = status;
    }

    if (req.query.symbol && req.query.symbol !== 'All') {
      query.tradingsymbol = { $regex: req.query.symbol as string, $options: 'i' };
    }

    const lotNum = Number(req.query.lots);
    if (req.query.lots && !isNaN(lotNum) && lotNum > 0) {
      query.quantity = lotNum;
    }

    const trades = await Position.find(query).sort({ createdAt: -1 }).limit(100).lean();

    // Helper to get LTP for Open trades
    const adapter = new AngelOneAdapter();
    const tradesWithPnl = await Promise.all(trades.map(async (t) => {
      let pnl = 0;
      let exitPrice = t.exitPrice || 0;

      if (t.status === 'CLOSED' && t.exitPrice) {
        pnl = t.side === 'BUY'
          ? (t.exitPrice - t.entryPrice) * t.quantity
          : (t.entryPrice - t.exitPrice) * t.quantity;
      } else if (t.status === 'OPEN') {
        try {
          // Fetch LTP for LIVE calculation
          const tokens = await AngelTokensModel.findOne({ clientcode: t.clientcode });
          if (tokens?.jwtToken && t.symboltoken) {
            const ltpResp = await adapter.getLtp(tokens.jwtToken, t.exchange, t.tradingsymbol, t.symboltoken);
            const ltp = ltpResp?.data?.ltp || 0;
            exitPrice = ltp;
            pnl = t.side === 'BUY'
              ? (ltp - t.entryPrice) * t.quantity
              : (t.entryPrice - ltp) * t.quantity;
          }
        } catch (e) {
          // Fallback to 0 if failed
        }
      }
      return { ...t, pnl, currentPrice: exitPrice };
    }));

    const totalPnl = tradesWithPnl.reduce((acc, curr) => acc + (curr.pnl || 0), 0);

    res.json({ ok: true, data: tradesWithPnl, totalRealisedPnl: totalPnl });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message });
  }
}

export const exportGlobalTradeHistory = async (req: Request, res: Response) => {
  try {
    const { fromDate, toDate, indexSymbol, strategy, status, lots, clientcode, userId } = req.query;
    let query: any = {};

    if (userId) {
      query.userId = userId;
    } else if (clientcode) {
      query.clientcode = clientcode;
    }

    if (fromDate && toDate) {
      const start = new Date(fromDate as string);
      start.setHours(0, 0, 0, 0);
      const end = new Date(toDate as string);
      end.setHours(23, 59, 59, 999);
      query.createdAt = { $gte: start, $lte: end };
    }

    if (indexSymbol && indexSymbol !== 'All') {
      query.tradingsymbol = { $regex: `^${indexSymbol}`, $options: 'i' };
    }

    if (strategy && strategy !== 'All') {
      query.strategy = strategy;
    }

    if (status && status !== 'All') {
      query.status = status;
    }

    const lotNum = Number(req.query.lots);
    if (req.query.lots && !isNaN(lotNum) && lotNum > 0) {
      query.quantity = lotNum;
    }

    const trades = await Position.find(query).sort({ createdAt: -1 }).lean();

    if (!trades.length) {
      return res.status(404).json({ ok: false, message: "No trades to export" });
    }

    const columns = [
      "signalTime", "tradingsymbol", "strategy", "side",
      "quantity", "exitQty", "entryPrice", "exitPrice", "pnl"
    ];

    const labels = [
      "Signal Time", "Symbol", "Strategy", "Entry Type",
      "Entry Qty", "Exit Qty", "Entry Price", "Exit Price", "Total P/L"
    ];

    const escapeCsv = (val: any) => {
      if (val === null || val === undefined) return "";
      if (val instanceof Date) return val.toLocaleString();
      const s = String(val);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = labels.join(",");
    const rows = trades.map((t: any) => {
      // Calculate PNL for export if not present
      let pnl = 0;
      if (t.status === 'CLOSED' && t.exitPrice) {
        pnl = t.side === 'BUY'
          ? (t.exitPrice - t.entryPrice) * t.quantity
          : (t.entryPrice - t.exitPrice) * t.quantity;
      }
      t.pnl = pnl.toFixed(2);
      t.signalTime = t.createdAt;
      t.exitQty = t.exitQty || t.quantity;

      return columns.map(c => escapeCsv(t[c])).join(",");
    });

    const csv = [header, ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="trade-history-${new Date().getTime()}.csv"`);
    return res.send(csv);
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message });
  }
}

export const getUniqueSymbols = async (req: Request, res: Response) => {
  try {
    const { indexSymbol, fromDate, toDate } = req.query;
    let query: any = {};

    if (fromDate && toDate) {
      const start = new Date(fromDate as string);
      start.setHours(0, 0, 0, 0);
      const end = new Date(toDate as string);
      end.setHours(23, 59, 59, 999);
      query.createdAt = { $gte: start, $lte: end };
    }

    if (indexSymbol && indexSymbol !== 'All') {
      query.tradingsymbol = { $regex: `^${indexSymbol}`, $options: 'i' };
    }
    const symbols = await Position.distinct("tradingsymbol", query);
    res.json({ ok: true, data: symbols });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message });
  }
}

