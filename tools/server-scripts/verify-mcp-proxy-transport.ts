#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import { MCP_SUPPORTED_TARGETS } from "../../packages/protocols/mcp/adapter/mcp-release-targets.ts";
import {
  MCP_DISCOVERY_TOOL_NAME,
  MCP_GATEWAY_TOOL_NAME,
  MCP_INTERFACE_VERSION
} from "../../packages/protocols/mcp/adapter/http-mcp-adapter-constants.ts";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.ts";
import { installAuthenticatedFetch } from "./test-auth-helper.ts";
import { installerProcessEnv } from "./lib/mcp-neutral-peer-identity-support.ts";
import { assertExpectedOutlets, outletNames } from "./lib/mcp-neutral-peer-protocol-support.ts";
import { createMcpProxyStdioClient } from "./lib/mcp-proxy-stdio-client.ts";
import { issueVerifierMcpApiKey } from "./lib/verifier-mcp-api-key.ts";
import { runCompleteTargetDiagnostics } from "./lib/complete-target-diagnostics.ts";
import {
  MCP_PROXY_TRANSPORT_REPORT_PATH,
  MCP_PROXY_TRANSPORT_SCHEMA_VERSION,
  MCP_PROXY_TRANSPORT_VERIFIER,
  createMcpProxyTransportReadiness
} from "./lib/mcp-proxy-transport-evidence.ts";

const repoRoot: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const connectorScript: any = path.join(repoRoot, "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts");
const restoreCapabilityKernelEnv: any = useIsolatedCapabilityKernelForVerifier();
const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-proxy-transport-server-"));
const installerHome: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-proxy-transport-home-"));
const redactionNeedles: any = new Set<any>([
  userDataPath,
  installerHome,
  os.homedir(),
  repoRoot,
  process.cwd()
].filter(Boolean));
const EXPECTED_CORE_OUTLETS: readonly any[] = Object.freeze([MCP_DISCOVERY_TOOL_NAME, MCP_GATEWAY_TOOL_NAME]);

let server: any = null;
let exitCode: any = 0;
const identityByToken: any = new Map<any, any>();
const report: Record<string, any> = {
  schemaVersion: MCP_PROXY_TRANSPORT_SCHEMA_VERSION,
  verifier: MCP_PROXY_TRANSPORT_VERIFIER,
  startedAt: new Date().toISOString(),
  algorithm: {
    transport: "Spawn the published meshrix-mcp proxy command as a child process and exchange JSON-RPC 2.0 messages over newline-delimited MCP stdio frames.",
    identity: "For every release target, create a real local MCP grant and persist the returned process identity package into an isolated file-backed process identity store before launching the proxy.",
    protocol: "Verify initialize, tools/list, and meshrix.discovery tools/call through the proxy process for every target listed by MCP_SUPPORTED_TARGETS.",
    redaction: "Report only target names, counts, statuses, and non-secret protocol booleans; temp roots, tokens, paths, and authorization material are scanned before write."
  },
  targets: [],
  summary: {}
};

function trackRedaction(...values: any[]) : any {
  for (const value of values) {
    const text: any = String(value || "").trim();
    if (text) {
      redactionNeedles.add(text);
    }
  }
}

function redactText(value: any = "") : any {
  let text: any = String(value || "");
  for (const needle of redactionNeedles) {
    if (needle && text.includes(needle)) {
      text = text.split(needle).join("[redacted]");
    }
  }
  text = text.replace(/Bearer\s+(?!\[redacted\])(?:[A-Za-z0-9._~+/=-]{8,})/giu, "Bearer [redacted]");
  text = text.replace(/"token"\s*:\s*"[^"]+"/giu, "\"token\":\"[redacted]\"");
  text = text.replace(/"X-Meshrix.js-Api-Key"\s*:\s*"[^"]+"/giu, "\"X-Meshrix.js-Api-Key\":\"[redacted]\"");
  text = text.replace(/\bmeshrix_[A-Za-z0-9_-]{12,}\b/gu, "meshrix_[redacted]");
  return text;
}

function safeEvidence(value: Record<string, any> = {}) : any {
  return JSON.parse(JSON.stringify(value, (_?: any, child?: any) : any => {
    if (typeof child !== "string") {
      return child;
    }
    return redactText(child);
  }));
}

