import { Request, Response } from "express";
import { Position } from "../models/Position.model";

export const getOpenPositions = async (req: Request, res: Response) => {
  try {
    const { clientcode } = req.params;

    // 1. Fetch from DB
    // Assuming status "OPEN" means open position. "COMPLETE" might be an intermittent status or old status.
    const positions = await Position.find({
      clientcode,
      status: { $in: ["OPEN", "COMPLETE"] },
    }).sort({ createdAt: -1 }).lean();

    if (!positions || positions.length === 0) {
      return res.json({ ok: true, data: [] });
    }

    // 2. Try to attach LTP if possible, but don't fail if error
    let positionsWithLtp = positions;

    // Attempt to get token for LTP fetch
    try {
      const AngelTokensModel = require("../models/AngelTokens").default;
      const { AngelOneAdapter } = require("../adapters/AngelOneAdapter");
      const InstrumentModel = require("../models/Instrument").default;

      const tokens = await AngelTokensModel.findOne({ clientcode });

      if (tokens?.jwtToken) {
        const adapter = new AngelOneAdapter();

        positionsWithLtp = await Promise.all(positions.map(async (p: any) => {
          try {
            let currentSymbolToken = p.symboltoken;
            // If symboltoken missing, try to find from Instrument
            if (!currentSymbolToken) {
              const inst = await InstrumentModel.findOne({ tradingsymbol: p.tradingsymbol, exchange: p.exchange });
              currentSymbolToken = inst?.symboltoken;
            }

            if (currentSymbolToken) {
              // LTP Call
              const ltpResp = await adapter.getLtp(tokens.jwtToken, p.exchange, p.tradingsymbol, currentSymbolToken);
              const ltp = ltpResp?.data?.ltp || 0;
              const pnl = p.side === "BUY"
                ? (ltp - p.entryPrice) * p.quantity
                : (p.entryPrice - ltp) * p.quantity;

              return { ...p, ltp, pnl, livePrice: ltp }; // livePrice for frontend compatibility
            }
            return { ...p, ltp: 0, pnl: 0, livePrice: 0 };
          } catch (innerErr) {
            // LTP fetch failed for this specific position (e.g. symbol error), return basic data
            return { ...p, ltp: 0, pnl: 0, livePrice: 0 };
          }
        }));
      }
    } catch (adapterErr) {
      console.warn("LTP Fetch skipped or failed (Market might be closed or token invalid):", adapterErr);
      // Fallback: return positions without LTP updates
    }

    res.json({
      ok: true,
      data: positionsWithLtp,
    });
  } catch (err) {
    console.error("getOpenPositions error:", err);
    res.status(500).json({
      ok: false,
      message: "Failed to fetch open positions",
    });
  }
};
export const closePosition = async (
  req: Request,
  res: Response
) => {
  const { orderid } = req.body;

  await Position.findOneAndUpdate(
    { orderid },
    { status: "CLOSED" }
  );

  res.json({ ok: true });
};
