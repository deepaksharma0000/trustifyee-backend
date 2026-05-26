import { placeOrderForClient, type PlaceOrderInput } from "./OrderService";
import {
  buildTokenAudit,
  logAngelResponse,
  logExecutionContext,
  logExecutionError,
  logOrderPayload,
  type ExecutionLogContext,
} from "../utils/executionLogger";
import { getIsolatedAngelSession } from "./AngelUserSessionManager";
import log from "../utils/logger";

export type TradeExecutionJob = {
  userId: string;
  clientCode: string;
  signalId?: string;
  clientOrderId: string;
  correlationId?: string;
  orderData: PlaceOrderInput & { broker?: string };
  outgoingIp?: string;
  agentUrl?: string;
  dedicatedIpEnabled?: boolean;
};

/**
 * Execution layer: places orders strictly under the target user's credentials.
 * Strategy/signal services must enqueue jobs here — they must not call Angel directly.
 */
export class TradeExecutionService {
  static async executeUserOrder(job: TradeExecutionJob): Promise<any> {
    const ctx: ExecutionLogContext = {
      userId: job.userId,
      clientCode: job.clientCode,
      purpose: "trade_execution_service",
      correlationId: job.correlationId,
      clientOrderId: job.clientOrderId,
      signalId: job.signalId,
    };

    logExecutionContext(ctx, "EXECUTION_START", {
      tradingsymbol: job.orderData?.tradingsymbol,
      side: job.orderData?.side,
      quantity: job.orderData?.quantity,
    });

    let tokenAudit;
    try {
      const previewSession = await getIsolatedAngelSession({
        userId: job.userId,
        clientcode: job.clientCode,
        purpose: "trade_execution_precheck",
        outgoingIp: job.outgoingIp,
        agentUrl: job.agentUrl,
        correlationId: job.correlationId,
        clientOrderId: job.clientOrderId,
      });

      tokenAudit = buildTokenAudit(previewSession);

      if (tokenAudit.tokenOwnerUserId !== job.userId) {
        throw new Error(
          `EXECUTION_ISOLATION_VIOLATION: token owner ${tokenAudit.tokenOwnerUserId} !== job userId ${job.userId}`
        );
      }

      if (tokenAudit.sessionClientCode !== job.clientCode) {
        throw new Error(
          `EXECUTION_ISOLATION_VIOLATION: session client ${tokenAudit.sessionClientCode} !== job client ${job.clientCode}`
        );
      }

      logOrderPayload(
        ctx,
        {
          exchange: job.orderData.exchange,
          tradingsymbol: job.orderData.tradingsymbol,
          side: job.orderData.side,
          quantity: job.orderData.quantity,
          orderType: job.orderData.ordertype,
          clientOrderId: job.clientOrderId,
        },
        tokenAudit
      );

      const response = await placeOrderForClient(job.userId, job.clientCode, {
        ...job.orderData,
        clientOrderId: job.clientOrderId,
        outgoingIp: job.outgoingIp,
        agentUrl: job.agentUrl,
        dedicatedIpEnabled: job.dedicatedIpEnabled,
        correlationId: job.correlationId,
      } as PlaceOrderInput & { clientOrderId?: string });

      logAngelResponse(ctx, response, tokenAudit);
      logExecutionContext(ctx, "EXECUTION_COMPLETE");

      return response;
    } catch (error) {
      logExecutionError(ctx, error, tokenAudit);
      throw error;
    }
  }
}

export default TradeExecutionService;
