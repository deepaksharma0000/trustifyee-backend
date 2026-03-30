// src/utils/optionUtils.ts
export function getATMStrike(niftyPrice: number) {
  return Math.round(niftyPrice / 50) * 50;
}

import moment from "moment-timezone";

export function getNearestExpiry(dates: Date[]) {
  const now = moment().tz("Asia/Kolkata");
  const todayStr = now.format("YYYY-MM-DD");
  const isPastMarketClose = now.hours() > 15 || (now.hours() === 15 && now.minutes() >= 30);

  const sortedExpiries = dates
    .map(d => moment(d).tz("Asia/Kolkata").format("YYYY-MM-DD"))
    .filter((value, index, self) => self.indexOf(value) === index) // unique
    .sort();

  for (const expiryStr of sortedExpiries) {
    if (expiryStr > todayStr) {
      return moment.tz(expiryStr, "Asia/Kolkata").toDate();
    }
    if (expiryStr === todayStr && !isPastMarketClose) {
      return moment.tz(expiryStr, "Asia/Kolkata").toDate();
    }
  }

  return dates.length > 0 ? dates[0] : undefined;
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
