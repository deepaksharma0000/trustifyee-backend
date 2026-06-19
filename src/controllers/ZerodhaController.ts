import { Request, Response } from "express";
import User from "../models/User";
import { ZerodhaAdapter } from "../adapters/ZerodhaAdapter";
import { ZerodhaSessionService } from "../services/ZerodhaSessionService";
import { config } from "../config";
import log from "../utils/logger";

const BROKER_CONNECT_PATH = "/dashboard/broker-connect";

function loadUserWithZerodhaCredentials(userId: string) {
  return User.findById(userId).select(
    "+zerodha_access_token +zerodha_api_key +zerodha_api_secret zerodha_user_id zerodha_connected zerodha_verified zerodha_token_expiry outgoing_ip broker broker_connected"
  );
}

function buildFrontendRedirect(query: string) {
  return `${config.frontendUrl}${BROKER_CONNECT_PATH}${query}`;
}

export const connectZerodha = async (req: any, res: Response) => {
  try {
    const userId = req.id;
    const userType = req.userType || "user";

    if (userType === "admin") {
      return res.status(400).json({
        ok: false,
        message: "Zerodha connect is for client accounts. Please login as a Live client user.",
      });
    }

    const result = await ZerodhaSessionService.prepareConnect(userId, userType, {
      api_key: req.body?.api_key,
      api_secret: req.body?.api_secret,
      client_key: req.body?.client_key,
    });

    return res.json({
      ok: true,
      auth_url: result.authUrl,
      state: result.state,
      api_key_source: result.apiKeySource,
    });
  } catch (err: any) {
    log.error("[ZERODHA_CONNECT] Failed", err.message);
    return res.status(400).json({ ok: false, message: err.message });
  }
};

export const zerodhaCallback = async (req: any, res: Response) => {
  try {
    const requestToken = req.query.request_token;
    const state = req.query.state || req.query.user_id;

    if (!requestToken) {
      return res.status(400).json({ ok: false, message: "request_token is required" });
    }

    const session = await ZerodhaSessionService.completeOAuth(String(requestToken), state ? String(state) : undefined);

    const redirectUrl = buildFrontendRedirect(`?zerodha=connected&kite_user_id=${encodeURIComponent(session.kiteUserId)}`);
    const wantsJson = String(req.query.format || "").toLowerCase() === "json";

    if (!wantsJson) {
      return res.redirect(redirectUrl);
    }

    return res.json({
      ok: true,
      message: "Connected to Zerodha successfully",
      broker: "Zerodha",
      kite_user_id: session.kiteUserId,
      redirect_url: redirectUrl,
    });
  } catch (err: any) {
    log.error("[ZERODHA_CALLBACK] Failed", err.message);

    const redirectUrl = buildFrontendRedirect(`?zerodha=error&message=${encodeURIComponent(err.message)}`);
    const wantsJson = String(req.query.format || "").toLowerCase() === "json";

    if (!wantsJson) {
      return res.redirect(redirectUrl);
    }

    return res.status(400).json({ ok: false, message: err.message });
  }
};

export const getZerodhaAuthUrl = async (req: any, res: Response) => {
  try {
    if (req.userType === "admin") {
      return res.status(400).json({ ok: false, message: "Zerodha connect is for client accounts only." });
    }
    const result = await ZerodhaSessionService.prepareConnect(req.id, req.userType || "user");
    return res.json({ ok: true, auth_url: result.authUrl, state: result.state });
  } catch (err: any) {
    return res.status(400).json({ ok: false, message: err.message });
  }
};

export const refreshZerodhaSession = async (req: any, res: Response) => {
  try {
    const user = await loadUserWithZerodhaCredentials(req.id);
    if (!user || !user.zerodha_connected) {
      return res.status(400).json({ ok: false, message: "Zerodha not connected" });
    }

    const sessionResp = await ZerodhaSessionService.validateSession(user);
    return res.json({ ok: true, message: "Session refreshed", profile: sessionResp.profile });
  } catch (err: any) {
    return res.status(401).json({ ok: false, message: err.message || "Session expired. Please reconnect." });
  }
};

export const disconnectZerodha = async (req: any, res: Response) => {
  try {
    const user = await loadUserWithZerodhaCredentials(req.id);
    if (!user) {
      return res.status(401).json({ ok: false, message: "User not found" });
    }

    await ZerodhaSessionService.disconnect(user);
    await User.updateOne({ _id: req.id }, { $set: { broker: null } });

    return res.json({ ok: true, message: "Disconnected from Zerodha" });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

export const getZerodhaProfile = async (req: any, res: Response) => {
  try {
    const user = await loadUserWithZerodhaCredentials(req.id);
    if (!user || !user.zerodha_connected) {
      return res.status(400).json({ ok: false, message: "Zerodha not connected" });
    }

    const sessionResp = await ZerodhaSessionService.validateSession(user);
    const status = ZerodhaSessionService.getBrokerStatus(user);

    return res.json({
      ok: true,
      profile: sessionResp.profile,
      ...status,
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

export const getZerodhaStatus = async (req: any, res: Response) => {
  try {
    const user = await User.findById(req.id).select(
      "zerodha_connected zerodha_verified zerodha_user_id zerodha_token_expiry broker broker_connected"
    );
    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    return res.json({ ok: true, ...ZerodhaSessionService.getBrokerStatus(user) });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

export const getZerodhaOrders = async (req: any, res: Response) => {
  try {
    const user = await loadUserWithZerodhaCredentials(req.id);
    if (!user || !user.zerodha_connected) {
      return res.status(400).json({ ok: false, message: "Zerodha not connected" });
    }

    const adapter = new ZerodhaAdapter(user.outgoing_ip);
    const orders = await adapter.getOrders(user);
    return res.json({ ok: true, orders });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

export const getZerodhaPositions = async (req: any, res: Response) => {
  try {
    const user = await loadUserWithZerodhaCredentials(req.id);
    if (!user || !user.zerodha_connected) {
      return res.status(400).json({ ok: false, message: "Zerodha not connected" });
    }

    const adapter = new ZerodhaAdapter(user.outgoing_ip);
    const positions = await adapter.getPositions(user);
    return res.json({ ok: true, positions });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

export const getZerodhaHoldings = async (req: any, res: Response) => {
  try {
    const user = await loadUserWithZerodhaCredentials(req.id);
    if (!user || !user.zerodha_connected) {
      return res.status(400).json({ ok: false, message: "Zerodha not connected" });
    }

    const adapter = new ZerodhaAdapter(user.outgoing_ip);
    const holdings = await adapter.getHoldings(user);
    return res.json({ ok: true, holdings });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

export const getZerodhaFunds = async (req: any, res: Response) => {
  try {
    const user = await loadUserWithZerodhaCredentials(req.id);
    if (!user || !user.zerodha_connected) {
      return res.status(400).json({ ok: false, message: "Zerodha not connected" });
    }

    const adapter = new ZerodhaAdapter(user.outgoing_ip);
    const funds = await adapter.getFunds(user);
    return res.json({ ok: true, funds });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

export const getAdminZerodhaStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    return res.json({ ok: true, ...ZerodhaSessionService.getBrokerStatus(user) });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};
