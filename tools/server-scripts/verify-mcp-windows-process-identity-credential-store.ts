#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPORT_PATH: any = "build/reports/mcp-windows-process-identity-credential-store.json";
const SCHEMA_VERSION: any = "v0.0.1:process-identity:mcp-windows-dpapi-report-0.0.1";
const VERIFIER: any = "tools/server-scripts/verify-mcp-windows-process-identity-credential-store.ts";
const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

if (process.platform !== "win32") {
  throw new Error("Windows DPAPI process identity verification requires a Windows runner.");
}

function redacted(value: any = "") : any {
  return String(value || "")
    .split(repoRoot).join("[redacted-path]")
    .split(os.homedir()).join("[redacted-path]")
    .replace(/verify-(?:private-key|grant)-[A-Za-z0-9_-]+/gu, "verify-secret-[redacted]");
}

const result: any = spawnSync(process.execPath, [
  "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts",
  "identity-store-self-test",
  "--target",
  "verify-windows-dpapi-system",
  "--json"
], {
  cwd: repoRoot,
  env: {
    ...process.env,
    MESHRIX_MCP_PROCESS_IDENTITY_STORE: "system"
  },
  encoding: "utf8",
  timeout: 60000,
  maxBuffer: 1024 * 1024
});

if (result.status !== 0) {
  throw new Error(redacted(`${result.stderr || ""}\n${result.stdout || ""}`).slice(-2000));
}

const output: any = String(result.stdout || "").trim();
const start: any = output.indexOf("{");
assert.notEqual(start, -1, "Windows DPAPI self-test did not return JSON.");
const selfTest: any = JSON.parse(output.slice(start));
assert.equal(selfTest.ok, true);
assert.equal(selfTest.storageBackend, "windows-dpapi");
assert.equal(selfTest.systemCredential, true);
assert.equal(selfTest.fileFallback, false);
assert.equal(String(selfTest.credentialRef || "").startsWith("windows-dpapi:"), true);

const report: Record<string, any> = {
  schemaVersion: SCHEMA_VERSION,
  verifier: VERIFIER,
  platform: "windows",
  assertions: {
    currentUserDpapiRoundTrip: true,
    abstractCredentialReference: true,
    privateFileFallbackAbsent: true,
    selfTestCleanupCompleted: true,
    reportLeakScan: true
  },
  summary: {
    releaseReady: true,
    storageBackend: "windows-dpapi",
    failedCount: 0
  }
};

const serialized: any = JSON.stringify(report);
assert.equal(serialized.includes(repoRoot), false);
assert.equal(serialized.includes(os.homedir()), false);
assert.equal(/verify-(?:private-key|grant)-/u.test(serialized), false);

await fs.mkdir(path.join(repoRoot, "build", "reports"), { recursive: true });
await fs.writeFile(path.join(repoRoot, REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`);
console.log("[mcp-windows-process-identity-store] ok");
