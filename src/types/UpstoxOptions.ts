// src/types/UpstoxOptions.ts
// export interface UpstoxOption {
//   name: string;
//   segment: string;
//   exchange: string;
//   expiry: string;
//   weekly: boolean;
//   instrument_key: string;
//   exchange_token: string;
//   trading_symbol: string;
//   tick_size: number;
//   lot_size: number;
//   instrument_type: "CE" | "PE";
//   freeze_quantity: number;
//   underlying_key: string;
//   underlying_type: string;
//   underlying_symbol: string;
//   strike_price: number;
//   minimum_lot: number;
// }
export interface UpstoxOption {
  instrument_key: string;
  token: number;              // REAL instrument_token
  tradingsymbol: string;
  lot_size: number;
  freeze_qty: number;
  tick_size: number;
  expiry: string;
  option_type: "CE" | "PE";
  strike: number;
}


export interface UpstoxOptionsResponse {
  status: string;
  data: UpstoxOption[];
}
