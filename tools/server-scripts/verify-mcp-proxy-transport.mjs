#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import { MCP_SUPPORTED_TARGETS } from "../../packages/protocols/mcp/adapter/mcp-release-targets.mjs";
import {
  MCP_DISCOVERY_TOOL_NAME,
  MCP_GATEWAY_TOOL_NAME,
  MCP_INTERFACE_VERSION
} from "../../packages/protocols/mcp/adapter/http-mcp-adapter-constants.mjs";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.mjs";
import { installAuthenticatedFetch } from "./test-auth-helper.mjs";
import { bindVerifierLocalMcpGrantIdentity, createVerifierLocalMcpGrantIdentity } from "./lib/local-mcp-verifier-identity.mjs";
import { installerProcessEnv, saveInstallerProcessIdentity } from "./lib/mcp-neutral-peer-identity-support.mjs";
import { assertExpectedOutlets, outletNames } from "./lib/mcp-neutral-peer-protocol-support.mjs";
import { createMcpProxyStdioClient } from "./lib/mcp-proxy-stdio-client.mjs";
import { issueVerifierLocalMcpGrant } from "./lib/local-mcp-device-authorization.mjs";
import {
  MCP_PROXY_TRANSPORT_REPORT_PATH,
  MCP_PROXY_TRANSPORT_SCHEMA_VERSION,
  MCP_PROXY_TRANSPORT_VERIFIER,
  createMcpProxyTransportReadiness
} from "./lib/mcp-proxy-transport-evidence.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const connectorScript = path.join(repoRoot, "packages/protocols/mcp/adapter/gateway-installer/bin/lico-mcp.mjs");
const restoreCapabilityKernelEnv = useIsolatedCapabilityKernelForVerifier();
const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-mcp-proxy-transport-server-"));
const installerHome = await fs.mkdtemp(path.join(os.tmpdir(), "lico-mcp-proxy-transport-home-"));
const redactionNeedles = new Set([
  userDataPath,
  installerHome,
  os.homedir(),
  repoRoot,
  process.cwd()
].filter(Boolean));
const EXPECTED_CORE_OUTLETS = Object.freeze([MCP_DISCOVERY_TOOL_NAME, MCP_GATEWAY_TOOL_NAME]);

let server = null;
let exitCode = 0;
const identityByToken = new Map();
const report = {
  schemaVersion: MCP_PROXY_TRANSPORT_SCHEMA_VERSION,
  verifier: MCP_PROXY_TRANSPORT_VERIFIER,
  startedAt: new Date().toISOString(),
  algorithm: {
    transport: "Spawn the published lico-mcp proxy command as a child process and exchange JSON-RPC 2.0 messages over newline-delimited MCP stdio frames.",
    identity: "For every release target, create a real local MCP grant and persist the returned process identity package into an isolated file-backed process identity store before launching the proxy.",
    protocol: "Verify initialize, tools/list, and lico.discovery tools/call through the proxy process for every target listed by MCP_SUPPORTED_TARGETS.",
    redaction: "Report only target names, counts, statuses, and non-secret protocol booleans; temp roots, tokens, paths, and authorization material are scanned before write."
  },
  targets: [],
  summary: {}
};

function trackRedaction(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      redactionNeedles.add(text);
    }
  }
}

function redactText(value = "") {
  let text = String(value || "");
  for (const needle of redactionNeedles) {
    if (needle && text.includes(needle)) {
      text = text.split(needle).join("[redacted]");
    }
  }
  text = text.replace(/Bearer\s+(?!\[redacted\])(?:[A-Za-z0-9._~+/=-]{8,})/giu, "Bearer [redacted]");
  text = text.replace(/"token"\s*:\s*"[^"]+"/giu, "\"token\":\"[redacted]\"");
  text = text.replace(/"X-LicoMesh-Api-Key"\s*:\s*"[^"]+"/giu, "\"X-LicoMesh-Api-Key\":\"[redacted]\"");
  text = text.replace(/\blico_[A-Za-z0-9_-]{12,}\b/gu, "lico_[redacted]");
  return text;
}

function safeEvidence(value = {}) {
  return JSON.parse(JSON.stringify(value, (_, child) => {
    if (typeof child !== "string") {
      return child;
    }
    return redactText(child);
  }));
}

function assertNoLeakText(text = "", label = "text") {
  const value = String(text || "");
  for (const needle of redactionNeedles) {
    assert.equal(value.includes(needle), false, `${label} leaked a redacted verifier value`);
  }
  assert.equal(/Bearer\s+(?!\[redacted\])(?:[A-Za-z0-9._~+/=-]{8,})/iu.test(value), false, `${label} leaked a bearer token`);
  assert.equal(/"token"\s*:\s*"(?!\[redacted\])[^"]+"/iu.test(value), false, `${label} leaked a token field`);
  assert.equal(/"X-LicoMesh-Api-Key"\s*:\s*"(?!\[redacted\])[^"]+"/iu.test(value), false, `${label} leaked an MCP API key`);
  assert.equal(/\blico_[A-Za-z0-9_-]{12,}\b/u.test(value), false, `${label} leaked a LicoMesh token-like value`);
}

function failureEvidence(error) {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    reasonCode: String(error?.reasonCode || ""),
    code: String(error?.code || ""),
    message: process.env.LICO_VERIFY_VERBOSE ? redactText(error?.message || String(error || "")) : ""
  };
}

