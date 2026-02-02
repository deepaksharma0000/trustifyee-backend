// src/services/optionService.ts
import { upstoxApi } from "../clients/upstoxClient";
import { upsertOptions } from "../repositories/optionRepo";
import { UpstoxOptionsResponse } from "../types/UpstoxOptions";

export async function fetchAndStoreOptionChain(underlying = "NSE_INDEX|Nifty 50") {
  const resp = await upstoxApi.get<UpstoxOptionsResponse>(
    `/option/contract?instrument_key=${encodeURIComponent(underlying)}`
  );

  if (resp.data.status !== "success") {
    throw new Error("Upstox returned non-success status");
  }

  const list = resp.data.data;

  await upsertOptions(list);

  return {
    count: list.length,
    message: "Options updated successfully",
  };
}
