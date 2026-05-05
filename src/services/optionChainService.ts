// src/services/optionChainService.ts
import UpstoxInstrumentModel, {
  IUpstoxInstrument,
} from "../models/UpstoxInstrument";
import log from "../utils/logger";

export type OptionSide = "CE" | "PE";
export type OptionSelectionMode = "ATM" | "OTM" | "ITM";

export interface OptionSelectionParams {
  underlyingSymbol: string; // e.g. "NIFTY", "BANKNIFTY"
  ltp: number; // current underlying price
  side: OptionSide; // CE / PE
  strikesAway?: number; // default 0 (pure ATM)
  expiryMode?: "NEAREST" | "NEXT"; // default NEAREST
}

/**
 * Get all options for an underlying from DB
 */
export async function getOptionChainFromDb(
  underlyingSymbol: string
): Promise<IUpstoxInstrument[]> {
  const regex = new RegExp(`^${underlyingSymbol}\\s`, "i");

//   const docs = await UpstoxInstrumentModel.find({
//     segment: "NSE_FO",
//     instrument_type: { $in: ["OPTIDX", "OPTSTK", "OPT"] },
//     tradingsymbol: regex,
//   })
const docs = await UpstoxInstrumentModel.find({
  segment: "NSE_FO",
  instrument_type: { $in: ["CE", "PE"] },       // sirf options
  instrument_token: { $ne: null },             // purana null data hata do
  tradingsymbol: regex
})
  .lean<IUpstoxInstrument[]>()
  .exec();

  return docs;
}

import moment from "moment-timezone";

/**
 * Group chain by expiry
 */
export function groupByExpiry(
  chain: IUpstoxInstrument[]
): Record<string, IUpstoxInstrument[]> {
  const map: Record<string, IUpstoxInstrument[]> = {};
  for (const ins of chain) {
    // Standardize to YYYY-MM-DD in IST
    const key = ins.expiry ? moment(ins.expiry).tz("Asia/Kolkata").format("YYYY-MM-DD") : "NO_EXPIRY";
    if (!map[key]) map[key] = [];
    map[key].push(ins);
  }
  return map;
}

/**
 * Pick nearest or next expiry
 */
export function pickExpiry(
    chain: IUpstoxInstrument[],
    mode: "NEAREST" | "NEXT" = "NEAREST"
): { expiry: string; instruments: IUpstoxInstrument[] } | null {
    const nowIst = moment().tz("Asia/Kolkata");
    const todayStr = nowIst.format("YYYY-MM-DD");

    // Get unique expiry dates, filter out past expiries
    const expiries = [...new Set(chain.map(i => {
        if (!i.expiry) return null;
        return moment(i.expiry).tz("Asia/Kolkata").format("YYYY-MM-DD");
    }))]
        .filter((e): e is string => !!e && e >= todayStr)
        .sort();

    if (expiries.length === 0) return null;

    const selectedExpiry = mode === "NEAREST"
        ? expiries[0]
        : expiries[1] || expiries[0];

    return {
        expiry: selectedExpiry,
        instruments: chain.filter(i => i.expiry && moment(i.expiry).tz("Asia/Kolkata").format("YYYY-MM-DD") === selectedExpiry)
    };
}


/**
 * Find ATM strike for given LTP
 */
export function findAtmStrike(
  instruments: IUpstoxInstrument[],
  ltp: number
): number | null {
  const strikes = instruments
    .map((i) => i.strike_price)
    .filter((s): s is number => typeof s === "number")
    .sort((a, b) => a - b);

  if (strikes.length === 0) return null;

  let best = strikes[0];
  let bestDiff = Math.abs(ltp - best);

  for (const s of strikes) {
    const diff = Math.abs(ltp - s);
    if (diff < bestDiff) {
      best = s;
      bestDiff = diff;
    }
  }

  return best;
}

/**
 * From chain, pick specific option (CE / PE, ATM/±n strike)
 */
export function pickOptionFromChain(
  instruments: IUpstoxInstrument[],
  params: OptionSelectionParams
): IUpstoxInstrument | null {
  const { ltp, side, strikesAway = 0 } = params;

  // filter by CE/PE
  const sideFiltered = instruments.filter(
    (i) => i.option_type?.toUpperCase() === side
  );

  if (sideFiltered.length === 0) return null;

  const atmStrike = findAtmStrike(sideFiltered, ltp);
  if (!atmStrike) return null;

  // Unique sorted strikes
  const uniqueStrikes = Array.from(
    new Set(
      sideFiltered
        .map((i) => i.strike_price)
        .filter((s): s is number => typeof s === "number")
    )
  ).sort((a, b) => a - b);

  const atmIndex = uniqueStrikes.indexOf(atmStrike);
  if (atmIndex === -1) return null;

  const targetIndex = atmIndex + strikesAway;
  if (targetIndex < 0 || targetIndex >= uniqueStrikes.length) return null;

  const targetStrike = uniqueStrikes[targetIndex];

  // final instrument for target strike
  const chosen = sideFiltered.find((i) => i.strike_price === targetStrike);
  return chosen || null;
}

/**
 * High-level helper: give me best instrument for params
 */
export async function selectOptionInstrument(
  params: OptionSelectionParams
): Promise<IUpstoxInstrument | null> {
  const { underlyingSymbol, expiryMode = "NEAREST" } = params;

  const chain = await getOptionChainFromDb(underlyingSymbol);
  if (!chain || chain.length === 0) {
    log.debug("No chain found in DB for underlying:", underlyingSymbol);
    return null;
  }

  const expGroup = pickExpiry(chain, expiryMode);
  if (!expGroup) {
    log.debug("No usable expiry found for", underlyingSymbol);
    return null;
  }

  const chosen = pickOptionFromChain(expGroup.instruments, params);
  return chosen;
}
