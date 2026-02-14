import InstrumentModel from "../models/Instrument";
import User from "../models/User";
import { AlgoRun } from "../models/AlgoRun";
import { AlgoTrade } from "../models/AlgoTrade";
import { Position } from "../models/Position.model";
import { getLiveIndexLtp } from "./MarketDataService";
import { getATMStrike, getNearestStrike } from "../utils/optionUtils";
import { placeOrderForClient } from "./OrderService";
import { AngelOneAdapter } from "../adapters/AngelOneAdapter";
import AngelTokensModel from "../models/AngelTokens";
import {
  resolveStrategyLegs,
  getStrategyConfig,
  StrategyName,
  ResolvedStrategyLeg
} from "./StrategyEngine";
import { log } from "../utils/logger";
import { decrypt } from "../utils/encryption";

type AlgoSymbol = "NIFTY" | "BANKNIFTY" | "FINNIFTY";

const RUNNERS = new Map<string, NodeJS.Timeout>();

const EOD_HOUR = 15;
const EOD_MIN = 20;

function startOfDay(d = new Date()) {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s;
}

function isEodTime(now = new Date()) {
  return (
    now.getHours() > EOD_HOUR ||
    (now.getHours() === EOD_HOUR && now.getMinutes() >= EOD_MIN)
  );
}

async function resolveOptions(symbol: AlgoSymbol, expiry: Date) {
  const ltp = await getLiveIndexLtp(symbol);
  const atm = getATMStrike(ltp);

  const strikes: number[] = await InstrumentModel.distinct("strike", {
    name: symbol,
    instrumenttype: "OPTIDX",
    expiry: { $gte: new Date() },
  });

  const usedStrike = getNearestStrike(strikes, atm);

  const baseQuery = {
    name: symbol,
    instrumenttype: "OPTIDX",
    expiry: {
      $gte: new Date(expiry.toISOString().slice(0, 10)),
      $lt: new Date(new Date(expiry).setDate(expiry.getDate() + 1)),
    },
  };

  const findOption = async (optiontype: "CE" | "PE") => {
    let opt = await InstrumentModel.findOne({
      ...baseQuery,
      strike: usedStrike,
      optiontype,
    })
      .select("tradingsymbol strike optiontype expiry symboltoken")
      .lean();

    if (opt) return opt;

    const sorted = strikes.sort((a, b) => a - b);
    const idx = sorted.findIndex((s) => s === usedStrike);
    if (idx === -1) return null;

    const otmStrike =
      optiontype === "CE" ? sorted[idx + 1] : sorted[idx - 1];

    if (!otmStrike) return null;

    opt = await InstrumentModel.findOne({
      ...baseQuery,
      strike: otmStrike,
      optiontype,
    })
      .select("tradingsymbol strike optiontype expiry symboltoken")
      .lean();

    return opt || null;
  };

  const ce = await findOption("CE");
  const pe = await findOption("PE");

  return { ltp, atm, usedStrike, ce, pe };
}

async function getEntryPrice(
  jwtToken: string,
  exchange: string,
  tradingsymbol: string,
  symboltoken: string
) {
  const adapter = new AngelOneAdapter();
  const resp = await adapter.getLtp(jwtToken, exchange, tradingsymbol, symboltoken);
  return Number(resp?.data?.ltp || 0);
}

async function squareOffPosition(position: any) {
  const exitSide = position.side === "BUY" ? "SELL" : "BUY";
  const resp = await placeOrderForClient(position.clientcode, {
    exchange: position.exchange,
    tradingsymbol: position.tradingsymbol,
    side: exitSide,
    transactiontype: exitSide,
    quantity: position.quantity,
    ordertype: "MARKET",
  });

  const session = await AngelTokensModel.findOne({ clientcode: position.clientcode }).lean();
  const exitPrice =
    session?.jwtToken && position.symboltoken
      ? await getEntryPrice(session.jwtToken, position.exchange, position.tradingsymbol, position.symboltoken)
      : 0;

  position.status = "CLOSED";
  position.exitOrderId =
    resp?.data?.orderid ||
    resp?.data?.data?.orderid ||
    "MANUAL";
  position.exitAt = new Date();
  position.exitPrice = exitPrice;
  await position.save();
}

