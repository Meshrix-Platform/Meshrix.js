import { configureMcpNotificationBus } from "#meshrix/protocols/mcp/notifications";
import {
  broadcastMcpNotification,
  registerMcpSseConnection,
  acknowledgeMcpCatalogConvergence,
  disconnectMcpSseConnectionsByGrant
} from "../state/sse-connection-state.ts";

export function bindServerMcpNotificationBus() : any {
  return configureMcpNotificationBus({
    broadcastNotification: broadcastMcpNotification,
    registerSseConnection: registerMcpSseConnection,
    acknowledgeCatalogConvergence: acknowledgeMcpCatalogConvergence,
    disconnectGrantConnections: disconnectMcpSseConnectionsByGrant
  });
}
