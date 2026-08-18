export const UPSTREAM_MCP_GATEWAY_REPORT_PATH: any = "build/reports/upstream-mcp-gateway-e2e.json";
export const UPSTREAM_MCP_GATEWAY_SCHEMA_VERSION: any = "v0.0.1:upstream-gateway:mcp-e2e-report-1";
export const UPSTREAM_MCP_GATEWAY_VERIFIER: any = "tools/server-scripts/verify-upstream-mcp-gateway-e2e.ts";
export const UPSTREAM_MCP_GATEWAY_READINESS_SOURCE: any =
  "tools/server-scripts/lib/upstream-mcp-gateway-evidence.ts#createUpstreamMcpGatewayReadiness";

export const UPSTREAM_MCP_GATEWAY_REQUIRED_TEST_NAMES: readonly any[] = Object.freeze([
  "load stdio MCP upstream service from the durable manifest snapshot",
  "create scoped API key with upstream MCP visibility",
  "downstream MCP tools/list exposes upstream MCP tool",
  "downstream MCP tools/call reaches upstream MCP tools/call",
  "failed upstream MCP tools/call opens service circuit",
  "approval-required upstream MCP call resumes exactly once with credential binding",
  "rejected and duplicate upstream MCP resolutions have no upstream side effects",
  "expired upstream MCP approval has no upstream side effects",
  "upstream MCP approval lifecycle emits bound audit evidence"
]);

function asRecord(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value?: any) : any {
  return Array.isArray(value) ? value : [];
}

function testEvidenceByName(report: Record<string, any> = {}) : any {
  return new Map<any, any>(asArray(report.tests).map((item?: any) : any => [String(item?.name || ""), asRecord(item)]));
}

export function createUpstreamMcpGatewayReadiness(report: Record<string, any> = {}) : any {
  const record: any = asRecord(report);
  const summary: any = asRecord(record.summary);
  const tests: any = testEvidenceByName(record);
  const approval: any = asRecord(tests.get(
    "approval-required upstream MCP call resumes exactly once with credential binding"
  )?.evidence);
  const rejected: any = asRecord(tests.get(
    "rejected and duplicate upstream MCP resolutions have no upstream side effects"
  )?.evidence);
  const expired: any = asRecord(tests.get(
    "expired upstream MCP approval has no upstream side effects"
  )?.evidence);
  const audit: any = asRecord(tests.get(
    "upstream MCP approval lifecycle emits bound audit evidence"
  )?.evidence);
  const reasons: any[] = [];

  if (record.schemaVersion !== UPSTREAM_MCP_GATEWAY_SCHEMA_VERSION) {
    reasons.push("upstream-mcp-gateway-schema-mismatch");
  }
  if (record.verifier !== UPSTREAM_MCP_GATEWAY_VERIFIER) {
    reasons.push("upstream-mcp-gateway-verifier-mismatch");
  }
  if (summary.reportLeakScan !== true) {
    reasons.push("upstream-mcp-gateway-report-leak-scan-missing");
  }
  if (Number(summary.failedCount || 0) !== 0) {
    reasons.push(`upstream-mcp-gateway-failed-count:${Number(summary.failedCount || 0)}`);
  }
  for (const [field, reason] of [
    ["approvalResumeVerified", "upstream-mcp-gateway-approval-resume-summary-missing"],
    ["approvalExactlyOnceVerified", "upstream-mcp-gateway-approval-exactly-once-summary-missing"],
    ["approvalDenialNoSideEffectVerified", "upstream-mcp-gateway-denial-side-effect-summary-missing"],
    ["approvalExpiryNoSideEffectVerified", "upstream-mcp-gateway-expiry-side-effect-summary-missing"],
    ["duplicateResolutionNoSideEffectVerified", "upstream-mcp-gateway-duplicate-resolution-summary-missing"],
    ["approvalAuditVerified", "upstream-mcp-gateway-approval-audit-summary-missing"],
    ["credentialBindingVerified", "upstream-mcp-gateway-credential-binding-summary-missing"]
  ]) {
    if (summary[field] !== true) reasons.push(reason);
  }

  for (const name of UPSTREAM_MCP_GATEWAY_REQUIRED_TEST_NAMES) {
    const item: any = tests.get(name);
    if (!item) {
      reasons.push(`upstream-mcp-gateway-required-test-missing:${name}`);
    } else if (item.status !== "passed") {
      reasons.push(`upstream-mcp-gateway-required-test-failed:${name}`);
    }
  }

  if (
    approval.pendingBeforeForward !== true ||
    approval.resumeCompleted !== true ||
    Number(approval.upstreamHitDelta) !== 1 ||
    approval.duplicateResolveRejected !== true
  ) {
    reasons.push("upstream-mcp-gateway-approval-resume-exactly-once-missing");
  }
  if (
    approval.credentialBindingAuthorized !== true ||
    approval.credentialInjectionAccepted !== true
  ) {
    reasons.push("upstream-mcp-gateway-approval-credential-binding-missing");
  }
  if (
    rejected.rejected !== true ||
    Number(rejected.upstreamHitDelta) !== 0 ||
    rejected.duplicateResolveRejected !== true
  ) {
    reasons.push("upstream-mcp-gateway-rejected-resolution-side-effect-guard-missing");
  }
  if (
    expired.expired !== true ||
    Number(expired.upstreamHitDelta) !== 0 ||
    expired.resolveRejected !== true
  ) {
    reasons.push("upstream-mcp-gateway-expired-resolution-side-effect-guard-missing");
  }
  if (
    Number(audit.gatewayCompletedCount) !== 1 ||
    Number(audit.operationPermissionPendingCount) < 3 ||
    Number(audit.operationPermissionCompletedCount) !== 1 ||
    audit.boundGrantAuditVerified !== true ||
    audit.rawCredentialRedacted !== true
  ) {
    reasons.push("upstream-mcp-gateway-approval-audit-binding-missing");
  }

  const releaseReady: any = reasons.length === 0;
  return {
    sourceOfTruth: UPSTREAM_MCP_GATEWAY_READINESS_SOURCE,
    report: UPSTREAM_MCP_GATEWAY_REPORT_PATH,
    releaseReady,
    readyField: "summary.releaseReady",
    coverageReady: releaseReady,
    liveStatus: releaseReady ? "passed" : "failed",
    reasons,
    requiredTestNames: [...UPSTREAM_MCP_GATEWAY_REQUIRED_TEST_NAMES]
  };
}
