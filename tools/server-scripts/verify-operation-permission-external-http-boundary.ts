#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import { installAuthenticatedFetch } from "./test-auth-helper.ts";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.ts";
import { issueVerifierMcpApiKey } from "./lib/verifier-mcp-api-key.ts";
import {
  createSignedMcpHeaders,
  createVerifierMcpProcessIdentity
} from "./mcp-process-identity-test-helper.ts";

const REPORT_PATH: any = "build/reports/operation-permission-external-http-boundary.json";
const AGENT_PROFILE_ID: any = "verify-http-boundary-agent";

const restoreCapabilityKernelEnv: any = useIsolatedCapabilityKernelForVerifier();
const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-tool-http-boundary-"));
const dynamicSecretNeedles: any = new Set<any>();
const mcpIdentityByToken: any = new Map<any, any>();
const report: Record<string, any> = {
  schemaVersion: "v0.0.1:operation-permission:external-http-boundary-report-1",
  verifier: "tools/server-scripts/verify-operation-permission-external-http-boundary.ts",
  startedAt: new Date().toISOString(),
  tests: [],
  destructiveTests: [],
  summary: {}
};

let server: any = null;

function safeEvidence(value: Record<string, any> = {}) : any {
  return JSON.parse(JSON.stringify(value, (_?: any, child?: any) : any => {
    if (typeof child !== "string") return child;
    for (const needle of dynamicSecretNeedles) {
      if (needle && child.includes(needle)) return "[redacted-dynamic-secret]";
    }
    if (child.includes(userDataPath) || child.includes(os.homedir())) return "[redacted-local-path]";
    if (/Bearer\s+\S+/i.test(child) || /meshrix_[a-z0-9_-]+=/i.test(child)) return "[redacted-secret]";
    if (/grant_|tool_exec|trace_|policy_/i.test(child)) return "[redacted-runtime-id]";
    return child;
  }));
}

function assertNoLeak(value?: any, label: any = "payload") : any {
  const serialized: any = JSON.stringify(value);
  assert.equal(serialized.includes(userDataPath), false, `${label} leaked verifier data path`);
  assert.equal(serialized.includes(os.homedir()), false, `${label} leaked user home path`);
  for (const needle of dynamicSecretNeedles) {
    assert.equal(needle ? serialized.includes(needle) : false, false, `${label} leaked dynamic secret`);
  }
  assert.equal(/Bearer\s+\S+/i.test(serialized), false, `${label} leaked bearer token`);
  assert.equal(/meshrix_[a-z0-9_-]+=/i.test(serialized), false, `${label} leaked cookie`);
}

async function writeReport() : Promise<any> {
  report.finishedAt = new Date().toISOString();
  report.summary.testCount = report.tests.length;
  report.summary.destructiveTestCount = report.destructiveTests.length;
  report.summary.failedCount = [...report.tests, ...report.destructiveTests].filter((item?: any) : any => item.status !== "passed").length;
  report.summary.releaseReady = report.summary.failedCount === 0;
  assertNoLeak(report, "operation permission external HTTP boundary report");
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function record(collection?: any, name?: any, status?: any, evidence: Record<string, any> = {}) : any {
  collection.push({ name, status, evidence: safeEvidence(evidence) });
}

function failureEvidence(error?: any) : any {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    message: String(error?.message || ""),
    code: String(error?.code || ""),
    status: Number(error?.status || 0) || 0
  };
}

async function test(name?: any, fn?: any) : Promise<any> {
  process.stdout.write(`  ${name} ... `);
  try {
    const evidence: any = await fn();
    record(report.tests, name, "passed", evidence);
    console.log("ok");
  } catch (error: any) {
    record(report.tests, name, "failed", failureEvidence(error));
    console.log("FAIL");
    throw error;
  }
}

async function destructiveTest(name?: any, fn?: any) : Promise<any> {
  process.stdout.write(`  destructive ${name} ... `);
  try {
    const evidence: any = await fn();
    record(report.destructiveTests, name, "passed", evidence);
    console.log("ok");
  } catch (error: any) {
    record(report.destructiveTests, name, "failed", failureEvidence(error));
    console.log("FAIL");
    throw error;
  }
}

async function fetchJson(route?: any, options: Record<string, any> = {}) : Promise<any> {
  const response: any = await fetch(`${server.url}${route}`, options);
  const text: any = await response.text();
  const payload: any = text.trim() ? JSON.parse(text) : {};
  assertNoLeak(payload, route);
  return { status: response.status, payload };
}

