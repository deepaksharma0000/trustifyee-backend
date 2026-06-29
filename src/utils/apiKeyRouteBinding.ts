import { config } from "../config";

const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

export type RouteType = "USER_STATIC_IP" | "SERVER_SHARED_IP" | "AGENT_ROUTE" | "UNKNOWN";

export type BrokerVerificationStatus = "VERIFIED" | "PENDING" | "FAILED" | "UNKNOWN";

export type BrokerConnectionMetadata = {
  brokerName: string;
  clientCode: string;
  apiKeyFingerprint: string;
  outgoingPublicIp: string | null;
  registeredRouteIp: string | null;
  routeType: RouteType;
  dedicatedIpEnabled: boolean;
  agentUrl: string | null;
  brokerAppName: string | null;
  connectionTimestamp: Date;
  verificationStatus: BrokerVerificationStatus;
  brokerLoginTimestamp: Date;
};

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
  const dedicatedRoutingEnabled = Boolean(input.dedicatedIpEnabled === true);

  if (config.forceSharedVpsRoute && !dedicatedRoutingEnabled) {
    return {
      routeIp: sharedIp || "",
      routeType: "SERVER_SHARED_IP" as RouteType,
      agentUrl: "",
    };
  }

  if (!dedicatedRoutingEnabled) {
    return {
      routeIp: sharedIp || "",
      routeType: sharedIp ? ("SERVER_SHARED_IP" as RouteType) : ("UNKNOWN" as RouteType),
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

export function resolveBrokerAppName(input?: {
  brokerAppName?: unknown;
  appName?: unknown;
  app_name?: unknown;
  smartapiAppName?: unknown;
  broker_config?: { appName?: unknown };
  brokerConfig?: { appName?: unknown };
}): string {
  const candidates = [
    input?.brokerAppName,
    input?.appName,
    input?.app_name,
    input?.smartapiAppName,
    input?.broker_config?.appName,
    input?.brokerConfig?.appName,
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) return value;
  }

  return "";
}

export function buildBrokerConnectionMetadata(input: {
  brokerName: string;
  apiKey: string;
  clientCode: string;
  outgoingIp?: string;
  agentUrl?: string;
  dedicatedIpEnabled?: boolean;
  brokerAppName?: unknown;
  verificationStatus?: BrokerVerificationStatus;
  connectionTimestamp?: Date;
  brokerLoginTimestamp?: Date;
}) : BrokerConnectionMetadata {
  const binding = buildApiKeyRouteBinding(input.apiKey, {
    outgoingIp: input.outgoingIp,
    agentUrl: input.agentUrl,
    dedicatedIpEnabled: input.dedicatedIpEnabled,
  });

  const registeredRouteIp = binding.routeIp || null;
  const outgoingPublicIp = normalizeIpv4(config.publicIp) || null;
  const connectionTimestamp = input.connectionTimestamp || new Date();
  const brokerLoginTimestamp = input.brokerLoginTimestamp || connectionTimestamp;

  return {
    brokerName: String(input.brokerName || "").trim() || "Angel One",
    clientCode: String(input.clientCode || "").trim().toUpperCase(),
    apiKeyFingerprint: binding.apiKeyFingerprint,
    outgoingPublicIp,
    registeredRouteIp,
    routeType: binding.routeType,
    dedicatedIpEnabled: Boolean(input.dedicatedIpEnabled),
    agentUrl: binding.agentUrl || null,
    brokerAppName: resolveBrokerAppName({
      brokerAppName: input.brokerAppName,
    }) || null,
    connectionTimestamp,
    verificationStatus: input.verificationStatus || "VERIFIED",
    brokerLoginTimestamp,
  };
}
