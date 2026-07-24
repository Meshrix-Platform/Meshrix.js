#!/usr/bin/env node
// Self-contained upstream gateway transit verification.
//
// The scenario registers the deterministic upstream fixture service twice
// (REST/OpenAPI-style HTTP operations and an MCP server, over both stdio and
// HTTP transports) through the canonical durable manifest flow, binds
// credentials through the local secret store, and verifies forwarding,
// credential injection, tool projection parity, risk governance, and the
// in-process downstream MCP projection. It needs no network access and no
// external credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createUpstreamGatewayRegistry,
  createUpstreamManifestSnapshotCommitter
} from "../../packages/agents/src/upstream-gateway/index.mjs";
import { createToolSkillManagementProvider } from "../../packages/capabilities/src/skills/tool-skill-management-provider.mjs";
import { createOperationPermissionPlatform } from "../../packages/capabilities/src/operation-permission-core/index.mjs";
import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.mjs";
import { resolveLocalSecretPayload } from "../../packages/foundation/src/security/secrets/local-secret-store.mjs";
import {
  closeDefaultUpstreamMcpSessions,
  listUpstreamMcpTools
} from "../../packages/protocols/mcp/upstream-mcp-client.mjs";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.mjs";
import {
  UPSTREAM_FIXTURE_TRANSIT_REPORT_PATH,
  UPSTREAM_FIXTURE_TRANSIT_SCHEMA_VERSION,
  UPSTREAM_FIXTURE_TRANSIT_VERIFIER,
  UPSTREAM_FIXTURE_REQUIRED_TOOL_NAMES,
  UPSTREAM_FIXTURE_SCHEMA_PARITY_TOOL_NAMES,
  createUpstreamFixtureTransitReadiness,
  stableUpstreamFixtureRefHash
} from "./lib/upstream-fixture-transit-evidence.mjs";
import {
  UPSTREAM_FIXTURE_CLI_PATH,
  UPSTREAM_FIXTURE_IDENTITY,
  UPSTREAM_FIXTURE_TOKEN_ENV,
  fixtureTokenProof
} from "./lib/upstream-fixture-service.mjs";
import {
  UPSTREAM_FIXTURE_MCP_SERVICE_ID,
  UPSTREAM_FIXTURE_REST_SERVICE_ID,
  UPSTREAM_FIXTURE_TOOL_PREFIX,
  upstreamFixtureGrantBindings
} from "./lib/upstream-fixture-grant.mjs";
import {
  callDownstreamMcp,
  createVerifierSecurityPermissions,
  createVerifierUpstreamGatewayOperationHandler,
  requiredArray,
  stableJson
} from "./lib/verifier-inprocess-mcp-adapter.mjs";
import {
  WINDOWS_LOCAL_PATH_PATTERN,
  redactReportText
} from "./lib/sensitive-report-scan.mjs";
import { loadVerifierPublishedServices, seedVerifierUpstreamServices, verifierOpaqueServiceId, writeVerifierLocalUpstreamSecret } from "./lib/upstream-gateway-verifier-publication.mjs";
import { createVerifierOperationDispatcher } from "./lib/verifier-operation-dispatcher.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixtureCliPath = path.join(repoRoot, UPSTREAM_FIXTURE_CLI_PATH);
const reportPath = path.join(repoRoot, UPSTREAM_FIXTURE_TRANSIT_REPORT_PATH);
const verifierStartedAt = new Date().toISOString();

const REST_SECRET_REF = "secret://verify/upstream-fixture/rest-token";
const MCP_SECRET_REF = "secret://verify/upstream-fixture/mcp-token";
const MCP_REMOTE_SECRET_REF = "secret://verify/upstream-fixture/mcp-remote-token";
const MCP_REMOTE_SERVICE_ID = verifierOpaqueServiceId("fixture-mcp-remote");
const MCP_REMOTE_TOOL_PREFIX = "fixture-remote";
const GATEWAY_SCOPES = ["gateway:read", "gateway:write"];

function structuredOperation(operation) {
  return {
    ...operation,
    payloadTransport: {
      request: { mode: "structured_json", maxBytes: 1024 * 1024, mediaTypes: ["application/json"] },
      response: { mode: "structured_json", maxBytes: 1024 * 1024, mediaTypes: ["application/json"] }
    }
  };
}

