export type McpUserContext = {
  userId: string;
  userType: "user" | "admin";
  email?: string;
  broker?: string;
  clientCode?: string;
};

export type McpRequestAuth = {
  apiKeyValid: boolean;
  user?: McpUserContext;
};
