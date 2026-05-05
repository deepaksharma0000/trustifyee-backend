import { UpstoxAdapter } from "../adapters/UpstoxAdapter";

let _upstoxAdapter: UpstoxAdapter | null = null;

export function getUpstoxAdapter(outgoingIp?: string) {
    if (!_upstoxAdapter) {
        _upstoxAdapter = new UpstoxAdapter(outgoingIp);
    }
    return _upstoxAdapter;
}
