// src/services/OptionUtils.ts

/**
 * NIFTY / FINNIFTY ke liye ATM strike nikalta hai
 * Example:
 *  price = 25208 → 25200
 */
export function getATMStrike(price: number, step = 50): number {
  if (!price || price <= 0) {
    throw new Error("Invalid index price for ATM calculation");
  }

  return Math.round(price / step) * step;
}
