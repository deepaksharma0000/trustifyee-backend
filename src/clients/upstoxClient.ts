// src/clients/upstoxClient.ts
import axios from "axios";


const BASE = "https://api.upstox.com/v2";

// Helper to create client with specific token
export const createUpstoxClient = (accessToken: string) => {
  return axios.create({
    baseURL: BASE,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    timeout: 10_000,
  });
};

// Legacy instance - uses env var if available, but doesn't crash if missing
const ENV_TOKEN = process.env.UPSTOX_TOKEN || "";

export const upstoxApi = axios.create({
  baseURL: BASE,
  headers: {
    ...(ENV_TOKEN ? { "Authorization": `Bearer ${ENV_TOKEN}` } : {}),
    "Content-Type": "application/json"
  },
  timeout: 10_000,
});

export async function placeUpstoxOrder(payload: any, accessToken?: string) {
  try {
    const token = accessToken || ENV_TOKEN;

    if (!token) {
      throw new Error("No Upstox Access Token provided (env UPSTOX_TOKEN missing and no dynamic token passed)");
    }

    const client = accessToken ? createUpstoxClient(accessToken) : upstoxApi;
    const resp = await client.post("/order/place", payload);
    return resp.data;
  } catch (err: any) {
    console.error(
      "UPSTOX ORDER ERROR:",
      JSON.stringify(err.response?.data || err.message, null, 2)
    );
    throw err;
  }
}
