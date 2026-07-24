#!/usr/bin/env node
// Deterministic downstream agent stand-in verification.
//
// A scripted agent scenario drives the published meshrix-mcp proxy CLI as a real
// stdio child process for every declared MCP client target. Each turn goes
// through the platform downstream MCP gateway (process identity, operation
// permission grant, tool projection) and reaches the deterministic upstream
// fixture MCP service, so the whole downstream chain runs with no LLM access
// and no external credentials. Custom scenarios can extend the default turn
// sequence through the MESHRIX_DOWNSTREAM_AGENT_SCENARIO environment variable.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.mjs";
import { installAuthenticatedFetch } from "./test-auth-helper.mjs";
import {
  DOWNSTREAM_AGENT_CLIENT_TARGETS,
  DOWNSTREAM_AGENT_CANCELLATION_TARGET,
  DOWNSTREAM_AGENT_SCENARIO_ENV,
  DOWNSTREAM_AGENT_TOOL_LOOP_REPORT_PATH,
  DOWNSTREAM_AGENT_TOOL_LOOP_SCHEMA_VERSION,
  DOWNSTREAM_AGENT_TOOL_LOOP_VERIFIER,
  createDownstreamAgentToolLoopReadiness,
  defaultDownstreamAgentScenario,
  normalizeDownstreamAgentScenario,
  stableDownstreamAgentRefHash
} from "./lib/downstream-agent-tool-loop-evidence.mjs";
import {
  UPSTREAM_FIXTURE_CLI_PATH,
  UPSTREAM_FIXTURE_TOKEN_ENV,
  fixtureTokenProof
} from "./lib/upstream-fixture-service.mjs";
import {
  UPSTREAM_FIXTURE_MCP_SERVICE_ID,
  UPSTREAM_FIXTURE_TOOL_PREFIX,
  upstreamFixtureGrantBindings,
  upstreamFixtureScenarioToolNames
} from "./lib/upstream-fixture-grant.mjs";
import { createVerifierLocalMcpGrantIdentity } from "./lib/local-mcp-verifier-identity.mjs";
import {
  installerProcessEnv,
  saveInstallerProcessIdentity
} from "./lib/mcp-neutral-peer-identity-support.mjs";
import { createMcpProxyStdioClient } from "./lib/mcp-proxy-stdio-client.mjs";
import { issueVerifierLocalMcpGrant } from "./lib/local-mcp-device-authorization.mjs";
import {
  WINDOWS_LOCAL_PATH_PATTERN,
  redactReportText
} from "./lib/sensitive-report-scan.mjs";
import { seedVerifierUpstreamServices, writeVerifierLocalUpstreamSecret } from "./lib/upstream-gateway-verifier-publication.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const connectorScript = path.join(repoRoot, "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.mjs");
const fixtureCliPath = path.join(repoRoot, UPSTREAM_FIXTURE_CLI_PATH);
const REPORT_PATH = path.join(repoRoot, DOWNSTREAM_AGENT_TOOL_LOOP_REPORT_PATH);
const MCP_SECRET_REF = "secret://verify/downstream-agent-tool-loop/fixture-token";
const GATEWAY_SCOPES = ["gateway:read", "gateway:write"];
const CANCELLATION_UPSTREAM_TOOL_NAMES = Object.freeze([
  "state.increment.delayed",
  "state.peer.wait",
  "state.probe"
]);
const CANCELLATION_TARGET_DELAY_MS = 1_500;
const CANCELLATION_PEER_DELAY_MS = 2_500;

const restoreCapabilityKernelEnv = useIsolatedCapabilityKernelForVerifier();
const verifierStartedAt = new Date().toISOString();
const runtimeSecretValues = new Set();
const redactionNeedles = new Set([
  repoRoot,
  os.homedir(),
  process.cwd(),
  connectorScript,
  fixtureCliPath
].filter(Boolean));
const tempRoots = [];
let server = null;
let userDataPath = "";
let installerHome = "";

const fixtureToken = `fixture-mcp-${randomBytes(18).toString("hex")}`;
runtimeSecretValues.add(fixtureToken);

function trackRedaction(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) redactionNeedles.add(text);
  }
}

