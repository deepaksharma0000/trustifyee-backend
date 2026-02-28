import { Request, Response } from "express";
import { Position } from "../models/Position.model";

export const getOpenPositions = async (req: Request, res: Response) => {
  try {
    const { clientcode } = req.params;
    const userId = (req as any).id;
    const isAdminRequested = clientcode === 'ADMIN_ALL';

    // 1. Fetch from DB
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const query: any = {
      $or: [
        { status: { $in: ["OPEN", "COMPLETE"] } },
        { status: "CLOSED", updatedAt: { $gte: today } }
      ]
    };

    if (clientcode !== 'ADMIN_DEMO' && !isAdminRequested) {
      if (userId) {
        query.userId = userId;
      } else {
        query.clientcode = clientcode;
      }
    }

    const positions = await Position.find(query).sort({ createdAt: -1 }).lean();

    if (!positions || positions.length === 0) {
      return res.json({ ok: true, data: [] });
    }

    // 2. Try to attach LTP if possible, but don't fail if error
    let positionsWithLtp = positions;

    // Attempt to get token for LTP fetch
    try {
      const AngelTokensModel = require("../models/AngelTokens").default;
      const UpstoxTokensModel = require("../models/UpstoxTokens").default;
      const { AngelOneAdapter } = require("../adapters/AngelOneAdapter");
      const { UpstoxAdapter } = require("../adapters/UpstoxAdapter");
      const InstrumentModel = require("../models/Instrument").default;

      const [angelTokens, upstoxTokens] = await Promise.all([
        AngelTokensModel.findOne(userId ? { userId, clientcode } : { clientcode }).lean(),
        UpstoxTokensModel.findOne(userId ? { userId } : {}).sort({ updatedAt: -1 }).lean()
      ]);

      const angelAdapter = new AngelOneAdapter();
      const upstoxAdapter = new UpstoxAdapter();

      positionsWithLtp = await Promise.all(positions.map(async (p: any) => {
        try {
          let currentSymbolToken = p.symboltoken;

          // Detect broker
          const isUpstox = currentSymbolToken?.includes("|") || p.exchange === "NSE_FO" || (currentSymbolToken && currentSymbolToken.length > 20);

          let ltp = 0;

          if (isUpstox && upstoxTokens?.accessToken) {
            // Try find token if missing
            if (!currentSymbolToken) {
              const UpstoxInstrumentModel = require("../models/UpstoxInstrument").default;
              const inst = await UpstoxInstrumentModel.findOne({ tradingsymbol: p.tradingsymbol });
              currentSymbolToken = inst?.instrument_key;
            }

            if (currentSymbolToken) {
              const resp = await upstoxAdapter.getLtp(upstoxTokens.accessToken, currentSymbolToken);
              const data = resp?.data || {};
              let entry = data[currentSymbolToken as keyof typeof data];
              if (!entry) {
                const altKey = currentSymbolToken.replace("|", ":");
                entry = data[altKey as keyof typeof data];
              }
              ltp = Number(entry?.last_price || 0);
            }
          } else if (!isUpstox && angelTokens?.jwtToken) {
            if (!currentSymbolToken) {
              const inst = await InstrumentModel.findOne({ tradingsymbol: p.tradingsymbol, exchange: p.exchange });
              currentSymbolToken = inst?.symboltoken;
            }

            if (currentSymbolToken) {
              const ltpResp = await angelAdapter.getLtp(angelTokens.jwtToken, p.exchange, p.tradingsymbol, currentSymbolToken);
              ltp = ltpResp?.data?.ltp || 0;
            }
          }

          if (ltp > 0) {
            const pnl = p.side === "BUY"
              ? (ltp - p.entryPrice) * p.quantity
              : (p.entryPrice - ltp) * p.quantity;
            return { ...p, ltp, pnl, livePrice: ltp };
          }

          return { ...p, ltp: 0, pnl: 0, livePrice: 0 };
        } catch (innerErr) {
          return { ...p, ltp: 0, pnl: 0, livePrice: 0 };
        }
      }));
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
