import {
  DOWNSTREAM_CLIENT_ASPECT_PROTOCOL_VERSION,
  DOWNSTREAM_CLIENT_ASPECT_SERVICE_KIND
} from "./constants.mjs";
import { publicMetadata, uniqueStrings } from "./identity-helpers.mjs";
import { resolveCommandCandidate } from "./identity-helpers.mjs";
import { protocolRecordBase } from "./audit-projection.mjs";

function publicCommandProbe(probe = {}) {
  return Object.freeze({
    found: probe.found === true,
    command: String(probe.command || "").trim()
  });
}

export class McpAgentFrameworkAdapterLayer {
  constructor({ layerId = "mcp", adapterKind = "agent-framework-mcp-adapter-layer" } = {}) {
    this.layerId = layerId;
    this.adapterKind = adapterKind;
  }

  supports(framework = {}) {
    return Boolean(framework?.mcp);
  }

  assembleFramework(framework = {}, context = {}) {
    const mcp = framework.mcp;
    if (!mcp) {
      return {
        aspectProtocolVersion: DOWNSTREAM_CLIENT_ASPECT_PROTOCOL_VERSION,
        serviceKind: DOWNSTREAM_CLIENT_ASPECT_SERVICE_KIND,
        layerId: this.layerId,
        protocol: "mcp",
        frameworkId: framework.frameworkId,
        frameworkLabel: framework.label,
        status: "unavailable",
        reasonCode: "mcp_adapter_not_declared",
        startup: {
          sequence: context.sequence || 0,
          assembledAt: context.assembledAt || ""
        }
      };
    }
    const commandProbe = resolveCommandCandidate(uniqueStrings([...framework.commandNames, ...mcp.commandNames]), context);
    return Object.freeze({
      ...protocolRecordBase({
        layerId: this.layerId,
        framework,
        protocolConfig: mcp,
        sequence: context.sequence || 0,
        assembledAt: context.assembledAt || ""
      }),
      adapterKind: this.adapterKind,
      status: "assembled",
      reasonCode: "",
      communication: {
        protocol: "mcp",
        direction: "agent-to-meshrix",
        transport: "client-config",
        targetRole: "downstream-client"
      },
      commandProbe: publicCommandProbe(commandProbe),
      capabilities: {
        serverName: mcp.serverName,
        installMode: mcp.installMode,
        locations: [...mcp.locations],
        configurationStrategy: mcp.configurationStrategy,
        canInstall: true,
        canScan: true,
        canRepair: true,
        toolBoundary: "v0.0.1:operation-permission:projection-1",
        mcpInterfaceVersion: "v0.0.1:mcp:interface-1"
      },
      metadata: publicMetadata(mcp.metadata)
    });
  }
}

export function createDefaultDownstreamClientAspectLayers() {
  return [new McpAgentFrameworkAdapterLayer()];
}
