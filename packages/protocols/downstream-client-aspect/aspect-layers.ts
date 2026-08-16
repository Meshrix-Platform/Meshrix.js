import {
  DOWNSTREAM_CLIENT_ASPECT_PROTOCOL_VERSION,
  DOWNSTREAM_CLIENT_ASPECT_SERVICE_KIND
} from "./constants.ts";
import { publicMetadata, uniqueStrings } from "./identity-helpers.ts";
import { resolveCommandCandidate } from "./identity-helpers.ts";
import { protocolRecordBase } from "./audit-projection.ts";
import type {
  DownstreamAspectLayer,
  DownstreamAssemblyContext,
  DownstreamCapability,
  DownstreamFrameworkDefinition,
  UnknownRecord
} from "./types.ts";

function publicCommandProbe(probe: UnknownRecord = {}) {
  return Object.freeze({
    found: probe.found === true,
    command: String(probe.command || "").trim()
  });
}

export class McpAgentFrameworkAdapterLayer implements DownstreamAspectLayer {
  adapterKind: string;
  layerId: string;
  constructor({ layerId = "mcp", adapterKind = "agent-framework-mcp-adapter-layer" }: { layerId?: string; adapterKind?: string } = {}) {
    this.layerId = layerId;
    this.adapterKind = adapterKind;
  }

  supports(framework: DownstreamFrameworkDefinition): boolean {
    return Boolean(framework?.mcp);
  }

  assembleFramework(framework: DownstreamFrameworkDefinition, context: DownstreamAssemblyContext = {}): DownstreamCapability {
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

export function createDefaultDownstreamClientAspectLayers(): DownstreamAspectLayer[] {
  return [new McpAgentFrameworkAdapterLayer()];
}
