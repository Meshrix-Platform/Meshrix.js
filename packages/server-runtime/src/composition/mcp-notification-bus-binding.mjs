import { configureMcpNotificationBus } from "#lico/protocols/mcp/adapter/http-mcp-adapter";
import {
  broadcastMcpNotification,
  registerMcpSseConnection,
  acknowledgeMcpCatalogConvergence,
  disconnectMcpSseConnectionsByGrant
} from "../state/sse-connection-state.mjs";

export function bindServerMcpNotificationBus() {
  configureMcpNotificationBus({
    broadcastNotification: broadcastMcpNotification,
    registerSseConnection: registerMcpSseConnection,
    acknowledgeCatalogConvergence: acknowledgeMcpCatalogConvergence,
    disconnectGrantConnections: disconnectMcpSseConnectionsByGrant
  });
}
