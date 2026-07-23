#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import { installAuthenticatedFetch } from "./test-auth-helper.mjs";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.mjs";
import { issueVerifierLocalMcpGrant } from "./lib/local-mcp-device-authorization.mjs";
import {
  createSignedMcpHeaders,
  createVerifierMcpProcessIdentity
} from "./mcp-process-identity-test-helper.mjs";

const REPORT_PATH = "build/reports/operation-permission-external-http-boundary.json";
const AGENT_PROFILE_ID = "verify-http-boundary-agent";

const restoreCapabilityKernelEnv = useIsolatedCapabilityKernelForVerifier();
const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-tool-http-boundary-"));
const dynamicSecretNeedles = new Set();
const mcpIdentityByToken = new Map();
const report = {
  schemaVersion: "v0.0.1:operation-permission:external-http-boundary-report-1",
  verifier: "tools/server-scripts/verify-operation-permission-external-http-boundary.mjs",
  startedAt: new Date().toISOString(),
  tests: [],
  destructiveTests: [],
  summary: {}
};

let server = null;

function safeEvidence(value = {}) {
  return JSON.parse(JSON.stringify(value, (_, child) => {
    if (typeof child !== "string") return child;
    for (const needle of dynamicSecretNeedles) {
      if (needle && child.includes(needle)) return "[redacted-dynamic-secret]";
    }
    if (child.includes(userDataPath) || child.includes(os.homedir())) return "[redacted-local-path]";
    if (/Bearer\s+\S+/i.test(child) || /lico_[a-z0-9_-]+=/i.test(child)) return "[redacted-secret]";
    if (/grant_|tool_exec|trace_|policy_/i.test(child)) return "[redacted-runtime-id]";
    return child;
  }));
}

function assertNoLeak(value, label = "payload") {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(userDataPath), false, `${label} leaked verifier data path`);
  assert.equal(serialized.includes(os.homedir()), false, `${label} leaked user home path`);
  for (const needle of dynamicSecretNeedles) {
    assert.equal(needle ? serialized.includes(needle) : false, false, `${label} leaked dynamic secret`);
  }
  assert.equal(/Bearer\s+\S+/i.test(serialized), false, `${label} leaked bearer token`);
  assert.equal(/lico_[a-z0-9_-]+=/i.test(serialized), false, `${label} leaked cookie`);
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  report.summary.testCount = report.tests.length;
  report.summary.destructiveTestCount = report.destructiveTests.length;
  report.summary.failedCount = [...report.tests, ...report.destructiveTests].filter((item) => item.status !== "passed").length;
  report.summary.releaseReady = report.summary.failedCount === 0;
  assertNoLeak(report, "operation permission external HTTP boundary report");
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function record(collection, name, status, evidence = {}) {
  collection.push({ name, status, evidence: safeEvidence(evidence) });
}

function failureEvidence(error) {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    message: String(error?.message || ""),
    code: String(error?.code || ""),
    status: Number(error?.status || 0) || 0
  };
}

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const evidence = await fn();
    record(report.tests, name, "passed", evidence);
    console.log("ok");
  } catch (error) {
    record(report.tests, name, "failed", failureEvidence(error));
    console.log("FAIL");
    throw error;
  }
}

async function destructiveTest(name, fn) {
  process.stdout.write(`  destructive ${name} ... `);
  try {
    const evidence = await fn();
    record(report.destructiveTests, name, "passed", evidence);
    console.log("ok");
  } catch (error) {
    record(report.destructiveTests, name, "failed", failureEvidence(error));
    console.log("FAIL");
    throw error;
  }
}

async function fetchJson(route, options = {}) {
  const response = await fetch(`${server.url}${route}`, options);
  const text = await response.text();
  const payload = text.trim() ? JSON.parse(text) : {};
  assertNoLeak(payload, route);
  return { status: response.status, payload };
}

