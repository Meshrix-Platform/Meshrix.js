const EMPTY_DELIVERY: Readonly<Record<string, any>> = Object.freeze({
  activeConnectionCount: 0,
  matchedConnectionCount: 0,
  deliveredConnectionCount: 0
});

let notificationBroadcaster: any = null;
let sseConnectionRegistrar: any = null;
let catalogConvergenceAcknowledger: any = null;
let grantConnectionDisconnector: any = null;

export function configureMcpNotificationBus({
  broadcastNotification = null,
  registerSseConnection = null,
  acknowledgeCatalogConvergence = null,
  disconnectGrantConnections = null
}: Record<string, any> = {}) : any {
  notificationBroadcaster = typeof broadcastNotification === "function" ? broadcastNotification : null;
  sseConnectionRegistrar = typeof registerSseConnection === "function" ? registerSseConnection : null;
  catalogConvergenceAcknowledger = typeof acknowledgeCatalogConvergence === "function"
    ? acknowledgeCatalogConvergence
    : null;
  grantConnectionDisconnector = typeof disconnectGrantConnections === "function"
    ? disconnectGrantConnections
    : null;
  return {
    broadcastConfigured: Boolean(notificationBroadcaster),
    sseConfigured: Boolean(sseConnectionRegistrar),
    acknowledgementConfigured: Boolean(catalogConvergenceAcknowledger),
    disconnectConfigured: Boolean(grantConnectionDisconnector)
  };
}

export function disconnectConfiguredMcpGrantConnections(grantId: any = "") : any {
  if (!grantConnectionDisconnector) return { disconnectedConnectionCount: 0 };
  const result: any = grantConnectionDisconnector(grantId);
  return result && typeof result === "object"
    ? result
    : { disconnectedConnectionCount: 0 };
}

export function acknowledgeConfiguredMcpCatalogConvergence(input: Record<string, any> = {}) : any {
  if (!catalogConvergenceAcknowledger) {
    return { ok: false, appliedConnectionCount: 0 };
  }
  const result: any = catalogConvergenceAcknowledger(input);
  return result && typeof result === "object"
    ? result
    : { ok: false, appliedConnectionCount: 0 };
}

export function broadcastConfiguredMcpNotification(payload?: any, options: Record<string, any> = {}) : any {
  if (!notificationBroadcaster) {
    return { ...EMPTY_DELIVERY };
  }
  const result: any = notificationBroadcaster(payload, options);
  return result && typeof result === "object" ? result : { ...EMPTY_DELIVERY };
}

export function registerConfiguredMcpSseConnection(connection: Record<string, any> = {}) : any {
  if (!sseConnectionRegistrar) {
    return null;
  }
  return sseConnectionRegistrar(connection);
}
