import axios from "axios";
import { config } from "../config";

interface PlaceOrderPayload {
  clientcode: string;
  tradingsymbol: string;
  exchange: string;
  side: "BUY" | "SELL";
  quantity: number;
  ordertype: "MARKET";
  variety?: string;
  producttype?: string;
}

export const placeAngelOrder = async (
  payload: PlaceOrderPayload
) => {
  if (!config.appBaseUrl) {
    throw new Error("APP_BASE_URL is not set");
  }
  const res = await axios.post(
    `${config.appBaseUrl}/api/orders/place`,
    payload,
    {
      headers: {
        'x-system-secret': 'INTERNAL_JOB_SECRET'
      }
    }
  );

  return res.data; // { ok, resp }
};

export const closeAngelOrder = async (
  clientcode: string,
  orderid: string
) => {
  if (!config.appBaseUrl) {
    throw new Error("APP_BASE_URL is not set");
  }
  const res = await axios.post(
    `${config.appBaseUrl}/api/orders/close`,
    { clientcode, orderid },
    {
      headers: {
        'x-system-secret': 'INTERNAL_JOB_SECRET'
      }
    }
  );

  return res.data;
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
    `${config.appBaseUrl}/api/orders/status/${clientcode}/${orderid}`,
    {
      headers: {
        'x-system-secret': 'INTERNAL_JOB_SECRET'
      }
    }
  );

  return res.data === true;
};
