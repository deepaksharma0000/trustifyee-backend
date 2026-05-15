import os from "os";
import { config } from "../config";

type AngelNetworkIdentity = {
  localIp: string;
  publicIp: string;
  macAddress: string;
  sourceId: string;
  userType: string;
};

const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

function normalizeIpv4(value?: string) {
  const ip = String(value || "").trim();
  return IPV4_REGEX.test(ip) ? ip : "";
}

function normalizeMac(value?: string) {
  const mac = String(value || "").trim().toLowerCase();
  return MAC_REGEX.test(mac) ? mac : "";
}

function detectLocalIpv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    const list = nets[name] || [];
    for (const net of list) {
      if (!net) continue;
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "";
}

function detectMacAddress() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    const list = nets[name] || [];
    for (const net of list) {
      if (!net) continue;
      const normalized = normalizeMac(net.mac || "");
      if (!normalized) continue;
      if (normalized === "00:00:00:00:00:00") continue;
      return normalized;
    }
  }
  return "";
}

let cachedIdentity: AngelNetworkIdentity | null = null;

export function getAngelNetworkIdentity(): AngelNetworkIdentity {
  if (cachedIdentity) return cachedIdentity;

  const envPublicIp = normalizeIpv4(process.env.ANGEL_CLIENT_PUBLIC_IP);
  const envLocalIp = normalizeIpv4(process.env.ANGEL_CLIENT_LOCAL_IP);
  const envMac = normalizeMac(process.env.ANGEL_CLIENT_MAC_ADDRESS);

  const publicIp = envPublicIp || normalizeIpv4(config.publicIp) || "127.0.0.1";
  const localIp = envLocalIp || normalizeIpv4(detectLocalIpv4()) || publicIp || "127.0.0.1";
  const macAddress = envMac || detectMacAddress() || "02:00:00:00:00:00";
  const sourceId = String(process.env.ANGEL_SOURCE_ID || "WEB").trim() || "WEB";
  const userType = String(process.env.ANGEL_USER_TYPE || "USER").trim() || "USER";

  cachedIdentity = {
    localIp,
    publicIp,
    macAddress,
    sourceId,
    userType,
  };

  return cachedIdentity;
}

