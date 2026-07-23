import crypto from "node:crypto";

export const UPSTREAM_FIXTURE_TRANSIT_REPORT_PATH = "build/reports/upstream-fixture-transit.json";
export const UPSTREAM_FIXTURE_TRANSIT_SCHEMA_VERSION = "v0.0.1:upstream-gateway:fixture-transit-report-1";
export const UPSTREAM_FIXTURE_TRANSIT_VERIFIER = "tools/server-scripts/verify-upstream-fixture-transit.mjs";
export const UPSTREAM_FIXTURE_TRANSIT_READINESS_SOURCE =
  "tools/server-scripts/lib/upstream-fixture-transit-evidence.mjs#createUpstreamFixtureTransitReadiness";

export const UPSTREAM_FIXTURE_REQUIRED_TOOL_NAMES = Object.freeze([
  "records.search",
  "records.get",
  "session.identity",
  "state.probe",
  "state.increment",
  "records.write",
  "records.purge"
]);

export const UPSTREAM_FIXTURE_SCHEMA_PARITY_TOOL_NAMES = Object.freeze([
  "records.search",
  "records.get"
]);

export function stableUpstreamFixtureRefHash(value = "") {
  const raw = String(value || "").trim();
  return raw ? crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12) : "";
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function includesEvery(actual, expected) {
  const set = new Set(asStringArray(actual));
  return expected.every((item) => set.has(item));
}

