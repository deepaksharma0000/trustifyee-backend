// src/services/lookupService.ts
import { OptionContract } from "../models/OptionContract";

export async function findByInstrumentKey(key: string) {
  return OptionContract.findOne({ instrument_key: key }).lean();
}