async function requestJson(route, options = {}) {
  const response = await fetch(`${server.url}${route}`, options);
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    payload: text.trim() ? JSON.parse(text) : {}
  };
}

async function createLocalGrant(target) {
  const verifierIdentity = createVerifierLocalMcpGrantIdentity({
    target,
    label: `verify-mcp-proxy-transport-${target}`
  });
  const response = await issueVerifierLocalMcpGrant({
    server,
    grantRequest: {
      targets: [target],
      label: `verify-mcp-proxy-transport-${target}`,
      connectorVersion: "verify-mcp-proxy-transport",
      processIdentity: verifierIdentity.request
    }
  });
  assert.equal(response.status, 201, JSON.stringify(safeEvidence(response.payload)));
  assert.equal(response.payload.ok, true);
  assert.ok(response.payload.token, "local grant did not return a token");
  trackRedaction(
    response.payload.token,
    response.payload.tokenPrefix,
    response.payload.grant?.tokenPrefix,
    response.payload.grant?.id
  );
  bindVerifierLocalMcpGrantIdentity({
    identityByToken,
    token: response.payload.token,
    identity: verifierIdentity.identity,
    payload: response.payload
  });
  await saveInstallerProcessIdentity({
    installerHome,
    target,
    serverUrl: server.url,
    identity: verifierIdentity.identity,
    payload: response.payload,
    trackRedaction
  });
  return {
    grantId: response.payload.grant?.id || "",
    token: response.payload.token
  };
}

async function verifyTargetProxyTransport(target) {
  const grant = await createLocalGrant(target);
  const env = {
    ...installerProcessEnv(installerHome),
    LICO_MCP_TOKEN: grant.token
  };
  const proxy = createMcpProxyStdioClient({
    connectorScript,
    target,
    baseUrl: server.url,
    env,
    cwd: repoRoot,
    redactText,
    timeoutMs: 12000
  });
  try {
    const profile = proxy.profile;
    const initialize = await proxy.request("initialize", {
      protocolVersion: profile.protocolVersion,
      capabilities: profile.capabilities,
      clientInfo: profile.clientInfo
    }, { id: 0 });
    assert.equal(initialize.result?.serverInfo?.name, "LicoMesh");
    assert.equal(initialize.result?.capabilities?.tools?.listChanged, true);
    await proxy.notify("notifications/initialized", {}, {
      omitParams: profile.initializedParamsOmitted === true
    });

    const toolsList = await proxy.request("tools/list", profile.toolsListParams || {}, {
      id: 1,
      omitParams: profile.toolsListParams === undefined
    });
    const tools = toolsList.result?.tools || [];
    assertExpectedOutlets(tools, EXPECTED_CORE_OUTLETS);

    const health = await proxy.request("tools/call", {
      name: "lico.discovery",
      arguments: {
        apiVersion: MCP_INTERFACE_VERSION,
        operation: "system.health",
        input: {},
        clientVersion: "verify-mcp-proxy-transport"
      }
    }, { id: 2 });
    assert.equal(health.error, undefined, JSON.stringify(safeEvidence(health.error || {})));
    assert.equal(health.result?.structuredContent?.payload?.ok, true);
    const close = await proxy.close();
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
  } catch (error) {
    await proxy.close().catch(() => {});
    throw error;
  }
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  const failedCount = report.targets.filter((row) => row.status !== "verified").length;
  report.summary = {
    targetCount: report.targets.length,
    requiredTargets: [...MCP_SUPPORTED_TARGETS],
    verifiedTargets: report.targets.filter((row) => row.status === "verified").map((row) => row.target),
    failedCount,
    reportLeakScan: true
  };
  const readiness = createMcpProxyTransportReadiness(report);
  report.summary.releaseReady = readiness.releaseReady;
  report.summary.coverageReady = readiness.coverageReady;
  report.summary.readinessSource = readiness.sourceOfTruth;
  report.summary.readinessReasons = readiness.reasons;
  const serialized = JSON.stringify(report);
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

  console.log("=== MCP Proxy Transport: real lico-mcp proxy stdio verifier ===");
  for (const target of MCP_SUPPORTED_TARGETS) {
    process.stdout.write(`  ${target} proxy stdio initialize/list/call ... `);
    try {
      const evidence = await verifyTargetProxyTransport(target);
      report.targets.push(evidence);
      console.log("ok");
    } catch (error) {
      report.targets.push({
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
      });
      console.log("FAIL");
      throw error;
    }
  }
} catch (error) {
  console.error(`FAIL: ${redactText(error?.message || String(error))}`);
  if (process.env.LICO_VERIFY_VERBOSE) {
    console.error(redactText(error?.stack || String(error)));
  }
  exitCode = 1;
} finally {
  try {
    const readiness = await writeReport();
    if (readiness.releaseReady !== true) {
      console.error(`FAIL: MCP proxy transport readiness failed: ${readiness.reasons.join(", ")}`);
      exitCode = 1;
    }
  } catch (error) {
    console.error(`FAIL: could not write report: ${redactText(error?.message || String(error))}`);
    exitCode = 1;
  }
  if (server?.close) {
    await server.close();
  }
  await fs.rm(installerHome, { recursive: true, force: true }).catch(() => {});
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
  restoreCapabilityKernelEnv();
}

if (exitCode === 0) {
  console.log(`PASS: MCP proxy transport verified for ${MCP_SUPPORTED_TARGETS.length} targets; report: ${MCP_PROXY_TRANSPORT_REPORT_PATH}`);
}

process.exit(exitCode);
