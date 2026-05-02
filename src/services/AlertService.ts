// src/services/AlertService.ts
import log from "../utils/logger";

export class AlertService {
    static async trigger(type: string, message: string, severity: "LOW" | "HIGH" | "CRITICAL" = "HIGH") {
        const payload = {
            alertType: type,
            message,
            severity,
            timestamp: new Date(),
        };

        // 🛡️ Log for traceability
        log.error({ type: "SYSTEM_ALERT", ...payload });

        // 🚀 ACTIONABLE: Integrate with Slack/Telegram Webhook here
        try {
            if (severity === "CRITICAL") {
                // Example: await axios.post(config.slackWebhook, payload);
                console.error(`🔥 [CRITICAL ALERT] ${message}`);
            }
        } catch (err) {
            log.error("Failed to send external alert", err);
        }
    }
}
