import InstrumentModel from "../models/Instrument";
import { config } from "../config";
import { getATMStrike } from "../utils/optionUtils";
import { getLiveIndexLtp, getLastIndexLtp } from "./MarketDataService";

function formatIstDate(date: Date) {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function getIstDayRange(dateStr: string) {
  const start = new Date(`${dateStr}T00:00:00+05:30`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

const OPTION_CHAIN_CACHE_MS = 5000;
const optionChainCache = new Map<
  string,
  { ts: number; data: any }
>();

function getNearestStrike(strikes: number[], atm: number) {
  if (!strikes.length) return 0;
  return strikes.reduce((prev, curr) =>
    Math.abs(curr - atm) < Math.abs(prev - atm) ? curr : prev
  );
}

export async function getOptionChain(
  symbol: "NIFTY" | "BANKNIFTY" | "FINNIFTY" = "NIFTY",
  expiry?: string,
  strikeRange: number = 5
) {
  const cacheKey = `${symbol}|${expiry || "NEAREST"}|${strikeRange}`;
  const now = Date.now();
  if (optionChainCache.has(cacheKey)) {
    const cached = optionChainCache.get(cacheKey)!;
    if (now - cached.ts < OPTION_CHAIN_CACHE_MS) {
      return cached.data;
    }
  }

  let currentLtp = await getLiveIndexLtp(symbol);
  if (currentLtp <= 0 && config.nodeEnv !== "production") {
    const last = getLastIndexLtp(symbol);
    if (last > 0) {
      currentLtp = last;
    }
  }
  if (currentLtp <= 0) {
    // If LTP is somehow still 0, we can't show a valid chain, but don't crash
    return { symbol, ltp: 0, atmStrike: 0, usedStrike: 0, options: [], expiries: [] };
  }

  const atm = getATMStrike(currentLtp);

  const baseQuery = {
    name: symbol,
    instrumenttype: "OPTIDX",
    expiry: { $gte: new Date() }
  };

  const expiries: Date[] = await InstrumentModel.distinct("expiry", baseQuery);
  let targetRange: { start: Date; end: Date } | undefined;

  if (expiry) {
    targetRange = getIstDayRange(expiry);
  } else if (expiries.length) {
    const istDates = expiries
      .map((d) => formatIstDate(new Date(d)))
      .filter((d) => d >= formatIstDate(new Date()))
      .sort();
    if (istDates.length) {
      targetRange = getIstDayRange(istDates[0]);
    }
  }

  const strikeQuery = {
    ...baseQuery,
    ...(targetRange
      ? {
        expiry: {
          $gte: targetRange.start,
          $lt: targetRange.end,
        },
      }
      : {}),
  };

  const strikes: number[] = await InstrumentModel.distinct("strike", strikeQuery);

  if (!strikes.length) {
    return { ltp: currentLtp, atmStrike: atm, options: [] };
  }

  const usedStrike = getNearestStrike(strikes, atm);
  const sorted = strikes.sort((a, b) => a - b);
  const idx = sorted.findIndex((s) => s === usedStrike);
  const otmStrike = idx >= 0 ? sorted[idx + 1] : undefined;
  const minIdx = Math.max(0, idx - strikeRange);
  const maxIdx = Math.min(sorted.length - 1, idx + strikeRange);
  const strikeSet = sorted.slice(minIdx, maxIdx + 1);

  const options = await InstrumentModel.find({
    ...strikeQuery,
    strike: { $in: strikeSet }
  })
    .sort({ expiry: 1 })
    .select("tradingsymbol strike optiontype expiry symboltoken")
    .lean();

  const response = {
    symbol,
    ltp: currentLtp,
    atmStrike: atm,
    usedStrike,
    options,
    expiries: Array.from(
      new Set(
        expiries
          .map((d) => formatIstDate(new Date(d)))
          .filter((d) => d >= formatIstDate(new Date()))
      )
    ).sort()
  };
  optionChainCache.set(cacheKey, { ts: Date.now(), data: response });
  return response;
}

// Backward compatibility
export async function getNiftyOptionChain(niftyLtp?: number) {
  void niftyLtp;
  return getOptionChain("NIFTY");
}