async function api(method, route, body = undefined) {
  return fetchJson(route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function grantToken() {
  const verifierIdentity = createVerifierMcpProcessIdentity({
    target: "codex",
    label: "verify-http-boundary"
  });
  const response = await issueVerifierLocalMcpGrant({
    server,
    grantRequest: {
      targets: ["codex"],
      label: "external-http-boundary",
      connectorVersion: "verify-operation-permission-external-http-boundary",
      agentProfileId: AGENT_PROFILE_ID,
      grantMode: "maintain",
      toolsets: ["lico.gateway.read"],
      processIdentity: verifierIdentity.request
    }
  });
  assert.equal(response.status, 201, JSON.stringify(response.payload, null, 2));
  assert.ok(response.payload.token);
  assert.ok(response.payload.processIdentity?.clientIdentityPackage);
  dynamicSecretNeedles.add(String(response.payload.token));
  mcpIdentityByToken.set(response.payload.token, {
    identity: verifierIdentity,
    clientIdentityPackage: response.payload.processIdentity.clientIdentityPackage
  });
  return response.payload.token;
}

async function toolRequest(route, token, body) {
  const bodyText = JSON.stringify(body);
  const binding = mcpIdentityByToken.get(token);
  const signedHeaders = binding
    ? createSignedMcpHeaders({
        token,
        target: "codex",
        privateKeyPem: binding.identity.keyPair.privateKeyPem,
        clientIdentityPackage: binding.clientIdentityPackage,
        method: "POST",
        url: `${server.url}${route}`,
        body: bodyText
      })
    : { "Content-Type": "application/json" };
  return fetchJson(route, {
    method: "POST",
    headers: {
      ...signedHeaders,
      Authorization: `Bearer ${token}`,
      "X-Lico-Agent-Profile-Id": AGENT_PROFILE_ID
    },
    body: bodyText
  });
}

function assertNoTrustedLocalGate(payload, label) {
  assert.equal(JSON.stringify(payload).includes("trusted_lico_client_required"), false, `${label} returned trusted local gate`);
}

try {
  server = await startHttpServer({
    userDataPath,
    distPath: "",
    port: 0,
    runtimeOptions: {
      profile: "minimal",
      enableFeatures: ["operation-permission-core", "upstream-gateway"]
    }
  });
  await installAuthenticatedFetch(server);

  console.log("\n=== Operation Permission External HTTP Boundary: grant token execute/dry-run/batch ===\n");

  const token = await grantToken();

  await test("grant token can execute a governed read tool through HTTP", async () => {
    const response = await toolRequest("/api/operation-permission/v1/execute", token, {
      toolId: "lico.gateway.metrics",
      input: {}
    });
    assert.equal(response.status, 200, JSON.stringify(response.payload, null, 2));
    assert.equal(response.payload.status, "ok");
    assertNoTrustedLocalGate(response.payload, "execute");
    return { status: response.status, toolId: response.payload.toolId, resultStatus: response.payload.status };
  });

  await test("grant token can dry-run the same governed HTTP boundary", async () => {
    const response = await toolRequest("/api/operation-permission/v1/dry-run", token, {
      toolId: "lico.gateway.metrics",
      input: {}
    });
    assert.equal(response.status, 200, JSON.stringify(response.payload, null, 2));
    assertNoTrustedLocalGate(response.payload, "dry-run");
    return { status: response.status, dryRun: response.payload.dryRun === true || response.payload.status === "dry_run" };
  });

  await test("grant token can batch governed read operations through HTTP", async () => {
    const response = await toolRequest("/api/operation-permission/v1/batch", token, {
      calls: [
        { toolId: "lico.gateway.metrics", input: {} },
        { toolId: "lico.gateway.externalServices.list", input: {} }
      ]
    });
    assert.equal(response.status, 200, JSON.stringify(response.payload, null, 2));
    assert.equal(Array.isArray(response.payload.results), true);
    assert.equal(response.payload.results.length, 2);
    assertNoTrustedLocalGate(response.payload, "batch");
    return { status: response.status, resultCount: response.payload.results.length };
  });

  await destructiveTest("missing and invalid grant tokens fail by token policy, not trusted local client gate", async () => {
    const missing = await fetchJson("/api/operation-permission/v1/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolId: "lico.gateway.metrics", input: {} })
    });
    assert.equal(missing.status, 401);
    assert.equal(missing.payload.error?.code, "missing_token");
    assertNoTrustedLocalGate(missing.payload, "missing token");

    const invalid = await toolRequest("/api/operation-permission/v1/execute", "ock_invalid_token_for_boundary_verifier", {
      toolId: "lico.gateway.metrics",
      input: {}
    });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.payload.error?.code, "invalid_token");
    assertNoTrustedLocalGate(invalid.payload, "invalid token");
    return {
      missing: missing.payload.error?.code,
      invalid: invalid.payload.error?.code
    };
  });

  await test("tool execution audit and metrics are recorded without token leakage", async () => {
    const audit = await api("GET", "/api/operation-permission/v1/audit?limit=20");
    assert.equal(audit.status, 200, JSON.stringify(audit.payload, null, 2));
    const executions = audit.payload.items || [];
    assert.equal(executions.some((item) => item.toolId === "lico.gateway.metrics" && item.status === "ok"), true);
    const metrics = await api("GET", "/api/operation-permission/v1/metrics/summary?limit=20");
    assert.equal(metrics.status, 200, JSON.stringify(metrics.payload, null, 2));
    assertNoLeak(audit.payload, "tool audit");
    assertNoLeak(metrics.payload, "tool metrics");
    return {
      auditItems: executions.length,
      metricsChecked: true
    };
  });

  await writeReport();
  console.log(`\n=== Operation Permission External HTTP Boundary passed; report: ${REPORT_PATH} ===`);
} catch (error) {
  await writeReport().catch(() => {});
  console.error(JSON.stringify(safeEvidence({
    ok: false,
    verifier: "tools/server-scripts/verify-operation-permission-external-http-boundary.mjs",
    failure: failureEvidence(error)
  }), null, 2));
  process.exitCode = 1;
} finally {
  await server?.close?.();
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
  restoreCapabilityKernelEnv();
}
