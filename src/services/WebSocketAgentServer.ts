import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import AgentModel from "../models/Agent";
import AgentHeartbeatModel from "../models/AgentHeartbeat";
import SignalDeliveryModel from "../models/SignalDelivery";
import { SignalExecutionResult } from "../models/SignalExecutionResult";
import { BrokerResponse } from "../models/BrokerResponse";
import UserModel from "../models/User";
import { Signal } from "../models/Signal";
import { decrypt } from "../utils/encryption";
import log from "../utils/logger";

export class WebSocketAgentServer {
  private static connections = new Map<string, WebSocket>();

  static init(server: any) {
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", async (request: any, socket: any, head: any) => {
      try {
        const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
        if (url.pathname !== "/ws/agent") return;

        const agentId = request.headers["x-agent-id"] as string;
        const timestamp = Number(request.headers["x-timestamp"]);
        const signature = request.headers["x-signature"] as string;

        const authenticated = await this.authenticate(agentId, timestamp, signature);
        if (!authenticated) {
          log.warn(`[WS_AGENT] Unauthorized handshake attempt. agentId: ${agentId}`);
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      } catch (err: any) {
        log.error(`[WS_AGENT] Upgrade connection handling error: ${err.message}`);
        socket.destroy();
      }
    });

    wss.on("connection", (ws: WebSocket, request) => {
      const agentId = request.headers["x-agent-id"] as string;
      this.connections.set(agentId, ws);
      log.info(`[WS_AGENT] Agent ${agentId} connected and registered.`);

      ws.on("message", async (data) => {
        try {
          const message = JSON.parse(data.toString());
          await this.handleMessage(agentId, message);
        } catch (err: any) {
          log.error(`[WS_AGENT] Error handling incoming socket message from agent ${agentId}: ${err.message}`);
        }
      });

      ws.on("close", () => {
        this.connections.delete(agentId);
        log.warn(`[WS_AGENT] Agent ${agentId} connection closed.`);
      });

      ws.on("error", (error) => {
        log.error(`[WS_AGENT] WebSocket error on agent ${agentId}: ${error.message}`);
      });
    });
  }

  private static async authenticate(agentId: string, timestamp: number, signature: string): Promise<boolean> {
    if (!agentId || !timestamp || !signature) return false;
    
    // Allow maximum 5 minutes clock drift for security
    const drift = Math.abs(Date.now() - timestamp);
    if (drift > 5 * 60 * 1000) {
      log.warn(`[WS_AGENT] Handshake timestamp drifted too far: ${drift}ms`);
      return false;
    }

    const agent = await AgentModel.findOne({ agentId, status: "active" });
    if (!agent) {
      log.warn(`[WS_AGENT] Active agent ${agentId} not found in database.`);
      return false;
    }

    const decryptedSecret = decrypt(agent.agentSecret);
    const expectedSignature = crypto
      .createHmac("sha256", decryptedSecret)
      .update(`${agentId}:${timestamp}`)
      .digest("hex");

    try {
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
    } catch {
      return false;
    }
  }

  private static async handleMessage(agentId: string, message: any) {
    if (!message || !message.event) return;

    if (message.event === "HEARTBEAT") {
      const payload = message.payload || {};
      await AgentHeartbeatModel.create({
        agentId,
        status: payload.status || "ONLINE",
        publicIp: payload.publicIp || "0.0.0.0",
        latencyMs: payload.pingMs || 0,
        metrics: payload.metrics || { cpuPercent: 0, memFreeBytes: 0, uptimeSeconds: 0 }
      });
      await AgentModel.updateOne(
        { agentId },
        {
          $set: {
            publicIp: payload.publicIp || "0.0.0.0",
            lastHeartbeatAt: new Date(),
            lastHeartbeatStatus: payload.status || "ONLINE",
            assignedExecutionIp: payload.assignedExecutionIp || undefined,
          },
        }
      );
      return;
    }

    if (message.event === "EXECUTION_CALLBACK") {
      log.info(`[WS_AGENT] Execution callback received for agent ${agentId}: messageId=${message.messageId}, status=${message.status}`);

      const delivery = await SignalDeliveryModel.findOne({ messageId: message.messageId });
      if (!delivery) {
        log.warn(`[WS_AGENT] Delivery tracking record for messageId ${message.messageId} not found.`);
        return;
      }

      // Update delivery record
      delivery.status = message.status === "SUCCESS" ? "DELIVERED" : "FAILED";
      delivery.acknowledgedAt = new Date();
      delivery.errorMessage = message.errorMessage || undefined;
      await delivery.save();

      const agent = await AgentModel.findOne({ agentId });
      if (!agent) return;

      const user = await UserModel.findById(agent.userId);
      const signal = await Signal.findById(delivery.signalId);

      // Log execution results in Mongoose models
      await SignalExecutionResult.findOneAndUpdate(
        { signalId: delivery.signalId, userId: agent.userId },
        {
          signalId: delivery.signalId,
          userId: agent.userId,
          agentId,
          broker: user?.broker || "ANGELONE",
          orderId: message.brokerOrderId,
          clientOrderId: message.clientOrderId,
          status: message.status === "SUCCESS" ? "SUCCESS" : "FAILED",
          errorMessage: message.errorMessage,
          executedAt: new Date(),
          source: "AGENT_EDGE",
          ipAddress: message.payload?.publicIp || "0.0.0.0",
          brokerResponse: message.brokerResponse,
        },
        { upsert: true }
      );

      // Create a BrokerResponse record to match existing tracking UI
      const clientcode = user?.broker_config?.clientCode || "UNKNOWN";
      await BrokerResponse.create({
        userId: String(agent.userId),
        clientcode,
        clientOrderId: message.clientOrderId,
        correlationId: message.correlationId || `corr_${Date.now()}`,
        tradingsymbol: signal?.tradingsymbol || "UNKNOWN",
        orderid: message.brokerOrderId || "FAILED",
        action: "PLACE_ORDER",
        status: message.status === "SUCCESS" ? "SUCCESS" : "REJECTED",
        message: message.errorMessage || "Executed via Edge Agent",
        usedIp: message.payload?.publicIp || "0.0.0.0",
        networkRoute: "AGENT_ROUTE",
        brokerError: message.brokerResponse,
      });

      return;
    }
  }

  static isAgentOnline(agentId: string): boolean {
    const ws = this.connections.get(agentId);
    return ws ? ws.readyState === WebSocket.OPEN : false;
  }

  static async sendSignal(
    agentId: string,
    signal: any,
    clientOrderId: string,
    correlationId: string
  ): Promise<boolean> {
    const ws = this.connections.get(agentId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log.error(`[WS_AGENT] Failed to dispatch signal payload to ${agentId}: agent offline.`);
      return false;
    }

    const agent = await AgentModel.findOne({ agentId });
    if (!agent) {
      log.error(`[WS_AGENT] Agent registration not found for ${agentId}.`);
      return false;
    }

    const messageId = `MSG-${uuidv4()}`;
    const timestamp = Date.now();

    const payload = {
      clientOrderId,
      correlationId,
      tradingsymbol: signal.tradingsymbol,
      symboltoken: signal.symboltoken,
      transactiontype: signal.side || signal.transactiontype,
      exchange: signal.exchange || "NFO",
      quantity: signal.quantity,
      price: signal.price || 0,
      ordertype: signal.ordertype || "MARKET",
      producttype: signal.producttype || "INTRADAY",
      duration: signal.duration || "DAY"
    };

    const payloadStr = JSON.stringify(payload);
    const decryptedSecret = decrypt(agent.agentSecret);
    const signature = crypto
      .createHmac("sha256", decryptedSecret)
      .update(`${messageId}:${timestamp}:${payloadStr}`)
      .digest("hex");

    const frame = {
      event: "EXECUTE_SIGNAL",
      messageId,
      timestamp,
      signature,
      payload
    };

    // Track signal delivery dispatch
    await SignalDeliveryModel.create({
      signalId: signal._id,
      agentId,
      messageId,
      status: "PENDING",
      dispatchedAt: new Date()
    });

    ws.send(JSON.stringify(frame));
    log.info(`[WS_AGENT] Signed signal frame sent to Agent ${agentId}: messageId=${messageId}`);
    return true;
  }
}
export default WebSocketAgentServer;
