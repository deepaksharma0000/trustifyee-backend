export type ParsedAliceResponse = {
  success: boolean;
  accepted: boolean;
  rejected: boolean;
  brokerOrderId?: string;
  uniqueOrderId?: string;
  rejectionReason?: string;
  brokerMessage: string;
  errorCode?: string;
  data: any;
  rawResponse: any;
};

const ACCEPTED_STATES = new Set([
  "OPEN",
  "COMPLETE",
  "COMPLETED",
  "FILLED",
  "PARTIALLY FILLED",
  "PENDING",
  "TRIGGER PENDING",
  "PUT ORDER REQ RECEIVED",
  "VALIDATION PENDING",
]);

const REJECTED_STATES = new Set(["REJECTED", "CANCELLED", "CANCELED", "FAILED", "ERROR"]);

function bodyOf(response: any) {
  if (!response) return {};
  if (response?.data && typeof response.data === "object") return response.data;
  return response;
}

export function parseAliceOrderPlacement(response: any): ParsedAliceResponse {
  const body = bodyOf(response);
  const statusRaw = String(body?.status || body?.stat || "").trim();
  const statusLower = statusRaw.toLowerCase();
  const message = String(body?.message || body?.emsg || "").trim();

  const resultRow = Array.isArray(body?.result)
    ? body.result[0]
    : Array.isArray(body?.data)
    ? body.data[0]
    : body?.result || body?.data || body;

  const brokerOrderId = String(
    resultRow?.brokerOrderId ||
      resultRow?.orderNo ||
      resultRow?.NOrdNo ||
      resultRow?.orderid ||
      body?.brokerOrderId ||
      ""
  ).trim();

  const legacyOk = statusLower === "ok" || body?.stat === "Ok";
  const rejected =
    statusLower === "not_ok" ||
    body?.stat === "Not_ok" ||
    Boolean(message && /fail|error|reject|invalid/i.test(message) && !legacyOk);

  const accepted = !rejected && (legacyOk || Boolean(brokerOrderId));

  return {
    success: accepted,
    accepted,
    rejected,
    brokerOrderId: brokerOrderId || undefined,
    rejectionReason: rejected ? message || "Alice Blue rejected order" : undefined,
    brokerMessage: message,
    data: resultRow || body,
    rawResponse: body,
  };
}

export function parseAliceOrderBook(response: any): any[] {
  const body = bodyOf(response);
  if (Array.isArray(body?.result)) return body.result;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body)) return body;
  return [];
}

export function findAliceOrderInBook(response: any, orderId: string, symbolMatch?: string) {
  const rows = parseAliceOrderBook(response);
  const id = String(orderId || "").trim();
  if (!id && !symbolMatch) return null;

  let order = rows.find(
    (row: any) =>
      String(row?.brokerOrderId || row?.orderNo || row?.orderid || "") === id
  );

  if (!order && symbolMatch) {
    order = [...rows].reverse().find(
      (row: any) =>
        String(row?.tradingSymbol || row?.tradingsymbol || row?.formattedInstrumentName || "")
          .toUpperCase()
          .includes(String(symbolMatch).toUpperCase())
    );
  }

  if (!order) return null;

  const orderStatus = String(
    rowStatus(order) || "PENDING"
  ).trim();

  return {
    orderid: String(order?.brokerOrderId || order?.orderNo || order?.orderid || id),
    orderstatus: orderStatus,
    status: orderStatus,
    tradingsymbol: order?.tradingSymbol || order?.tradingsymbol || order?.formattedInstrumentName,
    text: order?.rejectReason || order?.message || order?.statusMessage || "",
    ...order,
  };
}

function rowStatus(row: any): string {
  return String(
    row?.orderStatus ||
      row?.status ||
      row?.orderstatus ||
      ""
  )
    .trim()
    .toUpperCase();
}

export function isAcceptedAliceOrderState(value: any): boolean {
  return ACCEPTED_STATES.has(String(value || "").trim().toUpperCase());
}

export function isRejectedAliceOrderState(value: any): boolean {
  return REJECTED_STATES.has(String(value || "").trim().toUpperCase());
}
