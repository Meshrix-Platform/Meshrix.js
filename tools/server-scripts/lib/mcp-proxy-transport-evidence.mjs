import {
  MCP_SUPPORTED_TARGETS
} from "../../../packages/protocols/mcp/adapter/mcp-release-targets.mjs";

export const MCP_PROXY_TRANSPORT_REPORT_PATH = "build/reports/mcp-proxy-transport.json";
export const MCP_PROXY_TRANSPORT_SCHEMA_VERSION = "v0.0.1:mcp:proxy-transport-report-1";
export const MCP_PROXY_TRANSPORT_VERIFIER = "tools/server-scripts/verify-mcp-proxy-transport.mjs";
export const MCP_PROXY_TRANSPORT_READINESS_SOURCE =
  "tools/server-scripts/lib/mcp-proxy-transport-evidence.mjs#createMcpProxyTransportReadiness";

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function createMcpProxyTransportReadiness(report = {}) {
  const record = asRecord(report);
  const summary = asRecord(record.summary);
  const targets = Array.isArray(record.targets) ? record.targets.map(asRecord) : [];
  const byTarget = new Map(targets.map((row) => [String(row.target || ""), row]));
  const reasons = [];

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
  for (const target of MCP_SUPPORTED_TARGETS) {
    const row = byTarget.get(target);
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
    const profile = asRecord(row.clientProtocolProfile);
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

  const releaseReady = reasons.length === 0;
  return {
    sourceOfTruth: MCP_PROXY_TRANSPORT_READINESS_SOURCE,
    report: MCP_PROXY_TRANSPORT_REPORT_PATH,
    releaseReady,
    coverageReady: releaseReady,
    liveStatus: releaseReady ? "passed" : "failed",
    requiredTargets: [...MCP_SUPPORTED_TARGETS],
    verifiedTargets: targets
      .filter((row) => row.status === "verified")
      .map((row) => String(row.target || "")),
    reasons
  };
}