async function api(method?: any, route?: any, body: any = undefined) : Promise<any> {
  return fetchJson(route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function grantToken() : Promise<any> {
  const response: any = await issueVerifierMcpApiKey({
    server,
    access: {
      targets: ["codex"],
      label: "external-http-boundary",
      connectorVersion: "verify-operation-permission-external-http-boundary",
      agentProfileId: AGENT_PROFILE_ID,
      grantMode: "maintain",
      toolsets: ["meshrix.gateway.read"]
    }
  });
  assert.ok(response.apiKey);
  dynamicSecretNeedles.add(response.apiKey);
  return response.apiKey;
}

async function toolRequest(route?: any, token?: any, body?: any) : Promise<any> {
  const bodyText: any = JSON.stringify(body);
  return fetchJson(route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Meshrix-Api-Key": token,
      "X-Meshrix-MCP-Target": "codex",
      "X-Meshrix-Agent-Profile-Id": AGENT_PROFILE_ID
    },
    body: bodyText
  });
}

function assertNoTrustedLocalGate(payload?: any, label?: any) : any {
  assert.equal(JSON.stringify(payload).includes("trusted_meshrix_client_required"), false, `${label} returned trusted local gate`);
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

  const token: any = await grantToken();

  await test("grant token can execute a governed read tool through HTTP", async () : Promise<any> => {
    const response: any = await toolRequest("/api/operation-permission/v1/execute", token, {
      toolId: "meshrix.gateway.metrics",
      input: {}
    });
    assert.equal(response.status, 200, JSON.stringify(response.payload, null, 2));
    assert.equal(response.payload.status, "ok");
    assertNoTrustedLocalGate(response.payload, "execute");
    return { status: response.status, toolId: response.payload.toolId, resultStatus: response.payload.status };
  });

  await test("grant token can dry-run the same governed HTTP boundary", async () : Promise<any> => {
    const response: any = await toolRequest("/api/operation-permission/v1/dry-run", token, {
      toolId: "meshrix.gateway.metrics",
      input: {}
    });
    assert.equal(response.status, 200, JSON.stringify(response.payload, null, 2));
    assertNoTrustedLocalGate(response.payload, "dry-run");
    return { status: response.status, dryRun: response.payload.dryRun === true || response.payload.status === "dry_run" };
  });

  await test("grant token can batch governed read operations through HTTP", async () : Promise<any> => {
    const response: any = await toolRequest("/api/operation-permission/v1/batch", token, {
      calls: [
        { toolId: "meshrix.gateway.metrics", input: {} },
        { toolId: "meshrix.gateway.externalServices.list", input: {} }
      ]
    });
    assert.equal(response.status, 200, JSON.stringify(response.payload, null, 2));
    assert.equal(Array.isArray(response.payload.results), true);
    assert.equal(response.payload.results.length, 2);
    assertNoTrustedLocalGate(response.payload, "batch");
    return { status: response.status, resultCount: response.payload.results.length };
  });

  await destructiveTest("missing and invalid grant tokens fail by token policy, not trusted local client gate", async () : Promise<any> => {
    const missing: any = await fetchJson("/api/operation-permission/v1/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolId: "meshrix.gateway.metrics", input: {} })
    });
    assert.equal(missing.status, 401);
    assert.equal(missing.payload.error?.code, "missing_token");
    assertNoTrustedLocalGate(missing.payload, "missing token");

    const invalid: any = await toolRequest("/api/operation-permission/v1/execute", "ock_invalid_token_for_boundary_verifier", {
      toolId: "meshrix.gateway.metrics",
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

  await test("tool execution audit and metrics are recorded without token leakage", async () : Promise<any> => {
    const audit: any = await api("GET", "/api/operation-permission/v1/audit?limit=20");
    assert.equal(audit.status, 200, JSON.stringify(audit.payload, null, 2));
    const executions: any = audit.payload.items || [];
    assert.equal(executions.some((item?: any) : any => item.toolId === "meshrix.gateway.metrics" && item.status === "ok"), true);
    const metrics: any = await api("GET", "/api/operation-permission/v1/metrics/summary?limit=20");
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
} catch (error: any) {
  await writeReport().catch(() : any => {});
  console.error(JSON.stringify(safeEvidence({
    ok: false,
    verifier: "tools/server-scripts/verify-operation-permission-external-http-boundary.ts",
    failure: failureEvidence(error)
  }), null, 2));
  process.exitCode = 1;
} finally {
  await server?.close?.();
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() : any => {});
  restoreCapabilityKernelEnv();
}
