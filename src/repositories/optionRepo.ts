// src/repositories/optionRepo.ts
import { OptionContract } from "../models/OptionContract";
import { UpstoxOption } from "../types/UpstoxOptions";

export async function upsertOptions(options: UpstoxOption[]) {
  const ops = options.map(opt => ({
    updateOne: {
      filter: { instrument_key: opt.instrument_key },   // FIXED
      update: {
        $set: {
          instrument_key: opt.instrument_key,
          exchange_token: String(opt.token),
          tradingsymbol: opt.tradingsymbol,
          lot_size: opt.lot_size,
          freeze_quantity: opt.freeze_qty,
          tick_size: opt.tick_size,
          expiry: opt.expiry,
          instrument_type: opt.option_type,
          strike_price: opt.strike,
        }
      },
      upsert: true
    }
  }));

  return OptionContract.bulkWrite(ops, { ordered: false });
}
