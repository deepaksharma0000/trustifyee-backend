// src/services/optionService.ts
import { upstoxApi, createUpstoxClient } from "../clients/upstoxClient";
import { upsertOptions } from "../repositories/optionRepo";
import { UpstoxOptionsResponse } from "../types/UpstoxOptions";

export async function fetchAndStoreOptionChain(underlying = "NSE_INDEX|Nifty 50", accessToken?: string) {
  const client = accessToken ? createUpstoxClient(accessToken) : upstoxApi;

  // If using default client and no env token, this might fail with 401, which is expected if not configured.
  const resp = await client.get<UpstoxOptionsResponse>(
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
