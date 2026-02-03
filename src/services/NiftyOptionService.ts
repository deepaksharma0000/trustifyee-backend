import InstrumentModel from "../models/Instrument";
import { getATMStrike } from "../utils/optionUtils";
import { getLiveIndexLtp } from "./MarketDataService";

function getNearestStrike(strikes: number[], atm: number) {
  if (!strikes.length) return 0;
  return strikes.reduce((prev, curr) =>
    Math.abs(curr - atm) < Math.abs(prev - atm) ? curr : prev
  );
}

export async function getOptionChain(symbol: "NIFTY" | "BANKNIFTY" = "NIFTY", ltp?: number) {
  let currentLtp = ltp || 0;

  // Fetch live LTP if not provided
  if (currentLtp <= 0) {
    currentLtp = await getLiveIndexLtp(symbol);
  }

  // Fallback if still 0
  if (currentLtp <= 0) {
    currentLtp = symbol === "NIFTY" ? 25000 : 52000;
  }

  const atm = getATMStrike(currentLtp);

  // 1️⃣ Future option strikes for specific index
  const strikes: number[] = await InstrumentModel.distinct("strike", {
    name: symbol,
    instrumenttype: "OPTIDX",
    expiry: { $gte: new Date() }
  });

  if (!strikes.length) {
    return { ltp: currentLtp, atmStrike: atm, options: [] };
  }

  // 2️⃣ Nearest tradable strike
  const usedStrike = getNearestStrike(strikes, atm);

  // 3️⃣ Fetch CE + PE
  const options = await InstrumentModel.find({
    name: symbol,
    instrumenttype: "OPTIDX",
    strike: usedStrike
  })
    .sort({ expiry: 1 })
    .select("tradingsymbol strike optiontype expiry symboltoken")
    .lean();

  return {
    symbol,
    ltp: currentLtp,
    atmStrike: atm,
    usedStrike,
    options
  };
}

// Backward compatibility
export async function getNiftyOptionChain(niftyLtp?: number) {
  return getOptionChain("NIFTY", niftyLtp);
}