function rememberTempRoot(root) {
  tempRoots.push(root);
  trackRedaction(root);
  return root;
}

function redactText(value = "") {
  let text = redactReportText(value, {
    dynamicNeedles: [...redactionNeedles, ...runtimeSecretValues]
  });
  for (const secret of runtimeSecretValues) {
    if (secret) text = text.split(secret).join("[redacted-secret]");
  }
  return text;
}

function safeEvidence(value = {}) {
  return JSON.parse(JSON.stringify(value, (_, child) => {
    if (typeof child !== "string") return child;
    return redactText(child);
  }));
}

function assertNoSecretLeak(serialized = "") {
  const redacted = redactText(serialized);
  for (const secret of runtimeSecretValues) {
    if (secret && serialized.includes(secret)) {
      throw new Error("Downstream agent tool loop verifier attempted to write a secret into its report.");
    }
  }
  for (const needle of redactionNeedles) {
    if (needle && serialized.includes(needle)) {
      throw new Error("Downstream agent tool loop verifier attempted to write local verifier state into its report.");
    }
  }
  if (
    /(?:\/Users\/|\/private\/|\/var\/folders\/)[^\s"'`]+/u.test(redacted) ||
    WINDOWS_LOCAL_PATH_PATTERN.test(redacted)
  ) {
    throw new Error("Downstream agent tool loop verifier attempted to write a local path into its report.");
  }
  if (/Bearer\s+(?!\[redacted\])\S+/iu.test(redacted)) {
    throw new Error("Downstream agent tool loop verifier attempted to write a bearer token into its report.");
  }
}

async function writeReport(report) {
  const finishedAt = new Date().toISOString();
  report.startedAt = report.startedAt || verifierStartedAt;
  report.generatedAt = report.generatedAt || finishedAt;
  report.finishedAt = report.finishedAt || finishedAt;
  const readiness = createDownstreamAgentToolLoopReadiness(report);
  report.summary = {
    ...(report.summary || {}),
    reportLeakScan: true,
    releaseReady: readiness.releaseReady,
    liveStatus: readiness.liveStatus,
    readinessSourceOfTruth: readiness.sourceOfTruth
  };
  report.readiness = readiness;
  const serialized = `${JSON.stringify(safeEvidence(report), null, 2)}\n`;
  assertNoSecretLeak(serialized);
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, serialized);
  return readiness;
}

function failureEvidence(error, phase = "") {
  return {
    phase,
    name: error instanceof Error ? error.name : typeof error,
    code: String(error?.code || ""),
    message: redactText(error?.message || String(error)).slice(-1000)
  };
}

