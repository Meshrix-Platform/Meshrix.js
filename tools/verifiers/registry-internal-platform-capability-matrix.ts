import {
  MCP_SUPPORTED_TARGETS
} from "../../packages/protocols/mcp/adapter/mcp-release-targets.ts";

const MCP_SUPPORTED_TARGETS_REF: any = "$MCP_SUPPORTED_TARGETS";

export function validateInternalPlatformCapabilityMatrix(data?: any) : any {
  const issues: any[] = [];
  if (!Array.isArray(data.statusEnum) || data.statusEnum.length === 0) {
    issues.push("internal-platform-capability-matrix: statusEnum must be a non-empty array");
  }
  if (!Array.isArray(data.capabilities)) {
    issues.push("internal-platform-capability-matrix: capabilities must be an array");
    return issues;
  }
  const ids: any = new Set<any>();
  for (const capability of data.capabilities) {
    if (!capability.id) issues.push("internal-platform-capability-matrix: capability missing id");
    else if (ids.has(capability.id)) issues.push(`internal-platform-capability-matrix: duplicate capability "${capability.id}"`);
    else ids.add(capability.id);
    if (!capability.title) issues.push(`internal-platform-capability-matrix: capability "${capability.id || "(unnamed)"}" missing title`);
    for (const field of ["docs", "requirementRows", "requiredEdges"]) {
      if (!Array.isArray(capability[field])) {
        issues.push(`internal-platform-capability-matrix: capability "${capability.id || "(unnamed)"}" missing ${field} array`);
      }
    }
    if (capability.allowedMcpTargets !== undefined) {
      issues.push(...validateAllowedMcpTargets(capability));
    }
  }
  return issues;
}

function validateAllowedMcpTargets(capability: Record<string, any> = {}) : any {
  const issues: any[] = [];
  const label: any = `internal-platform-capability-matrix: capability "${capability.id || "(unnamed)"}"`;
  const value: any = capability.allowedMcpTargets;
  if (value === MCP_SUPPORTED_TARGETS_REF) {
    return issues;
  }
  if (typeof value === "string") {
    issues.push(`${label} uses unsupported allowedMcpTargets ref "${value}"`);
    return issues;
  }
  if (!Array.isArray(value)) {
    issues.push(`${label} allowedMcpTargets must be an array or ${MCP_SUPPORTED_TARGETS_REF}`);
    return issues;
  }
  if (value.length === 0) {
    issues.push(`${label} allowedMcpTargets must not be empty when declared`);
  }
  const supported: any = new Set<any>(MCP_SUPPORTED_TARGETS);
  const seen: any = new Set<any>();
  for (const target of value) {
    const normalized: any = String(target || "").trim();
    if (!normalized) {
      issues.push(`${label} allowedMcpTargets contains an empty target`);
      continue;
    }
    if (seen.has(normalized)) {
      issues.push(`${label} allowedMcpTargets duplicates "${normalized}"`);
    }
    seen.add(normalized);
    if (!supported.has(normalized)) {
      issues.push(`${label} allowedMcpTargets contains unsupported MCP target "${normalized}"`);
    }
  }
  return issues;
}
