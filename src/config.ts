import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 4000,
  nodeEnv: process.env.NODE_ENV || "development",
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/angelone",
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:4000",
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
  angelBaseUrl: process.env.ANGEL_BASE_URL || "https://apiconnect.angelone.in",
  angelSmartStreamUrl:
    process.env.ANGEL_SMART_STREAM_URL || "wss://smartapisocket.angelone.in/smart-stream",
  genPath: process.env.ANGEL_GENERATE_TOKENS_PATH || "/rest/auth/angelbroking/jwt/v1/generateTokens",
  refreshPath: process.env.ANGEL_REFRESH_TOKENS_PATH || "/rest/auth/angelbroking/jwt/v1/generateTokens",
  angelRedirectUrl: process.env.ANGEL_REDIRECT_URL || "http://localhost:3000/api/auth/angel/callback",

  // -------- UPSTOX ----------
  upstoxApiKey: process.env.UPSTOX_API_KEY || "",
  upstoxClientId: process.env.UPSTOX_CLIENT_ID || "",
  upstoxApiSecret: process.env.UPSTOX_API_SECRET || "",
  upstoxRedirectUri: process.env.UPSTOX_REDIRECT_URI || "http://localhost:3000/api/upstox/auth/callback",
  upstoxBaseUrl: process.env.UPSTOX_BASE_URL || "https://api.upstox.com",
  upstoxHftBaseUrl: process.env.UPSTOX_HFT_BASE_URL || "https://api-hft.upstox.com",

  // -------- ZERODHA ----------
  zerodhaApiKey: process.env.ZERODHA_API_KEY || "",
  zerodhaApiSecret: process.env.ZERODHA_API_SECRET || "",
  zerodhaRedirectUri: process.env.ZERODHA_REDIRECT_URI || "http://localhost:4000/api/zerodha/callback",
  zerodhaBaseUrl: process.env.ZERODHA_BASE_URL || "https://api.kite.trade",

  // -------- ALICE BLUE ----------
  aliceClientId: process.env.ALICE_CLIENT_ID || "",
  aliceAppCode: process.env.ALICE_APP_CODE || "",
  aliceApiSecret: process.env.ALICE_API_SECRET || "",
  aliceRedirectUrl: process.env.ALICE_REDIRECT_URL || "http://localhost:3000/api/alice/auth/callback",
  aliceAuthBaseUrl: process.env.ALICE_AUTH_BASE_URL || "https://ant.aliceblueonline.com",
  aliceOrderBaseUrl: process.env.ALICE_ORDER_BASE_URL || "https://a3.aliceblueonline.com",
  alicePlaceOrderPath: process.env.ALICE_PLACE_ORDER_PATH || "/open-api/od/v1/orders/placeorder",
  aliceOrderStatusPath: process.env.ALICE_ORDER_STATUS_PATH || "/open-api/od/v1/orders/book",
  aliceContractMasterNseUrl:
    process.env.ALICE_CM_NSE_URL ||
    "https://v2api.aliceblueonline.com/restpy/static/contract_master/NSE.zip",
  aliceContractMasterNfoUrl:
    process.env.ALICE_CM_NFO_URL ||
    "https://v2api.aliceblueonline.com/restpy/static/contract_master/NFO.zip",
  aliceContractMasterIndicesUrl:
    process.env.ALICE_CM_INDICES_URL ||
    "https://v2api.aliceblueonline.com/restpy/static/contract_master/INDICES.zip",
  aliceGetUserDetailsPath: process.env.ALICE_GET_USER_DETAILS_PATH || "/open-api/od/v1/vendor/getUserDetails",
  aliceContractMasterPath: process.env.ALICE_CONTRACT_MASTER_PATH || "/open-api/market/v1/contractMaster",
  aliceAllowServerExecution: process.env.ALICE_ALLOW_SERVER_EXECUTION !== "false",
  aliceSessionTtlHours: Number(process.env.ALICE_SESSION_TTL_HOURS || 24),
  aliceAutoSyncInstruments: process.env.ALICE_AUTO_SYNC_INSTRUMENTS === "true",
  aliceStartupSyncNfo: process.env.ALICE_STARTUP_SYNC_NFO !== "false",

  encryptionKey: process.env.ENCRYPTION_SECRET || "",
  publicIp: process.env.PUBLIC_IP || "",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:8080",
  executionMode: process.env.EXECUTION_MODE || (
    (process.env.NODE_ENV || "development") === "development" && (
      (process.env.APP_BASE_URL || "").includes("localhost") || 
      (process.env.APP_BASE_URL || "").includes("127.0.0.1") ||
      (process.env.FRONTEND_URL || "").includes("localhost") ||
      (process.env.FRONTEND_URL || "").includes("127.0.0.1") ||
      (process.env.MONGO_URI || "").includes("localhost") ||
      (process.env.MONGO_URI || "").includes("127.0.0.1")
    )
    ? "LOCAL_DEVICE"
    : "SERVER_SHARED_IP"
  ),
  forceSharedVpsRoute: process.env.FORCE_SHARED_VPS_ROUTE !== "false",
  usePlatformAngelApiKey: false, // Per-user SmartAPI keys only — see platformAngelApiKey.ts

  // Dedicated market-data account (isolated from trading users)
  dataClientCode: process.env.DATA_CLIENT_CODE || "",
  dataApiKey: process.env.DATA_API_KEY || "",
  dataPassword: process.env.DATA_PASSWORD || "",
  dataTotpSecret: process.env.DATA_TOTP_SECRET || "",
  /** MongoDB _id of the dedicated market-data User/Admin — never a trading account. */
  systemDataScopeUserId: process.env.SYSTEM_DATA_SCOPE_USER_ID || "",
  agentSecret: process.env.AGENT_SECRET || "default_agent_secret",
  circuitBreakerThreshold: process.env.CIRCUIT_BREAKER_THRESHOLD ? Number(process.env.CIRCUIT_BREAKER_THRESHOLD) : 100,

  // -------- MCP (Model Context Protocol) — see src/mcp/ and docs/MCP_DEPLOYMENT.md ----------
  mcpEnabled: process.env.MCP_ENABLED !== "false",
  mcpApiKey: process.env.MCP_API_KEY || "",
};

