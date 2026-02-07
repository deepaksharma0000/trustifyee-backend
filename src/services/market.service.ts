import axios from "axios";
import { config } from "../config";

/**
 * Abhi DB ya mock API se LTP
 * later AngelOne live feed laga sakte ho
 */
export const getLTP = async (tradingsymbol: string): Promise<number> => {
  if (!config.appBaseUrl) {
    throw new Error("APP_BASE_URL is not set");
  }
  const res = await axios.get(
    `${config.appBaseUrl}/api/ltp/${tradingsymbol}`
  );

  return res.data.ltp;
};