async function loadScenario() {
  const customPath = String(process.env[DOWNSTREAM_AGENT_SCENARIO_ENV] || "").trim();
  if (!customPath) {
    return {
      source: "embedded",
      turns: normalizeDownstreamAgentScenario(defaultDownstreamAgentScenario())
    };
  }
  const raw = await fs.readFile(path.resolve(repoRoot, customPath), "utf8");
  return {
    source: "custom",
    turns: normalizeDownstreamAgentScenario(JSON.parse(raw))
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

async function createLocalGrant({ target, scenario, extraToolNames = [] }) {
  const grantBindings = upstreamFixtureGrantBindings({
    secretRef: MCP_SECRET_REF,
    toolNames: [...new Set([
      ...upstreamFixtureScenarioToolNames(scenario.turns),
      ...extraToolNames
    ])]
  });
  const verifierIdentity = createVerifierLocalMcpGrantIdentity({
    target,
    label: `verify-downstream-agent-${target}`
  });
  const response = await issueVerifierLocalMcpGrant({
    server,
    grantRequest: {
      targets: [target],
      label: `verify-downstream-agent-${target}`,
      connectorVersion: "verify-downstream-agent-tool-loop",
      toolsets: ["meshrix.gateway.read", "meshrix.gateway.write"],
      dynamicCapabilities: [...grantBindings.dynamicCapabilities],
      allowedServiceIds: [...grantBindings.allowedServiceIds],
      allowedSecretBindings: [...grantBindings.allowedSecretBindings],
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
  await saveInstallerProcessIdentity({
    installerHome,
    target,
    serverUrl: server.url,
    identity: verifierIdentity.identity,
    payload: response.payload,
    trackRedaction
  });
  return {
    token: response.payload.token,
    grantIdHash: stableDownstreamAgentRefHash(response.payload.grant?.id || "")
  };
}

function proxyResponseOk(response = {}) {
  return !response.error && Boolean(response.result);
}

function publicToolNames(response = {}) {
  return (Array.isArray(response.result?.tools) ? response.result.tools : [])
    .map((tool) => String(tool?.name || ""))
    .filter(Boolean);
}

function structuredContent(response = {}) {
  const structured = response.result?.structuredContent;
  return structured && typeof structured === "object" && !Array.isArray(structured) ? structured : {};
}

function upstreamPayload(response = {}) {
  const payload = structuredContent(response).payload?.response?.structuredContent;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

async function runScenarioTurn({ client, turn, requestId, target, observed }) {
  if (turn.kind === "initialize") {
    const profile = client.profile;
    const initialize = await client.request("initialize", {
      protocolVersion: profile.protocolVersion,
      capabilities: profile.capabilities,
      clientInfo: profile.clientInfo
    }, { id: requestId, timeoutMs: 60000 });
    assert.equal(proxyResponseOk(initialize), true, JSON.stringify(safeEvidence(initialize)));
    assert.equal(initialize.result?.serverInfo?.name, "Meshrix");
    await client.notify("notifications/initialized", {}, {
      omitParams: profile.initializedParamsOmitted === true
    });
    observed.initialized = true;
    observed.initializedNotificationSent = true;
    observed.clientProtocolProfile = {
      target: profile.target,
      source: profile.profileSource,
      observedClientVersion: profile.observedClientVersion,
      protocolVersion: profile.protocolVersion,
      clientInfoName: profile.clientInfo.name,
      capabilityKeys: Object.keys(profile.capabilities),
      framing: profile.framing
    };
    return {
      serverName: "Meshrix",
      initializedNotificationSent: true,
      clientProtocolProfile: observed.clientProtocolProfile
    };
  }
  if (turn.kind === "tools/list") {
    const toolsList = await client.request("tools/list", client.profile.toolsListParams || {}, {
      id: requestId,
      timeoutMs: 60000,
      omitParams: client.profile.toolsListParams === undefined
    });
    assert.equal(proxyResponseOk(toolsList), true, JSON.stringify(safeEvidence(toolsList)));
    const toolNames = publicToolNames(toolsList);
    for (const toolName of turn.expect.visibleTools || []) {
      assert.equal(toolNames.includes(toolName), true, `expected visible tool missing: ${toolName}`);
    }
    for (const toolName of turn.expect.hiddenTools || []) {
      assert.equal(toolNames.includes(toolName), false, `expected hidden tool visible: ${toolName}`);
    }
    observed.toolNames = toolNames;
    return { toolCount: toolNames.length };
  }
  if (turn.expect.deniedTool === true) {
    let denied = false;
    let deniedMessage = "";
    try {
      await client.request("tools/call", {
        name: turn.toolName,
        arguments: turn.arguments
      }, { id: requestId, timeoutMs: 60000 });
    } catch (error) {
      denied = true;
      deniedMessage = redactText(error?.message || "");
    }
    assert.equal(denied, true, `expected the downstream gateway to reject ${turn.toolName}`);
    observed.deniedToolNames = [...(observed.deniedToolNames || []), turn.toolName];
    return { denied: true, deniedMessage: deniedMessage.slice(-200) };
  }
  const called = await client.request("tools/call", {
    name: turn.toolName,
    arguments: turn.arguments
  }, { id: requestId, timeoutMs: 120000 });
  assert.equal(proxyResponseOk(called), true, JSON.stringify(safeEvidence(called)));
  const structured = structuredContent(called);
  if (turn.expect.upstreamMcp === true) {
    assert.equal(structured.upstreamMcp, true, JSON.stringify(safeEvidence(structured)));
    assert.equal(structured.toolName, turn.toolName);
  }
  const evidence = { toolName: turn.toolName };
  if (turn.expect.credentialProof === true) {
    const payload = upstreamPayload(called);
    const authProof = payload.authProof && typeof payload.authProof === "object" ? payload.authProof : {};
    const tokenProofMatches = Boolean(authProof.tokenProof) && authProof.tokenProof === fixtureTokenProof(fixtureToken);
    assert.equal(authProof.presented, true, "fixture must receive the injected credential env");
    assert.equal(tokenProofMatches, true, "fixture credential proof must match the issued secret");
    observed.credentialProof = {
      credentialPresented: true,
      tokenProofMatchesIssuedCredential: tokenProofMatches,
      rawCredentialRedacted: true
    };
    evidence.credentialProof = observed.credentialProof;
  }
  observed.calledToolNames = [...(observed.calledToolNames || []), turn.toolName];
  return evidence;
}

function fixtureToolCall(name, args = {}) {
  return {
    name: `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.${name}`,
    arguments: args
  };
}

async function requestGatewayFixtureTool(name, args = {}) {
  return requestJson("/api/gateway/v1/forward", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      serviceId: UPSTREAM_FIXTURE_MCP_SERVICE_ID,
      operationKey: "tools/call",
      toolName: name,
      arguments: args
    })
  });
}

function gatewayFixturePayload(response = {}) {
  const payload = response.payload?.response?.structuredContent;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

function waitFor(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function runCancellationPropagationScenario({ client }) {
  const requestIds = {
    cancelled: 9_001,
    peer: 9_002,
    saturatedProbeStart: 9_100,
    admittedProbeStart: 9_200,
    finalProbe: 9_300
  };
  const startedAtMs = Date.now();
  const cancelledOutcome = client.requestRaw("tools/call", fixtureToolCall(
    "state.increment.delayed",
    { amount: 7, delayMs: CANCELLATION_TARGET_DELAY_MS }
  ), {
    id: requestIds.cancelled,
    timeoutMs: 10_000
  }).then(
    (message) => ({ kind: "response", message }),
    () => ({ kind: "abandoned" })
  );
  const peerOutcome = requestGatewayFixtureTool("state.peer.wait", {
    delayMs: CANCELLATION_PEER_DELAY_MS
  }).then(
    (response) => ({ kind: "response", response }),
    (error) => ({ kind: "error", error })
  );

  await waitFor(200);
  let saturatedProbe = null;
  let lastSaturationStats = {};
  let saturationAttempts = 0;
  for (; saturationAttempts < 100; saturationAttempts += 1) {
    const response = await requestGatewayFixtureTool("state.probe");
    if (response.status === 429) {
      saturatedProbe = response;
      break;
    }
    lastSaturationStats = gatewayFixturePayload(response).delayedOperations || {};
    await waitFor(25);
  }
  assert.ok(
    saturatedProbe?.status === 429,
    `two active upstream operations must saturate maxConcurrent=2 before cancellation; activeIncrement=${Number(lastSaturationStats.activeIncrement || 0)} activePeer=${Number(lastSaturationStats.activePeer || 0)}`
  );

  await client.notify("notifications/cancelled", { requestId: requestIds.cancelled });

  let admittedProbe = null;
  let admittedProbeAttempts = 0;
  for (; admittedProbeAttempts < 20; admittedProbeAttempts += 1) {
    const response = await client.requestRaw("tools/call", fixtureToolCall("state.probe"), {
      id: requestIds.admittedProbeStart + admittedProbeAttempts,
      timeoutMs: 5_000
    });
    if (!response?.error) {
      admittedProbe = response;
      break;
    }
    await waitFor(25);
  }
  assert.equal(proxyResponseOk(admittedProbe), true, JSON.stringify(safeEvidence(admittedProbe)));
  const admittedStructured = structuredContent(admittedProbe);
  const admittedPayload = upstreamPayload(admittedProbe);
  const admittedStats = admittedPayload.delayedOperations || {};
  assert.equal(admittedStructured.upstreamMcp, true);
  assert.match(admittedStructured.operation, /^upstream\.[A-Za-z0-9_-]+\.tools-call$/u);
  assert.ok(admittedStructured.toolExecutionId, "Operation Permission must issue a tool execution receipt");
  assert.equal(admittedStats.activeIncrement, 0, "cancelled increment must release its upstream operation");
  assert.equal(admittedStats.activePeer, 1, "peer must remain active when the replacement probe is admitted");
  assert.equal(admittedStats.matchedCancellations, 1, "upstream stdio fixture must correlate the cancellation request id");
  assert.equal(admittedPayload.counter, 0, "cancelled increment must not mutate the fixture counter");

  const peer = await peerOutcome;
  assert.equal(peer.kind, "response", "the independent peer request must complete");
  assert.equal(peer.response.status, 200, JSON.stringify(safeEvidence(peer.response.payload)));
  const peerPayload = gatewayFixturePayload(peer.response);
  assert.equal(peerPayload.peerCompleted, true, "the independent peer operation must be unaffected");

  const originalDeadlineAtMs = startedAtMs + CANCELLATION_TARGET_DELAY_MS;
  if (Date.now() <= originalDeadlineAtMs) {
    await waitFor(originalDeadlineAtMs - Date.now() + 50);
  }
  const finalProbe = await client.request("tools/call", fixtureToolCall("state.probe"), {
    id: requestIds.finalProbe,
    timeoutMs: 5_000
  });
  const finalPayload = upstreamPayload(finalProbe);
  const finalStats = finalPayload.delayedOperations || {};
  assert.equal(finalPayload.counter, 0, "cancelled increment must remain side-effect free after its original deadline");
  assert.equal(finalStats.incrementStarted, 1);
  assert.equal(finalStats.incrementCompleted, 0);
  assert.equal(finalStats.incrementCancelled, 1);
  assert.equal(finalStats.peerStarted, 1);
  assert.equal(finalStats.peerCompleted, 1);
  assert.equal(finalStats.peerCancelled, 0);
  assert.equal(finalStats.activeIncrement, 0);
  assert.equal(finalStats.activePeer, 0);

  const cancelledResponseCount = client.observedResponseCount(requestIds.cancelled);
  assert.equal(cancelledResponseCount, 0, "cancelled downstream request must not receive a JSON-RPC response");
  assert.equal(client.abandonRequest(requestIds.cancelled), true);
  assert.equal((await cancelledOutcome).kind, "abandoned");

  return {
    target: DOWNSTREAM_AGENT_CANCELLATION_TARGET,
    spawnedProxyTransport: true,
    downstreamMcpTransportProven: true,
    operationPermissionExecutionProven: true,
    gatewayRegistryForwardProven: true,
    actualStdioUpstreamProven: true,
    upstreamCancellationObserved: finalStats.matchedCancellations === 1,
    cancelledRequestIdCorrelated: finalStats.incrementCancelled === 1,
    cancelledRequestResponseCount: cancelledResponseCount,
    sideEffectAbsentAfterOriginalDeadline: Date.now() > originalDeadlineAtMs && finalPayload.counter === 0,
    trafficPolicyMaxConcurrent: 2,
    preCancellationCapacityDenied: saturatedProbe?.status === 429,
    trafficSlotReleasedWhilePeerActive: admittedStats.activePeer === 1,
    probeAdmittedAfterCancellation: proxyResponseOk(admittedProbe),
    peerUnaffected: peerPayload.peerCompleted === true && finalStats.peerCancelled === 0,
    finalCounter: finalPayload.counter,
    delayedIncrementStartedCount: finalStats.incrementStarted,
    delayedIncrementCompletedCount: finalStats.incrementCompleted,
    delayedIncrementCancelledCount: finalStats.incrementCancelled,
    peerStartedCount: finalStats.peerStarted,
    peerCompletedCount: finalStats.peerCompleted,
    saturationAttemptCount: saturationAttempts + 1,
    admissionAttemptCount: admittedProbeAttempts + 1
  };
}

async function runProxyClientTarget({ target, scenario }) {
  const tokenEnv = `MESHRIX_VERIFY_DOWNSTREAM_AGENT_${target.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase()}_${randomBytes(4).toString("hex").toUpperCase()}`;
  const cancellationTarget = target === DOWNSTREAM_AGENT_CANCELLATION_TARGET;
  const grant = await createLocalGrant({
    target,
    scenario,
    extraToolNames: cancellationTarget ? CANCELLATION_UPSTREAM_TOOL_NAMES : []
  });
  runtimeSecretValues.add(grant.token);
  const clientOptions = {
    connectorScript,
    target,
    baseUrl: server.url,
    tokenEnvName: tokenEnv,
    cwd: repoRoot,
    env: {
      ...installerProcessEnv(installerHome),
      [tokenEnv]: grant.token
    },
    timeoutMs: 120000,
    redactText
  };
  const client = createMcpProxyStdioClient(clientOptions);
  const observed = {
    initialized: false,
    initializedNotificationSent: false,
    clientProtocolProfile: null,
    toolNames: [],
    calledToolNames: [],
    deniedToolNames: [],
    credentialProof: null
  };
  const turnResults = [];
  try {
    let requestId = -1;
    for (const turn of scenario.turns) {
      requestId += 1;
      try {
        const evidence = await runScenarioTurn({ client, turn, requestId, target, observed });
        turnResults.push({ turnId: turn.turnId, kind: turn.kind, status: "passed", evidence });
      } catch (error) {
        turnResults.push({
          turnId: turn.turnId,
          kind: turn.kind,
          status: "failed",
          evidence: { message: redactText(error?.message || String(error)).slice(-500) }
        });
        throw error;
      }
    }
    const cancellationPropagation = cancellationTarget
      ? await runCancellationPropagationScenario({ client })
      : null;
    const close = await client.close();
    assert.equal(close.notifications, 0, "proxy must not reply to notifications/initialized");
    const readOnlyTool = `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.records.search`;
    const identityTool = `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.session.identity`;
    const destructiveTool = `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.records.purge`;
    return {
      target,
      status: "passed",
      realProxyTransport: true,
      proxyCommand: "meshrix-mcp proxy",
      protocol: "mcp-stdio-jsonl-json-rpc",
      initialized: observed.initialized,
      initializedNotificationSent: observed.initializedNotificationSent,
      unexpectedNotificationResponses: close.notifications,
      clientProtocolProfile: observed.clientProtocolProfile || {},
      grantIdHash: grant.grantIdHash,
      turnCount: scenario.turns.length,
      completedTurnIds: turnResults.filter((item) => item.status === "passed").map((item) => item.turnId),
      failedTurnCount: turnResults.filter((item) => item.status !== "passed").length,
      turns: turnResults,
      toolCount: observed.toolNames.length,
      readOnlyToolVisible: observed.toolNames.includes(readOnlyTool),
      identityToolVisible: observed.toolNames.includes(identityTool),
      destructiveToolHidden: !observed.toolNames.includes(destructiveTool),
      readOnlyCallOk: observed.calledToolNames.includes(readOnlyTool),
      identityCallOk: observed.calledToolNames.includes(identityTool),
      deniedDestructiveRejected: observed.deniedToolNames.includes(destructiveTool),
      credentialProof: observed.credentialProof || {},
      ...(cancellationPropagation ? { cancellationPropagation } : {}),
      proxyExitOk: close.status === 0,
      proxyDiagnostics: client.diagnostics()
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const scenario = await loadScenario();
  userDataPath = rememberTempRoot(await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-downstream-agent-loop-")));
  installerHome = rememberTempRoot(await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-downstream-agent-home-")));
  await writeVerifierLocalUpstreamSecret({
    userDataPath,
    fixtureUrl: "http://127.0.0.1",
    secretRef: MCP_SECRET_REF,
    resolvedSecretToken: fixtureToken,
    serviceId: UPSTREAM_FIXTURE_MCP_SERVICE_ID,
    provider: "downstream-agent-tool-loop-verifier",
    family: "upstream-gateway",
    authType: "env",
    payload: {
      env: {
        [UPSTREAM_FIXTURE_TOKEN_ENV]: fixtureToken
      }
    },
    bindNetworkTarget: false,
    scopes: GATEWAY_SCOPES,
    trackSecret: (secret) => {
      if (secret) runtimeSecretValues.add(secret);
    }
  });
  await seedVerifierUpstreamServices({
    userDataPath,
    services: [
      {
        serviceId: UPSTREAM_FIXTURE_MCP_SERVICE_ID,
        label: "Fixture MCP upstream",
        serviceProtocol: "mcp",
        mcp: {
          transport: "stdio",
          command: process.execPath,
          args: [fixtureCliPath, "--mode", "mcp-stdio"],
          toolNamePrefix: UPSTREAM_FIXTURE_TOOL_PREFIX,
          toolsCacheTtlMs: 0,
          timeoutMs: 15000
        },
        credentialRefs: [MCP_SECRET_REF],
        requiredScopes: GATEWAY_SCOPES,
        operations: [{
          operationKey: "tools/call",
          protocol: "mcp",
          requiredScopes: ["gateway:write"],
          risk: "safe_write"
        }],
        trafficPolicy: { perMinute: 600, burst: 120, maxConcurrent: 2 }
      }
    ]
  });

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

  const baseReport = {
    schemaVersion: DOWNSTREAM_AGENT_TOOL_LOOP_SCHEMA_VERSION,
    verifier: DOWNSTREAM_AGENT_TOOL_LOOP_VERIFIER,
    summary: {
      reportLeakScan: true,
      serviceConfigured: true,
      selfContained: true,
      targetCount: DOWNSTREAM_AGENT_CLIENT_TARGETS.length,
      fixtureCli: UPSTREAM_FIXTURE_CLI_PATH
    },
    notes: "Scripted target-specific client profiles drive the published meshrix-mcp proxy CLI over newline-delimited stdio JSON-RPC for every declared MCP client target, through the downstream MCP gateway to the deterministic upstream fixture MCP service."
  };

  const proxyClientTargets = [];
  for (const target of DOWNSTREAM_AGENT_CLIENT_TARGETS) {
    proxyClientTargets.push(await runProxyClientTarget({ target, scenario }));
  }
  const cancellationPropagation = proxyClientTargets.find(
    (item) => item.target === DOWNSTREAM_AGENT_CANCELLATION_TARGET
  )?.cancellationPropagation || {};

  const readiness = await writeReport({
    ...baseReport,
    evidence: {
      scenario: {
        source: scenario.source,
        turnCount: scenario.turns.length,
        turnIds: scenario.turns.map((turn) => turn.turnId)
      },
      secretStoreCredentialBinding: {
        accepted: true,
        serviceCredentialRefCount: 1,
        resolvedCredentialRefCount: 1,
        credentialRefHash: stableDownstreamAgentRefHash(MCP_SECRET_REF),
        secretPayloadEnvKeys: [UPSTREAM_FIXTURE_TOKEN_ENV],
        rawSecretRedacted: true
      },
      cancellationPropagation,
      proxyClientTargets
    }
  });
  console.log(`[downstream-agent-tool-loop] ${readiness.liveStatus}`);
  process.exitCode = readiness.releaseReady ? 0 : 1;
}

try {
  await main();
} catch (error) {
  const report = {
    schemaVersion: DOWNSTREAM_AGENT_TOOL_LOOP_SCHEMA_VERSION,
    verifier: DOWNSTREAM_AGENT_TOOL_LOOP_VERIFIER,
    summary: {
      reportLeakScan: true,
      serviceConfigured: true,
      selfContained: true,
      targetCount: DOWNSTREAM_AGENT_CLIENT_TARGETS.length,
      fixtureCli: UPSTREAM_FIXTURE_CLI_PATH
    },
    failure: failureEvidence(error, "downstream-agent-tool-loop"),
    evidence: null
  };
  try {
    const readiness = await writeReport(report);
    console.error(`[downstream-agent-tool-loop] ${readiness.liveStatus}: ${redactText(error?.message || String(error))}`);
    process.exitCode = 1;
  } catch (reportError) {
    console.error(`[downstream-agent-tool-loop] failed: ${redactText(reportError?.message || reportError)}`);
    process.exitCode = 1;
  }
} finally {
  if (server?.close) {
    await server.close().catch(() => {});
  }
  for (const root of tempRoots) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
  restoreCapabilityKernelEnv();
}