// --- STARTUP VALIDATION ---
export const validateConfig = () => {
  const isValidIpv4 = (ip: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
  const envPublicIp = (process.env.PUBLIC_IP || "").trim();
  const envAngelHeaderIp = (process.env.ANGEL_CLIENT_PUBLIC_IP || "").trim();

  const allowedModes = ["USER_ONLY", "SERVER_AUTO", "LOCAL_DEVICE", "SERVER_SHARED_IP", "STATIC_AGENT"];
  if (!allowedModes.includes(config.executionMode)) {
    throw new Error(`FATAL: EXECUTION_MODE must be one of ${allowedModes.join(", ")}`);
  }
  if (!config.encryptionKey) {
    throw new Error("FATAL: ENCRYPTION_SECRET is missing from environment variables.");
  }
  if (config.encryptionKey.length < 32) {
    throw new Error("FATAL: ENCRYPTION_SECRET must be at least 32 characters long for security.");
  }

  if (config.nodeEnv === "production" && !isValidIpv4(config.publicIp || "")) {
    throw new Error("FATAL: PUBLIC_IP must be a valid IPv4 address in production.");
  }

  if (config.nodeEnv === "production" && envAngelHeaderIp && envPublicIp && envAngelHeaderIp !== envPublicIp) {
    throw new Error("FATAL: PUBLIC_IP and ANGEL_CLIENT_PUBLIC_IP must match in production shared routing mode.");
  }

  if (config.nodeEnv === "production" && config.forceSharedVpsRoute !== true) {
    throw new Error("FATAL: FORCE_SHARED_VPS_ROUTE must remain enabled in production.");
  }

  if (config.nodeEnv === "production" && process.env.ALLOW_GLOBAL_ANGEL_API_KEY_FALLBACK === "true") {
    throw new Error("FATAL: ALLOW_GLOBAL_ANGEL_API_KEY_FALLBACK must be false in production.");
  }

  if (config.nodeEnv === "production" && process.env.ALLOW_GLOBAL_SESSION_FALLBACK === "true") {
    throw new Error("FATAL: ALLOW_GLOBAL_SESSION_FALLBACK must be false in production.");
  }

  // ANGEL_API_KEY is optional — not used for user trading or TickEngine (DATA_API_KEY only).

  validateSystemDataIsolation();
};

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/** Fail-fast: market data account must be fully configured and isolated from trading. */
export function validateSystemDataIsolation(): void {
  const missing: string[] = [];
  const dataApiKey = String(config.dataApiKey || "").trim();
  const dataClientCode = String(config.dataClientCode || "").trim();
  const dataScopeUserId = String(config.systemDataScopeUserId || "").trim();

  if (!dataApiKey) missing.push("DATA_API_KEY");
  if (!dataClientCode) missing.push("DATA_CLIENT_CODE");
  if (!dataScopeUserId) missing.push("SYSTEM_DATA_SCOPE_USER_ID");

  if (missing.length > 0) {
    console.error(`FATAL: Market data isolation requires env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  if (dataApiKey.length < 6) {
    console.error("FATAL: DATA_API_KEY must be at least 6 characters (SmartAPI Private Key).");
    process.exit(1);
  }

  if (!OBJECT_ID_RE.test(dataScopeUserId)) {
    console.error("FATAL: SYSTEM_DATA_SCOPE_USER_ID must be a valid 24-character MongoDB ObjectId.");
    process.exit(1);
  }

  console.log("[STARTUP] System Data Isolation Validation Passed", {
    dataClientCode,
    dataScopeUserId,
    dataApiKeyConfigured: true,
  });
}
