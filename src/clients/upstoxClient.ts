// src/clients/upstoxClient.ts
import axios from "axios";

const BASE = "https://api.upstox.com/v2";
const TOKEN = process.env.UPSTOX_TOKEN!;

export const upstoxApi = axios.create({
  baseURL: BASE,
  headers: {
    "Authorization": `Bearer ${TOKEN}`,
    "Content-Type": "application/json"
  },
  timeout: 10_000,
});

export async function placeUpstoxOrder(payload: any) {
  try {
    const resp = await upstoxApi.post("/order/place", payload);
    return resp.data;
  } catch (err: any) {
    // console.error("UPSTOX ORDER ERROR:", err.response?.data || err);
    console.error(
  "UPSTOX ORDER ERROR:",
  JSON.stringify(err.response?.data, null, 2)
);
    throw err;
  }
}
