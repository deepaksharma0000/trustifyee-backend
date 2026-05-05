import { config } from '../config';

// ALWAYS use config.publicIp (from .env) as the authoritative IP
// Never auto-detect — auto-detection returns IPv6 on dual-stack servers
export const getPublicIp = (): string => {
    return config.publicIp || '147.93.18.15';
};