async function enforceRisk(run: any) {
  const openPositions = await Position.find({
    runId: String(run._id),
    status: "OPEN",
  }).lean();

  if (openPositions.length === 0) return;

  let totalEntry = 0;
  let totalPnl = 0;

  for (const p of openPositions) {
    const session = await AngelTokensModel.findOne({ clientcode: p.clientcode }).lean();
    if (!session?.jwtToken || !p.symboltoken) continue;
    const ltp = await getEntryPrice(session.jwtToken, p.exchange, p.tradingsymbol, p.symboltoken);

    const pnl =
      p.side === "BUY"
        ? (ltp - p.entryPrice) * p.quantity
        : (p.entryPrice - ltp) * p.quantity;

    totalEntry += p.entryPrice * p.quantity;
    totalPnl += pnl;

    const slPrice =
      p.side === "BUY"
        ? p.entryPrice * (1 - run.stopLossPercent / 100)
        : p.entryPrice * (1 + run.stopLossPercent / 100);
    const tpPrice =
      p.side === "BUY"
        ? p.entryPrice * (1 + run.targetPercent / 100)
        : p.entryPrice * (1 - run.targetPercent / 100);

    if (
      (p.side === "BUY" && (ltp <= slPrice || ltp >= tpPrice)) ||
      (p.side === "SELL" && (ltp >= slPrice || ltp <= tpPrice))
    ) {
      await squareOffPosition(p);
    }
  }

  if (totalEntry > 0) {
    const pnlPercent = (totalPnl / totalEntry) * 100;
    if (pnlPercent <= -run.maxLossPercent) {
      await stopRun(String(run._id), "Max loss hit");
    }
  }
}

async function placeTradesForRun(run: any) {
  const today = startOfDay();
  const batches = await AlgoTrade.distinct("batchId", {
    runId: String(run._id),
    createdAt: { $gte: today },
  });

  if (batches.length >= run.maxTradesPerDay) {
    await stopRun(String(run._id), "Max trades reached");
    return;
  }

  const { ce, pe } = await resolveOptions(run.symbol, run.expiry);
  if (!ce || !pe) {
    return;
  }

  const optionList =
    run.optionSide === "CE" ? [ce] :
      run.optionSide === "PE" ? [pe] :
        [ce, pe];

  const batchId = `BATCH-${Date.now()}`;
  const users = await User.find({
    status: "active",
    trading_status: "enabled",
  }).lean();

  for (const user of users) {
    const rawClientKey = user.client_key;
    if (!rawClientKey) continue;
    const clientcode = decrypt(rawClientKey);

    // -------------------------------------------------------------
    // Enforce Training & Token Conditions (User Request)
    // -------------------------------------------------------------
    let angelSession: any = null;

    if (user.licence === "Live") {
      angelSession = await AngelTokensModel.findOne({ clientcode }).lean();

      const broker_connected = !!angelSession;
      const token_valid = !!(angelSession?.jwtToken);

      const trading_enabled = (
        user.status === "active" &&
        user.trading_status === "enabled" &&
        user.licence === "Live" &&
        broker_connected === true &&
        token_valid === true
      );

      if (!trading_enabled) {
        log.warn(`Token Expired – Skipping User ${user.user_name}`);
        continue;
      }
    }
    // -------------------------------------------------------------

    for (const opt of optionList) {
      if (user.licence === "Demo") {
        const paperId = `PAPER-${Date.now()}-${Math.random()}`;
        await Position.create({
          clientcode,
          orderid: paperId,
          tradingsymbol: opt.tradingsymbol,
          exchange: "NFO",
          side: "BUY",
          quantity: 1,
          entryPrice: 0,
          symboltoken: opt.symboltoken,
          status: "OPEN",
          runId: String(run._id),
          strategy: run.strategy,
          mode: "paper",
        });

        await AlgoTrade.create({
          runId: String(run._id),
          batchId,
          userId: String(user._id),
          clientcode,
          orderid: paperId,
          tradingsymbol: opt.tradingsymbol,
          optiontype: opt.optiontype,
          strike: opt.strike,
          side: "BUY",
          quantity: 1,
          mode: "paper",
          status: "ok",
        });
        continue;
      }

      try {
        const resp = await placeOrderForClient(clientcode, {
          exchange: "NFO",
          tradingsymbol: opt.tradingsymbol,
          side: "BUY",
          transactiontype: "BUY",
          quantity: 1,
          ordertype: "MARKET",
        });

        const orderid =
          resp?.data?.orderid ||
          resp?.data?.data?.orderid ||
          `BROKER-${Date.now()}-${Math.random()}`;

        // Uses the session fetched above
        const entryPrice = angelSession?.jwtToken && opt.symboltoken
          ? await getEntryPrice(angelSession.jwtToken, "NFO", opt.tradingsymbol, opt.symboltoken)
          : 0;

        await Position.create({
          clientcode,
          orderid,
          tradingsymbol: opt.tradingsymbol,
          exchange: "NFO",
          side: "BUY",
          quantity: 1,
          entryPrice: entryPrice || 0,
          symboltoken: opt.symboltoken,
          status: "OPEN",
          runId: String(run._id),
          strategy: run.strategy,
          mode: "live",
        });

        await AlgoTrade.create({
          runId: String(run._id),
          batchId,
          userId: String(user._id),
          clientcode,
          orderid,
          tradingsymbol: opt.tradingsymbol,
          optiontype: opt.optiontype,
          strike: opt.strike,
          side: "BUY",
          quantity: 1,
          mode: "live",
          status: "ok",
        });
      } catch (err: any) {
        await AlgoTrade.create({
          runId: String(run._id),
          batchId,
          userId: String(user._id),
          clientcode,
          orderid: `ERR-${Date.now()}`,
          tradingsymbol: opt.tradingsymbol,
          optiontype: opt.optiontype,
          strike: opt.strike,
          side: "BUY",
          quantity: 1,
          mode: (user.licence as string) === "Demo" ? "paper" : "live",
          status: "error",
          error: err?.message || String(err),
        });
      }
    }
  }
}

