import axios from "axios";

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
  const res = await axios.post(
    "http://localhost:4000/api/orders/place",
    payload
  );

  return res.data; // { ok, resp }
};

// ✅ ye function alag hi rahega
export const checkAngelOrderStatus = async (
  clientcode: string,
  orderid: string
): Promise<boolean> => {
  const res = await axios.get(
    `http://localhost:4000/api/orders/status/${clientcode}/${orderid}`
  );

  return res.data === true;
};
