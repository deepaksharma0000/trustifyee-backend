// src/routes/execution.routes.ts
import { Router } from "express";
import { config } from "../config";
import { StartupDiagnostics } from "../utils/startupDiagnostics";
import { buildIpWhitelistDiagnostics } from "../services/BrokerSessionValidator";

const router = Router();

/**
 * Retrieve execution route health, whitelist verification metrics, and system safety diagnostics
 */
router.get("/route-status", async (req, res) => {
  try {
    const detectedOutboundIp = StartupDiagnostics.detectedOutboundIp || "UNKNOWN";
    const configuredPublicIp = config.publicIp || "UNKNOWN";
    const isMatch = StartupDiagnostics.whitelistMatch;

    let routeClassification = "UNKNOWN";
    if (config.executionMode === "LOCAL_DEVICE") {
      routeClassification = "LOCAL DEVICE ROUTING";
    } else if (config.executionMode === "SERVER_SHARED_IP") {
      routeClassification = "SHARED CENTRALIZED ROUTING";
    } else if (config.executionMode === "STATIC_AGENT") {
      routeClassification = "ISOLATED STATIC AGENT ROUTING";
    } else if (config.executionMode === "USER_ONLY") {
      routeClassification = "ISOLATED USER RUNTIME ROUTING";
    } else if (config.executionMode === "SERVER_AUTO") {
      routeClassification = "SERVER AUTOMATED ROUTING";
    }

    const ipDiagnostics = buildIpWhitelistDiagnostics();

    res.json({
      status: "success",
      data: {
        executionMode: config.executionMode,
        detectedOutboundIp,
        configuredPublicIp,
        brokerWhitelistMatch: isMatch,
        routeClassification,
        safetyStatus: isMatch ? "SECURE" : "FALLBACK_ACTIVE",
        ipWhitelistDiagnostics: ipDiagnostics,
        operationalNote:
          "brokerWhitelistMatch=true only means PUBLIC_IP matches VPS egress. Each user SmartAPI app must whitelist that IP in Angel One portal.",
      }
    });
  } catch (err: any) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

export default router;
