import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 3000,
  nodeEnv: process.env.NODE_ENV || "development",
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/angelone",
  appBaseUrl: process.env.APP_BASE_URL || "",
  corsOrigins: (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  fallbackNiftyLtp: process.env.FALLBACK_NIFTY_LTP ? Number(process.env.FALLBACK_NIFTY_LTP) : 0,
  fallbackBankNiftyLtp: process.env.FALLBACK_BANKNIFTY_LTP ? Number(process.env.FALLBACK_BANKNIFTY_LTP) : 0,
  fallbackFinNiftyLtp: process.env.FALLBACK_FINNIFTY_LTP ? Number(process.env.FALLBACK_FINNIFTY_LTP) : 0,
  disableLiveLtp: process.env.DISABLE_LIVE_LTP === "true",

  angelIndexSymbolNifty: process.env.ANGEL_INDEX_SYMBOL_NIFTY || "NIFTY 50",
  angelIndexSymbolBankNifty: process.env.ANGEL_INDEX_SYMBOL_BANKNIFTY || "NIFTY BANK",
  angelIndexSymbolFinNifty: process.env.ANGEL_INDEX_SYMBOL_FINNIFTY || "NIFTY FIN SERVICE",
  angelIndexTokenNifty: process.env.ANGEL_INDEX_TOKEN_NIFTY || "99926000",
  angelIndexTokenBankNifty: process.env.ANGEL_INDEX_TOKEN_BANKNIFTY || "99926001",
  angelIndexTokenFinNifty: process.env.ANGEL_INDEX_TOKEN_FINNIFTY || "99926037",

  // -------- ANGEL ONE ----------
  angelApiKey: process.env.ANGEL_API_KEY || "",
  angelBaseUrl: process.env.ANGEL_BASE_URL || "https://smartapi.angelbroking.com",
  genPath: process.env.ANGEL_GENERATE_TOKENS_PATH || "/rest/auth/angelbroking/jwt/v1/generateTokens",
  refreshPath: process.env.ANGEL_REFRESH_TOKENS_PATH || "/rest/auth/angelbroking/jwt/v1/refreshToken",

  // -------- UPSTOX ----------
  upstoxApiKey: process.env.UPSTOX_API_KEY || "",
  upstoxClientId: process.env.UPSTOX_CLIENT_ID || "",
  upstoxApiSecret: process.env.UPSTOX_API_SECRET || "",
  upstoxRedirectUri: process.env.UPSTOX_REDIRECT_URI || "http://localhost:3000/api/upstox/auth/callback",
  upstoxBaseUrl: process.env.UPSTOX_BASE_URL || "https://api.upstox.com",
  upstoxHftBaseUrl: process.env.UPSTOX_HFT_BASE_URL || "https://api-hft.upstox.com",


  // -------- ALICE BLUE ----------

  // -------- ALICE BLUE ----------

  // Trading login / internal client code agar kahin use kar rahe ho
  aliceClientId: process.env.ALICE_CLIENT_ID || "",
  // Developer Portal se
  aliceAppCode: process.env.ALICE_APP_CODE || "",
  aliceApiSecret: process.env.ALICE_API_SECRET || "",
  aliceRedirectUrl:
    process.env.ALICE_REDIRECT_URL || "http://localhost:3000/api/alice/auth/callback",

  aliceAuthBaseUrl:
    process.env.ALICE_AUTH_BASE_URL || "https://ant.aliceblueonline.com",

  aliceOrderBaseUrl:
    process.env.ALICE_ORDER_BASE_URL || "https://a3.aliceblueonline.com",

  alicePlaceOrderPath:
    process.env.ALICE_PLACE_ORDER_PATH || "/open-api/od/v1/orders/place",

  aliceOrderStatusPath:
    process.env.ALICE_ORDER_STATUS_PATH || "/open-api/od/v1/orders/book",

  aliceContractMasterNseUrl:
    process.env.ALICE_CM_NSE_URL || "",

  aliceContractMasterNfoUrl:
    process.env.ALICE_CM_NFO_URL || "",

  aliceContractMasterIndicesUrl:
    process.env.ALICE_CM_INDICES_URL || "",

  aliceGetUserDetailsPath:
    process.env.ALICE_GET_USER_DETAILS_PATH ||
    "/open-api/od/v1/vendor/getUserDetails",

  aliceContractMasterPath:
    process.env.ALICE_CONTRACT_MASTER_PATH || "/open-api/market/v1/contractMaster",

  encryptionKey: process.env.ENCRYPTION_SECRET || "",
};