function assertNoLeakText(text: any = "", label: any = "text") : any {
  const value: any = String(text || "");
  for (const needle of redactionNeedles) {
    assert.equal(value.includes(needle), false, `${label} leaked a redacted verifier value`);
  }
  assert.equal(/Bearer\s+(?!\[redacted\])(?:[A-Za-z0-9._~+/=-]{8,})/iu.test(value), false, `${label} leaked a bearer token`);
  assert.equal(/"token"\s*:\s*"(?!\[redacted\])[^"]+"/iu.test(value), false, `${label} leaked a token field`);
  assert.equal(/"X-Meshrix.js-Api-Key"\s*:\s*"(?!\[redacted\])[^"]+"/iu.test(value), false, `${label} leaked an MCP API key`);
  assert.equal(/\bmeshrix_[A-Za-z0-9_-]{12,}\b/u.test(value), false, `${label} leaked a Meshrix.js token-like value`);
}

function failureEvidence(error?: any) : any {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    reasonCode: String(error?.reasonCode || ""),
    code: String(error?.code || ""),
    message: process.env.MESHRIX_VERIFY_VERBOSE ? redactText(error?.message || String(error || "")) : ""
  };
}

async function requestJson(route?: any, options: Record<string, any> = {}) : Promise<any> {
  const response: any = await fetch(`${server.url}${route}`, options);
  const text: any = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    payload: text.trim() ? JSON.parse(text) : {}
  };
}

async function createVerifierApiKey(target?: any) : Promise<any> {
  const response: any = await issueVerifierMcpApiKey({
    server,
    access: {
      targets: [target],
      label: `verify-mcp-proxy-transport-${target}`,
      connectorVersion: "verify-mcp-proxy-transport",
      toolsets: ["meshrix.storage.read", "meshrix.gateway.read", "meshrix.gateway.write"],
      maxRisk: "repair_write"
    }
  });
  assert.ok(response.apiKey, "API Key issuance did not return plaintext to the direct verifier caller");
  trackRedaction(
    response.apiKey,
    response.record.keyId
  );
  return {
    keyId: response.record.keyId,
    token: response.apiKey
  };
}

async function verifyTargetProxyTransport(target?: any) : Promise<any> {
  const grant: any = await createVerifierApiKey(target);
  const env: Record<string, any> = {
    ...installerProcessEnv(installerHome),
    MESHRIX_MCP_TOKEN: grant.token
  };
  const proxy: any = createMcpProxyStdioClient({
    connectorScript,
    target,
    baseUrl: server.url,
    env,
    cwd: repoRoot,
    redactText,
    timeoutMs: 12000
  });
  try {
    const profile: any = proxy.profile;
    const initialize: any = await proxy.request("initialize", {
      protocolVersion: profile.protocolVersion,
      capabilities: profile.capabilities,
      clientInfo: profile.clientInfo
    }, { id: 0 });
    assert.equal(initialize.result?.serverInfo?.name, "Meshrix.js");
    assert.equal(initialize.result?.capabilities?.tools?.listChanged, true);
    await proxy.notify("notifications/initialized", {}, {
      omitParams: profile.initializedParamsOmitted === true
    });

    const toolsList: any = await proxy.request("tools/list", profile.toolsListParams || {}, {
      id: 1,
      omitParams: profile.toolsListParams === undefined
    });
    const tools: any = toolsList.result?.tools || [];
    assertExpectedOutlets(tools, EXPECTED_CORE_OUTLETS);

    const health: any = await proxy.request("tools/call", {
      name: "meshrix.discovery",
      arguments: {
        apiVersion: MCP_INTERFACE_VERSION,
        operation: "system.health",
        input: {},
        clientVersion: "verify-mcp-proxy-transport"
      }
    }, { id: 2 });
    assert.equal(health.error, undefined, JSON.stringify(safeEvidence(health.error || {})));
    assert.equal(health.result?.structuredContent?.payload?.ok, true);
    const close: any = await proxy.close();
    assert.equal(close.notifications, 0, "proxy must not reply to notifications/initialized");
    return {
      target,
      status: "verified",
      proxyTransport: "stdio-jsonl",
      clientProtocolProfile: {
        target: profile.target,
        source: profile.profileSource,
        observedClientVersion: profile.observedClientVersion,
        protocolVersion: profile.protocolVersion,
        clientInfoName: profile.clientInfo.name,
        capabilityKeys: Object.keys(profile.capabilities),
        framing: profile.framing
      },
      processIdentityStored: true,
      initialized: true,
      initializedNotificationSent: true,
      unexpectedNotificationResponses: close.notifications,
      toolsListed: true,
      toolCount: tools.length,
      outlets: outletNames(tools),
      healthCallOk: true
    };
  } catch (error: any) {
    await proxy.close().catch(() : any => {});
    throw error;
  }
}

