/**
 * Backward-compatible facade — delegates to AngelUserSessionManager for
 * per-user isolated sessions. Prefer importing from AngelUserSessionManager directly.
 */
export {
  getIsolatedAngelSession as ensureValidSession,
  executeWithIsolatedSession as executeWithSessionRecovery,
  isAngelInvalidToken,
  type IsolatedAngelSession as ValidAngelSession,
} from "./AngelUserSessionManager";