const restoreCapabilityKernelEnv = useIsolatedCapabilityKernelForVerifier();
const verifierDispatcher = createVerifierOperationDispatcher("verify-upstream-fixture-transit");
const runtimeSecretValues = new Set();
const redactionNeedles = new Set([repoRoot, os.homedir(), process.cwd()]);

const restToken = `fixture-rest-${randomBytes(18).toString("hex")}`;
const mcpToken = `fixture-mcp-${randomBytes(18).toString("hex")}`;
for (const token of [restToken, mcpToken]) {
  runtimeSecretValues.add(token);
}

let userDataPath = "";
let fixtureChild = null;
let operationPermissionPlatform = null;
let registry = null;
let publishedManifestSnapshot = null;
let serviceConfigured = false;
let currentPhase = "initializing";

function redactText(value = "") {
  let text = redactReportText(value, {
    dynamicNeedles: [...redactionNeedles, ...runtimeSecretValues]
  });
  for (const secret of runtimeSecretValues) {
    if (secret) text = text.split(secret).join("[redacted-secret]");
  }
  return text;
}

function failureEvidence(error, phase = "") {
  return {
    phase: String(error?.verifierPhase || phase || ""),
    name: error instanceof Error ? error.name : typeof error,
    code: String(error?.code || ""),
    message: redactText(error?.message || String(error)).slice(-1000)
  };
}

async function runPhase(phase, fn) {
  currentPhase = phase;
  try {
    return await fn();
  } catch (error) {
    error.verifierPhase = phase;
    throw error;
  }
}

function assertNoSecretLeak(serialized = "") {
  for (const secret of runtimeSecretValues) {
    if (secret && serialized.includes(secret)) {
      throw new Error("Upstream fixture transit verifier attempted to write a secret into its report.");
    }
  }
  if (serialized.includes(repoRoot) ||
    serialized.includes(os.homedir()) ||
    /(?:\/Users\/|\/private\/|\/var\/folders\/)[^\s"'`]+/u.test(serialized) ||
    WINDOWS_LOCAL_PATH_PATTERN.test(serialized)) {
    throw new Error("Upstream fixture transit verifier attempted to write a local path into its report.");
  }
}

async function writeReport(report) {
  const finishedAt = new Date().toISOString();
  report.startedAt = report.startedAt || verifierStartedAt;
  report.generatedAt = report.generatedAt || finishedAt;
  report.finishedAt = report.finishedAt || finishedAt;
  const readiness = createUpstreamFixtureTransitReadiness(report);
  report.summary = {
    ...(report.summary || {}),
    releaseReady: readiness.releaseReady,
    liveStatus: readiness.liveStatus,
    readinessSourceOfTruth: readiness.sourceOfTruth
  };
  report.readiness = readiness;
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  assertNoSecretLeak(serialized);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, serialized);
  return readiness;
}

