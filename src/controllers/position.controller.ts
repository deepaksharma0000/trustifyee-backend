import { Request, Response } from "express";
import { Position } from "../models/Position.model";
import { placeOrderForClient, getOrderStatusForClient, PlaceOrderInput } from "../services/OrderService";
import log from "../utils/logger";
import { getInstrumentLtp } from "../services/MarketDataService";

export const getOpenPositions = async (req: Request, res: Response) => {
  try {
    const { clientcode } = req.params;
    const userId = (req as any).id;
    const isAdminRequested = clientcode === "ADMIN_ALL";
    const userType = (req as any).userType;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const query: any = {
      $or: [
        { status: { $in: ["OPEN", "COMPLETE", "REJECTED"] } },
        { status: "CLOSED", updatedAt: { $gte: today } },
      ],
    };

    // Regular users only see current day positions.
    if (userType === "user") {
      query.createdAt = { $gte: today };
    }

    if (clientcode === "ADMIN_DEMO") {
      if (userType === "user") {
        query.userId = userId;
      }
      if (userType === "admin") {
        query.mode = "paper";
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

    let positionsWithLtp = positions;

    try {
      const InstrumentModel = require("../models/Instrument").default;
      const UpstoxInstrumentModel = require("../models/UpstoxInstrument").default;

      positionsWithLtp = await Promise.all(
        positions.map(async (p: any) => {
          try {
            let currentSymbolToken = p.symboltoken;
            if (!currentSymbolToken) {
              const isUpstoxLike =
                p.exchange === "NSE_FO" ||
                String(p.symboltoken || "").includes("|") ||
                String(p.symboltoken || "").length > 20;

              if (isUpstoxLike) {
                const upstoxInst = await UpstoxInstrumentModel.findOne({ tradingsymbol: p.tradingsymbol });
                currentSymbolToken = upstoxInst?.instrument_key;
              } else {
                const inst = await InstrumentModel.findOne({
                  tradingsymbol: p.tradingsymbol,
                  exchange: p.exchange,
                });
                currentSymbolToken = inst?.symboltoken;
              }
            }

            const ltp = currentSymbolToken
              ? await getInstrumentLtp(p.exchange, p.tradingsymbol, currentSymbolToken, {
                userId: String(p.userId || userId || ""),
                clientcode: String(p.clientcode || ""),
              })
              : 0;

            if (ltp > 0) {
              const pnl =
                p.side === "BUY"
                  ? (ltp - p.entryPrice) * p.quantity
                  : (p.entryPrice - ltp) * p.quantity;

              return { ...p, ltp, pnl, livePrice: ltp };
            }

            return { ...p, ltp: 0, pnl: 0, livePrice: 0 };
          } catch {
            return { ...p, ltp: 0, pnl: 0, livePrice: 0 };
          }
        })
      );
    } catch (adapterErr) {
      log.warn("LTP fetch skipped or failed", adapterErr);
    }

    const recentPositions = positionsWithLtp.filter(
      (p: any) =>
        (!p.entryPrice || p.entryPrice === 0) &&
        p.mode === "live" &&
        p.orderid &&
        new Date().getTime() - new Date(p.createdAt).getTime() < 15 * 60 * 1000
    );

    if (recentPositions.length > 0) {
      const toHeal = recentPositions.slice(0, 3);

      for (const p of toHeal) {
        try {
          await new Promise((r) => setTimeout(r, 600));

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
        } catch {
          // best effort healing
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
    const { orderid } = req.body;

    const position = await Position.findOne({
      orderid,
      status: { $in: ["OPEN", "COMPLETE"] },
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
      symboltoken: position.symboltoken,
    };

    let orderidResp = "PAPER-EXIT";
    if (position.mode !== "paper") {
      const resp = await placeOrderForClient(position.userId, position.clientcode, orderInput);

      if (resp && resp.status !== 200) {
        return res.status(400).json({ ok: false, message: resp.message || "Broker exit order failed" });
      }

      orderidResp = resp?.data?.orderid || resp?.data?.data?.orderid || "MANUAL";
    } else {
      orderidResp = `PAPER-EXIT-${Date.now()}`;
    }

    let exitPrice = 0;
    try {
      if (position.symboltoken) {
        exitPrice = await getInstrumentLtp(position.exchange, position.tradingsymbol, position.symboltoken, {
          userId: String(position.userId || ""),
          clientcode: String(position.clientcode || ""),
        });
      }
    } catch (e) {
      log.warn("Failed to fetch exit price in position controller", e);
    }

    position.status = "CLOSED";
    position.exitOrderId = orderidResp;
    position.exitQty = position.quantity;
    position.exitPrice = exitPrice || position.targetPrice || position.stopLossPrice;
    position.exitAt = new Date();
    await position.save();

    try {
      const { AutoExitService } = require("../services/AutoExitService");
      if (position.autoSquareOffEnabled) {
        await AutoExitService.cancelExit(position.orderid);
        position.autoSquareOffStatus = "CANCELLED";
        await position.save();
      }
    } catch {
      // no-op
    }

    res.json({ ok: true, message: "Position squared off successfully", orderid: orderidResp });
  } catch (err: any) {
    log.error("Close position error:", err.message);
    res.status(500).json({ ok: false, message: "Failed to close position: " + err.message });
  }
};
