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

import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.ts";
import { installAuthenticatedFetch } from "./test-auth-helper.ts";
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
} from "./lib/downstream-agent-tool-loop-evidence.ts";
import {
  UPSTREAM_FIXTURE_CLI_PATH,
  UPSTREAM_FIXTURE_TOKEN_ENV,
  fixtureTokenProof
} from "./lib/upstream-fixture-service.ts";
import {
  UPSTREAM_FIXTURE_MCP_SERVICE_ID,
  UPSTREAM_FIXTURE_TOOL_PREFIX,
  upstreamFixtureGrantBindings,
  upstreamFixtureScenarioToolNames
} from "./lib/upstream-fixture-grant.ts";
import { provisionVerifierLocalSecretKey } from "./lib/local-secret-verifier-key.ts";
import { installerProcessEnv } from "./lib/mcp-neutral-peer-identity-support.ts";
import { createMcpProxyStdioClient } from "./lib/mcp-proxy-stdio-client.ts";
import { issueVerifierMcpApiKey } from "./lib/verifier-mcp-api-key.ts";
import {
  WINDOWS_LOCAL_PATH_PATTERN,
  redactReportText
} from "./lib/sensitive-report-scan.ts";
import { seedVerifierUpstreamServices, writeVerifierLocalUpstreamSecret } from "./lib/upstream-gateway-verifier-publication.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const connectorScript: any = path.join(repoRoot, "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts");
const fixtureCliPath: any = path.join(repoRoot, UPSTREAM_FIXTURE_CLI_PATH);
const REPORT_PATH: any = path.join(repoRoot, DOWNSTREAM_AGENT_TOOL_LOOP_REPORT_PATH);
const MCP_SECRET_REF: any = "secret://verify/downstream-agent-tool-loop/fixture-token";
const GATEWAY_SCOPES: any[] = ["gateway:read", "gateway:write"];
const CANCELLATION_UPSTREAM_TOOL_NAMES: readonly any[] = Object.freeze([
  "state.increment.delayed",
  "state.peer.wait",
  "state.probe"
]);
const CANCELLATION_TARGET_DELAY_MS: any = 1_500;
const CANCELLATION_PEER_DELAY_MS: any = 2_500;

const restoreCapabilityKernelEnv: any = useIsolatedCapabilityKernelForVerifier();
const localSecretKeyCustody: any = await provisionVerifierLocalSecretKey();
const verifierStartedAt: any = new Date().toISOString();
const runtimeSecretValues: any = new Set<any>();
const redactionNeedles: any = new Set<any>([
  repoRoot,
  os.homedir(),
  process.cwd(),
  connectorScript,
  fixtureCliPath
].filter(Boolean));
const tempRoots: any[] = [];
let server: any = null;
let userDataPath: any = "";
let installerHome: any = "";

const fixtureToken: any = `fixture-mcp-${randomBytes(18).toString("hex")}`;
runtimeSecretValues.add(fixtureToken);

function trackRedaction(...values: any[]) : any {
  for (const value of values) {
    const text: any = String(value || "").trim();
    if (text) redactionNeedles.add(text);
  }
}

function rememberTempRoot(root?: any) : any {
  tempRoots.push(root);
  trackRedaction(root);
  return root;
}

function redactText(value: any = "") : any {
  let text: any = redactReportText(value, {
    dynamicNeedles: [...redactionNeedles, ...runtimeSecretValues]
  });
  for (const secret of runtimeSecretValues) {
    if (secret) text = text.split(secret).join("[redacted-secret]");
  }
  return text;
}

function safeEvidence(value: Record<string, any> = {}) : any {
  return JSON.parse(JSON.stringify(value, (_?: any, child?: any) : any => {
    if (typeof child !== "string") return child;
    return redactText(child);
  }));
}

function assertNoSecretLeak(serialized: any = "") : any {
  const redacted: any = redactText(serialized);
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

async function writeReport(report?: any) : Promise<any> {
  const finishedAt: any = new Date().toISOString();
  report.startedAt = report.startedAt || verifierStartedAt;
  report.generatedAt = report.generatedAt || finishedAt;
  report.finishedAt = report.finishedAt || finishedAt;
  const readiness: any = createDownstreamAgentToolLoopReadiness(report);
  report.summary = {
    ...(report.summary || {}),
    reportLeakScan: true,
    releaseReady: readiness.releaseReady,
    liveStatus: readiness.liveStatus,
    readinessSourceOfTruth: readiness.sourceOfTruth
  };
  report.readiness = readiness;
  const serialized: any = `${JSON.stringify(safeEvidence(report), null, 2)}\n`;
  assertNoSecretLeak(serialized);
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, serialized);
  return readiness;
}

