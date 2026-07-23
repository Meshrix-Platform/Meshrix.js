const EMPTY_DELIVERY = Object.freeze({
  activeConnectionCount: 0,
  matchedConnectionCount: 0,
  deliveredConnectionCount: 0
});

let notificationBroadcaster = null;
let sseConnectionRegistrar = null;
let catalogConvergenceAcknowledger = null;
let grantConnectionDisconnector = null;

export function configureMcpNotificationBus({
  broadcastNotification = null,
  registerSseConnection = null,
  acknowledgeCatalogConvergence = null,
  disconnectGrantConnections = null
} = {}) {
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

export function disconnectConfiguredMcpGrantConnections(grantId = "") {
  if (!grantConnectionDisconnector) return { disconnectedConnectionCount: 0 };
  const result = grantConnectionDisconnector(grantId);
  return result && typeof result === "object"
    ? result
    : { disconnectedConnectionCount: 0 };
}

export function acknowledgeConfiguredMcpCatalogConvergence(input = {}) {
  if (!catalogConvergenceAcknowledger) {
    return { ok: false, appliedConnectionCount: 0 };
  }
  const result = catalogConvergenceAcknowledger(input);
  return result && typeof result === "object"
    ? result
    : { ok: false, appliedConnectionCount: 0 };
}

export function broadcastConfiguredMcpNotification(payload, options = {}) {
  if (!notificationBroadcaster) {
    return { ...EMPTY_DELIVERY };
  }
  const result = notificationBroadcaster(payload, options);
  return result && typeof result === "object" ? result : { ...EMPTY_DELIVERY };
}

export function registerConfiguredMcpSseConnection(connection = {}) {
  if (!sseConnectionRegistrar) {
    return null;
  }
  return sseConnectionRegistrar(connection);
}
