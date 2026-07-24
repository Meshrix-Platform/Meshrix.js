#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  CLIENT_FINGERPRINT_VERSION,
  createProcessIdentityRequestHeaders,
  generateProcessIdentityClientKeyPair
} from "../../packages/foundation/src/security/process-identity/index.mjs";
import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import { upstreamOperationCapabilityId } from "../../packages/agents/src/upstream-gateway/operation-capability.mjs";
import { installAuthenticatedFetch } from "./test-auth-helper.mjs";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.mjs";
import { issueVerifierLocalMcpGrant } from "./lib/local-mcp-device-authorization.mjs";
import { seedVerifierUpstreamServices, verifierOpaqueServiceId } from "./lib/upstream-gateway-verifier-publication.mjs";

const REPORT_PATH = "build/reports/mcp-gateway-load.json";
const MCP_INTERFACE_VERSION = "v0.0.1:mcp:interface-1";
const SERVICE_ID = verifierOpaqueServiceId("stress-mcp-gateway-fixture");

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

function numberOption(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(argValue(name, process.env[name.replace(/^--/, "MESHRIX_STRESS_").replace(/-/g, "_").toUpperCase()] || fallback));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

const options = {
  concurrency: numberOption("--concurrency", 8, { min: 1, max: 512 }),
  requests: numberOption("--requests", 120, { min: 1, max: 100000 }),
  durationMs: numberOption("--duration-ms", 8000, { min: 1000, max: 600000 }),
  maxRssMb: numberOption("--max-rss-mb", 1024, { min: 128, max: 1024 * 1024 }),
  maxCpuRatio: numberOption("--max-cpu-ratio", 1.5, { min: 0.1, max: 64 }),
  reportPath: argValue("--report", REPORT_PATH)
};

const restoreCapabilityKernelEnv = useIsolatedCapabilityKernelForVerifier();
const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-load-"));
let server = null;
let fixture = null;
let fixtureUrl = "";
let token = "";
let fixtureHits = 0;
let processIdentityKeyPair = null;
let clientIdentityPackage = null;

function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((percentileValue / 100) * sorted.length));
  return Number(sorted[index].toFixed(2));
}

