#!/usr/bin/env node
import assert from "node:assert/strict";

import { SERVER_API_OPERATIONS as GENERATED_SERVER_API_OPERATIONS } from "../../packages/contracts/src/generated/operations.generated.mjs";
import { SERVER_API_OPERATIONS as SOURCE_SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.mjs";
import { PROTOCOL_OPERATION_DEFINITIONS } from "../../packages/contracts/src/operations/protocol-operation-definitions.mjs";
import { KERNEL_API_OPERATION_IDS } from "../../packages/foundation/src/security/authorization/generated-capabilities.mjs";
import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import { installAuthenticatedFetch } from "./test-auth-helper.mjs";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.mjs";
import { startOperationPermissionProtocolFixtureServer } from "./lib/operation-permission-protocol-fixture.mjs";
import {
  createOperationPermissionProtocolConsistencyHarness,
  OPERATION_PERMISSION_PROTOCOL_CONSISTENCY
} from "./lib/operation-permission-protocol-consistency-harness.mjs";

const {
  reportPath: REPORT_PATH,
  serviceIdPrefix: SERVICE_ID_PREFIX,
  readTool: READ_TOOL,
  writeTool: WRITE_TOOL,
  approvalTool: APPROVAL_TOOL,
  forbiddenConfigMutationTool: FORBIDDEN_CONFIG_MUTATION_TOOL,
  requiredTagOperations: REQUIRED_TAG_OPERATIONS,
  requiredAuthorizationGovernanceOperations: REQUIRED_AUTHORIZATION_GOVERNANCE_OPERATIONS,
  requiredOperationPermissionOperations: REQUIRED_OPERATION_PERMISSION_OPERATIONS
} = OPERATION_PERMISSION_PROTOCOL_CONSISTENCY;

const restoreCapabilityKernelEnv = useIsolatedCapabilityKernelForVerifier();
const harness = await createOperationPermissionProtocolConsistencyHarness();
const {
  userDataPath,
  trackSecret,
  redactText,
  writeReport,
  test,
  destructiveTest,
  writeUpstreamGatewayConfig,
  setFixtureUrl,
  setServer,
  api,
  localMcpGrant,
  consoleGrant,
  operationHttp,
  operationRpc,
  callMcp,
  publicPayload,
  classifyDecision,
  hasStalePolicy,
  callAllChannels,
  assertSameDecision,
  capabilities,
  openMcpSse,
  cleanup
} = harness;

let fixture = null;
let exitCode = 0;

function approvalTagInput(label) {
  return {
    tagId: `governance:op-permission-protocol-${label}-${Date.now()}`,
    kind: "custom",
    label: `Operation Permission protocol pending approval ${label}`,
    scopePrerequisites: ["auth:admin"]
  };
}

function operationNames(capabilities = {}) {
  return new Set((capabilities.operations || []).map((operation) => String(operation.name || "")));
}

async function verifyRegistration() {
  const sourceOperationIds = new Set(SOURCE_SERVER_API_OPERATIONS.map((operation) => operation.id));
  const generatedOperationIds = new Set(GENERATED_SERVER_API_OPERATIONS.map((operation) => operation.id));
  const protocolOperationIds = new Set(PROTOCOL_OPERATION_DEFINITIONS.map((operation) => operation.id));
  const generatedCapabilityIds = new Set(KERNEL_API_OPERATION_IDS);
  const required = [
    ...REQUIRED_TAG_OPERATIONS,
    ...REQUIRED_AUTHORIZATION_GOVERNANCE_OPERATIONS,
    ...REQUIRED_OPERATION_PERMISSION_OPERATIONS
  ];
  const missingSource = required.filter((operationId) => !sourceOperationIds.has(operationId));
  const missingGenerated = [
    ...REQUIRED_TAG_OPERATIONS,
    ...REQUIRED_AUTHORIZATION_GOVERNANCE_OPERATIONS,
    "operation_permission.execute"
  ]
    .filter((operationId) => !generatedOperationIds.has(operationId));
  const missingProtocol = [...REQUIRED_TAG_OPERATIONS, ...REQUIRED_AUTHORIZATION_GOVERNANCE_OPERATIONS]
    .filter((operationId) => !protocolOperationIds.has(operationId));
  const missingCapabilities = [
    ...REQUIRED_TAG_OPERATIONS,
    ...REQUIRED_AUTHORIZATION_GOVERNANCE_OPERATIONS,
    "operation_permission.execute"
  ].filter((operationId) => !generatedCapabilityIds.has(operationId));
  assert.deepEqual(missingSource, [], "Source operation registry is missing required Operation Permission surfaces");
  assert.deepEqual(missingGenerated, [], "Generated operation artifact is missing required public governance surfaces");
  assert.deepEqual(missingProtocol, [], "Protocol definitions are missing tag management surfaces");
  assert.deepEqual(missingCapabilities, [], "Generated capability artifact is missing required governance capabilities");
  return {
    requiredOperationCount: required.length,
    tagOperationCount: REQUIRED_TAG_OPERATIONS.length,
    authorizationGovernanceOperationCount: REQUIRED_AUTHORIZATION_GOVERNANCE_OPERATIONS.length,
    generatedCapabilityCheckedCount: REQUIRED_TAG_OPERATIONS.length + REQUIRED_AUTHORIZATION_GOVERNANCE_OPERATIONS.length + 1
  };
}

async function verifyAllowDenyAndApprovalParity() {
  const readGrant = await localMcpGrant({
    label: "Operation Permission protocol read verifier",
    grantMode: "read",
    toolsets: ["lico.gateway.read"],
    maxRisk: "read_only"
  });
  const allowed = await callAllChannels({
    token: readGrant.token,
    toolId: READ_TOOL,
    mcpToolName: "lico.gateway",
    operation: READ_TOOL,
    input: {},
    idBase: 200
  });
  assertSameDecision(allowed.decisions, "allow");

  const denied = await callAllChannels({
    token: readGrant.token,
    toolId: WRITE_TOOL,
    mcpToolName: "lico.gateway",
    operation: WRITE_TOOL,
    input: { serviceId: `${SERVICE_ID_PREFIX}-missing`, operationKey: "echo" },
    idBase: 300
  });
  assertSameDecision(denied.decisions, "deny");

  const adminGrant = await localMcpGrant({
    label: "Operation Permission protocol stale policy verifier",
    grantMode: "maintain",
    toolsets: ["lico.gateway.admin", "lico.runtime.maintain", "lico.authorization.admin"],
    maxRisk: "repair_write"
  });
  const tagId = `custom:op-permission-protocol-${Date.now()}`;
  trackSecret(tagId);
  const tagUpdate = await api("POST", "/api/tag-management/v1/tags", {
    tagId,
    kind: "custom",
    label: "Operation Permission protocol consistency policy",
    scopePrerequisites: ["auth:admin"]
  }, { expectedStatuses: [200, 201] });
  assert.equal(tagUpdate.payload.refresh?.grantRefreshRequired, true);
  assert.equal(tagUpdate.payload.mcpToolListChanged, undefined);

  const approvalInputs = {
    http: approvalTagInput("http"),
    rpc: approvalTagInput("rpc"),
    mcp: approvalTagInput("mcp")
  };
  const approvalPayloads = {
    http: publicPayload("http", await operationHttp(adminGrant.token, APPROVAL_TOOL, approvalInputs.http)),
    rpc: publicPayload("rpc", await operationRpc(adminGrant.token, APPROVAL_TOOL, approvalInputs.rpc, 401)),
    mcp: publicPayload("mcp", await callMcp(adminGrant.token, "lico.discovery", APPROVAL_TOOL, approvalInputs.mcp, 402, [200, 202]))
  };
  const approvalDecisions = Object.fromEntries(
    Object.entries(approvalPayloads).map(([channel, payload]) => [channel, classifyDecision(payload)])
  );
  assertSameDecision(approvalDecisions, "approval_required");
  assert.equal(Object.values(approvalPayloads).every(hasStalePolicy), true, "all approval decisions must expose stale policy state");

  return {
    allow: allowed.decisions,
    deny: denied.decisions,
    approval: approvalDecisions,
    stalePolicyAcrossChannels: true
  };
}

async function verifyRevokedAndRateLimitParity() {
  const revokedGrant = await localMcpGrant({
    label: "Operation Permission protocol revoked verifier",
    grantMode: "read",
    toolsets: ["lico.gateway.read"],
    maxRisk: "read_only"
  });
  const revoke = await api("POST", `/api/operation-permission/v1/grants/${encodeURIComponent(revokedGrant.grantId)}/revoke`, {
    reason: "verify-operation-permission-protocol-consistency"
  }, { expectedStatuses: [200] });
  assert.equal(revoke.payload.grant?.enabled, false);
  const revoked = await callAllChannels({
    token: revokedGrant.token,
    toolId: READ_TOOL,
    mcpToolName: "lico.gateway",
    operation: READ_TOOL,
    input: {},
    idBase: 500
  });
  assertSameDecision(revoked.decisions, "revoked_grant");

  async function rateLimitedChannel(channel) {
    const grant = await consoleGrant({
      label: `Operation Permission protocol rate verifier ${channel}`,
      type: "machine",
      toolsets: ["lico.gateway.read"],
      maxRisk: "read_only",
      rateLimit: { perMinute: 1 }
    });
    if (channel === "http") {
      await operationHttp(grant.token, READ_TOOL, {});
      return publicPayload("http", await operationHttp(grant.token, READ_TOOL, {}));
    }
    if (channel === "rpc") {
      await operationRpc(grant.token, READ_TOOL, {}, 601);
      return publicPayload("rpc", await operationRpc(grant.token, READ_TOOL, {}, 602));
    }
    await callMcp(grant.token, "lico.gateway", READ_TOOL, {}, 603);
    return publicPayload("mcp", await callMcp(grant.token, "lico.gateway", READ_TOOL, {}, 604));
  }

  const ratePayloads = {
    http: await rateLimitedChannel("http"),
    rpc: await rateLimitedChannel("rpc"),
    mcp: await rateLimitedChannel("mcp")
  };
  const rateDecisions = Object.fromEntries(
    Object.entries(ratePayloads).map(([channel, payload]) => [channel, classifyDecision(payload)])
  );
  assertSameDecision(rateDecisions, "rate_limited");

  return {
    revoked: revoked.decisions,
    rateLimited: rateDecisions
  };
}

async function verifyMcpDiscoveryRefresh() {
  const grant = await localMcpGrant({
    label: "Operation Permission protocol discovery verifier",
    grantMode: "read",
    toolsets: ["lico.gateway.read"],
    maxRisk: "read_only"
  });
  const sse = await openMcpSse(grant.token);
  try {
    const before = await capabilities(grant.token, 700);
    const beforeNames = operationNames(before);
    assert.equal(beforeNames.has(READ_TOOL), true, "read operation missing before update");
    assert.equal(beforeNames.has(WRITE_TOOL), false, "write operation leaked before grant update");

    const update = await api("POST", `/api/operation-permission/v1/grants/${encodeURIComponent(grant.grantId)}`, {
      scopes: ["gateway:read", "gateway:write"],
      toolsets: ["lico.gateway.read", "lico.gateway.write"],
      maxRisk: "safe_write",
      metadata: { maxRisk: "safe_write" },
      reason: "verify-operation-permission-protocol-consistency"
    }, { expectedStatuses: [200] });
    assert.equal(update.payload.grant?.enabled, true);
    const grantEvent = await sse.waitForReasonCode("upstream_audiences_published");

    const afterGrant = await capabilities(grant.token, 701);
    const afterGrantNames = operationNames(afterGrant);
    assert.equal(afterGrantNames.has(WRITE_TOOL), true, "write operation was not visible after grant update");

    const tagId = `custom:op-permission-discovery-${Date.now()}`;
    trackSecret(tagId);
    const tagUpdate = await api("POST", "/api/tag-management/v1/tags", {
      tagId,
      kind: "custom",
      label: "Operation Permission discovery refresh policy",
      scopePrerequisites: ["auth:admin"]
    }, { expectedStatuses: [200, 201] });
    assert.equal(tagUpdate.payload.mcpToolListChanged, undefined);

    const afterTag = await capabilities(grant.token, 702);
    const afterTagNames = operationNames(afterTag);
    assert.equal(afterTagNames.has(READ_TOOL), true, "read operation missing after tag policy update");
    assert.equal(afterTagNames.has(WRITE_TOOL), true, "grant-visible write operation missing after tag policy update");
    assert.equal(afterTagNames.has(FORBIDDEN_CONFIG_MUTATION_TOOL), false, "config mutation operation leaked after tag policy update");

    return {
      unauthorizedHiddenBeforeGrantUpdate: true,
      writeVisibleAfterGrantUpdate: true,
      adminHiddenAfterTagPolicyUpdate: true,
      notifications: [
        grantEvent.params?.change?.reasonCode,
        "unrelated_tag_catalog_unchanged"
      ],
      operationCounts: {
        before: before.operations?.length || 0,
        afterGrant: afterGrant.operations?.length || 0,
        afterTag: afterTag.operations?.length || 0
      }
    };
  } finally {
    await sse.close();
  }
}

try {
  const fixtureStarted = await startOperationPermissionProtocolFixtureServer();
  fixture = fixtureStarted.server;
  const fixtureUrl = fixtureStarted.url;
  setFixtureUrl(fixtureUrl);

  await writeUpstreamGatewayConfig([
    {
      serviceId: SERVICE_ID_PREFIX,
      label: "Operation Permission protocol upstream",
      baseUrl: fixtureUrl,
      healthPath: "/health",
      operations: [
        {
          operationKey: "approval",
          method: "POST",
          path: "/health",
          risk: "repair_write",
          requiredScopes: ["gateway:maintain"],
          requiresApproval: true,
          payloadTransport: {
            request: { mode: "structured_json", maxBytes: 1024 * 1024, mediaTypes: ["application/json"] },
            response: { mode: "structured_json", maxBytes: 1024 * 1024, mediaTypes: ["application/json"] }
          }
        }
      ]
    }
  ]);

  const serverStarted = await startHttpServer({
    userDataPath,
    distPath: "",
    port: 0,
    runtimeOptions: {
      profile: "minimal",
      enableFeatures: ["operation-permission-core", "upstream-gateway"]
    }
  });
  setServer(serverStarted);
  await installAuthenticatedFetch(serverStarted);

  console.log("\n=== Operation Permission Protocol Consistency: HTTP/RPC/MCP/console parity ===\n");

  await test("tag and operation permission operations are in generated registries", verifyRegistration);
  await test("allow deny approval and stale-policy decisions converge across HTTP RPC console and MCP", verifyAllowDenyAndApprovalParity);
  await destructiveTest("revoked grant and per-grant rate-limit decisions converge across HTTP RPC console and MCP", verifyRevokedAndRateLimitParity);
  await test("MCP discovery refreshes after grant and tag policy changes without leaking unauthorized operations", verifyMcpDiscoveryRefresh);
} catch (error) {
  console.error(`FAIL: ${redactText(error?.message || String(error))}`);
  if (process.env.LICO_VERIFY_VERBOSE) {
    console.error(redactText(error?.stack || String(error)));
  }
  exitCode = 1;
} finally {
  try {
    await writeReport();
  } catch (error) {
    console.error(`FAIL: could not write report: ${redactText(error?.message || String(error))}`);
    exitCode = 1;
  }
  await cleanup({ fixture, restoreCapabilityKernelEnv });
}

if (exitCode === 0) {
  console.log(`PASS: operation permission protocol consistency verified; report: ${REPORT_PATH}`);
}

process.exit(exitCode);
