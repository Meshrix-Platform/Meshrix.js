import { configureMcpNotificationBus } from "#meshrix/protocols/mcp/adapter/http-mcp-adapter";
import {
  broadcastMcpNotification,
  registerMcpSseConnection,
  acknowledgeMcpCatalogConvergence,
  disconnectMcpSseConnectionsByGrant
} from "../state/sse-connection-state.ts";

export function bindServerMcpNotificationBus() : any {
  configureMcpNotificationBus({
    broadcastNotification: broadcastMcpNotification,
    registerSseConnection: registerMcpSseConnection,
    acknowledgeCatalogConvergence: acknowledgeMcpCatalogConvergence,
    disconnectGrantConnections: disconnectMcpSseConnectionsByGrant
  });
}
