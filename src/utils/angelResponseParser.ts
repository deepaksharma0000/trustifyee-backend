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

export function parseAngelResponse(response: any): ParsedAngelResponse {
  const body = responseBody(response);
  const data = body?.data ?? null;
  const statusValue = normalizeSuccess(body?.status);
  const successValue = normalizeSuccess(body?.success);
  const success = successValue ?? statusValue ?? false;
  const brokerMessage = String(body?.brokerMessage || body?.message || body?.emsg || data?.brokerMessage || data?.message || "").trim();
  const errorCode = String(body?.errorCode || body?.errorcode || body?.error_code || data?.errorCode || data?.errorcode || "").trim();
  const brokerOrderId = String(data?.orderid || data?.orderId || body?.orderid || body?.orderId || "").trim() || undefined;
  const uniqueOrderId = String(data?.uniqueorderid || data?.uniqueOrderId || body?.uniqueorderid || body?.uniqueOrderId || "").trim() || undefined;

  const rejectionReason = String(
    body?.rejectionReason ||
      body?.rejectreason ||
      data?.rejectionReason ||
      data?.rejectreason ||
      data?.text ||
      brokerMessage ||
      errorCode ||
      "Broker rejected request"
  ).trim();

  const rejected = success === false || Boolean(errorCode && errorCode !== "0");

  return {
    success,
    accepted: success && !rejected,
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
