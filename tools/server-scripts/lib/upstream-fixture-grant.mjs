import {
  compileUpstreamOperationCapability
} from "../../../packages/agents/src/upstream-gateway/operation-capability.mjs";
import { verifierOpaqueServiceId } from "./upstream-gateway-verifier-publication.mjs";

export const UPSTREAM_FIXTURE_MCP_SERVICE_ID = verifierOpaqueServiceId("fixture-mcp");
export const UPSTREAM_FIXTURE_REST_SERVICE_ID = verifierOpaqueServiceId("fixture-rest");
export const UPSTREAM_FIXTURE_TOOL_PREFIX = "fixture";

export const UPSTREAM_FIXTURE_GRANTED_TOOL_NAMES = Object.freeze([
  "records.search",
  "session.identity"
]);

/**
 * Derive the upstream fixture tool names a scenario needs the grant to expose:
 * every non-denied tools/call target plus every expected-visible tool. Denied
 * tools stay out of the grant so denial turns exercise real gateway rejection.
 */
export function upstreamFixtureScenarioToolNames(turns = []) {
  const publicPrefix = `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.`;
  const names = new Set();
  const collect = (publicToolName) => {
    const raw = String(publicToolName || "");
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
} = {}) {
  const credentialRefs = String(secretRef || "").trim() ? [String(secretRef).trim()] : [];
  const serviceCapability = compileUpstreamOperationCapability(
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
  const capabilities = [serviceCapability, ...toolNames.map((upstreamToolName) =>
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
    dynamicCapabilities: Object.freeze(capabilities.map((item) => item.capabilityId)),
    allowedServiceIds: Object.freeze([serviceId]),
    allowedSecretBindings: Object.freeze([
      ...new Set(capabilities.flatMap((item) => item.credentialBindingIds))
    ])
  });
}
