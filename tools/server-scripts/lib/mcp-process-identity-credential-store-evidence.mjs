import process from "node:process";

export const MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_REPORT_PATH =
  "build/reports/mcp-process-identity-credential-store.json";
export const MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_SCHEMA_VERSION =
  "v0.0.1:process-identity:mcp-credential-store-report-0.0.3";
export const MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_VERIFIER =
  "tools/server-scripts/verify-mcp-process-identity-credential-store.mjs";
export const MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_READINESS_SOURCE =
  "tools/server-scripts/lib/mcp-process-identity-credential-store-evidence.mjs#createMcpProcessIdentityCredentialStoreReadiness";

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function passedTest(report = {}, name = "", predicate = () => true) {
  return asArray(report.tests).some((item) =>
    item?.name === name &&
    item?.status === "passed" &&
    predicate(asRecord(item.evidence))
  );
}

export function currentPlatformSystemBackends(platform = process.platform) {
  if (platform === "darwin") {
    return ["macos-keychain"];
  }
  if (platform === "linux") {
    return ["linux-secret-service", "linux-kernel-keyring"];
  }
  if (platform === "win32") {
    return ["windows-dpapi"];
  }
  return [];
}

export function createMcpProcessIdentityCredentialStoreReadiness(report = {}, options = {}) {
  const record = asRecord(report);
  const summary = asRecord(record.summary);
  const platform = String(options.platform || process.platform || "");
  const expectedBackends = currentPlatformSystemBackends(platform);
  const reportedPlatform = String(summary.platform || "");
  const backend = String(summary.currentPlatformSystemCredentialBackend || "");
  const failedCount = Number(summary.failedCount || 0);
  const privateFileFallbackPassed = summary.privateFileFallbackPassed === true &&
    passedTest(record, "private file fallback remains explicit and 0600 scoped", (evidence) =>
      evidence.storageBackend === "private-file-fallback" &&
      evidence.fileFallback === true &&
      evidence.fileModeChecked === true);
  const explicitSystemNoFileFallbackPassed = summary.explicitSystemNoFileFallbackPassed === true &&
    passedTest(record, "explicit system mode does not read private file fallback", (evidence) =>
      evidence.explicitSystemLoadNull === true &&
      evidence.fileFallbackStillExplicit === true);
  const currentPlatformSystemCredentialPassed = summary.currentPlatformSystemCredentialReady === true &&
    passedTest(record, "current platform system credential store is release-ready", (evidence) =>
      evidence.platform === platform &&
      evidence.systemCredential === true &&
      evidence.fileFallback === false &&
      expectedBackends.includes(evidence.storageBackend));
  const linuxContainerSecretServicePassed = summary.linuxContainerSecretServicePassed === true &&
    passedTest(record, "Linux container Secret Service stores process identity", (evidence) =>
      evidence.storageBackend === "linux-secret-service" &&
      evidence.systemCredential === true &&
      evidence.fileFallback === false);
  const reasons = [];

  if (record.schemaVersion !== MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_SCHEMA_VERSION) {
    reasons.push("mcp-process-identity-credential-store-schema-mismatch");
  }
  if (record.verifier !== MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_VERIFIER) {
    reasons.push("mcp-process-identity-credential-store-verifier-mismatch");
  }
  if (summary.reportLeakScan !== true) {
    reasons.push("mcp-process-identity-credential-store-report-leak-scan-missing");
  }
  if (failedCount !== 0) {
    reasons.push("mcp-process-identity-credential-store-failed-tests");
  }
  if (privateFileFallbackPassed !== true) {
    reasons.push("mcp-process-identity-credential-store-file-fallback-not-proven");
  }
  if (explicitSystemNoFileFallbackPassed !== true) {
    reasons.push("mcp-process-identity-credential-store-explicit-system-file-fallback-not-denied");
  }
  if (reportedPlatform !== platform) {
    reasons.push("mcp-process-identity-credential-store-platform-mismatch");
  }
  if (expectedBackends.length === 0) {
    reasons.push("mcp-process-identity-credential-store-platform-backend-unsupported");
  }
  if (currentPlatformSystemCredentialPassed !== true) {
    reasons.push("mcp-process-identity-credential-store-current-platform-system-backend-not-ready");
  }
  if (!expectedBackends.includes(backend)) {
    reasons.push("mcp-process-identity-credential-store-current-platform-system-backend-mismatch");
  }
  if (linuxContainerSecretServicePassed !== true) {
    reasons.push("mcp-process-identity-credential-store-linux-secret-service-portability-not-proven");
  }

  return {
    sourceOfTruth: MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_READINESS_SOURCE,
    report: MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_REPORT_PATH,
    releaseReady: reasons.length === 0,
    platform,
    expectedBackends,
    currentPlatformSystemCredentialBackend: backend,
    currentPlatformSystemCredentialReady: currentPlatformSystemCredentialPassed,
    linuxContainerSecretServiceReady: linuxContainerSecretServicePassed,
    privateFileFallbackReady: privateFileFallbackPassed,
    explicitSystemNoFileFallbackReady: explicitSystemNoFileFallbackPassed,
    reasons
  };
}