async function startFixtureHttpChild() {
  const child = spawn(process.execPath, [fixtureCliPath, "--mode", "http", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      [UPSTREAM_FIXTURE_TOKEN_ENV]: restToken
    }
  });
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2048);
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for the upstream fixture HTTP service to start."));
    }, 15000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.ok === true && parsed.url) {
            clearTimeout(timer);
            resolve(parsed.url);
            return;
          }
        } catch {
          // Wait for a complete startup line.
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Upstream fixture HTTP service exited early (code=${code}): ${redactText(stderr)}`));
    });
  });
  return { child, url };
}

function identityPayload(response = {}) {
  const direct = response && typeof response === "object" && !Array.isArray(response) ? response : {};
  const candidate = direct.structuredContent || direct;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
}

function restJson(forwardResult = {}) {
  const payload = forwardResult?.response?.json;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

function fixtureIdentityProof(payload = {}, issuedToken = "") {
  const principal = String(payload.principal || "").trim();
  const accountId = String(payload.accountId || "").trim();
  const authProof = payload.authProof && typeof payload.authProof === "object" ? payload.authProof : {};
  return {
    principalPresent: principal === UPSTREAM_FIXTURE_IDENTITY.principal,
    principalHash: stableUpstreamFixtureRefHash(principal),
    accountIdPresent: accountId === UPSTREAM_FIXTURE_IDENTITY.accountId,
    accountIdHash: stableUpstreamFixtureRefHash(accountId),
    credentialPresented: authProof.presented === true,
    credentialAccepted: authProof.accepted === true,
    tokenProofMatchesIssuedCredential: Boolean(authProof.tokenProof) &&
      authProof.tokenProof === fixtureTokenProof(issuedToken),
    rawIdentityRedacted: true
  };
}

async function stopFixtureChild() {
  if (!fixtureChild) return;
  const child = fixtureChild;
  fixtureChild = null;
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child already exited.
      }
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(killTimer);
      resolve();
    }
  });
}

try {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upstream-fixture-transit-"));
  redactionNeedles.add(userDataPath);
  const started = await runPhase("fixture-http-startup", () => startFixtureHttpChild());
  fixtureChild = started.child;
  const fixtureUrl = started.url;
  redactionNeedles.add(fixtureUrl);

  await runPhase("secret-store-provisioning", async () => {
    await writeVerifierLocalUpstreamSecret({
      userDataPath,
      fixtureUrl,
      secretRef: REST_SECRET_REF,
      resolvedSecretToken: restToken,
      serviceId: UPSTREAM_FIXTURE_REST_SERVICE_ID,
      provider: "upstream-fixture-transit-verifier",
      family: "upstream-gateway",
      authType: "bearer",
      payload: { token: restToken },
      scopes: GATEWAY_SCOPES,
      trackSecret: (secret) => {
        if (secret) runtimeSecretValues.add(secret);
      }
    });
    await writeVerifierLocalUpstreamSecret({
      userDataPath,
      fixtureUrl,
      secretRef: MCP_SECRET_REF,
      resolvedSecretToken: mcpToken,
      serviceId: UPSTREAM_FIXTURE_MCP_SERVICE_ID,
      provider: "upstream-fixture-transit-verifier",
      family: "upstream-gateway",
      authType: "env",
      payload: {
        env: {
          [UPSTREAM_FIXTURE_TOKEN_ENV]: mcpToken
        }
      },
      bindNetworkTarget: false,
      scopes: GATEWAY_SCOPES,
      trackSecret: (secret) => {
        if (secret) runtimeSecretValues.add(secret);
      }
    });
    // The MCP-over-HTTP surface runs inside the same fixture process as the
    // REST surface, so its service-scoped secret carries the same token value.
    await writeVerifierLocalUpstreamSecret({
      userDataPath,
      fixtureUrl,
      secretRef: MCP_REMOTE_SECRET_REF,
      resolvedSecretToken: restToken,
      serviceId: MCP_REMOTE_SERVICE_ID,
      provider: "upstream-fixture-transit-verifier",
      family: "upstream-gateway",
      authType: "bearer",
      payload: { token: restToken },
      scopes: GATEWAY_SCOPES,
      trackSecret: (secret) => {
        if (secret) runtimeSecretValues.add(secret);
      }
    });
  });

  const mcpStdioConfig = {
    transport: "stdio",
    command: process.execPath,
    args: [fixtureCliPath, "--mode", "mcp-stdio"],
    toolNamePrefix: UPSTREAM_FIXTURE_TOOL_PREFIX,
    toolsCacheTtlMs: 0,
    timeoutMs: 15000
  };
  await runPhase("service-registration", async () => {
    await seedVerifierUpstreamServices({
      userDataPath,
      services: [
        {
          serviceId: UPSTREAM_FIXTURE_REST_SERVICE_ID,
          label: "Fixture REST upstream",
          baseUrl: fixtureUrl,
          allowLocalNetwork: true,
          healthPath: "/health",
          credentialRefs: [REST_SECRET_REF],
          requiredScopes: GATEWAY_SCOPES,
          trafficPolicy: { perMinute: 120, burst: 60 },
          operations: [
            {
              operationKey: "records-list",
              method: "GET",
              path: "/api/records",
              risk: "read_only",
              requiredScopes: ["gateway:read"],
              publicResponseFields: ["ok", "query", "count", "items"],
              responseSchema: {
                type: "object",
                required: ["ok", "count", "items"],
                properties: {
                  ok: { const: true },
                  query: { type: "string" },
                  count: { type: "number" },
                  items: { type: "array" }
                },
                additionalProperties: true
              }
            },
            { operationKey: "record-detail", method: "GET", path: "/api/records/detail", risk: "read_only", requiredScopes: ["gateway:read"] },
            { operationKey: "echo", method: "POST", path: "/api/echo", risk: "safe_write", requiredScopes: ["gateway:write"] },
            { operationKey: "session-identity", method: "GET", path: "/api/session/identity", risk: "read_only", requiredScopes: ["gateway:read"] },
            {
              operationKey: "records-purge",
              method: "POST",
              path: "/api/records/purge",
              risk: "destructive",
              requiredScopes: ["gateway:write"],
              requiresApproval: true,
              requiredApproval: { approvalLayers: ["user"] }
            }
          ].map(structuredOperation)
        },
        {
          serviceId: UPSTREAM_FIXTURE_MCP_SERVICE_ID,
          label: "Fixture MCP upstream",
          serviceProtocol: "mcp",
          mcp: mcpStdioConfig,
          credentialRefs: [MCP_SECRET_REF],
          requiredScopes: GATEWAY_SCOPES,
          operations: [structuredOperation({ operationKey: "tools/call", protocol: "mcp", risk: "safe_write", requiredScopes: ["gateway:write"] })],
          trafficPolicy: { perMinute: 120, burst: 60 }
        },
        {
          serviceId: MCP_REMOTE_SERVICE_ID,
          label: "Fixture MCP-over-HTTP upstream",
          serviceProtocol: "mcp",
          allowLocalNetwork: true,
          mcp: {
            transport: "http",
            url: `${fixtureUrl}/mcp`,
            toolNamePrefix: MCP_REMOTE_TOOL_PREFIX,
            toolsCacheTtlMs: 0,
            timeoutMs: 15000
          },
          credentialRefs: [MCP_REMOTE_SECRET_REF],
          requiredScopes: GATEWAY_SCOPES,
          operations: [structuredOperation({ operationKey: "tools/call", protocol: "mcp", risk: "safe_write", requiredScopes: ["gateway:write"] })],
          trafficPolicy: { perMinute: 120, burst: 60 }
        }
      ]
    });
  });

  registry = createUpstreamGatewayRegistry({ userDataPath });
  const manifestLoad = await loadVerifierPublishedServices({ userDataPath, registry });
  publishedManifestSnapshot = manifestLoad.snapshot;
  const services = registry.listServices().items;
  const restService = services.find((service) => service.serviceId === UPSTREAM_FIXTURE_REST_SERVICE_ID);
  const mcpService = services.find((service) => service.serviceId === UPSTREAM_FIXTURE_MCP_SERVICE_ID);
  const remoteService = services.find((service) => service.serviceId === MCP_REMOTE_SERVICE_ID);
  assert.equal(Boolean(restService), true, "fixture REST service must load from the durable manifest snapshot");
  assert.equal(Boolean(mcpService), true, "fixture MCP service must load from the durable manifest snapshot");
  assert.equal(Boolean(remoteService), true, "fixture MCP-over-HTTP service must load from the durable manifest snapshot");
  assert.equal(mcpService.serviceProtocol, "mcp");
  assert.equal(mcpService.mcp?.transport, "stdio");
  assert.equal(mcpService.mcp?.toolNamePrefix, UPSTREAM_FIXTURE_TOOL_PREFIX);
  assert.equal(remoteService.mcp?.transport, "http");
  assert.equal(restService.credentialReferenceCount, 1);
  assert.equal(mcpService.credentialReferenceCount, 1);
  serviceConfigured = true;

  const resolvedSecrets = await runPhase("secret-store-binding", async () => {
    const rest = await resolveLocalSecretPayload({
      dataDir: userDataPath,
      secretRef: REST_SECRET_REF,
      expectedScope: {
        serviceId: UPSTREAM_FIXTURE_REST_SERVICE_ID,
        requiredScopes: ["gateway:read"],
        host: new URL(fixtureUrl).hostname,
        protocol: new URL(fixtureUrl).protocol.replace(/:$/, "")
      }
    });
    assert.equal(rest.status, "active");
    assert.equal(rest.payload?.token, restToken);
    const mcp = await resolveLocalSecretPayload({
      dataDir: userDataPath,
      secretRef: MCP_SECRET_REF,
      expectedScope: { serviceId: UPSTREAM_FIXTURE_MCP_SERVICE_ID, requiredScopes: ["gateway:read"] }
    });
    assert.equal(mcp.status, "active");
    assert.equal(mcp.payload?.env?.[UPSTREAM_FIXTURE_TOKEN_ENV], mcpToken);
    assert.equal(mcpStdioConfig.env, undefined, "MCP descriptor must not carry inline credential material");
    return { rest, mcp };
  });

  const directTools = await runPhase("fixture-mcp-direct-tools-list", () => listUpstreamMcpTools({
    ...mcpStdioConfig,
    env: { [UPSTREAM_FIXTURE_TOKEN_ENV]: mcpToken }
  }));
  const projectedTools = await runPhase("upstream-tools-projection", () =>
    registry.listMcpTools({ serviceId: UPSTREAM_FIXTURE_MCP_SERVICE_ID, refresh: true }));
  const directByName = new Map(directTools.tools.map((tool) => [tool.name, tool]));
  const projectedByUpstreamName = new Map(
    projectedTools.items.map((tool) => [tool._meta?.upstreamToolName, tool])
  );
  for (const toolName of UPSTREAM_FIXTURE_REQUIRED_TOOL_NAMES) {
    assert.equal(directByName.has(toolName), true, `fixture MCP server is missing ${toolName}.`);
    assert.equal(projectedByUpstreamName.has(toolName), true, `upstream projection is missing ${toolName}.`);
  }
  for (const toolName of UPSTREAM_FIXTURE_SCHEMA_PARITY_TOOL_NAMES) {
    assert.equal(
      stableJson(projectedByUpstreamName.get(toolName).inputSchema),
      stableJson(directByName.get(toolName).inputSchema),
      `projected input schema must match the fixture schema for ${toolName}.`
    );
  }
  assert.deepEqual(requiredArray(projectedByUpstreamName.get("records.search").inputSchema), ["query"]);
  assert.deepEqual(requiredArray(projectedByUpstreamName.get("records.get").inputSchema), ["recordId"]);
  const purgeProjected = projectedByUpstreamName.get("records.purge");
  assert.equal(purgeProjected._meta?.risk, "repair_write");

  const readOnlyCall = await runPhase("upstream-mcp-readonly-call", () => registry.callMcpToolByPublicName(
    `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.records.search`,
    { arguments: { query: "alpha", perPage: 1 } },
    { scopes: ["gateway:read"] }
  ));
  assert.equal(readOnlyCall.ok, true);
  assert.equal(readOnlyCall.serviceId, UPSTREAM_FIXTURE_MCP_SERVICE_ID);
  assert.equal(readOnlyCall.upstream?.toolName, "records.search");
  const readOnlyPayload = identityPayload(readOnlyCall.response);
  assert.equal(readOnlyPayload.ok, true);
  assert.equal(readOnlyPayload.count, 1);

  const mcpIdentityCall = await runPhase("upstream-mcp-credential-proof", () => registry.callMcpToolByPublicName(
    `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.session.identity`,
    { arguments: {} },
    { scopes: ["gateway:read"] }
  ));
  assert.equal(mcpIdentityCall.ok, true);
  const mcpIdentityProof = fixtureIdentityProof(identityPayload(mcpIdentityCall.response), mcpToken);
  assert.equal(mcpIdentityProof.credentialPresented, true, "gateway must inject the env credential into the fixture MCP child");
  assert.equal(mcpIdentityProof.tokenProofMatchesIssuedCredential, true, "fixture MCP child must receive exactly the issued credential");

  const stateIncrement = await runPhase("upstream-mcp-state-increment", () => registry.callMcpToolByPublicName(
    `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.state.increment`,
    { arguments: { amount: 2 } },
    { scopes: ["gateway:write"] }
  ));
  assert.equal(stateIncrement.ok, true);
  assert.equal(identityPayload(stateIncrement.response).counter, 2);
  const stateAfterIncrement = await runPhase("upstream-mcp-state-probe", () => registry.callMcpToolByPublicName(
    `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.state.probe`,
    { arguments: {} },
    { scopes: ["gateway:read"] }
  ));
  assert.equal(stateAfterIncrement.ok, true);
  assert.equal(
    identityPayload(stateAfterIncrement.response).counter,
    2,
    "state.increment and state.probe must execute in the same initialized stdio session"
  );

  const remoteList = await runPhase("upstream-mcp-http-transport-list", () =>
    registry.listMcpTools({ serviceId: MCP_REMOTE_SERVICE_ID, refresh: true }));
  assert.equal(remoteList.count > 0, true);
  const remoteCall = await runPhase("upstream-mcp-http-transport-call", () => registry.callMcpToolByPublicName(
    `upstream.${MCP_REMOTE_TOOL_PREFIX}.records.get`,
    { arguments: { recordId: "record-002" } },
    { scopes: ["gateway:read"] }
  ));
  assert.equal(remoteCall.ok, true);
  assert.equal(identityPayload(remoteCall.response).record?.recordId, "record-002");

  const restList = await runPhase("rest-forward-records-list", () => registry.forward(
    { serviceId: UPSTREAM_FIXTURE_REST_SERVICE_ID, operationKey: "records-list", query: { query: "alpha" } },
    { scopes: ["gateway:read"] }
  ));
  assert.equal(restList.ok, true);
  assert.equal(restJson(restList).ok, true);
  assert.equal(Number(restJson(restList).count), 1);
  assert.equal(Boolean(restList.auditId), true);

  const restEcho = await runPhase("rest-forward-echo", () => registry.forward(
    { serviceId: UPSTREAM_FIXTURE_REST_SERVICE_ID, operationKey: "echo", bodyJson: { message: "fixture-transit" } },
    { scopes: ["gateway:write"] }
  ));
  assert.equal(restEcho.ok, true);
  const restEchoPayload = restJson(restEcho);
  assert.equal(restEchoPayload.echoed?.message, "fixture-transit");
  assert.equal(restEchoPayload.authProof?.presented, true, "gateway must inject the issued bearer material into REST calls");
  assert.equal(restEchoPayload.authProof?.accepted, true);

  const restIdentity = await runPhase("rest-forward-session-identity", () => registry.forward(
    { serviceId: UPSTREAM_FIXTURE_REST_SERVICE_ID, operationKey: "session-identity" },
    { scopes: ["gateway:read"] }
  ));
  assert.equal(restIdentity.ok, true);
  const restIdentityProof = fixtureIdentityProof(restJson(restIdentity), restToken);
  assert.equal(restIdentityProof.tokenProofMatchesIssuedCredential, true, "fixture REST identity must prove the issued bearer credential");

  let missingReadScopeRejected = false;
  await runPhase("rest-forward-scope-denial", async () => {
    try {
      await registry.forward(
        { serviceId: UPSTREAM_FIXTURE_REST_SERVICE_ID, operationKey: "records-list" },
        { scopes: [] }
      );
    } catch (error) {
      missingReadScopeRejected = error?.status === 403 && /scope denied/i.test(String(error?.message || ""));
    }
    assert.equal(missingReadScopeRejected, true, "read-only forwarding must reject subjects without gateway:read.");
  });

  const restPurgePending = await runPhase("rest-forward-destructive-guard", () => registry.forward(
    { serviceId: UPSTREAM_FIXTURE_REST_SERVICE_ID, operationKey: "records-purge" },
    { scopes: ["gateway:write"] }
  ));
  assert.equal(restPurgePending.status, "pending_approval");

  const mcpPurgePending = await runPhase("upstream-mcp-destructive-guard", () => registry.callMcpToolByPublicName(
    `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.records.purge`,
    { arguments: {} },
    { scopes: ["gateway:write"] }
  ));
  assert.equal(mcpPurgePending.status, "pending_approval");
  assert.equal(mcpPurgePending.risk, "repair_write");

  const stateAfterGuards = await runPhase("fixture-state-integrity", () => registry.callMcpToolByPublicName(
    `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.state.probe`,
    { arguments: {} },
    { scopes: ["gateway:read"] }
  ));
  const stateAfterGuardsPayload = identityPayload(stateAfterGuards.response);
  assert.equal(stateAfterGuardsPayload.purged, false, "destructive guard must not execute the purge");
  assert.equal(
    Number(stateAfterGuardsPayload.callCount || 0) >= 3,
    true,
    "stdio MCP list/call/probe operations must retain one initialized upstream session"
  );

  operationPermissionPlatform = createOperationPermissionPlatform({
    userDataPath,
    operations: SERVER_API_OPERATIONS,
    controllers: {
      system: {
        handleUpstreamGatewayOperation: createVerifierUpstreamGatewayOperationHandler({
          userDataPath,
          upstreamGatewayRegistry: registry
        })
      }
    },
    operationDispatcher: verifierDispatcher.operationDispatcher,
    operationConcurrencyScope: verifierDispatcher.operationConcurrencyScope,
    securityPermissions: createVerifierSecurityPermissions(),
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {}
    }
  });
  const manifestCommitter = createUpstreamManifestSnapshotCommitter({
    registry,
    getBaseOperations: () => SERVER_API_OPERATIONS,
    getOperationPermissionPlatform: () => operationPermissionPlatform
  });
  await runPhase("upstream-operation-catalog-commit", () =>
    manifestCommitter.commitManifestSnapshot(publishedManifestSnapshot));
  const downstreamProvider = createToolSkillManagementProvider({
    operationPermissionPlatform,
    userDataPath,
    evaluateToolAudience: (input) => registry.evaluateProjectedOperationAudience(input),
    resolveAudiencePartitionKeys: (grantId) => manifestCommitter.getAudiencePartitionKeysForGrant(grantId),
    resolveAudienceCatalogFacts: (grantId) => manifestCommitter.getAudienceCatalogFactsForGrant(grantId)
  });
  const grantBindings = upstreamFixtureGrantBindings({ secretRef: MCP_SECRET_REF });
  const downstreamGrant = await runPhase("downstream-operation-permission-grant", () => operationPermissionPlatform.store.createGrant({
    label: "Fixture downstream agent",
    type: "machine",
    scopes: GATEWAY_SCOPES,
    toolsets: ["meshrix.gateway.read", "meshrix.gateway.write"],
    dynamicCapabilities: [...grantBindings.dynamicCapabilities],
    allowedServiceIds: [...grantBindings.allowedServiceIds],
    allowedSecretBindings: [...grantBindings.allowedSecretBindings],
    metadata: {
      agentId: "fixture-downstream-agent",
      profileId: "meshrix.mcp.opencode",
      mcpTarget: "opencode",
      maxRisk: "safe_write"
    }
  }));
  await runPhase("upstream-audience-refresh", () => manifestCommitter.refreshAudienceProjection());
  runtimeSecretValues.add(downstreamGrant.token);

  const readOnlyPublicTool = `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.records.search`;
  const identityPublicTool = `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.session.identity`;
  const destructivePublicTool = `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.records.purge`;
  const downstreamList = await runPhase("downstream-tools-list", () => callDownstreamMcp({
    provider: downstreamProvider,
    upstreamGatewayRegistry: registry,
    token: downstreamGrant.token,
    body: { jsonrpc: "2.0", id: 101, method: "tools/list", params: {} }
  }));
  assert.equal(downstreamList.handled, true);
  assert.equal(downstreamList.statusCode, 200);
  const downstreamToolNames = (downstreamList.payload?.result?.tools || []).map((tool) => tool.name);
  assert.equal(downstreamToolNames.includes(readOnlyPublicTool), true);
  assert.equal(downstreamToolNames.includes(identityPublicTool), true);
  assert.equal(downstreamToolNames.includes(destructivePublicTool), false);

  const downstreamCall = await runPhase("downstream-readonly-call", () => callDownstreamMcp({
    provider: downstreamProvider,
    upstreamGatewayRegistry: registry,
    token: downstreamGrant.token,
    body: {
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: { name: readOnlyPublicTool, arguments: { query: "alpha", perPage: 1 } }
    }
  }));
  assert.equal(downstreamCall.statusCode, 200);
  assert.equal(downstreamCall.payload?.result?.structuredContent?.upstreamMcp, true);
  assert.equal(downstreamCall.payload?.result?.structuredContent?.toolName, readOnlyPublicTool);

  const downstreamIdentityCall = await runPhase("downstream-identity-call", () => callDownstreamMcp({
    provider: downstreamProvider,
    upstreamGatewayRegistry: registry,
    token: downstreamGrant.token,
    body: {
      jsonrpc: "2.0",
      id: 103,
      method: "tools/call",
      params: { name: identityPublicTool, arguments: {} }
    }
  }));
  assert.equal(downstreamIdentityCall.statusCode, 200);
  assert.equal(downstreamIdentityCall.payload?.result?.structuredContent?.upstreamMcp, true);
  assert.equal(downstreamIdentityCall.payload?.result?.structuredContent?.toolName, identityPublicTool);

  const runtimeJson = await fs.readFile(path.join(userDataPath, "upstream-gateway", "runtime.json"), "utf8");
  assertNoSecretLeak(runtimeJson);

  const report = {
    schemaVersion: UPSTREAM_FIXTURE_TRANSIT_SCHEMA_VERSION,
    verifier: UPSTREAM_FIXTURE_TRANSIT_VERIFIER,
    summary: {
      reportLeakScan: true,
      serviceConfigured: true,
      selfContained: true,
      fixtureCli: UPSTREAM_FIXTURE_CLI_PATH
    },
    evidence: {
      restForwarding: {
        recordsListOk: true,
        recordsListAuditIdPresent: Boolean(restList.auditId),
        responseSchemaValidated: true,
        credentialHeaderInjectionProven: restEchoPayload.authProof?.presented === true &&
          restEchoPayload.authProof?.accepted === true,
        echoOk: restEchoPayload.echoed?.message === "fixture-transit",
        identityProof: restIdentityProof
      },
      mcpTransit: {
        directToolCount: directTools.tools.length,
        projectedToolCount: projectedTools.count,
        requiredToolsPresent: [...UPSTREAM_FIXTURE_REQUIRED_TOOL_NAMES],
        schemaParityTools: [...UPSTREAM_FIXTURE_SCHEMA_PARITY_TOOL_NAMES],
        readOnlyCallOk: true,
        readOnlyCallAuditIdPresent: Boolean(readOnlyCall.auditId),
        credentialEnvInjectionProven: mcpIdentityProof.credentialPresented === true &&
          mcpIdentityProof.tokenProofMatchesIssuedCredential === true,
        identityProof: mcpIdentityProof,
        httpTransportListOk: remoteList.count > 0,
        httpTransportCallOk: remoteCall.ok === true,
        stdioStatefulIncrementProbeProven:
          identityPayload(stateIncrement.response).counter === 2 &&
          identityPayload(stateAfterIncrement.response).counter === 2,
        stdioStatefulSessionReuseProven: Number(stateAfterGuardsPayload.callCount || 0) >= 3,
        stdioStatefulSessionObservedCallCount: Number(stateAfterGuardsPayload.callCount || 0),
        approvalBoundRiskProjected: purgeProjected._meta?.risk === "repair_write"
      },
      secretStoreCredentialBinding: {
        accepted: true,
        serviceCredentialRefCount: restService.credentialReferenceCount + mcpService.credentialReferenceCount + remoteService.credentialReferenceCount,
        resolvedCredentialRefCount: 3,
        credentialRefHash: stableUpstreamFixtureRefHash([REST_SECRET_REF, MCP_SECRET_REF, MCP_REMOTE_SECRET_REF].join(",")),
        restProvider: resolvedSecrets.rest.provider,
        restAuthType: resolvedSecrets.rest.authType,
        mcpAuthType: resolvedSecrets.mcp.authType,
        secretPayloadEnvKeys: Object.keys(resolvedSecrets.mcp.payload?.env || {}).sort(),
        descriptorHasInlineCredential: false,
        rawSecretRedacted: true
      },
      downstreamAgentProjection: {
        grantLabel: "Fixture downstream agent",
        readOnlyToolVisible: true,
        identityToolVisible: true,
        destructiveToolHidden: true,
        readOnlyCallOk: true,
        identityCallOk: true
      },
      deniedCalls: {
        missingReadScopeRejected: true,
        destructiveWithoutApproval: mcpPurgePending.status,
        restDestructiveWithoutApproval: restPurgePending.status
      }
    },
    notes: "Self-contained upstream fixture transit verification: REST and MCP registration, credential injection, stateful stdio session reuse, projection parity, risk governance, and downstream MCP projection all ran against the deterministic fixture with no external network or credentials."
  };
  const readiness = await writeReport(report);
  console.log(`[upstream-fixture-transit] ${readiness.liveStatus}`);
  process.exitCode = readiness.releaseReady ? 0 : 1;
} catch (error) {
  const report = {
    schemaVersion: UPSTREAM_FIXTURE_TRANSIT_SCHEMA_VERSION,
    verifier: UPSTREAM_FIXTURE_TRANSIT_VERIFIER,
    summary: {
      reportLeakScan: true,
      serviceConfigured,
      selfContained: true,
      fixtureCli: UPSTREAM_FIXTURE_CLI_PATH
    },
    currentPhase,
    evidence: null,
    failure: failureEvidence(error, currentPhase),
    notes: "Upstream fixture transit verification did not complete; this report records the failed verifier run."
  };
  const readiness = await writeReport(report).catch(() => null);
  console.error(`[upstream-fixture-transit] ${readiness?.liveStatus || "failed"}: ${redactText(error?.message || String(error))}`);
  process.exitCode = 1;
} finally {
  operationPermissionPlatform?.close?.();
  await registry?.close?.().catch(() => undefined);
  await closeDefaultUpstreamMcpSessions().catch(() => undefined);
  await verifierDispatcher.close();
  await stopFixtureChild();
  if (userDataPath) {
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
  }
  restoreCapabilityKernelEnv();
}