export function createUpstreamFixtureTransitReadiness(report = {}) {
  const record = asRecord(report);
  const summary = asRecord(record.summary);
  const evidence = asRecord(record.evidence);
  const restForwarding = asRecord(evidence.restForwarding);
  const restIdentityProof = asRecord(restForwarding.identityProof);
  const mcpTransit = asRecord(evidence.mcpTransit);
  const mcpIdentityProof = asRecord(mcpTransit.identityProof);
  const secretStoreCredentialBinding = asRecord(evidence.secretStoreCredentialBinding);
  const downstreamAgentProjection = asRecord(evidence.downstreamAgentProjection);
  const deniedCalls = asRecord(evidence.deniedCalls);
  const failure = asRecord(record.failure);
  const reasons = [];

  if (record.schemaVersion !== UPSTREAM_FIXTURE_TRANSIT_SCHEMA_VERSION) {
    reasons.push("upstream-fixture-transit-schema-mismatch");
  }
  if (record.verifier !== UPSTREAM_FIXTURE_TRANSIT_VERIFIER) {
    reasons.push("upstream-fixture-transit-verifier-mismatch");
  }
  if (summary.reportLeakScan !== true) {
    reasons.push("upstream-fixture-transit-report-leak-scan-missing");
  }
  if (summary.serviceConfigured !== true) {
    reasons.push("upstream-fixture-transit-service-not-configured");
  }
  if (summary.selfContained !== true) {
    reasons.push("upstream-fixture-transit-not-self-contained");
  }
  if (Object.keys(failure).length > 0) {
    reasons.push("upstream-fixture-transit-runtime-failure");
  }
  if (!evidence || Object.keys(evidence).length === 0) {
    reasons.push("upstream-fixture-transit-evidence-missing");
  }

  if (restForwarding.recordsListOk !== true) {
    reasons.push("upstream-fixture-transit-rest-records-list-not-ok");
  }
  if (restForwarding.recordsListAuditIdPresent !== true) {
    reasons.push("upstream-fixture-transit-rest-audit-missing");
  }
  if (restForwarding.responseSchemaValidated !== true) {
    reasons.push("upstream-fixture-transit-rest-response-schema-not-validated");
  }
  if (restForwarding.credentialHeaderInjectionProven !== true) {
    reasons.push("upstream-fixture-transit-rest-credential-header-injection-not-proven");
  }
  if (restForwarding.echoOk !== true) {
    reasons.push("upstream-fixture-transit-rest-echo-not-ok");
  }
  if (restIdentityProof.principalPresent !== true || !restIdentityProof.principalHash) {
    reasons.push("upstream-fixture-transit-rest-identity-principal-proof-missing");
  }
  if (restIdentityProof.accountIdPresent !== true || !restIdentityProof.accountIdHash) {
    reasons.push("upstream-fixture-transit-rest-identity-account-proof-missing");
  }
  if (restIdentityProof.tokenProofMatchesIssuedCredential !== true) {
    reasons.push("upstream-fixture-transit-rest-identity-token-proof-mismatch");
  }
  if (restIdentityProof.rawIdentityRedacted !== true) {
    reasons.push("upstream-fixture-transit-rest-identity-redaction-missing");
  }

  if (Number(mcpTransit.directToolCount || 0) <= 0) {
    reasons.push("upstream-fixture-transit-direct-tool-count-empty");
  }
  if (Number(mcpTransit.projectedToolCount || 0) <= 0) {
    reasons.push("upstream-fixture-transit-projected-tool-count-empty");
  }
  if (!includesEvery(mcpTransit.requiredToolsPresent, UPSTREAM_FIXTURE_REQUIRED_TOOL_NAMES)) {
    reasons.push("upstream-fixture-transit-required-tools-incomplete");
  }
  if (!includesEvery(mcpTransit.schemaParityTools, UPSTREAM_FIXTURE_SCHEMA_PARITY_TOOL_NAMES)) {
    reasons.push("upstream-fixture-transit-schema-parity-tools-incomplete");
  }
  if (mcpTransit.readOnlyCallOk !== true) {
    reasons.push("upstream-fixture-transit-mcp-readonly-call-not-ok");
  }
  if (mcpTransit.readOnlyCallAuditIdPresent !== true) {
    reasons.push("upstream-fixture-transit-mcp-readonly-audit-missing");
  }
  if (mcpTransit.credentialEnvInjectionProven !== true) {
    reasons.push("upstream-fixture-transit-mcp-credential-env-injection-not-proven");
  }
  if (mcpIdentityProof.principalPresent !== true || !mcpIdentityProof.principalHash) {
    reasons.push("upstream-fixture-transit-mcp-identity-principal-proof-missing");
  }
  if (mcpIdentityProof.accountIdPresent !== true || !mcpIdentityProof.accountIdHash) {
    reasons.push("upstream-fixture-transit-mcp-identity-account-proof-missing");
  }
  if (mcpIdentityProof.tokenProofMatchesIssuedCredential !== true) {
    reasons.push("upstream-fixture-transit-mcp-identity-token-proof-mismatch");
  }
  if (mcpIdentityProof.rawIdentityRedacted !== true) {
    reasons.push("upstream-fixture-transit-mcp-identity-redaction-missing");
  }
  if (mcpTransit.httpTransportListOk !== true) {
    reasons.push("upstream-fixture-transit-mcp-http-transport-list-not-ok");
  }
  if (mcpTransit.httpTransportCallOk !== true) {
    reasons.push("upstream-fixture-transit-mcp-http-transport-call-not-ok");
  }
  if (mcpTransit.stdioStatefulIncrementProbeProven !== true) {
    reasons.push("upstream-fixture-transit-mcp-stdio-increment-probe-not-proven");
  }
  if (
    mcpTransit.stdioStatefulSessionReuseProven !== true ||
    Number(mcpTransit.stdioStatefulSessionObservedCallCount || 0) < 3
  ) {
    reasons.push("upstream-fixture-transit-mcp-stdio-stateful-session-not-proven");
  }

  if (secretStoreCredentialBinding.accepted !== true) {
    reasons.push("upstream-fixture-transit-secret-store-credential-binding-not-accepted");
  }
  if (Number(secretStoreCredentialBinding.serviceCredentialRefCount || 0) <= 0) {
    reasons.push("upstream-fixture-transit-secret-store-credential-ref-missing");
  }
  if (Number(secretStoreCredentialBinding.resolvedCredentialRefCount || 0) !==
    Number(secretStoreCredentialBinding.serviceCredentialRefCount || 0)) {
    reasons.push("upstream-fixture-transit-secret-store-credential-ref-not-resolved");
  }
  if (!secretStoreCredentialBinding.credentialRefHash) {
    reasons.push("upstream-fixture-transit-secret-store-credential-ref-hash-missing");
  }
  if (secretStoreCredentialBinding.descriptorHasInlineCredential !== false) {
    reasons.push("upstream-fixture-transit-inline-credential-present");
  }
  if (secretStoreCredentialBinding.rawSecretRedacted !== true) {
    reasons.push("upstream-fixture-transit-secret-store-redaction-missing");
  }

  if (downstreamAgentProjection.readOnlyToolVisible !== true) {
    reasons.push("upstream-fixture-transit-downstream-readonly-tool-hidden");
  }
  if (downstreamAgentProjection.identityToolVisible !== true) {
    reasons.push("upstream-fixture-transit-downstream-identity-tool-hidden");
  }
  if (downstreamAgentProjection.destructiveToolHidden !== true) {
    reasons.push("upstream-fixture-transit-downstream-destructive-tool-visible");
  }
  if (downstreamAgentProjection.readOnlyCallOk !== true) {
    reasons.push("upstream-fixture-transit-downstream-readonly-call-not-ok");
  }
  if (downstreamAgentProjection.identityCallOk !== true) {
    reasons.push("upstream-fixture-transit-downstream-identity-call-not-ok");
  }

  if (deniedCalls.missingReadScopeRejected !== true) {
    reasons.push("upstream-fixture-transit-missing-read-scope-not-rejected");
  }
  if (deniedCalls.destructiveWithoutApproval !== "pending_approval") {
    reasons.push("upstream-fixture-transit-destructive-without-approval-not-pending");
  }

  const releaseReady = reasons.length === 0;
  return {
    sourceOfTruth: UPSTREAM_FIXTURE_TRANSIT_READINESS_SOURCE,
    report: UPSTREAM_FIXTURE_TRANSIT_REPORT_PATH,
    releaseReady,
    liveStatus: releaseReady ? "passed" : "failed",
    reasons,
    requiredToolNames: [...UPSTREAM_FIXTURE_REQUIRED_TOOL_NAMES],
    schemaParityToolNames: [...UPSTREAM_FIXTURE_SCHEMA_PARITY_TOOL_NAMES]
  };
}
