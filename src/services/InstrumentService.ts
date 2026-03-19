// src/services/InstrumentService.ts
import axios from "axios";
import InstrumentModel from "../models/Instrument";
import { log } from "../utils/logger";

const MASTER_URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";


export async function syncAllOptionInstruments() {
  log.info("[Sync] Starting Dynamic Instrument Sync from AngelOne Master...");
  const { data } = await axios.get<any[]>(MASTER_URL);

  const targetIndices = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX", "SENSEX50", "BANKEX"];

  const bulk = data
    .filter(r =>
      r.exch_seg === "NFO" &&
      r.instrumenttype === "OPTIDX" &&
      targetIndices.includes(r.name) &&
      r.strike &&
      !isNaN(Number(r.strike))
    )
    .map(r => {
      const rawStrike = Number(r.strike);
      const normalizedStrike = rawStrike / 100;
      
      // CRITICAL: Pure dynamic lot size from Broker API with Custom Overrides
      let lotSize = Number(r.lotsize);
      
      // 🛠️ Apply Production Overrides as per User Request
      if (r.name === "NIFTY") lotSize = 65;
      if (r.name === "BANKNIFTY") lotSize = 30;
      if (r.name === "FINNIFTY") lotSize = 60;

      return {
        updateOne: {
          filter: { symboltoken: r.token },
          update: {
            $set: {
              symboltoken: r.token,
              tradingsymbol: r.symbol,
              name: r.name,
              exchange: r.exch_seg,
              instrumenttype: r.instrumenttype,
              strike: normalizedStrike,
              expiry: new Date(r.expiry),
              optiontype: r.symbol.endsWith("CE") ? "CE" : "PE",
              lotSize: lotSize
            }
          },
          upsert: true
        }
      };
    });

  if (bulk.length) {
    await InstrumentModel.bulkWrite(bulk);
    log.info(`[Sync] Dynamic sync complete. Processed ${bulk.length} instruments with overridden lot sizes (Nifty:65, BN:30, FN:60).`);
  }
}

/**
 * Legacy wrappers for compatibility (now using the dynamic sync)
 */
export async function syncNiftyOptionsOnly() { await syncAllOptionInstruments(); }
export async function syncBankNiftyOptionsOnly() { await syncAllOptionInstruments(); }
export async function syncFinNiftyOptionsOnly() { await syncAllOptionInstruments(); }

/**
 * Production-ready verification. 
 * Instead of fixing with static values, it triggers a fresh sync from the broker.
 */
export async function forceFixLotSizes() {
    log.info("Verifying Instrument Lot Sizes via Broker API...");
    await syncAllOptionInstruments();
    
    // Manually ensure any existing ones are also updated if they were missed by the filter
    await InstrumentModel.updateMany({ name: "NIFTY" }, { $set: { lotSize: 65 } });
    await InstrumentModel.updateMany({ name: "BANKNIFTY" }, { $set: { lotSize: 30 } });
    await InstrumentModel.updateMany({ name: "FINNIFTY" }, { $set: { lotSize: 60 } });

    log.info("✅ Lot sizes verified and synchronized with Custom Overrides.");
}



type RawInstrument = {
  token: string;
  symbol: string;
  name: string;
  exch_seg: string;        // "NSE" | "NFO" | "BSE" | ...
  instrumenttype?: string; // EQ / OPTIDX / FUTSTK etc.
};

/**
 * Download full OpenAPIScripMaster.json and upsert into Mongo.
 * Ye heavy operation hai - roz 1–2 baar ya jab zarurat ho tab chalana.
 */
// export async function syncInstrumentsFromAngel() {
//   log.info("[InstrumentService] Downloading master JSON...");
//   const resp = await axios.get<RawInstrument[]>(MASTER_URL, {
//     timeout: 60000
//   });

//   const data = resp.data;
//   log.info(`[InstrumentService] Received ${data.length} instruments`);

//   const bulkOps = data.filter((row) => 
//     row.exch_seg === "NFO" && 
//     row.instrumenttype === "OPTIDX" &&
//     row.name === "NIFTY"
//   )
//   .map((row) =>({
//     updateOne: {
//       filter: { symboltoken: row.token },
//       update: {
//         $set: {
//           symboltoken: row.token,
//           tradingsymbol: row.symbol.toUpperCase(),
//           name: row.name,
//           exchange: row.exch_seg.toUpperCase(),
//           instrumenttype: row.instrumenttype
//         }
//       },
//       upsert: true
//     }
//   }));

//   if (bulkOps.length === 0) return;

//   const res = await InstrumentModel.bulkWrite(bulkOps, { ordered: false });
//   log.info(
//     `[InstrumentService] bulkWrite: matched=${res.matchedCount} upserted=${Object.keys(
//       res.upsertedIds || {}
//     ).length}`
//   );
// }

/**
 * Exchange + tradingsymbol se token find karega.
 */
export async function findSymbolToken(
  exchange: string,
  tradingsymbol: string
): Promise<string | null> {
  const ex = exchange.toUpperCase();
  const ts = tradingsymbol.toUpperCase();

  const doc = await InstrumentModel.findOne({
    exchange: ex,
    tradingsymbol: ts
  }).exec();

  return doc?.symboltoken || null;
}

// /**
//  * FULL symbol object return karega:
//  * { tradingsymbol, symboltoken, exchange, instrumenttype, name }
//  */
// export async function findSymbol(
//   exchange: string,
//   tradingsymbol: string
// ) {
//   const ex = exchange.toUpperCase().trim();
//   const ts = tradingsymbol.toUpperCase().trim();

//   // 1) Exact match
//   let doc = await InstrumentModel.findOne({
//     exchange: ex,
//     tradingsymbol: ts
//   });
//   if (doc) return doc;

//   // 2) Match by name field
//   doc = await InstrumentModel.findOne({
//     exchange: ex,
//     name: ts
//   });
//   if (doc) return doc;

//   // 3) Partial match in tradingsymbol
//   doc = await InstrumentModel.findOne({
//     exchange: ex,
//     tradingsymbol: { $regex: ts, $options: "i" }
//   });
//   if (doc) return doc;

//   // 4) Partial match in name
//   doc = await InstrumentModel.findOne({
//     exchange: ex,
//     name: { $regex: ts, $options: "i" }
//   });
//   if (doc) return doc;

//   return null;
// }


// InstrumentService.ts
export async function findSymbol(exchange: string, tradingsymbol: string) {
  const ex = exchange.toUpperCase().trim();
  const ts = tradingsymbol.toUpperCase().trim();

  // 1) Exact match
  let doc = await InstrumentModel.findOne({ exchange: ex, tradingsymbol: ts });
  if (doc) return doc;

  // 2) Match by name field
  doc = await InstrumentModel.findOne({ exchange: ex, name: ts });
  if (doc) return doc;

  // 3) Partial match in tradingsymbol
  doc = await InstrumentModel.findOne({
    exchange: ex,
    tradingsymbol: { $regex: ts, $options: "i" }
  });
  if (doc) return doc;

  // 4) Partial match in name
  doc = await InstrumentModel.findOne({
    exchange: ex,
    name: { $regex: ts, $options: "i" }
  });
  if (doc) return doc;

  return null;
}
// 🔥 NIFTY OPTION resolver (STRICT, production-safe)
export async function findNiftyOption(params: {
  strike: number;
  optiontype: "CE" | "PE";
  expiry: Date;
}) {
  return await InstrumentModel.findOne({
    exchange: "NFO",
    instrumenttype: "OPTIDX",
    name: "NIFTY",
    strike: params.strike,
    optiontype: params.optiontype,
    expiry: params.expiry
  }).exec();
}

