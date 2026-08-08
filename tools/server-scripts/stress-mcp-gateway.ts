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
} from "../../packages/foundation/src/security/process-identity/index.ts";
import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import { upstreamOperationCapabilityId } from "../../packages/agents/src/upstream-gateway/operation-capability.ts";
import { installAuthenticatedFetch } from "./test-auth-helper.ts";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.ts";
import { issueVerifierMcpApiKey } from "./lib/verifier-mcp-api-key.ts";
import { seedVerifierUpstreamServices, verifierOpaqueServiceId } from "./lib/upstream-gateway-verifier-publication.ts";

const REPORT_PATH: any = "build/reports/mcp-gateway-load.json";
const MCP_INTERFACE_VERSION: any = "v0.0.1:mcp:interface-1";
const SERVICE_ID: any = verifierOpaqueServiceId("stress-mcp-gateway-fixture");

function argValue(name?: any, fallback: any = "") : any {
  const index: any = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

function numberOption(name?: any, fallback?: any, { min = 0, max = Number.MAX_SAFE_INTEGER }: Record<string, any> = {}) : any {
  const value: any = Number(argValue(name, process.env[name.replace(/^--/, "MESHRIX_STRESS_").replace(/-/g, "_").toUpperCase()] || fallback));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

const options: Record<string, any> = {
  concurrency: numberOption("--concurrency", 8, { min: 1, max: 512 }),
  requests: numberOption("--requests", 120, { min: 1, max: 100000 }),
  durationMs: numberOption("--duration-ms", 8000, { min: 1000, max: 600000 }),
  maxRssMb: numberOption("--max-rss-mb", 1024, { min: 128, max: 1024 * 1024 }),
  maxCpuRatio: numberOption("--max-cpu-ratio", 1.5, { min: 0.1, max: 64 }),
  reportPath: argValue("--report", REPORT_PATH)
};

const restoreCapabilityKernelEnv: any = useIsolatedCapabilityKernelForVerifier();
const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-load-"));
let server: any = null;
let fixture: any = null;
let fixtureUrl: any = "";
let token: any = "";
let fixtureHits: any = 0;
let processIdentityKeyPair: any = null;
let clientIdentityPackage: any = null;

function percentile(values?: any, percentileValue?: any) : any {
  if (values.length === 0) return 0;
  const sorted: any = [...values].sort((left?: any, right?: any) : any => left - right);
  const index: any = Math.min(sorted.length - 1, Math.floor((percentileValue / 100) * sorted.length));
  return Number(sorted[index].toFixed(2));
}

function closeServer(target?: any) : any {
  return new Promise((resolve?: any) : any => {
    if (!target?.close) {
      resolve();
      return;
    }
    target.close(() : any => resolve());
  });
}

function sendJson(response?: any, status?: any, payload?: any) : any {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function startFixtureServer() : any {
  return new Promise((resolve?: any) : any => {
    const upstream: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
      const url: any = new URL(request.url || "/", "http://127.0.0.1");
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
    upstream.listen(0, "127.0.0.1", () : any => {
      const address: any = upstream.address();
      resolve({
        server: upstream,
        url: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

async function writeUpstreamGatewayConfig() : Promise<any> {
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

async function fetchJson(route?: any, options: Record<string, any> = {}) : Promise<any> {
  const response: any = await fetch(`${server.url}${route}`, options);
  const text: any = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    payload: text.trim() ? JSON.parse(text) : {}
  };
}

function sha256Base64Url(value?: any) : any {
  return createHash("sha256").update(value).digest("base64url");
}

function stressClientFingerprint() : any {
  const fingerprint: Record<string, any> = {
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

function defaultIdentityHash({ publicKeyHash = "", clientFingerprint = {} }: Record<string, any> = {}) : any {
  return `sha256:${sha256Base64Url(Buffer.from([
    "v0.0.1:process-identity:mcp-default-identity-1",
    "codex",
    "stress-mcp-gateway-install",
    publicKeyHash,
    clientFingerprint.fingerprintHash || ""
  ].join("\n"), "utf8"))}`;
}

function mcpHeaders({ body = "" }: Record<string, any> = {}) : any {
  void body;
  return {
    "Content-Type": "application/json",
    "X-Meshrix.js-Api-Key": token,
    "X-Meshrix.js-MCP-Target": "codex"
  };
}

function mcpRequest(id?: any, toolName?: any, operation?: any, input: Record<string, any> = {}) : any {
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

async function callMcp(body?: any) : Promise<any> {
  const serialized: any = JSON.stringify(body);
  return fetchJson("/mcp", {
    method: "POST",
    headers: mcpHeaders({ body: serialized }),
    body: serialized
  });
}

async function createVerifierApiKey() : Promise<any> {
  const response: any = await issueVerifierMcpApiKey({
    server,
    access: {
      targets: ["codex"],
      label: "stress-mcp-gateway",
      connectorVersion: "stress-mcp-gateway",
      toolsets: ["meshrix.gateway.read", "meshrix.gateway.write", "meshrix.storage.read"],
      dynamicCapabilities: [upstreamOperationCapabilityId(
        { serviceId: SERVICE_ID },
        { operationKey: "echo" }
      )],
      allowedServiceIds: [SERVICE_ID]
    }
  });
  assert.ok(response.apiKey);
  return response.apiKey;
}

function createSafetyMonitor() : any {
  let lastCpu: any = process.cpuUsage();
  let lastTime: any = performance.now();
  const state: Record<string, any> = {
    triggered: false,
    reason: "",
    peakRssMb: 0,
    peakCpuRatio: 0
  };
  return {
    state,
    check() : any {
      const memory: any = process.memoryUsage();
      const rssMb: any = memory.rss / 1024 / 1024;
      state.peakRssMb = Math.max(state.peakRssMb, rssMb);
      const now: any = performance.now();
      const cpuDelta: any = process.cpuUsage(lastCpu);
      const elapsedMs: any = now - lastTime;
      if (elapsedMs < 500) {
        return state;
      }
      const elapsedMicros: any = Math.max(1, elapsedMs * 1000);
      const cpuRatio: any = (cpuDelta.user + cpuDelta.system) / elapsedMicros;
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

async function runPhase(name?: any, makeBody?: any, safetyMonitor?: any, { durationMs: phaseDurationMs = options.durationMs }: Record<string, any> = {}) : Promise<any> {
  const startedAt: any = performance.now();
  const deadline: any = startedAt + phaseDurationMs;
  const latencies: any[] = [];
  const stats: Record<string, any> = {
    name,
    issued: 0,
    completed: 0,
    ok: 0,
    failed: 0,
    firstErrorCode: "",
    safetyStop: false,
    safetyReason: ""
  };

  async function worker(workerId?: any) : Promise<any> {
    while (stats.issued < options.requests && performance.now() < deadline) {
      const safety: any = safetyMonitor.check();
      if (safety.triggered) {
        stats.safetyStop = true;
        stats.safetyReason = safety.reason;
        return;
      }
      const id: any = stats.issued + 1;
      stats.issued += 1;
      const before: any = performance.now();
      try {
        const response: any = await callMcp(makeBody(id, workerId));
        const latency: any = performance.now() - before;
        latencies.push(latency);
        stats.completed += 1;
        if (response.status === 200 && !response.payload?.error) {
          stats.ok += 1;
        } else {
          stats.failed += 1;
          stats.firstErrorCode ||= String(response.payload?.error?.data?.code || response.payload?.error?.code || response.status);
        }
      } catch (error: any) {
        stats.completed += 1;
        stats.failed += 1;
        stats.firstErrorCode ||= error?.name || "request_failed";
      }
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, (_?: any, index?: any) : any => worker(index)));
  const durationMs: any = Math.max(1, performance.now() - startedAt);
  return {
    ...stats,
    durationMs: Number(durationMs.toFixed(2)),
    requestsPerSecond: Number(((stats.completed * 1000) / durationMs).toFixed(2)),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95)
  };
}

function assertNoReportLeak(report?: any) : any {
  const serialized: any = JSON.stringify(report);
  assert.equal(serialized.includes(userDataPath), false, "load report leaked local data path");
  assert.equal(serialized.includes(os.homedir()), false, "load report leaked user home path");
  assert.equal(token ? serialized.includes(token) : false, false, "load report leaked token");
  assert.equal(fixtureUrl ? serialized.includes(fixtureUrl) : false, false, "load report leaked fixture URL");
  assert.equal(server?.url ? serialized.includes(server.url) : false, false, "load report leaked server URL");
}

function createReadiness(phases?: any, safetyState?: any) : any {
  const reasons: any[] = [];
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
    phaseCompletionReady: phases.every((phase?: any) : any => phase.completed === options.requests),
    resourceSafetyReady: safetyState.triggered !== true,
    failureFree: phases.every((phase?: any) : any => phase.failed === 0)
  };
}

try {
  const fixtureStarted: any = await startFixtureServer();
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
  token = await createVerifierApiKey();

  const initializeBody: any = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stress-mcp-gateway", version: "1" }
      }
    });
  const initialize: any = await fetchJson("/mcp", {
    method: "POST",
    headers: mcpHeaders({ body: initializeBody }),
    body: initializeBody
  });
  assert.equal(initialize.status, 200, JSON.stringify(initialize.payload));

  const safetyMonitor: any = createSafetyMonitor();
  const healthPhase: any = await runPhase(
    "downstream-mcp-system-health",
    (id?: any) : any => mcpRequest(id, "meshrix.discovery", "system.health", {}),
    safetyMonitor
  );
  const gatewayPhase: any = await runPhase(
    "upstream-gateway-forward-through-mcp",
    (id?: any) : any => mcpRequest(id + options.requests, "meshrix.gateway", "meshrix.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      query: { i: String(id) }
    }),
    safetyMonitor,
    { durationMs: Math.max(options.durationMs, 15000) }
  );

  const phases: any[] = [healthPhase, gatewayPhase];
  const readiness: any = createReadiness(phases, safetyMonitor.state);
  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:mcp:gateway-load-report-1",
    generatedAt: new Date().toISOString(),
    verifier: "tools/server-scripts/stress-mcp-gateway.ts",
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
      failedPhaseCount: phases.filter((phase?: any) : any => phase.failed !== 0).length,
      incompletePhaseCount: phases.filter((phase?: any) : any => phase.completed !== options.requests).length,
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
} catch (error: any) {
  console.error(`[mcp-gateway-load] FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (server?.close) await server.close();
  await closeServer(fixture);
  await fs.rm(userDataPath, { recursive: true, force: true });
  restoreCapabilityKernelEnv();
}
