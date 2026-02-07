import axios from "axios";
import { config } from "../config";

interface PlaceOrderPayload {
  clientcode: string;
  tradingsymbol: string;
  exchange: string;
  side: "BUY" | "SELL";
  quantity: number;
  ordertype: "MARKET";
}

export const placeAngelOrder = async (
  payload: PlaceOrderPayload
) => {
  if (!config.appBaseUrl) {
    throw new Error("APP_BASE_URL is not set");
  }
  const res = await axios.post(
    `${config.appBaseUrl}/api/orders/place`,
    payload
  );

  return res.data; // { ok, resp }
};

// ✅ ye function alag hi rahega
export const checkAngelOrderStatus = async (
  clientcode: string,
  orderid: string
): Promise<boolean> => {
  if (!config.appBaseUrl) {
    throw new Error("APP_BASE_URL is not set");
  }
  const res = await axios.get(
    `${config.appBaseUrl}/api/orders/status/${clientcode}/${orderid}`
  );

  return res.data === true;
};
