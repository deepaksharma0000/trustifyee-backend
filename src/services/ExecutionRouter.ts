import mongoose from "mongoose";
import User from "../models/User";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import { BrokerResponse } from "../models/BrokerResponse";
import { WebSocketAgentServer } from "./WebSocketAgentServer";
import ExecutionAgentRegistry from "./ExecutionAgentRegistry";
import log from "../utils/logger";

export type RoutedExecutionPayload = {
  userId: string;
  clientcode: string;
  clientOrderId: string;
  correlationId: string;
  signalId?: string;
  orderInput: {
    exchange?: string;
    tradingsymbol: string;
    side: "BUY" | "SELL";
    transactiontype?: "BUY" | "SELL";
    quantity: number;
    ordertype?: string;
    price?: number;
    producttype?: string;
    duration?: string;
    symboltoken?: string;
    strategyName?: string;
    strategy?: string;
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ExecutionRouter {
  static async routeOrderViaAssignedIp(input: RoutedExecutionPayload) {
    const signalObjectId = input.signalId ? input.signalId : new mongoose.Types.ObjectId().toString();
    const user = await User.findById(input.userId)
      .select("+assignedExecutionIp +outgoing_ip +agent_url +broker +licence")
      .lean();

    if (!user) {
      throw new Error(`USER_NOT_FOUND: ${input.userId}`);
    }

    const assignedExecutionIp = ExecutionAgentRegistry.normalizeExecutionIp((user as any).assignedExecutionIp);
    if (!assignedExecutionIp) {
      throw new Error("ASSIGNED_EXECUTION_IP_NOT_CONFIGURED");
    }

    const resolved = await ExecutionAgentRegistry.resolveBestAgent(assignedExecutionIp);
    if (!resolved) {
      throw new Error("NO_EXECUTION_AGENT_FOR_ASSIGNED_IP");
    }

    const { agent, health } = resolved;

    await SignalExecutionResult.findOneAndUpdate(
      { clientOrderId: input.clientOrderId },
      {
        $setOnInsert: {
          signalId: signalObjectId,
          userId: input.userId,
          clientOrderId: input.clientOrderId,
          broker: String((user as any).broker || "ANGELONE").toUpperCase(),
        },
        $set: {
          status: "PENDING",
          correlationId: input.correlationId,
          executedAt: new Date(),
          agentId: agent.agentId,
          source: "AGENT_EDGE",
          ipAddress: assignedExecutionIp,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const signal = {
      _id: signalObjectId,
      tradingsymbol: input.orderInput.tradingsymbol,
      symboltoken: input.orderInput.symboltoken,
      transactiontype: input.orderInput.transactiontype || input.orderInput.side,
      side: input.orderInput.side,
      exchange: input.orderInput.exchange || "NFO",
      quantity: input.orderInput.quantity,
      price: input.orderInput.price || 0,
      ordertype: input.orderInput.ordertype || "MARKET",
      producttype: input.orderInput.producttype || "INTRADAY",
      duration: input.orderInput.duration || "DAY",
      clientOrderId: input.clientOrderId,
      correlationId: input.correlationId,
      strategyName: input.orderInput.strategyName || input.orderInput.strategy || "Manual",
      assignedExecutionIp,
    };

    const dispatched = await WebSocketAgentServer.sendSignal(agent.agentId, signal, input.clientOrderId, input.correlationId);
    if (!dispatched) {
      throw new Error("EXECUTION_AGENT_DISPATCH_FAILED");
    }

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = await SignalExecutionResult.findOne({ clientOrderId: input.clientOrderId }).lean();
      if (result && result.status && result.status !== "PENDING" && result.status !== "QUEUED") {
        const response = await BrokerResponse.findOne({ clientOrderId: input.clientOrderId }).sort({ createdAt: -1 }).lean();
        return {
          status: result.status === "SUCCESS",
          httpStatus: result.status === "SUCCESS" ? 200 : 400,
          data: {
            agentId: agent.agentId,
            assignedExecutionIp,
            executionHealth: health.status,
            brokerOrderId: result.orderId || undefined,
            clientOrderId: input.clientOrderId,
            correlationId: input.correlationId,
            status: result.status,
            message: result.errorMessage || (result.status === "SUCCESS" ? "Execution completed" : "Execution failed"),
            brokerResponse: result.brokerResponse || response?.brokerError || null,
          },
        };
      }

      await sleep(500);
    }

    return {
      status: false,
      httpStatus: 202,
      data: {
        agentId: agent.agentId,
        assignedExecutionIp,
        executionHealth: health.status,
        clientOrderId: input.clientOrderId,
        correlationId: input.correlationId,
        status: "PENDING",
        message: "Execution dispatched to agent and awaiting callback",
      },
    };
  }
}

export default ExecutionRouter;
