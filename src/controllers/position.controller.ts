import { Request, Response } from "express";
import { Position } from "../models/Position.model";
import { placeOrderForClient, getOrderStatusForClient } from "../services/OrderService";
import AngelTokensModel from "../models/AngelTokens";
import log from "../utils/logger";
import { getUpstoxAdapter } from "../utils/upstox";
import { PlaceOrderInput } from "../services/OrderService";

export const getOpenPositions = async (req: Request, res: Response) => {
  try {
    const { clientcode } = req.params;
    const userId = (req as any).id;
    const isAdminRequested = clientcode === 'ADMIN_ALL';

    // 1. Fetch from DB
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const userType = (req as any).userType;

    const query: any = {
      $or: [
        { status: { $in: ["OPEN", "COMPLETE", "REJECTED"] } },
        { status: "CLOSED", updatedAt: { $gte: today } }
      ]
    };

    // 🔥 Requirement: Regular users (XYZ) should ONLY see current day positions
    if (userType === 'user') {
      query.createdAt = { $gte: today };
    }

    if (clientcode === 'ADMIN_DEMO') {
      // If client (non-admin) is requesting ADMIN_DEMO, force filter by their own userId
      if (userType === 'user') {
        query.userId = userId;
      }
      // If admin is requesting ADMIN_DEMO, we show all demo (paper mode) trades
      if (userType === 'admin') {
        query.mode = 'paper';
      }
    } else if (!isAdminRequested) {
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
      const InstrumentModel = require("../models/Instrument").default;

      // ── For ADMIN_ALL: find any available valid token ──────────────────
      // We cannot use clientcode='ADMIN_ALL' as a key — no token exists for it.
      // Instead, pick the most-recently-updated live token from the DB.
      const [angelTokens, upstoxTokens] = await Promise.all([
        (isAdminRequested || clientcode === 'ADMIN_DEMO')
          ? AngelTokensModel.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 }).lean()
          : AngelTokensModel.findOne(userId ? { userId } : { clientcode }).lean(),
        (isAdminRequested || clientcode === 'ADMIN_DEMO')
          ? UpstoxTokensModel.findOne({ accessToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 }).lean()
          : UpstoxTokensModel.findOne(userId ? { userId } : {}).sort({ updatedAt: -1 }).lean()
      ]);

      let angelAdapter: any = null;
      if (angelTokens?.userId) {
        try {
          const { createAngelAdapter } = await import("../utils/broker");
          angelAdapter = await createAngelAdapter(String(angelTokens.userId));
        } catch (adapterErr) {
          log.warn("Unable to create Angel adapter for LTP enrichment", adapterErr);
        }
      }
      const upstoxAdapter = getUpstoxAdapter();

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
          } else if (!isUpstox && angelTokens?.jwtToken && angelAdapter) {
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

    // 3. Auto-sync missing Entry Prices for Live trades if 0 (Optimized for Rate Limits)
    const recentPositions = positionsWithLtp.filter((p: any) =>
      (!p.entryPrice || p.entryPrice === 0) &&
      p.mode === "live" &&
      p.orderid &&
      // Only heal orders from the last 15 minutes to avoid hitting rate limits for old junk
      (new Date().getTime() - new Date(p.createdAt).getTime() < 15 * 60 * 1000)
    );

    if (recentPositions.length > 0) {
      // Limit to max 3 heals per refresh cycle to stay under broker rate limits
      const toHeal = recentPositions.slice(0, 3);

      for (const p of toHeal) {
        try {
          // Add a small delay between each broker call (600ms)
          await new Promise(r => setTimeout(r, 600));

          const statusResp = await getOrderStatusForClient(
            p.userId,
            p.clientcode,
            p.orderid,
            undefined,
            p.tradingsymbol
          );
          let bData = statusResp?.data || statusResp;
          if (Array.isArray(bData)) bData = bData[bData.length - 1];

          if (bData && (bData.averageprice || bData.price)) {
            const newPrice = Number(bData.averageprice || bData.price);
            if (newPrice > 0) {
              await Position.updateOne({ _id: p._id }, { entryPrice: newPrice });
              p.entryPrice = newPrice;
            }
          }
        } catch (e) {
          // ignore and continue
        }
      }
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
export const closePosition = async (req: Request, res: Response) => {
  try {
    const { orderid, clientcode } = req.body;
    const user = (req as any).user;

    const position = await Position.findOne({
      orderid,
      status: { $in: ["OPEN", "COMPLETE"] }
    });

    if (!position) {
      return res.status(404).json({ ok: false, message: "Open position not found" });
    }

    const exitSide = position.side === "BUY" ? "SELL" : "BUY";
    const orderInput: PlaceOrderInput = {
      exchange: position.exchange,
      tradingsymbol: position.tradingsymbol,
      side: exitSide,
      transactiontype: exitSide,
      quantity: position.quantity,
      ordertype: "MARKET",
      producttype: (position as any).productType || "INTRADAY",
      symboltoken: position.symboltoken
    };

    // 1. Place Exit Order with Broker (Only for Live Mode)
    let orderid_resp = "PAPER-EXIT";

    if (position.mode !== "paper") {
      const resp = await placeOrderForClient(position.userId, position.clientcode, orderInput);

      if (resp && resp.status !== 200) {
        return res.status(400).json({ ok: false, message: resp.message || "Broker exit order failed" });
      }

      orderid_resp = resp?.data?.orderid || resp?.data?.data?.orderid || "MANUAL";
    } else {
      orderid_resp = `PAPER-EXIT-${Date.now()}`;
    }

    // 2. Capture Exit Price (LTP)
    let exitPrice = 0;
    try {
      let tokens = await AngelTokensModel.findOne({ clientcode: position.clientcode });
      if (!tokens?.jwtToken) {
        // Fallback for Demo trades
        tokens = await AngelTokensModel.findOne({ jwtToken: { $exists: true, $ne: "" } }).sort({ updatedAt: -1 });
      }

      if (tokens?.jwtToken && position.symboltoken) {
        const { createAngelAdapter } = await import("../utils/broker");
        const adapter = await createAngelAdapter(String(position.userId));
        const ltpResp = await adapter.getLtp(tokens.jwtToken, position.exchange, position.tradingsymbol, position.symboltoken);
        exitPrice = ltpResp?.data?.ltp || 0;
      }
    } catch (e) {
      log.warn("Failed to fetch exit price in position controller", e);
    }

    // 3. Update DB
    position.status = "CLOSED";
    position.exitOrderId = orderid_resp;
    position.exitQty = position.quantity;
    position.exitPrice = exitPrice || position.targetPrice || position.stopLossPrice;
    position.exitAt = new Date();
    await position.save();

    // 4. Cancel Auto Exit Job if any
    try {
      const { AutoExitService } = require("../services/AutoExitService");
      if (position.autoSquareOffEnabled) {
        await AutoExitService.cancelExit(position.orderid);
        position.autoSquareOffStatus = "CANCELLED";
        await position.save();
      }
    } catch (e) { }

    res.json({ ok: true, message: "Position squared off successfully", orderid: orderid_resp });
  } catch (err: any) {
    log.error("Close position error:", err.message);
    res.status(500).json({ ok: false, message: "Failed to close position: " + err.message });
  }
};
