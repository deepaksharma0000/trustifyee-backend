import { IBrokerAdapter } from "./IBrokerAdapter";
import { AngelOneAdapter } from "./AngelOneAdapter";
import { UpstoxAdapter } from "./UpstoxAdapter";
import { ZerodhaAdapter } from "./ZerodhaAdapter";
import { IUser } from "../models/User";

export class BrokerAdapterRegistry {
  static getAdapter(broker?: string, options?: any): IBrokerAdapter {
    const b = String(broker || "").trim().toUpperCase();
    if (b === "ANGELONE" || b === "ANGEL_ONE") {
      const user = options?.user;
      let userId = options?.userId || (user ? String(user._id) : "");
      let apiKey = options?.apiKey;
      let outgoingIp = options?.outgoingIp;
      let agentUrl = options?.agentUrl;

      if (user) {
        const encKey = user.api_key || user.broker_config?.apiKey;
        if (encKey) {
          const { safeDecrypt } = require("../utils/encryption");
          const userIdent = `user_${String(user._id)}`;
          apiKey = safeDecrypt(encKey, userIdent);
        }
        const dedicatedIpEnabled = Boolean(user.dedicated_ip_enabled === true);
        if (dedicatedIpEnabled) {
          outgoingIp = user.outgoing_ip;
          agentUrl = user.agent_url;
        }
      }

      if (!apiKey) {
        throw new Error(
          "ANGEL_ADAPTER_SCOPE_ERROR: User SmartAPI Private Key is required. Reconnect broker from Profile."
        );
      }

      if (userId && apiKey) {
        const { getOrCreateUserAngelAdapter } = require("../services/AngelAdapterRegistry");
        return getOrCreateUserAngelAdapter(userId, apiKey, { outgoingIp, agentUrl }) as any as IBrokerAdapter;
      }

      return new AngelOneAdapter(apiKey, outgoingIp, false, agentUrl);
    } else if (b === "UPSTOX") {
      const user = options?.user;
      let outgoingIp = options?.outgoingIp;
      if (user && user.dedicated_ip_enabled) {
        outgoingIp = user.outgoing_ip;
      }
      return new UpstoxAdapter(outgoingIp) as any as IBrokerAdapter;
    } else if (b === "ZERODHA") {
      const user = options?.user;
      let outgoingIp = options?.outgoingIp;
      if (user && user.dedicated_ip_enabled) {
        outgoingIp = user.outgoing_ip;
      }
      return new ZerodhaAdapter(outgoingIp);
    } else if (b === "ALICEBLUE" || b === "ALICE_BLUE") {
      const user = options?.user;
      let outgoingIp = options?.outgoingIp;
      if (user && user.dedicated_ip_enabled) {
        outgoingIp = user.outgoing_ip;
      }
      const { AliceBlueAdapter } = require("./AliceBlueAdapter");
      return new AliceBlueAdapter(outgoingIp) as any as IBrokerAdapter;
    }
    throw new Error(`Unsupported broker: ${broker}`);
  }
}
