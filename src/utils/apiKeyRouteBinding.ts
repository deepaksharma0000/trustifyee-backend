import { config } from "../config";

const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

export type RouteType = "USER_STATIC_IP" | "SERVER_SHARED_IP" | "AGENT_ROUTE" | "UNKNOWN";

export function normalizeIpv4(value?: string): string {
  const ip = String(value || "").trim();
  return IPV4_REGEX.test(ip) ? ip : "";
}

export function apiKeyFingerprint(key?: string): string {
  const raw = String(key || "").trim();
  if (!raw) return "EMPTY";
  if (raw.length <= 4) return `${raw}(${raw.length})`;
  return `${raw.slice(0, 2)}***${raw.slice(-2)}(${raw.length})`;
}

export function resolveRouteBinding(input: {
  outgoingIp?: string;
  agentUrl?: string;
  dedicatedIpEnabled?: boolean;
}) {
  const localBindingEnabled = process.env.ANGEL_ENABLE_LOCAL_BINDING === "true";
  const routeIpFromProfile = normalizeIpv4(input.outgoingIp);
  const routeAgentUrl = String(input.agentUrl || "").trim();
  const sharedIp =
    normalizeIpv4(config.publicIp) ||
    normalizeIpv4(process.env.ANGEL_CLIENT_PUBLIC_IP);
  const dedicatedRoutingEnabled =
    Boolean(input.dedicatedIpEnabled) || Boolean(routeIpFromProfile || routeAgentUrl);

  if (config.forceSharedVpsRoute && !dedicatedRoutingEnabled) {
    return {
      routeIp: sharedIp || "",
      routeType: "SERVER_SHARED_IP" as RouteType,
      agentUrl: "",
    };
  }

  if (routeAgentUrl) {
    return {
      routeIp: routeIpFromProfile || sharedIp || "",
      routeType: "AGENT_ROUTE" as RouteType,
      agentUrl: routeAgentUrl,
    };
  }

  if (routeIpFromProfile && !localBindingEnabled) {
    return {
      routeIp: sharedIp || "",
      routeType: "SERVER_SHARED_IP" as RouteType,
      agentUrl: "",
    };
  }

  if (routeIpFromProfile) {
    return {
      routeIp: routeIpFromProfile,
      routeType: "USER_STATIC_IP" as RouteType,
      agentUrl: "",
    };
  }

  if (sharedIp) {
    return {
      routeIp: sharedIp,
      routeType: "SERVER_SHARED_IP" as RouteType,
      agentUrl: "",
    };
  }

  return {
    routeIp: "",
    routeType: "UNKNOWN" as RouteType,
    agentUrl: "",
  };
}

export function buildApiKeyRouteBinding(
  apiKey: string,
  input: {
    outgoingIp?: string;
    agentUrl?: string;
    dedicatedIpEnabled?: boolean;
  }
) {
  const route = resolveRouteBinding(input);
  return {
    apiKeyFingerprint: apiKeyFingerprint(apiKey),
    routeIp: route.routeIp,
    routeType: route.routeType,
    agentUrl: route.agentUrl,
  };
}
