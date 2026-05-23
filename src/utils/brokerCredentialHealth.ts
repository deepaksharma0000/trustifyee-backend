import { decrypt, encrypt } from "./encryption";
import log from "./logger";

const MASKED_VALUE_REGEX = /^(\*+|.{1,8}\.\.\.|enc::.+)$/i;

export const cleanCredentialInput = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const clean = value.trim();
  return MASKED_VALUE_REGEX.test(clean) ? "" : clean;
};

export const resolveClientCodeInput = (body: any): string =>
  (
    cleanCredentialInput(body?.client_code) ||
    cleanCredentialInput(body?.client_key) ||
    cleanCredentialInput(body?.clientCode) ||
    cleanCredentialInput(body?.clientcode)
  ).toUpperCase();

export const assertEncryptedRoundTrip = (field: string, plainValue: string, encryptedValue: string) => {
  if (!plainValue || !encryptedValue || encryptedValue.trim().length < 16) {
    throw new Error(`${field} encryption failed or returned empty`);
  }

  const decrypted = decrypt(encryptedValue, `${field}_round_trip`);
  if (decrypted !== plainValue) {
    throw new Error(`${field} encryption round-trip validation failed`);
  }
};

export const encryptRequiredCredential = (field: string, plainValue: string): string => {
  const clean = cleanCredentialInput(plainValue);
  if (!clean) {
    throw new Error(`${field} is required and cannot be empty or masked`);
  }

  const encrypted = encrypt(clean);
  assertEncryptedRoundTrip(field, clean, encrypted);
  return encrypted;
};

export type BrokerCredentialHealth = {
  ok: boolean;
  missing: string[];
  decrypted: {
    clientCode: string;
    password: string;
    totpSecret: string;
    apiKey: string;
  };
};

export const evaluateBrokerCredentialHealth = (profile: any, context: string): BrokerCredentialHealth => {
  const clientCode = profile?.client_key ? decrypt(profile.client_key, `${context}_client_key`) : "";
  const password = profile?.broker_password ? decrypt(profile.broker_password, `${context}_password`) : "";
  const totpSecret = profile?.broker_totp_secret ? decrypt(profile.broker_totp_secret, `${context}_totp_secret`) : "";
  const apiKey = profile?.api_key ? decrypt(profile.api_key, `${context}_api_key`) : "";

  const missing: string[] = [];
  if (!String(profile?.broker || "").trim()) missing.push("broker");
  if (!clientCode) missing.push("client_key");
  if (!password) missing.push("broker_password");
  if (!totpSecret) missing.push("broker_totp_secret");
  if (!apiKey) missing.push("api_key");

  log.info("[BROKER_CREDENTIAL_HEALTH]", {
    context,
    userId: String(profile?._id || ""),
    broker: profile?.broker || null,
    brokerConnected: Boolean(profile?.broker_connected),
    brokerVerified: Boolean(profile?.broker_verified),
    hasClientKey: Boolean(profile?.client_key),
    clientKeyEncryptedLength: String(profile?.client_key || "").length,
    clientCodeResolved: Boolean(clientCode),
    hasPassword: Boolean(profile?.broker_password),
    passwordResolved: Boolean(password),
    hasTotpSecret: Boolean(profile?.broker_totp_secret),
    totpResolved: Boolean(totpSecret),
    hasApiKey: Boolean(profile?.api_key),
    apiKeyResolved: Boolean(apiKey),
    missing,
  });

  return {
    ok: missing.length === 0,
    missing,
    decrypted: {
      clientCode,
      password,
      totpSecret,
      apiKey,
    },
  };
};
