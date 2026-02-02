import axios from "axios";

/**
 * Abhi DB ya mock API se LTP
 * later AngelOne live feed laga sakte ho
 */
export const getLTP = async (tradingsymbol: string): Promise<number> => {
  const res = await axios.get(
    `http://localhost:4000/api/ltp/${tradingsymbol}`
  );

  return res.data.ltp;
};
