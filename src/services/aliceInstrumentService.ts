// src/services/aliceInstrumentService.ts
import AliceTokensModel, { IAliceTokens } from "../models/AliceTokens";
import AliceInstrumentModel, { IAliceInstrument } from "../models/AliceInstrument";
import { AliceBlueAdapter } from "../adapters/AliceBlueAdapter";
import { log } from "../utils/logger";

const aliceAdapter = new AliceBlueAdapter();

interface ContractMasterRow {
  exch: string;                     // "NFO"
  exchange_segment?: string;        // "nse_fo"
  expiry_date?: number | string;    // 1769472000000
  formatted_ins_name?: string;      // "VBL JAN26 465 PE"
  instrument_type?: string;         // "OPTSTK"
  lot_size?: string | number;       // "1125"
  option_type?: string;             // "CE"/"PE"
  pdc?: any;
  strike_price?: string | number;   // "465"
  symbol: string;                   // "VBL"
  tick_size?: string | number;      // "0.05"
  token: string;                    // "153502"
  trading_symbol: string;           // "VBL27JAN26P465"
}


export class AliceInstrumentService {
  private static async getSessionId(clientcode: string): Promise<string> {
    const doc = await AliceTokensModel.findOne({ clientcode }).lean<IAliceTokens>();
    if (!doc || !doc.sessionId) {
      throw new Error(`No Alice sessionId found for clientcode=${clientcode}`);
    }
    return doc.sessionId;
  }

  static async syncExchangeInstruments(params: {
    clientcode: string;      // e.g. "LALIT_ALICE"
    exchange: string;        // "NSE" | "NFO" | "MCX" etc.
  }) {
    const { clientcode, exchange } = params;

    // const sessionId = await this.getSessionId(clientcode);
         await this.getSessionId(clientcode); 
         
     const raw = await aliceAdapter.getContractMasterForExchange(exchange);

if (!Array.isArray(raw)) {
  throw new Error("Contract master adapter did not return an array");
}

console.log("Alice contract master raw response ===>");
console.log(JSON.stringify(raw.slice(0, 3), null, 2));

// 🔹 unwrap: agar raw[0] khud ek array hai, use hi rows maan lo
let rowsAny: any[] = raw;

if (Array.isArray(raw[0])) {
  rowsAny = raw[0] as any[];
}

const rows = rowsAny as ContractMasterRow[];

let inserted = 0;
let skipped = 0;

for (const r of rows) {
  // 1) Invalid / non-object rows skip
  if (!r || typeof r !== "object") {
    skipped++;
    continue;
  }

  const row = r as ContractMasterRow;

  // 2) minimal required fields check
  if (!row.exch || !row.token || !row.trading_symbol || !row.symbol) {
    skipped++;
    continue;
  }

  // 3) expiry convert (ms -> Date)
  let expiry: Date | null = null;
  if (row.expiry_date !== undefined && row.expiry_date !== null) {
    const ms =
      typeof row.expiry_date === "string"
        ? Number(row.expiry_date)
        : row.expiry_date;
    if (!Number.isNaN(ms) && ms > 0) {
      expiry = new Date(ms);
    }
  }

  // 4) numeric fields
  const strike =
    row.strike_price !== undefined && row.strike_price !== null
      ? Number(row.strike_price)
      : null;

  const lotSize =
    row.lot_size !== undefined && row.lot_size !== null
      ? Number(row.lot_size)
      : null;

  await AliceInstrumentModel.updateOne(
    { exchange: row.exch, token: row.token },
    {
      $set: {
        exchange: row.exch,
        token: row.token,
        tradingSymbol: row.trading_symbol,
        symbol: row.symbol,
        instrumentType: row.instrument_type ?? null,
        expiry,
        strikePrice: strike,
        lotSize,
        segment: row.exchange_segment ?? null,
        underlyingSymbol: row.symbol,
        raw: row
      }
    },
    { upsert: true }
  );

  inserted++;
}

log.info(
  `Alice contract master processed for ${exchange}: inserted/updated=${inserted}, skipped=${skipped}`
);

return { exchange, count: inserted, skipped };
  }
}
