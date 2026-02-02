import InstrumentModel from "../models/Instrument";
import { getATMStrike } from "../utils/optionUtils";

function getNearestStrike(strikes: number[], atm: number) {
  return strikes.reduce((prev, curr) =>
    Math.abs(curr - atm) < Math.abs(prev - atm) ? curr : prev
  );
}

export async function getNiftyOptionChain(niftyLtp: number) {
  const atm = getATMStrike(niftyLtp);

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
