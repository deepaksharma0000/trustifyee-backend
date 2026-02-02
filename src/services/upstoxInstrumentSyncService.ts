// src/services/upstoxInstrumentSyncService.ts
import axios from "axios";
import zlib from "zlib";
import UpstoxInstrumentModel from "../models/UpstoxInstrument";
import { log } from "../utils/logger";

const COMPLETE_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

type RawUpstoxInstrument = {
  instrument_key: string;
  trading_symbol?: string;   // note: JSON me "trading_symbol"
  tradingsymbol?: string;    // safety
  name?: string;
  exchange: string;
  segment: string;
  instrument_type: string;   // "CE" | "PE" | "FUT" | "EQ" ...
  option_type?: string;      // kuch cases me nahi hoga
  expiry?: number | string;
  strike_price?: number;
  lot_size?: number;
  tick_size?: number;
  [key: string]: any;
};

export async function syncNseFoInstruments() {
  log.info("Starting NSE_FO instruments sync from complete.json.gz...");

  const resp = await axios.get(COMPLETE_URL, {
    responseType: "arraybuffer",
    timeout: 30000,
  });

  const gunzipped = zlib.gunzipSync(resp.data);
  const jsonStr = gunzipped.toString("utf-8");

  const instruments: RawUpstoxInstrument[] = JSON.parse(jsonStr);

  // 1) Sirf NSE_FO segment
  const nseFo = instruments.filter((ins) => ins.segment === "NSE_FO");
  log.info("Total NSE_FO instruments:", nseFo.length);

  // 2) NSE_FO me se sirf options: CE / PE
  const optionInstruments = nseFo.filter(
    (ins) => ins.instrument_type === "CE" || ins.instrument_type === "PE"
  );

  log.info("Option instruments:", optionInstruments.length);

  if (optionInstruments.length === 0) {
    log.debug("No option instruments to upsert.");
    return;
  }

  const bulkOps = optionInstruments.map((ins) => {
    let expiry: Date | null = null;
    if (ins.expiry !== undefined && ins.expiry !== null) {
      if (typeof ins.expiry === "number") {
        expiry = new Date(ins.expiry); // ms timestamp
      } else {
        expiry = new Date(ins.expiry);
      }
    }

    const tradingSymbol = ins.tradingsymbol || ins.trading_symbol;

    const mapped = {
      instrument_key: ins.instrument_key,
      instrument_token: ins.instrument_key,  // yahi Upstox order me use karoge
      tradingsymbol: tradingSymbol,
      name: ins.name || tradingSymbol,
      exchange: ins.exchange,
      segment: ins.segment,
      instrument_type: ins.instrument_type,  // "CE" / "PE"
      option_type: ins.instrument_type,      // for clarity, same store kar lo
      expiry,
      strike_price: ins.strike_price ?? null,
      lot_size: ins.lot_size ?? null,
      tick_size: ins.tick_size ?? null,
      raw: ins,
    };

    return {
      updateOne: {
        filter: { instrument_key: mapped.instrument_key },
        update: { $set: mapped },
        upsert: true,
      },
    };
  });

  const result = await UpstoxInstrumentModel.bulkWrite(bulkOps, {
    ordered: false,
  });

  log.info("NSE_FO option instruments sync complete", {
    matched: result.matchedCount,
    upserted: Object.keys(result.upsertedIds || {}).length,
    modified: result.modifiedCount,
  });
}