function closeServer(target) {
  return new Promise((resolve) => {
    if (!target?.close) {
      resolve();
      return;
    }
    target.close(() => resolve());
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function startFixtureServer() {
  return new Promise((resolve) => {
    const upstream = http.createServer(async (request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/echo") {
        fixtureHits += 1;
        sendJson(response, 200, { ok: true, index: url.searchParams.get("i") || "" });
        return;
      }
      sendJson(response, 404, { ok: false, error: "not_found" });
    });
    upstream.listen(0, "127.0.0.1", () => {
      const address = upstream.address();
      resolve({
        server: upstream,
        url: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

async function writeUpstreamGatewayConfig() {
  await seedVerifierUpstreamServices({
    userDataPath,
    services: [
      {
        serviceId: SERVICE_ID,
        label: "MCP gateway load fixture",
        baseUrl: fixtureUrl,
        healthPath: "/health",
        trafficPolicy: { perMinute: 100000, burst: 100000 },
        operations: [
          {
            operationKey: "echo",
            method: "GET",
            path: "/echo",
            risk: "read_only",
            requiredScopes: ["gateway:read"],
            payloadTransport: {
              request: { mode: "structured_json", maxBytes: 1024, mediaTypes: ["application/json"] },
              response: { mode: "structured_json", maxBytes: 1024 * 1024, mediaTypes: ["application/json"] }
            }
          }
        ]
      }
    ]
  });
}

async function fetchJson(route, options = {}) {
  const response = await fetch(`${server.url}${route}`, options);
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    payload: text.trim() ? JSON.parse(text) : {}
  };
}

function sha256Base64Url(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function stressClientFingerprint() {
  const fingerprint = {
    fingerprintId: "stress-mcp-gateway-fp",
    machineInstanceId: "stress-mcp-gateway-machine",
    appInstanceId: "stress-mcp-gateway-app",
    runtimeInstanceId: "stress-mcp-gateway-runtime"
  };
  fingerprint.fingerprintHash = `sha256:${sha256Base64Url(Buffer.from([
    CLIENT_FINGERPRINT_VERSION,
    fingerprint.fingerprintId,
    fingerprint.machineInstanceId,
    fingerprint.appInstanceId,
    fingerprint.runtimeInstanceId
  ].join("\n"), "utf8"))}`;
  return fingerprint;
}

function defaultIdentityHash({ publicKeyHash = "", clientFingerprint = {} } = {}) {
  return `sha256:${sha256Base64Url(Buffer.from([
    "v0.0.1:process-identity:mcp-default-identity-1",
    "codex",
    "stress-mcp-gateway-install",
    publicKeyHash,
    clientFingerprint.fingerprintHash || ""
  ].join("\n"), "utf8"))}`;
}

function mcpHeaders({ body = "" } = {}) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Meshrix-Api-Key": token,
    "X-Meshrix-MCP-Target": "codex",
    ...createProcessIdentityRequestHeaders({
      privateKeyPem: processIdentityKeyPair?.privateKeyPem || "",
      method: "POST",
      url: new URL(`${server.url}/mcp`),
      body,
      clientIdentityPackage
    })
  };
}

function mcpRequest(id, toolName, operation, input = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: {
        apiVersion: MCP_INTERFACE_VERSION,
        operation,
        input,
        clientVersion: "stress-mcp-gateway"
      }
    }
  };
}

async function callMcp(body) {
  const serialized = JSON.stringify(body);
  return fetchJson("/mcp", {
    method: "POST",
    headers: mcpHeaders({ body: serialized }),
    body: serialized
  });
}

async function createLocalGrant() {
  processIdentityKeyPair = generateProcessIdentityClientKeyPair();
  const clientFingerprint = stressClientFingerprint();
  const response = await issueVerifierLocalMcpGrant({
    server,
    grantRequest: {
      targets: ["codex"],
      label: "stress-mcp-gateway",
      connectorVersion: "stress-mcp-gateway",
      toolsets: ["meshrix.gateway.read", "meshrix.gateway.write", "meshrix.storage.read"],
      dynamicCapabilities: [upstreamOperationCapabilityId(
        { serviceId: SERVICE_ID },
        { operationKey: "echo" }
      )],
      allowedServiceIds: [SERVICE_ID],
      processIdentity: {
        clientId: "codex",
        installationId: "stress-mcp-gateway-install",
        processPublicKeyPem: processIdentityKeyPair.publicKeyPem,
        clientFingerprint,
        defaultIdentityHash: defaultIdentityHash({
          publicKeyHash: processIdentityKeyPair.publicKeyHash,
          clientFingerprint
        })
      }
    }
  });
  assert.equal(response.status, 201, JSON.stringify(response.payload));
  clientIdentityPackage = response.payload.processIdentity?.clientIdentityPackage || null;
  assert.equal(Boolean(clientIdentityPackage), true);
  return response.payload.token;
}

function createSafetyMonitor() {
  let lastCpu = process.cpuUsage();
  let lastTime = performance.now();
  const state = {
    triggered: false,
    reason: "",
    peakRssMb: 0,
    peakCpuRatio: 0
  };
  return {
    state,
    check() {
      const memory = process.memoryUsage();
      const rssMb = memory.rss / 1024 / 1024;
      state.peakRssMb = Math.max(state.peakRssMb, rssMb);
      const now = performance.now();
      const cpuDelta = process.cpuUsage(lastCpu);
      const elapsedMs = now - lastTime;
      if (elapsedMs < 500) {
        return state;
      }
      const elapsedMicros = Math.max(1, elapsedMs * 1000);
      const cpuRatio = (cpuDelta.user + cpuDelta.system) / elapsedMicros;
      state.peakCpuRatio = Math.max(state.peakCpuRatio, cpuRatio);
      lastCpu = process.cpuUsage();
      lastTime = now;
      if (rssMb >= options.maxRssMb * 0.9) {
        state.triggered = true;
        state.reason = "rss_threshold";
      } else if (cpuRatio >= options.maxCpuRatio) {
        state.triggered = true;
        state.reason = "cpu_threshold";
      }
      return state;
    }
  };
}

async function runPhase(name, makeBody, safetyMonitor, { durationMs: phaseDurationMs = options.durationMs } = {}) {
  const startedAt = performance.now();
  const deadline = startedAt + phaseDurationMs;
  const latencies = [];
  const stats = {
    name,
    issued: 0,
    completed: 0,
    ok: 0,
    failed: 0,
    firstErrorCode: "",
    safetyStop: false,
    safetyReason: ""
  };

  async function worker(workerId) {
    while (stats.issued < options.requests && performance.now() < deadline) {
      const safety = safetyMonitor.check();
      if (safety.triggered) {
        stats.safetyStop = true;
        stats.safetyReason = safety.reason;
        return;
      }
      const id = stats.issued + 1;
      stats.issued += 1;
      const before = performance.now();
      try {
        const response = await callMcp(makeBody(id, workerId));
        const latency = performance.now() - before;
        latencies.push(latency);
        stats.completed += 1;
        if (response.status === 200 && !response.payload?.error) {
          stats.ok += 1;
        } else {
          stats.failed += 1;
          stats.firstErrorCode ||= String(response.payload?.error?.data?.code || response.payload?.error?.code || response.status);
        }
      } catch (error) {
        stats.completed += 1;
        stats.failed += 1;
        stats.firstErrorCode ||= error?.name || "request_failed";
      }
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, (_, index) => worker(index)));
  const durationMs = Math.max(1, performance.now() - startedAt);
  return {
    ...stats,
    durationMs: Number(durationMs.toFixed(2)),
    requestsPerSecond: Number(((stats.completed * 1000) / durationMs).toFixed(2)),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95)
  };
}

function assertNoReportLeak(report) {
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(userDataPath), false, "load report leaked local data path");
  assert.equal(serialized.includes(os.homedir()), false, "load report leaked user home path");
  assert.equal(token ? serialized.includes(token) : false, false, "load report leaked token");
  assert.equal(fixtureUrl ? serialized.includes(fixtureUrl) : false, false, "load report leaked fixture URL");
  assert.equal(server?.url ? serialized.includes(server.url) : false, false, "load report leaked server URL");
}

function createReadiness(phases, safetyState) {
  const reasons = [];
  for (const phase of phases) {
    if (phase.failed !== 0) {
      reasons.push(`phase-failed:${phase.name}:${phase.failed}`);
    }
    if (phase.completed !== options.requests) {
      reasons.push(`phase-incomplete:${phase.name}:${phase.completed}/${options.requests}`);
    }
  }
  if (safetyState.triggered) {
    reasons.push(`resource-safety-cutoff:${safetyState.reason || "unknown"}`);
  }
  return {
    releaseReady: reasons.length === 0,
    reasons,
    phaseCompletionReady: phases.every((phase) => phase.completed === options.requests),
    resourceSafetyReady: safetyState.triggered !== true,
    failureFree: phases.every((phase) => phase.failed === 0)
  };
}

try {
  const fixtureStarted = await startFixtureServer();
  fixture = fixtureStarted.server;
  fixtureUrl = fixtureStarted.url;
  await writeUpstreamGatewayConfig();

  server = await startHttpServer({
    userDataPath,
    distPath: "",
    port: 0,
    runtimeOptions: {
      profile: "minimal",
      enableFeatures: ["upstream-gateway", "operation-permission-core"]
    }
  });
  await installAuthenticatedFetch(server);
  token = await createLocalGrant();

  const initializeBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stress-mcp-gateway", version: "1" }
      }
    });
  const initialize = await fetchJson("/mcp", {
    method: "POST",
    headers: mcpHeaders({ body: initializeBody }),
    body: initializeBody
  });
  assert.equal(initialize.status, 200, JSON.stringify(initialize.payload));

  const safetyMonitor = createSafetyMonitor();
  const healthPhase = await runPhase(
    "downstream-mcp-system-health",
    (id) => mcpRequest(id, "meshrix.discovery", "system.health", {}),
    safetyMonitor
  );
  const gatewayPhase = await runPhase(
    "upstream-gateway-forward-through-mcp",
    (id) => mcpRequest(id + options.requests, "meshrix.gateway", "meshrix.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      query: { i: String(id) }
    }),
    safetyMonitor,
    { durationMs: Math.max(options.durationMs, 15000) }
  );

  const phases = [healthPhase, gatewayPhase];
  const readiness = createReadiness(phases, safetyMonitor.state);
  const report = {
    schemaVersion: "v0.0.1:mcp:gateway-load-report-1",
    generatedAt: new Date().toISOString(),
    verifier: "tools/server-scripts/stress-mcp-gateway.mjs",
    options,
    safety: {
      triggered: safetyMonitor.state.triggered,
      reason: safetyMonitor.state.reason,
      peakRssMb: Number(safetyMonitor.state.peakRssMb.toFixed(2)),
      peakCpuRatioOneCore: Number(safetyMonitor.state.peakCpuRatio.toFixed(4)),
      rssCutoffMb: Number((options.maxRssMb * 0.9).toFixed(2)),
      cpuCutoffRatio: options.maxCpuRatio
    },
    phases,
    fixture: {
      hitCount: fixtureHits
    },
    releaseReady: readiness.releaseReady,
    summary: {
      releaseReady: readiness.releaseReady,
      reportLeakScan: true,
      phaseCount: phases.length,
      failedPhaseCount: phases.filter((phase) => phase.failed !== 0).length,
      incompletePhaseCount: phases.filter((phase) => phase.completed !== options.requests).length,
      resourceSafetyCutoff: safetyMonitor.state.triggered === true,
      resourceSafetyReason: safetyMonitor.state.reason,
      phaseCompletionReady: readiness.phaseCompletionReady,
      resourceSafetyReady: readiness.resourceSafetyReady,
      failureFree: readiness.failureFree,
      readinessReasons: readiness.reasons
    }
  };
  assertNoReportLeak(report);
  await fs.mkdir(path.dirname(options.reportPath), { recursive: true });
  await fs.writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[mcp-gateway-load] report=${options.reportPath}`);
  console.log(`[mcp-gateway-load] phases=${phases.length} releaseReady=${report.releaseReady}`);
  process.exitCode = report.releaseReady ? 0 : 1;
} catch (error) {
  console.error(`[mcp-gateway-load] FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (server?.close) await server.close();
  await closeServer(fixture);
  await fs.rm(userDataPath, { recursive: true, force: true });
  restoreCapabilityKernelEnv();
}
