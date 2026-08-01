import {
  compileUpstreamOperationCapability
} from "../../../packages/agents/src/upstream-gateway/operation-capability.ts";
import { verifierOpaqueServiceId } from "./upstream-gateway-verifier-publication.ts";

export const UPSTREAM_FIXTURE_MCP_SERVICE_ID: any = verifierOpaqueServiceId("fixture-mcp");
export const UPSTREAM_FIXTURE_REST_SERVICE_ID: any = verifierOpaqueServiceId("fixture-rest");
export const UPSTREAM_FIXTURE_TOOL_PREFIX: any = "fixture";

export const UPSTREAM_FIXTURE_GRANTED_TOOL_NAMES: readonly any[] = Object.freeze([
  "records.search",
  "session.identity"
]);

/**
 * Derive the upstream fixture tool names a scenario needs the grant to expose:
 * every non-denied tools/call target plus every expected-visible tool. Denied
 * tools stay out of the grant so denial turns exercise real gateway rejection.
 */
export function upstreamFixtureScenarioToolNames(turns: any = []) : any {
  const publicPrefix: any = `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.`;
  const names: any = new Set<any>();
  const collect: any = (publicToolName?: any) : any => {
    const raw: any = String(publicToolName || "");
    if (raw.startsWith(publicPrefix)) {
      names.add(raw.slice(publicPrefix.length));
    }
  };
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (turn?.kind === "tools/call" && turn?.expect?.deniedTool !== true) {
      collect(turn.toolName);
    }
    for (const visibleToolName of turn?.expect?.visibleTools || []) {
      collect(visibleToolName);
    }
  }
  return names.size > 0 ? [...names] : [...UPSTREAM_FIXTURE_GRANTED_TOOL_NAMES];
}

export function upstreamFixtureGrantBindings({
  serviceId = UPSTREAM_FIXTURE_MCP_SERVICE_ID,
  secretRef = "",
  toolNames = UPSTREAM_FIXTURE_GRANTED_TOOL_NAMES
}: Record<string, any> = {}) : any {
  const credentialRefs: any = String(secretRef || "").trim() ? [String(secretRef).trim()] : [];
  const serviceCapability: any = compileUpstreamOperationCapability(
    {
      serviceId,
      serviceProtocol: "mcp",
      credentialRefs
    },
    {
      operationKey: "tools/call",
      protocol: "mcp",
      risk: "safe_write",
      requiredScopes: ["gateway:write"]
    }
  );
  const capabilities: any[] = [serviceCapability, ...toolNames.map((upstreamToolName?: any) : any =>
    compileUpstreamOperationCapability(
      {
        serviceId,
        serviceProtocol: "mcp",
        credentialRefs
      },
      {
        operationKey: "tools/call",
        upstreamToolName,
        risk: "read_only"
      },
      { upstreamToolName }
    )
  )];
  return Object.freeze({
    dynamicCapabilities: Object.freeze(capabilities.map((item?: any) : any => item.capabilityId)),
    allowedServiceIds: Object.freeze([serviceId]),
    allowedSecretBindings: Object.freeze([
      ...new Set<any>(capabilities.flatMap((item?: any) : any => item.credentialBindingIds))
    ])
  });
}
