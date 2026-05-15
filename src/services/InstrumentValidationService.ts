import InstrumentModel from "../models/Instrument";
import log from "../utils/logger";

type InstrumentValidationInput = {
  exchange: string;
  tradingsymbol: string;
  requestedToken?: string;
  allowExpired?: boolean;
};

export type InstrumentValidationResult = {
  valid: boolean;
  reason?: string;
  exchange: string;
  tradingsymbol: string;
  symboltoken?: string;
  correctedToken?: string;
  cacheKey: string;
  metadata?: {
    underlying?: string;
    expiry?: string;
    strike?: number;
    optionType?: "CE" | "PE";
  };
};

type CachedResult = {
  expiresAt: number;
  result: InstrumentValidationResult;
};

const CACHE_TTL_MS = 60_000;
const validationCache = new Map<string, CachedResult>();

const MONTH_MAP: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

const OPTION_SYMBOL_REGEX = /^([A-Z]+)(\d{2})([A-Z]{3})(\d{2})(\d+)(CE|PE)$/;

function normalize(value?: string) {
  return String(value || "").trim().toUpperCase();
}

function parseOptionSymbol(tradingsymbol: string) {
  const ts = normalize(tradingsymbol);
  const match = ts.match(OPTION_SYMBOL_REGEX);
  if (!match) return null;

  const [, underlying, dd, mmm, yy, strikeRaw, opt] = match;
  const month = MONTH_MAP[mmm];
  if (month === undefined) return null;

  const day = Number(dd);
  const year = 2000 + Number(yy);
  const strike = Number(strikeRaw);
  if (!day || !year || !strike) return null;

  const expiry = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  if (Number.isNaN(expiry.getTime())) return null;

  return {
    underlying,
    expiry,
    strike,
    optionType: opt as "CE" | "PE",
  };
}

function toIstDayStart(date: Date) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  return new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
}

function buildCacheKey(exchange: string, tradingsymbol: string) {
  const parsed = parseOptionSymbol(tradingsymbol);
  if (parsed) {
    const expiryStr = parsed.expiry.toISOString().slice(0, 10);
    return `${normalize(exchange)}|${parsed.underlying}|${expiryStr}|${parsed.strike}|${parsed.optionType}`;
  }
  return `${normalize(exchange)}|SYMBOL|${normalize(tradingsymbol)}`;
}

export function clearInstrumentValidationCache() {
  validationCache.clear();
}

export async function validateInstrumentFromMaster(
  input: InstrumentValidationInput
): Promise<InstrumentValidationResult> {
  const exchange = normalize(input.exchange);
  const tradingsymbol = normalize(input.tradingsymbol);
  const requestedToken = normalize(input.requestedToken);
  const allowExpired = Boolean(input.allowExpired);
  const cacheKey = buildCacheKey(exchange, tradingsymbol);
  const now = Date.now();

  const cached = validationCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const parsed = parseOptionSymbol(tradingsymbol);
  const parsedMeta = parsed
    ? {
        underlying: parsed.underlying,
        expiry: parsed.expiry.toISOString().slice(0, 10),
        strike: parsed.strike,
        optionType: parsed.optionType,
      }
    : undefined;

  const instrument = await InstrumentModel.findOne({
    exchange,
    tradingsymbol,
  })
    .select("symboltoken expiry")
    .lean() as any;

  if (!instrument?.symboltoken) {
    if (parsed && !allowExpired) {
      const today = toIstDayStart(new Date());
      const expiryDay = toIstDayStart(parsed.expiry);
      if (expiryDay.getTime() < today.getTime()) {
        const expiredResult: InstrumentValidationResult = {
          valid: false,
          reason: "EXPIRED_OPTION_CONTRACT",
          exchange,
          tradingsymbol,
          cacheKey,
          metadata: parsedMeta,
        };
        validationCache.set(cacheKey, {
          expiresAt: now + CACHE_TTL_MS,
          result: expiredResult,
        });
        return expiredResult;
      }
    }

    const missingResult: InstrumentValidationResult = {
      valid: false,
      reason: "SYMBOL_NOT_FOUND_IN_MASTER",
      exchange,
      tradingsymbol,
      cacheKey,
      metadata: parsedMeta,
    };
    validationCache.set(cacheKey, {
      expiresAt: now + CACHE_TTL_MS,
      result: missingResult,
    });
    return missingResult;
  }

  if (!allowExpired && instrument.expiry) {
    const expiryDay = toIstDayStart(new Date(instrument.expiry));
    const today = toIstDayStart(new Date());
    if (expiryDay.getTime() < today.getTime()) {
      const expiredResult: InstrumentValidationResult = {
        valid: false,
        reason: "EXPIRED_OPTION_CONTRACT",
        exchange,
        tradingsymbol,
        symboltoken: String(instrument.symboltoken),
        cacheKey,
        metadata: parsedMeta,
      };
      validationCache.set(cacheKey, {
        expiresAt: now + CACHE_TTL_MS,
        result: expiredResult,
      });
      return expiredResult;
    }
  }

  const masterToken = normalize(instrument.symboltoken);
  const correctedToken =
    requestedToken && requestedToken !== masterToken ? masterToken : undefined;

  if (correctedToken) {
    log.warn("[INSTRUMENT_VALIDATION_TOKEN_CORRECTED]", {
      exchange,
      tradingsymbol,
      requestedToken,
      masterToken,
    });
  }

  const okResult: InstrumentValidationResult = {
    valid: true,
    exchange,
    tradingsymbol,
    symboltoken: masterToken,
    correctedToken,
    cacheKey,
    metadata: parsedMeta,
  };

  validationCache.set(cacheKey, {
    expiresAt: now + CACHE_TTL_MS,
    result: okResult,
  });

  return okResult;
}

