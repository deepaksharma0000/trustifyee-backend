import InstrumentModel from "../models/Instrument";
import { getATMStrike } from "../utils/optionUtils";
import { getLiveNiftyLtp } from "./MarketDataService";

function getNearestStrike(strikes: number[], atm: number) {
  return strikes.reduce((prev, curr) =>
    Math.abs(curr - atm) < Math.abs(prev - atm) ? curr : prev
  );
}

export async function getNiftyOptionChain(niftyLtp?: number) {
  let currentLtp = niftyLtp || 0;

  // Fetch live LTP if not provided
  if (currentLtp <= 0) {
    currentLtp = await getLiveNiftyLtp();
  }

  // Fallback if still 0 (e.g., market closed or session expired)
  if (currentLtp <= 0) {
    currentLtp = 25000; // Default fallback for safety
  }

  const atm = getATMStrike(currentLtp);

  // 1️⃣ All future NIFTY option strikes
  const strikes: number[] = await InstrumentModel.distinct("strike", {
    name: "NIFTY",
    instrumenttype: "OPTIDX",
    expiry: { $gte: new Date() }
  });

  if (!strikes.length) {
    return { niftyLtp, atmStrike: atm, options: [] };
  }

  // 2️⃣ Nearest tradable strike
  const usedStrike = getNearestStrike(strikes, atm);

  // 3️⃣ Fetch CE + PE (nearest expiry first)
  const options = await InstrumentModel.find({
    name: "NIFTY",
    instrumenttype: "OPTIDX",
    strike: usedStrike
  })
    .sort({ expiry: 1 })
    .select("tradingsymbol strike optiontype expiry symboltoken")
    .lean();

  return {
    niftyLtp,
    atmStrike: atm,
    usedStrike,
    options
  };
}
