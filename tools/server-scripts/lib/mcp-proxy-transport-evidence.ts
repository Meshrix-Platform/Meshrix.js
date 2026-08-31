import {
  MCP_SUPPORTED_TARGETS
} from "../../../packages/protocols/mcp/adapter/mcp-release-targets.ts";

export const MCP_PROXY_TRANSPORT_REPORT_PATH: any = "build/reports/mcp-proxy-transport.json";
export const MCP_PROXY_TRANSPORT_SCHEMA_VERSION: any = "v0.0.1:mcp:proxy-transport-report-1";
export const MCP_PROXY_TRANSPORT_VERIFIER: any = "tools/server-scripts/verify-mcp-proxy-transport.ts";
export const MCP_PROXY_TRANSPORT_READINESS_SOURCE: any =
  "tools/server-scripts/lib/mcp-proxy-transport-evidence.ts#createMcpProxyTransportReadiness";

function asRecord(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function createMcpProxyTransportReadiness(report: Record<string, any> = {}) : any {
  const record: any = asRecord(report);
  const summary: any = asRecord(record.summary);
  const targets: any = Array.isArray(record.targets) ? record.targets.map(asRecord) : [];
  const byTarget: any = new Map<any, any>(targets.map((row?: any) : any => [String(row.target || ""), row]));
  const reasons: any[] = [];

  if (record.schemaVersion !== MCP_PROXY_TRANSPORT_SCHEMA_VERSION) {
    reasons.push("mcp-proxy-transport-schema-mismatch");
  }
  if (record.verifier !== MCP_PROXY_TRANSPORT_VERIFIER) {
    reasons.push("mcp-proxy-transport-verifier-mismatch");
  }
  if (summary.reportLeakScan !== true) {
    reasons.push("mcp-proxy-transport-report-leak-scan-missing");
  }
  if (Number(summary.failedCount || 0) !== 0) {
    reasons.push(`mcp-proxy-transport-failed-count:${Number(summary.failedCount || 0)}`);
  }
  if (Number(summary.unexecutedCount ?? MCP_SUPPORTED_TARGETS.length) !== 0) {
    reasons.push(`mcp-proxy-transport-unexecuted-count:${Number(summary.unexecutedCount ?? MCP_SUPPORTED_TARGETS.length)}`);
  }
  if (targets.length !== MCP_SUPPORTED_TARGETS.length || byTarget.size !== MCP_SUPPORTED_TARGETS.length) {
    reasons.push("mcp-proxy-transport-target-cardinality-invalid");
  }
  for (const target of MCP_SUPPORTED_TARGETS) {
    const row: any = byTarget.get(target);
    if (!row) {
      reasons.push(`mcp-proxy-transport-target-missing:${target}`);
      continue;
    }
    if (row.status !== "verified") {
      reasons.push(`mcp-proxy-transport-target-not-verified:${target}:${String(row.status || "missing")}`);
    }
    if (row.proxyTransport !== "stdio-jsonl") {
      reasons.push(`mcp-proxy-transport-target-transport-mismatch:${target}`);
    }
    const profile: any = asRecord(row.clientProtocolProfile);
    if (profile.target !== target || profile.framing !== "jsonl") {
      reasons.push(`mcp-proxy-transport-client-profile-mismatch:${target}`);
    }
    if (String(profile.source || "") !== "neutral-protocol-peer") {
      reasons.push(`mcp-proxy-transport-client-profile-source-invalid:${target}`);
    }
    if (row.processIdentityStored !== true) {
      reasons.push(`mcp-proxy-transport-process-identity-not-stored:${target}`);
    }
    if (
      row.initialized !== true ||
      row.initializedNotificationSent !== true ||
      row.toolsListed !== true ||
      row.healthCallOk !== true
    ) {
      reasons.push(`mcp-proxy-transport-protocol-incomplete:${target}`);
    }
    if (Number(row.unexpectedNotificationResponses ?? -1) !== 0) {
      reasons.push(`mcp-proxy-transport-notification-response-invalid:${target}`);
    }
  }
  if (summary.releaseReady !== undefined && summary.releaseReady !== (reasons.length === 0)) {
    reasons.push("mcp-proxy-transport-release-ready-mismatch");
  }

  const releaseReady: any = reasons.length === 0;
  return {
    sourceOfTruth: MCP_PROXY_TRANSPORT_READINESS_SOURCE,
    report: MCP_PROXY_TRANSPORT_REPORT_PATH,
    releaseReady,
    coverageReady: releaseReady,
    liveStatus: releaseReady ? "passed" : "failed",
    requiredTargets: [...MCP_SUPPORTED_TARGETS],
    verifiedTargets: targets
      .filter((row?: any) : any => row.status === "verified")
      .map((row?: any) : any => String(row.target || "")),
    reasons
  };
}
