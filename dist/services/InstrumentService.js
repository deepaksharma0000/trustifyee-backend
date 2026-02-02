"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncNiftyOptionsOnly = syncNiftyOptionsOnly;
exports.syncBankNiftyOptionsOnly = syncBankNiftyOptionsOnly;
exports.findSymbolToken = findSymbolToken;
exports.findSymbol = findSymbol;
exports.findNiftyOption = findNiftyOption;
// src/services/InstrumentService.ts
const axios_1 = __importDefault(require("axios"));
const Instrument_1 = __importDefault(require("../models/Instrument"));
const MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";
async function syncNiftyOptionsOnly() {
    const { data } = await axios_1.default.get(MASTER_URL);
    const bulk = data
        .filter(r => r.exch_seg === "NFO" &&
        r.instrumenttype === "OPTIDX" &&
        r.name === "NIFTY" &&
        r.strike &&
        !isNaN(Number(r.strike)))
        .map(r => {
        const lotSizeFromAngel = r.lotsize;
        if (r.name === "NIFTY" && r.instrumenttype === "OPTIDX") {
            console.log("🧪 LOTSIZE CHECK:", {
                symbol: r.symbol,
                lotsize: lotSizeFromAngel,
                type: typeof lotSizeFromAngel
            });
        }
        const rawStrike = Number(r.strike); // e.g. 2550000
        const normalizedStrike = rawStrike / 100; // e.g. 25500
        const lotSize = Number(r.lotsize) || 75; // 🔥 FROM ANGEL DOCS
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
        await Instrument_1.default.bulkWrite(bulk);
    }
}
async function syncBankNiftyOptionsOnly() {
    const { data } = await axios_1.default.get(MASTER_URL);
    const bulk = data
        .filter(r => r.exch_seg === "NFO" &&
        r.instrumenttype === "OPTIDX" &&
        r.name === "BANKNIFTY" &&
        r.strike &&
        !isNaN(Number(r.strike)))
        .map(r => {
        const lotSizeFromAnge = r.lotsize;
        if (r.name === "BANKNIFTY" && r.instrumenttype === "OPTIDX") {
            console.log("🧪 LOTSIZE CHECK:", {
                symbol: r.symbol,
                lotsize: lotSizeFromAnge,
                type: typeof lotSizeFromAnge
            });
        }
        const rawStrike = Number(r.strike);
        const normalizedStrike = rawStrike / 100;
        const lotSize = Number(r.lotsize) || 30; // 🔥 BANKNIFTY LOT
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
        await Instrument_1.default.bulkWrite(bulk);
    }
}
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
async function findSymbolToken(exchange, tradingsymbol) {
    const ex = exchange.toUpperCase();
    const ts = tradingsymbol.toUpperCase();
    const doc = await Instrument_1.default.findOne({
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
async function findSymbol(exchange, tradingsymbol) {
    const ex = exchange.toUpperCase().trim();
    const ts = tradingsymbol.toUpperCase().trim();
    // 1) Exact match
    let doc = await Instrument_1.default.findOne({ exchange: ex, tradingsymbol: ts });
    if (doc)
        return doc;
    // 2) Match by name field
    doc = await Instrument_1.default.findOne({ exchange: ex, name: ts });
    if (doc)
        return doc;
    // 3) Partial match in tradingsymbol
    doc = await Instrument_1.default.findOne({
        exchange: ex,
        tradingsymbol: { $regex: ts, $options: "i" }
    });
    if (doc)
        return doc;
    // 4) Partial match in name
    doc = await Instrument_1.default.findOne({
        exchange: ex,
        name: { $regex: ts, $options: "i" }
    });
    if (doc)
        return doc;
    return null;
}
// 🔥 NIFTY OPTION resolver (STRICT, production-safe)
async function findNiftyOption(params) {
    return await Instrument_1.default.findOne({
        exchange: "NFO",
        instrumenttype: "OPTIDX",
        name: "NIFTY",
        strike: params.strike,
        optiontype: params.optiontype,
        expiry: params.expiry
    }).exec();
}
