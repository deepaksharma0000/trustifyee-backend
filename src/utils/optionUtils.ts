// src/utils/optionUtils.ts
export function getATMStrike(niftyPrice: number) {
  return Math.round(niftyPrice / 50) * 50;
}

export function getNearestExpiry(dates: Date[]) {
  const now = new Date();
  return dates
    .filter(d => d > now)
    .sort((a, b) => a.getTime() - b.getTime())[0];
}
export function getNearestStrike(
  availableStrikes: number[],
  atm: number
) {
  if (!availableStrikes.length) return atm;

  return availableStrikes.reduce((prev, curr) =>
    Math.abs(curr - atm) < Math.abs(prev - atm) ? curr : prev
  );
}
