#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLIENT_FINGERPRINT_VERSION,
  createProcessIdentityRequestHeaders,
  createProcessIdentityService,
  generateProcessIdentityClientKeyPair
} from "../../packages/foundation/src/security/process-identity/index.mjs";
import { createOperationPermissionStore } from "../../packages/capabilities/src/operation-permission-core/store.mjs";
import { createSecurityAlertStore } from "../../packages/foundation/src/security/security-alerts.mjs";
import { assertNoLeak } from "./lib/report-evidence-safety.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath = path.join(repoRoot, "build", "reports", "mcp-client-identity-proof.json");
const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-mcp-identity-"));

function request(headers = {}, url = "/mcp") {
  return {
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${globalThis.__token}`,
      "x-lico-mcp-target": "opencode",
      ...headers
    },
    socket: { remoteAddress: "127.0.0.1" }
  };
}

await fs.mkdir(path.dirname(reportPath), { recursive: true });
const processIdentity = createProcessIdentityService({ dataDir: userDataPath });
const securityPermissions = {
  processIdentity,
  verifyProcessIdentity: (input) => processIdentity.verifySignedRequest(input)
};
const store = createOperationPermissionStore({
  userDataPath,
  capabilityResolver: () => ["cap:api:mcp.request"],
  registry: {
    getCatalog: () => ({
      fingerprint: "verify",
      scopes: [{ id: "console:read" }],
      toolsets: [],
      tools: []
    })
  },
  securityPermissions
});
const alerts = createSecurityAlertStore({ userDataPath });

try {
  const keyPair = generateProcessIdentityClientKeyPair();
  const clientFingerprint = {
    fingerprintId: "verify-fp",
    machineInstanceId: "verify-machine",
    appInstanceId: "verify-app",
    runtimeInstanceId: "verify-runtime"
  };
  clientFingerprint.fingerprintHash = `sha256:${crypto
    .createHash("sha256")
    .update(Buffer.from([
      CLIENT_FINGERPRINT_VERSION,
      clientFingerprint.fingerprintId,
      clientFingerprint.machineInstanceId,
      clientFingerprint.appInstanceId,
      clientFingerprint.runtimeInstanceId
    ].join("\n"), "utf8"))
    .digest("base64url")}`;
  const issued = await processIdentity.issueLocalMcpClientIdentityPackage({
    input: {
      clientId: "opencode",
      installationId: "verify-install",
      processPublicKeyPem: keyPair.publicKeyPem,
      clientFingerprint,
      defaultIdentityHash: `sha256:${crypto
        .createHash("sha256")
        .update(Buffer.from([
          "v0.0.1:process-identity:mcp-default-identity-1",
          "opencode",
          "verify-install",
          keyPair.publicKeyHash,
          clientFingerprint.fingerprintHash
        ].join("\n"), "utf8"))
        .digest("base64url")}`
    }
  });
  assert.equal(issued.ok, true);
  const grant = await store.createGrant({
    label: "verify local mcp",
    type: "mcp-client",
    scopes: ["console:read"],
    capabilities: ["cap:api:mcp.request"],
    metadata: {
      issuedBy: "lico-mcp-local-pairing",
      mcpServer: "lico-mcp-server",
      clientTarget: "opencode",
      mcpTarget: "opencode",
      clientId: "opencode"
    }
  });
  globalThis.__token = grant.token;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const url = new URL("/mcp", "http://127.0.0.1");
  const missing = await store.authorizeRequest({
    request: request({}, "/mcp"),
    requestBody: body,
    url,
    method: "POST"
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reasonCode, "process_identity_headers_missing");
  const signedHeaders = createProcessIdentityRequestHeaders({
    privateKeyPem: keyPair.privateKeyPem,
    method: "POST",
    url,
    body,
    clientIdentityPackage: issued.clientIdentityPackage,
    nonce: "verify-nonce"
  });
  const signed = await store.authorizeRequest({
    request: request(signedHeaders, "/mcp"),
    requestBody: body,
    url,
    method: "POST"
  });
  assert.equal(signed.ok, true);
  const replay = await store.authorizeRequest({
    request: request(signedHeaders, "/mcp"),
    requestBody: body,
    url,
    method: "POST"
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.reasonCode, "process_identity_nonce_replay");
  const alertItems = alerts.listAlerts({ limit: 20 });
  assert.equal(alertItems.some((item) => item.reasonCode === "process_identity_headers_missing"), true);
  assert.equal(alertItems.some((item) => item.reasonCode === "process_identity_nonce_replay"), true);
  const report = {
    schemaVersion: "v0.0.1:process-identity:mcp-client-proof-report-1",
    generatedAt: new Date().toISOString(),
    verifier: "tools/server-scripts/verify-mcp-client-identity-proof.mjs",
    summary: {
      releaseReady: true,
      reportLeakScan: true,
      missingSignatureDenied: true,
      signedRequestAccepted: true,
      replayDenied: true,
      alertCount: alertItems.length
    }
  };
  assertNoLeak(report, "MCP client identity proof report");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log("[mcp-client-identity-proof] ok");
} finally {
  store.close();
  alerts.close();
  await fs.rm(userDataPath, { recursive: true, force: true });
}
