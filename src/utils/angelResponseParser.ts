export type ParsedAngelResponse = {
  success: boolean;
  accepted: boolean;
  rejected: boolean;
  brokerOrderId?: string;
  uniqueOrderId?: string;
  rejectionReason?: string;
  brokerMessage: string;
  errorCode: string;
  data: any;
  rawResponse: any;
};

const ACCEPTED_ORDER_STATES = new Set([
  "NEW",
  "PENDING",
  "OPEN",
  "ACCEPTED",
  "COMPLETE",
  "COMPLETED",
  "FILLED",
  "PARTIALLY FILLED",
  "TRIGGER PENDING",
  "EXECUTED",
]);

const REJECTED_ORDER_STATES = new Set([
  "REJECTED",
  "CANCELLED",
  "CANCELED",
  "FAILED",
  "ERROR",
]);

function responseBody(response: any) {
  return response?.data && typeof response.data === "object" && !Buffer.isBuffer(response.data)
    ? response.data
    : response || {};
}

function normalizeSuccess(value: any): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "success", "ok"].includes(normalized)) return true;
    if (["false", "failed", "error", "rejected"].includes(normalized)) return false;
  }
  if (typeof value === "number") return value === 1;
  return undefined;
}

export function normalizeAngelOrderState(value: any): string {
  return String(value || "").trim().toUpperCase();
}

export function isAcceptedAngelOrderState(value: any): boolean {
  return ACCEPTED_ORDER_STATES.has(normalizeAngelOrderState(value));
}

export function isRejectedAngelOrderState(value: any): boolean {
  return REJECTED_ORDER_STATES.has(normalizeAngelOrderState(value));
}

export function parseAngelResponse(response: any): ParsedAngelResponse {
  const body = responseBody(response);
  const data = body?.data ?? null;
  const orderState = normalizeAngelOrderState(
    body?.status ||
      body?.orderstatus ||
      body?.orderStatus ||
      data?.status ||
      data?.orderstatus ||
      data?.orderStatus
  );
  const statusValue = normalizeSuccess(body?.status ?? body?.orderstatus ?? data?.status ?? data?.orderstatus);
  const successValue = normalizeSuccess(body?.success);
  const stateIndicatesAcceptance = isAcceptedAngelOrderState(orderState);
  const stateIndicatesRejection = isRejectedAngelOrderState(orderState);
  const success = successValue ?? statusValue ?? (stateIndicatesAcceptance ? true : stateIndicatesRejection ? false : false);
  const brokerMessage = String(
    body?.brokerMessage ||
      body?.message ||
      body?.emsg ||
      body?.text ||
      body?.statusmessage ||
      data?.brokerMessage ||
      data?.message ||
      data?.emsg ||
      data?.text ||
      data?.statusmessage ||
      ""
  ).trim();
  const errorCode = String(body?.errorCode || body?.errorcode || body?.error_code || data?.errorCode || data?.errorcode || "").trim();
  const brokerOrderId = String(data?.orderid || data?.orderId || body?.orderid || body?.orderId || "").trim() || undefined;
  const uniqueOrderId = String(data?.uniqueorderid || data?.uniqueOrderId || body?.uniqueorderid || body?.uniqueOrderId || "").trim() || undefined;

  const rejectionReason = String(
    body?.rejectionReason ||
      body?.rejectreason ||
      data?.rejectionReason ||
      data?.rejectreason ||
      body?.text ||
      data?.text ||
      body?.statusmessage ||
      data?.statusmessage ||
      data?.text ||
      brokerMessage ||
      errorCode ||
      "Broker rejected request"
  ).trim();

  const hasOrderReference = Boolean(brokerOrderId || uniqueOrderId);
  const rejected = Boolean(
    success === false ||
      stateIndicatesRejection ||
      (errorCode && errorCode !== "0" && errorCode !== "0.0") ||
      String(rejectionReason || "").toLowerCase().includes("rejected")
  );

  return {
    success: success || hasOrderReference || stateIndicatesAcceptance,
    accepted: !rejected && (success || hasOrderReference || stateIndicatesAcceptance),
    rejected,
    brokerOrderId,
    uniqueOrderId,
    rejectionReason: rejected ? rejectionReason : undefined,
    brokerMessage,
    errorCode,
    data,
    rawResponse: body,
  };
}

export function parseAngelRows(response: any): { ok: boolean; rows: any[]; parsed: ParsedAngelResponse } {
  const parsed = parseAngelResponse(response);
  const body = parsed.rawResponse || {};
  const data = parsed.data;

  const candidates = [
    data,
    data?.data,
    data?.positions,
    data?.position,
    data?.orders,
    data?.orderBook,
    body?.positions,
    body?.orders,
    body?.orderBook,
  ];

  const rows = candidates.find((candidate) => Array.isArray(candidate));

  if (Array.isArray(rows)) {
    return { ok: true, rows, parsed };
  }

  if (parsed.success && (data === null || data === "" || (typeof data === "object" && Object.keys(data || {}).length === 0))) {
    return { ok: true, rows: [], parsed };
  }

  return { ok: false, rows: [], parsed };
}

export function parseAngelOrderPlacement(response: any) {
  return parseAngelResponse(response);
}
