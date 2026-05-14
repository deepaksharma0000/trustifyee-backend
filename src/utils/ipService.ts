import { config } from '../config';

// ALWAYS use config.publicIp (from .env) as the authoritative IP
// Never auto-detect — auto-detection returns IPv6 on dual-stack servers
export const getPublicIp = (): string => {
    const ip = (config.publicIp || "").trim();
    if (!ip) {
        throw new Error("PUBLIC_IP is not configured");
    }
    return ip;
};
