import {
  DOWNSTREAM_CLIENT_ASPECT_PROTOCOL_VERSION,
  DOWNSTREAM_CLIENT_ASPECT_SERVICE_KIND
} from "./constants.ts";
import { publicMetadata, uniqueStrings } from "./identity-helpers.ts";
import { resolveCommandCandidate } from "./identity-helpers.ts";
import { protocolRecordBase } from "./audit-projection.ts";

function publicCommandProbe(probe: Record<string, any> = {}) : any {
  return Object.freeze({
    found: probe.found === true,
    command: String(probe.command || "").trim()
  });
}

export class McpAgentFrameworkAdapterLayer {
  adapterKind: any;
  layerId: any;
  constructor({ layerId = "mcp", adapterKind = "agent-framework-mcp-adapter-layer" }: Record<string, any> = {}) {
    this.layerId = layerId;
    this.adapterKind = adapterKind;
  }

  supports(framework: Record<string, any> = {}) : any {
    return Boolean(framework?.mcp);
  }

  assembleFramework(framework: Record<string, any> = {}, context: Record<string, any> = {}) : any {
    const mcp: any = framework.mcp;
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
    const commandProbe: any = resolveCommandCandidate(uniqueStrings([...framework.commandNames, ...mcp.commandNames]), context);
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

export function createDefaultDownstreamClientAspectLayers() : any {
  return [new McpAgentFrameworkAdapterLayer()];
}
