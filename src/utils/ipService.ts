import axios from "axios";
import { config } from '../config';
import log from './logger';

// ALWAYS use config.publicIp (from .env) as the authoritative IP
// Never auto-detect — auto-detection returns IPv6 on dual-stack servers
export const getPublicIp = (): string => {
    const ip = (config.publicIp || "").trim();
    if (!ip) {
        throw new Error("PUBLIC_IP is not configured");
    }
    return ip;
};

/**
 * Actively probes external public services to determine the current system's outbound IPv4 address.
 * Includes multiple fallback providers and a short timeout limit to ensure high reliability.
 */
export const detectOutboundIp = async (): Promise<string> => {
    const providers = [
        "https://api.ipify.org?format=json",
        "https://icanhazip.com",
        "https://ifconfig.me/ip"
    ];

    for (const url of providers) {
        try {
            const response = await axios.get(url, { 
                timeout: 3000,
                headers: { "User-Agent": "Mozilla/5.0 (TradingEngine/1.0)" }
            });
            let ip = "";
            if (typeof response.data === "string") {
                ip = response.data.trim();
            } else if (response.data && typeof response.data.ip === "string") {
                ip = response.data.ip.trim();
            }

            // Simple IPv4 format check
            if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
                return ip;
            }
        } catch (err: any) {
            log.warn(`[IP_DETECTION] Provider ${url} failed: ${err.message}`);
        }
    }
    
    // In local development or isolated systems, fall back to localhost IP if external resolution completely fails
    log.error("[IP_DETECTION] Failed to resolve outbound public IP address from all external directories. Falling back to localhost/loopback.");
    return "127.0.0.1";
};

