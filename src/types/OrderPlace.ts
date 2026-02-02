export interface PlaceOrderInput {
  instrument_key: string;
  quantity: number;
  price?: number; // limit orders only
  order_type: "MARKET" | "LIMIT";
  transaction_type: "BUY" | "SELL";
  product: "I" | "D" | "M" | "CNC"; // Intraday, Delivery, etc.
  validity: "DAY" | "IOC";
}