export async function startRun(params: {
  symbol: AlgoSymbol;
  expiry: Date;
  strategy: string;
  optionSide?: "CE" | "PE" | "BOTH";
  createdBy: string;
}) {
  const existing = await AlgoRun.findOne({ status: "running" }).lean();
  if (existing) {
    return { ok: false, error: "Algo already running" };
  }

  const run = await AlgoRun.create({
    symbol: params.symbol,
    expiry: params.expiry,
    strategy: params.strategy,
    optionSide: params.optionSide || "BOTH",
    status: "running",
    createdBy: params.createdBy,
    startedAt: new Date(),
    maxTradesPerDay: 5,
    maxLossPercent: 2,
    stopLossPercent: 1,
    targetPercent: 2,
  });

  await placeTradesForRun(run);

  const interval = setInterval(async () => {
    const current = await AlgoRun.findById(run._id).lean();
    if (!current || current.status !== "running") {
      clearInterval(interval);
      RUNNERS.delete(String(run._id));
      return;
    }

    if (isEodTime()) {
      await stopRun(String(run._id), "EOD");
      return;
    }

    await enforceRisk(current);
    await placeTradesForRun(current);
  }, 30000);

  RUNNERS.set(String(run._id), interval);

  return { ok: true, run };
}

export async function stopRun(runId: string, reason = "Stopped") {
  const run = await AlgoRun.findById(runId);
  if (!run) return { ok: false, error: "Run not found" };

  run.status = "stopped";
  run.stoppedAt = new Date();
  run.stopReason = reason;
  await run.save();

  const timer = RUNNERS.get(runId);
  if (timer) {
    clearInterval(timer);
    RUNNERS.delete(runId);
  }

  const openPositions = await Position.find({ runId, status: "OPEN" });
  for (const p of openPositions) {
    await squareOffPosition(p);
  }

  return { ok: true };
}

export async function getStatus() {
  const run = await AlgoRun.findOne({ status: "running" }).lean();
  return run || null;
}

export async function getRuns(limit = 50) {
  return AlgoRun.find().sort({ createdAt: -1 }).limit(limit).lean();
}

export async function getTrades(runId: string, limit = 200) {
  return AlgoTrade.find({ runId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

export async function getSummary(date?: string) {
  const start = date ? new Date(date) : startOfDay();
  const end = new Date(start);
  end.setDate(start.getDate() + 1);

  const trades = await AlgoTrade.find({
    createdAt: { $gte: start, $lt: end },
  }).lean();

  const totalTrades = trades.length;
  const success = trades.filter((t) => t.status === "ok").length;
  const failed = trades.filter((t) => t.status === "error").length;

  const openPositions = await Position.countDocuments({
    status: "OPEN",
  });

  const closedPositions = await Position.find({
    status: "CLOSED",
    exitAt: { $gte: start, $lt: end },
  }).lean();

  const pnl = closedPositions.reduce((sum, p) => {
    const exitPrice = p.exitPrice ?? p.entryPrice;
    const diff = p.side === "BUY" ? (exitPrice - p.entryPrice) : (p.entryPrice - exitPrice);
    return sum + diff * p.quantity;
  }, 0);

  return {
    date: start.toISOString().slice(0, 10),
    totalTrades,
    success,
    failed,
    openPositions,
    closedPositions: closedPositions.length,
    pnl,
  };
}
