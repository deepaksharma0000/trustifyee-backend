import https from "https";

/**
 * Force IPv4 for outbound HTTPS requests.
 * This is critical for brokers like AngelOne that only whitelist IPv4 addresses.
 */
export const ipv4Agent = new https.Agent({
  family: 4,
  keepAlive: true,
  timeout: 10000
});