async function writeReport() : Promise<any> {
  report.finishedAt = new Date().toISOString();
  const failedCount: any = report.targets.filter((row?: any) : any => row.status !== "verified").length;
  report.summary = {
    targetCount: report.targets.length,
    requiredTargets: [...MCP_SUPPORTED_TARGETS],
    executedTargets: report.targets.map((row?: any) : any => row.target),
    unexecutedCount: Math.max(0, MCP_SUPPORTED_TARGETS.length - report.targets.length),
    verifiedTargets: report.targets.filter((row?: any) : any => row.status === "verified").map((row?: any) : any => row.target),
    failedCount,
    reportLeakScan: true
  };
  const readiness: any = createMcpProxyTransportReadiness(report);
  report.summary.releaseReady = readiness.releaseReady;
  report.summary.coverageReady = readiness.coverageReady;
  report.summary.readinessSource = readiness.sourceOfTruth;
  report.summary.readinessReasons = readiness.reasons;
  const serialized: any = JSON.stringify(report);
  assertNoLeakText(serialized, "mcp proxy transport report");
  await fs.mkdir(path.dirname(MCP_PROXY_TRANSPORT_REPORT_PATH), { recursive: true });
  await fs.writeFile(MCP_PROXY_TRANSPORT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return readiness;
}

try {
  server = await startHttpServer({
    userDataPath,
    distPath: "",
    port: 0,
    runtimeOptions: {
      profile: "minimal",
      enableFeatures: ["operation-permission-core"]
    }
  });
  trackRedaction(server.url);
  await installAuthenticatedFetch(server);

  console.log("=== MCP Proxy Transport: real meshrix-mcp proxy stdio verifier ===");
  const diagnostics: any = await runCompleteTargetDiagnostics({
    targets: MCP_SUPPORTED_TARGETS,
    runTarget: async (target?: any) : Promise<any> => {
      process.stdout.write(`  ${target} proxy stdio initialize/list/call ... `);
      const evidence: any = await verifyTargetProxyTransport(target);
      console.log("ok");
      return evidence;
    },
    failureOutcome: async (target?: any, error?: any) : Promise<any> => {
      console.log("FAIL");
      return {
        target,
        status: "failed",
        proxyTransport: "stdio-jsonl",
        processIdentityStored: false,
        initialized: false,
        initializedNotificationSent: false,
        unexpectedNotificationResponses: -1,
        toolsListed: false,
        healthCallOk: false,
        failure: failureEvidence(error)
      };
    }
  });
  report.targets.push(...diagnostics.outcomes);
  if (diagnostics.failures.length > 0) {
    exitCode = 1;
  }
} catch (error: any) {
  console.error(`FAIL: ${redactText(error?.message || String(error))}`);
  if (process.env.MESHRIX_VERIFY_VERBOSE) {
    console.error(redactText(error?.stack || String(error)));
  }
  exitCode = 1;
} finally {
  try {
    const readiness: any = await writeReport();
    if (readiness.releaseReady !== true) {
      console.error(`FAIL: MCP proxy transport readiness failed: ${readiness.reasons.join(", ")}`);
      exitCode = 1;
    }
  } catch (error: any) {
    console.error(`FAIL: could not write report: ${redactText(error?.message || String(error))}`);
    exitCode = 1;
  }
  if (server?.close) {
    await server.close();
  }
  await fs.rm(installerHome, { recursive: true, force: true }).catch(() : any => {});
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() : any => {});
  restoreCapabilityKernelEnv();
}

if (exitCode === 0) {
  console.log(`PASS: MCP proxy transport verified for ${MCP_SUPPORTED_TARGETS.length} targets; report: ${MCP_PROXY_TRANSPORT_REPORT_PATH}`);
}

process.exit(exitCode);
