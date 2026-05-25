export function normalizeFiniteNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function isPlausibleLtp(exchange: string, ltp: number): boolean {
  if (!Number.isFinite(ltp) || ltp <= 0) return false;

  const ex = String(exchange || "").toUpperCase();
  if (ex === "NFO" || ex === "BFO" || ex === "NSE_FO" || ex === "BSE_FO") {
    return ltp < 100000;
  }

  return ltp < 1000000;
}
