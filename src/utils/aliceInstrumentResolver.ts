import AliceInstrumentModel, { IAliceInstrument } from "../models/AliceInstrument";
import InstrumentModel from "../models/Instrument";
import log from "./logger";

export type AliceInstrumentResolution = {
  found: boolean;
  exchange: string;
  tradingsymbol: string;
  symboltoken: string;
  source: "direct" | "metadata" | "signal_token" | "none";
};

export async function resolveAliceInstrument(
  exchange: string,
  tradingSymbol: string,
  fallbackToken?: string
): Promise<AliceInstrumentResolution> {
  const exchangeUpper = exchange.toUpperCase();
  const notFound: AliceInstrumentResolution = {
    found: false,
    exchange: exchangeUpper,
    tradingsymbol: tradingSymbol,
    symboltoken: "",
    source: "none",
  };

  let doc = await AliceInstrumentModel.findOne({
    exchange: exchangeUpper,
    tradingSymbol: tradingSymbol,
  }).lean<IAliceInstrument>();

  if (!doc) {
    doc = await AliceInstrumentModel.findOne({
      exchange: exchangeUpper,
      tradingSymbol: {
        $regex: new RegExp(
          `^${String(tradingSymbol).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "i"
        ),
      },
    }).lean<IAliceInstrument>();
  }

  if (doc) {
    return {
      found: true,
      exchange: doc.exchange,
      tradingsymbol: doc.tradingSymbol,
      symboltoken: doc.token,
      source: "direct",
    };
  }

  const original = await InstrumentModel.findOne({
    exchange: exchangeUpper,
    tradingsymbol: tradingSymbol,
  }).lean();

  if (original?.strike && original?.expiry) {
    const expDate = new Date(original.expiry);
    const startOfDay = new Date(expDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(expDate);
    endOfDay.setHours(23, 59, 59, 999);

    doc = await AliceInstrumentModel.findOne({
      exchange: exchangeUpper,
      symbol: original.name || original.tradingsymbol.replace(/[0-9].*$/, ""),
      strikePrice: original.strike,
      optionType: original.optiontype,
      expiry: { $gte: startOfDay, $lt: endOfDay },
    }).lean<IAliceInstrument>();

    if (doc) {
      log.debug("[AliceInstrumentResolver] Metadata match", {
        from: tradingSymbol,
        to: doc.tradingSymbol,
      });
      return {
        found: true,
        exchange: doc.exchange,
        tradingsymbol: doc.tradingSymbol,
        symboltoken: doc.token,
        source: "metadata",
      };
    }
  }

  if (fallbackToken) {
    return {
      found: true,
      exchange: exchangeUpper,
      tradingsymbol: tradingSymbol,
      symboltoken: String(fallbackToken),
      source: "signal_token",
    };
  }

  return notFound;
}

export async function countAliceInstruments(exchange?: string): Promise<number> {
  const filter = exchange ? { exchange: exchange.toUpperCase() } : {};
  return AliceInstrumentModel.countDocuments(filter);
}
