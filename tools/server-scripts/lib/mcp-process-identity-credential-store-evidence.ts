import process from "node:process";

export const MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_REPORT_PATH: any =
  "build/reports/mcp-process-identity-credential-store.json";
export const MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_SCHEMA_VERSION: any =
  "v0.0.1:process-identity:mcp-credential-store-report-0.0.3";
export const MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_VERIFIER: any =
  "tools/server-scripts/verify-mcp-process-identity-credential-store.ts";
export const MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_READINESS_SOURCE: any =
  "tools/server-scripts/lib/mcp-process-identity-credential-store-evidence.ts#createMcpProcessIdentityCredentialStoreReadiness";

function asRecord(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value?: any) : any {
  return Array.isArray(value) ? value : [];
}

function passedTest(report: Record<string, any> = {}, name: any = "", predicate: any = () : any => true) : any {
  return asArray(report.tests).some((item?: any) : any =>
    item?.name === name &&
    item?.status === "passed" &&
    predicate(asRecord(item.evidence))
  );
}

export function currentPlatformSystemBackends(platform: any = process.platform) : any {
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

export function createMcpProcessIdentityCredentialStoreReadiness(report: Record<string, any> = {}, options: Record<string, any> = {}) : any {
  const record: any = asRecord(report);
  const summary: any = asRecord(record.summary);
  const platform: any = String(options.platform || process.platform || "");
  const expectedBackends: any = currentPlatformSystemBackends(platform);
  const reportedPlatform: any = String(summary.platform || "");
  const backend: any = String(summary.currentPlatformSystemCredentialBackend || "");
  const failedCount: any = Number(summary.failedCount || 0);
  const privateFileFallbackPassed: any = summary.privateFileFallbackPassed === true &&
    passedTest(record, "private file fallback remains explicit and 0600 scoped", (evidence?: any) : any =>
      evidence.storageBackend === "private-file-fallback" &&
      evidence.fileFallback === true &&
      evidence.fileModeChecked === true);
  const explicitSystemNoFileFallbackPassed: any = summary.explicitSystemNoFileFallbackPassed === true &&
    passedTest(record, "explicit system mode does not read private file fallback", (evidence?: any) : any =>
      evidence.explicitSystemLoadNull === true &&
      evidence.fileFallbackStillExplicit === true);
  const currentPlatformSystemCredentialPassed: any = summary.currentPlatformSystemCredentialReady === true &&
    passedTest(record, "current platform system credential store is release-ready", (evidence?: any) : any =>
      evidence.platform === platform &&
      evidence.systemCredential === true &&
      evidence.fileFallback === false &&
      expectedBackends.includes(evidence.storageBackend));
  const linuxContainerSecretServicePassed: any = summary.linuxContainerSecretServicePassed === true &&
    passedTest(record, "Linux container Secret Service stores process identity", (evidence?: any) : any =>
      evidence.storageBackend === "linux-secret-service" &&
      evidence.systemCredential === true &&
      evidence.fileFallback === false);
  const reasons: any[] = [];

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
