/**
 * LIVE ORDER EXECUTION AUDIT UTILITY
 * Used to verify the routing and session validity during trade execution.
 */
export const logLiveExecution = (
  userId: string,
  clientCode: string,
  mode: string,
  route: string,
  orderPayload: any
) => {
  console.log(JSON.stringify({
    event: "[LIVE_EXECUTION_AUDIT]",
    timestamp: new Date().toISOString(),
    userId,
    clientCode,
    broker: "ANGELONE",
    mode, // Should be 'Live' for real execution
    route,
    orderPayload,
    isVerified: !!clientCode && clientCode !== "undefined",
    sessionValidity: "CHECK_PENDING"
  }, null, 2));
};