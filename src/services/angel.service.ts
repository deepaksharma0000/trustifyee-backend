import axios from "axios";
import log from "../utils/logger";
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

const systemHeaders = {
  "x-system-secret": "INTERNAL_JOB_SECRET",
};

function ensureAppBaseUrl() {
  if (!config.appBaseUrl) {
    throw new Error("APP_BASE_URL is not set");
  }
}

export const placeAngelOrder = async (payload: PlaceOrderPayload) => {
  ensureAppBaseUrl();
  try {
    const res = await axios.post(`${config.appBaseUrl}/api/orders/place`, payload, {
      headers: systemHeaders,
      timeout: 15000,
    });

    return res.data;
  } catch (error: any) {
    log.error("[angel.service] placeAngelOrder failed", {
      message: error?.message,
      status: error?.response?.status,
      data: error?.response?.data,
      tradingsymbol: payload.tradingsymbol,
      clientcode: payload.clientcode,
    });
    throw error;
  }
};

export const closeAngelOrder = async (clientcode: string, orderid: string) => {
  ensureAppBaseUrl();

  try {
    const res = await axios.post(
      `${config.appBaseUrl}/api/orders/close`,
      { clientcode, orderid },
      {
        headers: systemHeaders,
        timeout: 15000,
      }
    );

    return res.data;
  } catch (error: any) {
    log.error("[angel.service] closeAngelOrder failed", {
      message: error?.message,
      status: error?.response?.status,
      data: error?.response?.data,
      clientcode,
      orderid,
    });
    throw error;
  }
};

export const checkAngelOrderStatus = async (
  clientcode: string,
  orderid: string
): Promise<boolean> => {
  ensureAppBaseUrl();

  try {
    const res = await axios.get(`${config.appBaseUrl}/api/orders/status/${clientcode}/${orderid}`, {
      headers: systemHeaders,
      timeout: 15000,
    });

    return res.data === true;
  } catch (error: any) {
    log.error("[angel.service] checkAngelOrderStatus failed", {
      message: error?.message,
      status: error?.response?.status,
      data: error?.response?.data,
      clientcode,
      orderid,
    });
    throw error;
  }
};