function failureEvidence(error?: any, phase: any = "") : any {
  return {
    phase,
    name: error instanceof Error ? error.name : typeof error,
    code: String(error?.code || ""),
    message: redactText(error?.message || String(error)).slice(-1000)
  };
}

async function loadScenario() : Promise<any> {
  const customPath: any = String(process.env[DOWNSTREAM_AGENT_SCENARIO_ENV] || "").trim();
  if (!customPath) {
    return {
      source: "embedded",
      turns: normalizeDownstreamAgentScenario(defaultDownstreamAgentScenario())
    };
  }
  const raw: any = await fs.readFile(path.resolve(repoRoot, customPath), "utf8");
  return {
    source: "custom",
    turns: normalizeDownstreamAgentScenario(JSON.parse(raw))
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

async function createVerifierApiKey({ target, scenario, extraToolNames = [] }: Record<string, any>) : Promise<any> {
  const grantBindings: any = upstreamFixtureGrantBindings({
    secretRef: MCP_SECRET_REF,
    toolNames: [...new Set<any>([
      ...upstreamFixtureScenarioToolNames(scenario.turns),
      ...extraToolNames
    ])]
  });
  const response: any = await issueVerifierMcpApiKey({
    server,
    access: {
      targets: [target],
      label: `verify-downstream-agent-${target}`,
      connectorVersion: "verify-downstream-agent-tool-loop",
      toolsets: ["meshrix.gateway.read", "meshrix.gateway.write"],
      dynamicCapabilities: [...grantBindings.dynamicCapabilities],
      allowedServiceIds: [...grantBindings.allowedServiceIds],
      allowedSecretBindings: [...grantBindings.allowedSecretBindings],
      maxRisk: "repair_write"
    }
  });
  assert.ok(response.apiKey, "API Key issuance did not return plaintext to the direct verifier caller");
  trackRedaction(
    response.apiKey,
    response.record.keyId
  );
  return {
    token: response.apiKey,
    keyIdHash: stableDownstreamAgentRefHash(response.record.keyId)
  };
}

function proxyResponseOk(response: Record<string, any> = {}) : any {
  return !response.error && Boolean(response.result);
}

function publicToolNames(response: Record<string, any> = {}) : any {
  return (Array.isArray(response.result?.tools) ? response.result.tools : [])
    .map((tool?: any) : any => String(tool?.name || ""))
    .filter(Boolean);
}

function structuredContent(response: Record<string, any> = {}) : any {
  const structured: any = response.result?.structuredContent;
  return structured && typeof structured === "object" && !Array.isArray(structured) ? structured : {};
}

function upstreamPayload(response: Record<string, any> = {}) : any {
  const payload: any = structuredContent(response).payload?.response?.structuredContent;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

async function runScenarioTurn({ client, turn, requestId, target, observed }: Record<string, any>) : Promise<any> {
  if (turn.kind === "initialize") {
    const profile: any = client.profile;
    const initialize: any = await client.request("initialize", {
      protocolVersion: profile.protocolVersion,
      capabilities: profile.capabilities,
      clientInfo: profile.clientInfo
    }, { id: requestId, timeoutMs: 60000 });
    assert.equal(proxyResponseOk(initialize), true, JSON.stringify(safeEvidence(initialize)));
    assert.equal(initialize.result?.serverInfo?.name, "Meshrix.js");
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
      serverName: "Meshrix.js",
      initializedNotificationSent: true,
      clientProtocolProfile: observed.clientProtocolProfile
    };
  }
  if (turn.kind === "tools/list") {
    const toolsList: any = await client.request("tools/list", client.profile.toolsListParams || {}, {
      id: requestId,
      timeoutMs: 60000,
      omitParams: client.profile.toolsListParams === undefined
    });
    assert.equal(proxyResponseOk(toolsList), true, JSON.stringify(safeEvidence(toolsList)));
    const toolNames: any = publicToolNames(toolsList);
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
    let denied: any = false;
    let deniedMessage: any = "";
    try {
      await client.request("tools/call", {
        name: turn.toolName,
        arguments: turn.arguments
      }, { id: requestId, timeoutMs: 60000 });
    } catch (error: any) {
      denied = true;
      deniedMessage = redactText(error?.message || "");
    }
    assert.equal(denied, true, `expected the downstream gateway to reject ${turn.toolName}`);
    observed.deniedToolNames = [...(observed.deniedToolNames || []), turn.toolName];
    return { denied: true, deniedMessage: deniedMessage.slice(-200) };
  }
  const called: any = await client.request("tools/call", {
    name: turn.toolName,
    arguments: turn.arguments
  }, { id: requestId, timeoutMs: 120000 });
  assert.equal(proxyResponseOk(called), true, JSON.stringify(safeEvidence(called)));
  const structured: any = structuredContent(called);
  if (turn.expect.upstreamMcp === true) {
    assert.equal(structured.upstreamMcp, true, JSON.stringify(safeEvidence(structured)));
    assert.equal(structured.toolName, turn.toolName);
  }
  const evidence: Record<string, any> = { toolName: turn.toolName };
  if (turn.expect.credentialProof === true) {
    const payload: any = upstreamPayload(called);
    const authProof: any = payload.authProof && typeof payload.authProof === "object" ? payload.authProof : {};
    const tokenProofMatches: any = Boolean(authProof.tokenProof) && authProof.tokenProof === fixtureTokenProof(fixtureToken);
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

function fixtureToolCall(name?: any, args: Record<string, any> = {}) : any {
  return {
    name: `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.${name}`,
    arguments: args
  };
}

async function requestGatewayFixtureTool(name?: any, args: Record<string, any> = {}) : Promise<any> {
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

function gatewayFixturePayload(response: Record<string, any> = {}) : any {
  const payload: any = response.payload?.response?.structuredContent;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

function waitFor(durationMs?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, durationMs));
}

async function runCancellationPropagationScenario({ client }: Record<string, any>) : Promise<any> {
  const requestIds: Record<string, any> = {
    cancelled: 9_001,
    peer: 9_002,
    saturatedProbeStart: 9_100,
    admittedProbeStart: 9_200,
    finalProbe: 9_300
  };
  const startedAtMs: any = Date.now();
  const cancelledOutcome: any = client.requestRaw("tools/call", fixtureToolCall(
    "state.increment.delayed",
    { amount: 7, delayMs: CANCELLATION_TARGET_DELAY_MS }
  ), {
    id: requestIds.cancelled,
    timeoutMs: 10_000
  }).then(
    (message?: any) : any => ({ kind: "response", message }),
    () : any => ({ kind: "abandoned" })
  );
  const peerOutcome: any = requestGatewayFixtureTool("state.peer.wait", {
    delayMs: CANCELLATION_PEER_DELAY_MS
  }).then(
    (response?: any) : any => ({ kind: "response", response }),
    (error?: any) : any => ({ kind: "error", error })
  );

  await waitFor(200);
  let saturatedProbe: any = null;
  let lastSaturationStats: Record<string, any> = {};
  let saturationAttempts: any = 0;
  for (; saturationAttempts < 100; saturationAttempts += 1) {
    const response: any = await requestGatewayFixtureTool("state.probe");
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

  let admittedProbe: any = null;
  let admittedProbeAttempts: any = 0;
  for (; admittedProbeAttempts < 20; admittedProbeAttempts += 1) {
    const response: any = await client.requestRaw("tools/call", fixtureToolCall("state.probe"), {
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
  const admittedStructured: any = structuredContent(admittedProbe);
  const admittedPayload: any = upstreamPayload(admittedProbe);
  const admittedStats: any = admittedPayload.delayedOperations || {};
  assert.equal(admittedStructured.upstreamMcp, true);
  assert.match(admittedStructured.operation, /^upstream\.[A-Za-z0-9_-]+\.tools-call$/u);
  assert.ok(admittedStructured.toolExecutionId, "Operation Permission must issue a tool execution receipt");
  assert.equal(admittedStats.activeIncrement, 0, "cancelled increment must release its upstream operation");
  assert.equal(admittedStats.activePeer, 1, "peer must remain active when the replacement probe is admitted");
  assert.equal(admittedStats.matchedCancellations, 1, "upstream stdio fixture must correlate the cancellation request id");
  assert.equal(admittedPayload.counter, 0, "cancelled increment must not mutate the fixture counter");

  const peer: any = await peerOutcome;
  assert.equal(peer.kind, "response", "the independent peer request must complete");
  assert.equal(peer.response.status, 200, JSON.stringify(safeEvidence(peer.response.payload)));
  const peerPayload: any = gatewayFixturePayload(peer.response);
  assert.equal(peerPayload.peerCompleted, true, "the independent peer operation must be unaffected");

  const originalDeadlineAtMs: any = startedAtMs + CANCELLATION_TARGET_DELAY_MS;
  if (Date.now() <= originalDeadlineAtMs) {
    await waitFor(originalDeadlineAtMs - Date.now() + 50);
  }
  const finalProbe: any = await client.request("tools/call", fixtureToolCall("state.probe"), {
    id: requestIds.finalProbe,
    timeoutMs: 5_000
  });
  const finalPayload: any = upstreamPayload(finalProbe);
  const finalStats: any = finalPayload.delayedOperations || {};
  assert.equal(finalPayload.counter, 0, "cancelled increment must remain side-effect free after its original deadline");
  assert.equal(finalStats.incrementStarted, 1);
  assert.equal(finalStats.incrementCompleted, 0);
  assert.equal(finalStats.incrementCancelled, 1);
  assert.equal(finalStats.peerStarted, 1);
  assert.equal(finalStats.peerCompleted, 1);
  assert.equal(finalStats.peerCancelled, 0);
  assert.equal(finalStats.activeIncrement, 0);
  assert.equal(finalStats.activePeer, 0);

  const cancelledResponseCount: any = client.observedResponseCount(requestIds.cancelled);
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

async function runProxyClientTarget({ target, scenario }: Record<string, any>) : Promise<any> {
  const tokenEnv: any = `MESHRIX_VERIFY_DOWNSTREAM_AGENT_${target.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase()}_${randomBytes(4).toString("hex").toUpperCase()}`;
  const cancellationTarget: any = target === DOWNSTREAM_AGENT_CANCELLATION_TARGET;
  const grant: any = await createVerifierApiKey({
    target,
    scenario,
    extraToolNames: cancellationTarget ? CANCELLATION_UPSTREAM_TOOL_NAMES : []
  });
  runtimeSecretValues.add(grant.token);
  const clientOptions: Record<string, any> = {
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
  const client: any = createMcpProxyStdioClient(clientOptions);
  const observed: Record<string, any> = {
    initialized: false,
    initializedNotificationSent: false,
    clientProtocolProfile: null,
    toolNames: [],
    calledToolNames: [],
    deniedToolNames: [],
    credentialProof: null
  };
  const turnResults: any[] = [];
  try {
    let requestId: any = -1;
    for (const turn of scenario.turns) {
      requestId += 1;
      try {
        const evidence: any = await runScenarioTurn({ client, turn, requestId, target, observed });
        turnResults.push({ turnId: turn.turnId, kind: turn.kind, status: "passed", evidence });
      } catch (error: any) {
        turnResults.push({
          turnId: turn.turnId,
          kind: turn.kind,
          status: "failed",
          evidence: { message: redactText(error?.message || String(error)).slice(-500) }
        });
        throw error;
      }
    }
    const cancellationPropagation: any = cancellationTarget
      ? await runCancellationPropagationScenario({ client })
      : null;
    const close: any = await client.close();
    assert.equal(close.notifications, 0, "proxy must not reply to notifications/initialized");
    const readOnlyTool: any = `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.records.search`;
    const identityTool: any = `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.session.identity`;
    const destructiveTool: any = `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.records.purge`;
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
      completedTurnIds: turnResults.filter((item?: any) : any => item.status === "passed").map((item?: any) : any => item.turnId),
      failedTurnCount: turnResults.filter((item?: any) : any => item.status !== "passed").length,
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
    await client.close().catch(() : any => {});
  }
}

async function main() : Promise<any> {
  const scenario: any = await loadScenario();
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
    trackSecret: (secret?: any) : any => {
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

  const baseReport: Record<string, any> = {
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

  const proxyClientTargets: any[] = [];
  for (const target of DOWNSTREAM_AGENT_CLIENT_TARGETS) {
    proxyClientTargets.push(await runProxyClientTarget({ target, scenario }));
  }
  const cancellationPropagation: any = proxyClientTargets.find(
    (item?: any) : any => item.target === DOWNSTREAM_AGENT_CANCELLATION_TARGET
  )?.cancellationPropagation || {};

  const readiness: any = await writeReport({
    ...baseReport,
    evidence: {
      scenario: {
        source: scenario.source,
        turnCount: scenario.turns.length,
        turnIds: scenario.turns.map((turn?: any) : any => turn.turnId)
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
} catch (error: any) {
  const report: Record<string, any> = {
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
    const readiness: any = await writeReport(report);
    console.error(`[downstream-agent-tool-loop] ${readiness.liveStatus}: ${redactText(error?.message || String(error))}`);
    process.exitCode = 1;
  } catch (reportError: any) {
    console.error(`[downstream-agent-tool-loop] failed: ${redactText(reportError?.message || reportError)}`);
    process.exitCode = 1;
  }
} finally {
  if (server?.close) {
    await server.close().catch(() : any => {});
  }
  for (const root of tempRoots) {
    await fs.rm(root, { recursive: true, force: true }).catch(() : any => {});
  }
  await localSecretKeyCustody.close();
  restoreCapabilityKernelEnv();
}
