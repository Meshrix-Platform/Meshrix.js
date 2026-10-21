import { configureMcpNotificationBus, disconnectMcpGrantSessions } from "#meshrix/protocols/mcp/notifications";
import {
  broadcastMcpNotification,
  registerMcpSseConnection,
  acknowledgeMcpCatalogConvergence,
  disconnectMcpSseConnectionsByGrant,
  setMcpSseGrantSessionDisconnector
} from "../state/sse-connection-state.ts";

export function bindServerMcpNotificationBus() : any {
  setMcpSseGrantSessionDisconnector(disconnectMcpGrantSessions);
  return configureMcpNotificationBus({
    broadcastNotification: broadcastMcpNotification,
    registerSseConnection: registerMcpSseConnection,
    acknowledgeCatalogConvergence: acknowledgeMcpCatalogConvergence,
    disconnectGrantConnections: disconnectMcpSseConnectionsByGrant
  });
}
