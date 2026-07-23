#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import fsSync from "node:fs";

import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.mjs";
import { createOperationPermissionPlatform } from "../../packages/capabilities/src/operation-permission-core/index.mjs";
import { SERVER_API_OPERATIONS as GENERATED_SERVER_API_OPERATIONS } from "../../packages/contracts/src/generated/operations.generated.mjs";
import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.mjs";
import { KERNEL_API_OPERATION_IDS } from "../../packages/foundation/src/security/authorization/generated-capabilities.mjs";
import { createSystemControllerCapabilityEcosystemHandlers } from "../../packages/protocols/http/controllers/system-controller-capability-ecosystem-handlers.mjs";
import {
  STRATEGY_MANAGEMENT_PROTOCOL_VERSION,
  createStrategyManagementProvider
} from "../../packages/server-runtime/src/composition/strategy-management-provider.mjs";
import {
  filterOperationsForFeatures,
  operationFeatureId,
  resolveFeatureRuntime
} from "../../packages/server-runtime/src/composition/features/feature-manifest.mjs";
import { executeStrategyManagementOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executors/runtime-admin-executors.mjs";
import { dispatchOperation } from "#lico/server-runtime/composition/dispatch-operation";
import { reduceCapabilityCheckpoints } from "./capability-acceptance-checkpoint-reducer.mjs";
import { PLATFORM_ACCEPTANCE_COMMANDS } from "./lib/platform-acceptance-command-catalog.mjs";

const REPORT_PATH = "build/reports/strategy-management.json";
const CHECKPOINT_PATH = "tools/registry/capability-acceptance-checkpoints/strategy-management.json";
const VERSION_REGISTRY_PATH = "packages/foundation/src/version-control/version-registry.json";
const STRATEGY_REPORT_SCHEMA_VERSION = "v0.0.1:strategy-management:verification-report-1";
const STRATEGY_BROWSER_REPORT_SCHEMA_VERSION = "v0.0.1:schema:strategy-management-browser-report-1";
const STRATEGY_PROTOCOL_VERSION = STRATEGY_MANAGEMENT_PROTOCOL_VERSION;
const EXPECTED_NAMED_ASSERTIONS = Object.freeze([
  "strategy.preview.operations.registered",
  "strategy.preview.input.closed",
  "strategy.preview.deterministic.normalization",
  "strategy.preview.configuration.explicit",
  "strategy.preview.authorization.denied",
  "strategy.preview.privacy.safe",
  "strategy.preview.side_effects.none",
  "strategy.preview.later_reauthorization",
  "strategy.version_registry.identities.current",
  "strategy.acceptance.machine.zero_open",
  "strategy.docs.preview_only"
]);
const EXPECTED_OPERATION_IDS = Object.freeze([
  "strategy.describe",
  "strategy.workflow_policy.evaluate",
  "strategy.agent_policy.evaluate",
  "strategy.route_policy.evaluate",
  "strategy.queue_policy.evaluate",
  "strategy.tool_policy.preview"
]);
const EXPECTED_PROVIDER_SURFACE = Object.freeze([
  "describe",
  "evaluateAgentPolicy",
  "evaluateQueuePolicy",
  "evaluateRoutePolicy",
  "evaluateToolPolicy",
  "evaluateWorkflowPolicy",
  "protocolVersion"
].sort());
const EXPECTED_POLICY_DECISION_COLUMNS = Object.freeze([
  "decision_id",
  "tool_execution_id",
  "trace_id",
  "tool_id",
  "grant_id",
  "effect",
  "reason_code",
  "missing_scopes_json",
  "missing_toolsets_json",
  "evaluated_layers_json",
  "ledger_event_id",
  "created_at"
]);
const PROVIDER_METHOD_BY_OPERATION = Object.freeze({
  "strategy.describe": "describe",
  "strategy.workflow_policy.evaluate": "evaluateWorkflowPolicy",
  "strategy.agent_policy.evaluate": "evaluateAgentPolicy",
  "strategy.route_policy.evaluate": "evaluateRoutePolicy",
  "strategy.queue_policy.evaluate": "evaluateQueuePolicy",
  "strategy.tool_policy.preview": "evaluateToolPolicy"
});
const VALID_INPUT_BY_OPERATION = Object.freeze({
  "strategy.workflow_policy.evaluate": { workflowId: "workflow-a", risk: "repair_write" },
  "strategy.agent_policy.evaluate": { roleId: "role-a" },
  "strategy.route_policy.evaluate": { routeId: "route-a", internalCapabilityId: "capability-a" },
  "strategy.queue_policy.evaluate": { queueDefinitionId: "queue-a", operationId: "jobs.create" },
  "strategy.tool_policy.preview": { toolId: "lico.jobs.list" }
});
const PRIVATE_REPORT_KEYS = new Set([
  "grantId",
  "profileId",
  "subject",
  "effectivePolicySnapshot",
  "context",
  "credential",
  "secret",
  "token"
]);

function stableDecision(value) {
  if (Array.isArray(value)) return value.map(stableDecision);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "decisionId" && key !== "createdAt")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableDecision(item)]));
}

function strategyOperationIds(operations) {
  return operations
    .filter((operation) => String(operation.id || "").startsWith("strategy."))
    .map((operation) => operation.id)
    .sort();
}

function captureResponse() {
  return {
    statusCode: 200,
    body: "",
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(chunk = "") {
      this.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
    }
  };
}

function writeJson(response, status, payload = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function parseResponse(response) {
  return response.body ? JSON.parse(response.body) : {};
}

function assertNoPrivateKeys(value, location = "report") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateKeys(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.equal(PRIVATE_REPORT_KEYS.has(key), false, `${location}.${key} must not be emitted`);
    assertNoPrivateKeys(item, `${location}.${key}`);
  }
}

function parseArrayMetadata(value, field) {
  const parsed = JSON.parse(String(value || "[]"));
  assert.ok(Array.isArray(parsed), `${field} must be a JSON array`);
  assert.ok(parsed.every((item) => typeof item === "string"), `${field} must contain only strings`);
  return parsed;
}

function assertion(id, passed, details = {}) {
  return Object.freeze({
    id,
    passed: passed === true,
    ...details
  });
}

function collectVersionRegistryActiveVersions(registry) {
  const versions = new Map();
  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.artifactId === "string" && typeof value.activeVersion === "string") {
      versions.set(value.artifactId, value.activeVersion);
    }
    Object.values(value).forEach(walk);
  };
  walk(registry);
  return versions;
}

function reduceStrategyAcceptanceMachine() {
  const evidenceCommandAuthority = new Map(
    PLATFORM_ACCEPTANCE_COMMANDS.map((command) => [command.id, Object.freeze({
      acceptanceCommandId: command.id,
      ownedReports: Object.freeze([...(command.ownedReports || [])])
    })])
  );
  const checkpoints = JSON.parse(fsSync.readFileSync(CHECKPOINT_PATH, "utf8"));
  return reduceCapabilityCheckpoints(checkpoints, { evidenceCommandAuthority });
}

function assertPreviewOnlyDocumentation() {
  const doc = fsSync.readFileSync("docs/functionality/STRATEGY-MANAGEMENT.md", "utf8");
  const consoleClient = fsSync.readFileSync("apps/console/lib/strategy-management.ts", "utf8");
  const prohibited = /\b(rollout|rollback|active revision|activeRevision)\b/i;
  assert.equal(prohibited.test(doc), false, "STRATEGY-MANAGEMENT.md must not claim rollout/active revision/rollback");
  assert.equal(prohibited.test(consoleClient), false, "console strategy client must not claim rollout/active revision/rollback");
  assert.match(doc, /read-only preview/i);
}

const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-strategy-verifier-"));
let operationPermissionPlatform = null;

try {
  let decisionSequence = 0;
  let strategyAuthorizationCallCount = 0;
  let operationPermissionPolicyCallCount = 0;
  let governedExecutionCallCount = 0;
  const providerCallCounts = Object.fromEntries(Object.values(PROVIDER_METHOD_BY_OPERATION).map((name) => [name, 0]));
  const fixedPolicyRevision = Object.freeze({
    protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z"
  });
  const securityPermissions = {
    evaluatePolicy({ tool = null } = {}) {
      operationPermissionPolicyCallCount += 1;
      const toolId = String(tool?.id || "");
      return {
        effect: "deny",
        allowed: false,
        reasonCode: "current_policy_denied",
        redactedReason: "The current Operation Permission policy denied this tool.",
        missingScopes: ["governed:execute"],
        missingToolsets: [],
        missingCapabilities: [],
        evaluatedLayers: ["current_governance_policy"],
        createdAt: "2026-01-01T00:00:00.000Z",
        resource: { toolId, operationId: String(tool?.operationId || "") },
        effectivePolicySnapshot: { policyRevision: fixedPolicyRevision }
      };
    },
    getGovernancePolicyRevision() {
      return fixedPolicyRevision;
    },
    appendDecision() {}
  };
  operationPermissionPlatform = createOperationPermissionPlatform({
    userDataPath,
    operations: SERVER_API_OPERATIONS,
    controllers: {},
    operationDispatcher: async () => {
      governedExecutionCallCount += 1;
      return { ok: true, status: 200, payload: { ok: true } };
    },
    securityPermissions,
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  });

  const baseProvider = createStrategyManagementProvider({
    getOperationPermissionPlatform: () => operationPermissionPlatform,
    createDecisionId: (policyType) => `${policyType}-${++decisionSequence}`,
    now: () => "2026-01-01T00:00:00.000Z"
  });
  assert.deepEqual(Object.keys(baseProvider).sort(), EXPECTED_PROVIDER_SURFACE);
  const strategyManagementProvider = Object.freeze(Object.fromEntries(
    Object.entries(baseProvider).map(([name, value]) => {
      if (typeof value !== "function") return [name, value];
      return [name, (...args) => {
        providerCallCounts[name] += 1;
        return value(...args);
      }];
    })
  ));
  assert.deepEqual(Object.keys(strategyManagementProvider).sort(), EXPECTED_PROVIDER_SURFACE);

  const handlers = createSystemControllerCapabilityEcosystemHandlers({
    parseJsonBody: (buffer) => JSON.parse(buffer.toString("utf8")),
    getStrategyManagementProvider: () => strategyManagementProvider,
    sendConsoleDomainOperation: async ({ operationId, input = {}, context = {}, response, errorMessage }) => {
      const operationResult = await executeStrategyManagementOperation({ operationId, input, context });
      if (!operationResult) {
        writeJson(response, 404, {
          ok: false,
          error: errorMessage || "Strategy operation failed.",
          code: "strategy_operation_not_found"
        });
        return;
      }
      writeJson(response, operationResult.status || 200, operationResult.payload || {});
    }
  });
  const operationById = new Map(SERVER_API_OPERATIONS.map((operation) => [operation.id, operation]));

  async function dispatchStrategy(operationId, payload = {}, { scopes = ["console:read"] } = {}) {
    const authSession = { user: { userId: "strategy-verifier", scopes } };
    const operation = operationById.get(operationId);
    assert.ok(operation, `${operationId} must be registered`);
    const response = captureResponse();
    const method = String(operation.http?.method || "POST").toUpperCase();
    await dispatchOperation({
      operation,
      controllers: { system: handlers },
      request: { headers: {}, method },
      response,
      requestBody: method === "GET" ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload)),
      url: new URL(operation.http?.path || "/", "http://127.0.0.1"),
      authorizeOperation: async () => {
        strategyAuthorizationCallCount += 1;
        const allowed = scopes.includes("console:read");
        return {
          ok: allowed,
          status: allowed ? 200 : 403,
          session: authSession,
          error: allowed ? "" : "Strategy preview requires console:read.",
          authorizationDecision: {
            decisionId: `strategy-authorization-${strategyAuthorizationCallCount}`,
            reasonCode: allowed ? "operation_authorized" : "missing_required_scope",
            missingScopes: allowed ? [] : ["console:read"],
            missingCapabilities: []
          }
        };
      },
      authSession,
      actor: authSession.user,
      skipAuthorization: false
    });
    return { status: response.statusCode, payload: parseResponse(response) };
  }

  const sourceIds = strategyOperationIds(SERVER_API_OPERATIONS);
  const generatedIds = strategyOperationIds(GENERATED_SERVER_API_OPERATIONS);
  const capabilityIds = KERNEL_API_OPERATION_IDS.filter((id) => id.startsWith("strategy.")).sort();
  const catalogTools = createToolCatalog({ operations: SERVER_API_OPERATIONS })
    .tools
    .filter((tool) => tool.operationId.startsWith("strategy."))
    .sort((left, right) => left.operationId.localeCompare(right.operationId));

  assert.deepEqual(sourceIds, [...EXPECTED_OPERATION_IDS].sort());
  assert.deepEqual(sourceIds, generatedIds);
  assert.deepEqual(sourceIds, capabilityIds);
  assert.equal(catalogTools.length, EXPECTED_OPERATION_IDS.length);
  assert.ok(catalogTools.every((tool) => tool.id.startsWith("lico.strategy.")));
  assert.ok(catalogTools.every((tool) => tool.requiredScopes.includes("console:read")));
  assert.ok(catalogTools.every((tool) => tool.readOnly === true));

  for (const operationId of EXPECTED_OPERATION_IDS) {
    const operation = operationById.get(operationId);
    const generatedOperation = GENERATED_SERVER_API_OPERATIONS.find((item) => item.id === operationId);
    assert.ok(generatedOperation, `${operationId} must exist in generated operations`);
    assert.deepEqual(generatedOperation.inputSchema, operation.inputSchema, `${operationId} input schema must be generated exactly`);
    assert.equal(operationFeatureId(operation), "strategy-management");
    assert.equal(operation.readOnly, true);
    assert.equal(operation.safety?.risk || "read_only", "read_only");
    assert.equal(operation.requiredScopes.includes("console:read"), true);

    const method = PROVIDER_METHOD_BY_OPERATION[operationId];
    const before = providerCallCounts[method];
    const unauthorized = await dispatchStrategy(operationId, VALID_INPUT_BY_OPERATION[operationId] || {}, { scopes: [] });
    assert.equal(unauthorized.status, 403);
    assert.equal(providerCallCounts[method], before, `${operationId} must authorize before provider entry`);
  }

  for (const operationId of EXPECTED_OPERATION_IDS.filter((id) => id !== "strategy.describe")) {
    const method = PROVIDER_METHOD_BY_OPERATION[operationId];
    const before = providerCallCounts[method];
    const invalid = await dispatchStrategy(operationId, {});
    assert.equal(invalid.status, 400);
    assert.equal(providerCallCounts[method], before, `${operationId} must validate before provider entry`);
  }

  const describe = await dispatchStrategy("strategy.describe");
  assert.equal(describe.status, 200);
  assert.equal(describe.payload.protocolVersion, STRATEGY_MANAGEMENT_PROTOCOL_VERSION);
  assert.deepEqual(describe.payload.capabilities, [...EXPECTED_OPERATION_IDS].sort());

  const workflow = await dispatchStrategy("strategy.workflow_policy.evaluate", {
    workflowId: "workflow-a",
    risk: "repair_write"
  });
  const workflowEquivalent = await dispatchStrategy("strategy.workflow_policy.evaluate", {
    workflowId: "  workflow-a  ",
    risk: " repair_write "
  });
  const workflowChanged = await dispatchStrategy("strategy.workflow_policy.evaluate", {
    workflowId: "workflow-a",
    risk: "read_only"
  });
  assert.deepEqual(stableDecision(workflow.payload), stableDecision(workflowEquivalent.payload));
  assert.notDeepEqual(stableDecision(workflow.payload), stableDecision(workflowChanged.payload));

  const agent = await dispatchStrategy("strategy.agent_policy.evaluate", { roleId: "role-a" });
  const agentEquivalent = await dispatchStrategy("strategy.agent_policy.evaluate", { roleId: "  role-a  " });
  const agentChanged = await dispatchStrategy("strategy.agent_policy.evaluate", { roleId: "role-b" });
  assert.deepEqual(stableDecision(agent.payload), stableDecision(agentEquivalent.payload));
  assert.notDeepEqual(stableDecision(agent.payload), stableDecision(agentChanged.payload));

  const route = await dispatchStrategy("strategy.route_policy.evaluate", {
    routeId: "route-a",
    internalCapabilityId: "capability-a"
  });
  const routeEquivalent = await dispatchStrategy("strategy.route_policy.evaluate", {
    routeId: " route-a ",
    internalCapabilityId: " capability-a "
  });
  const routeChanged = await dispatchStrategy("strategy.route_policy.evaluate", { routeId: "route-a" });
  assert.deepEqual(stableDecision(route.payload), stableDecision(routeEquivalent.payload));
  assert.notDeepEqual(stableDecision(route.payload), stableDecision(routeChanged.payload));

  const queue = await dispatchStrategy("strategy.queue_policy.evaluate", {
    queueDefinitionId: "queue-a",
    operationId: "jobs.create",
    maxAttempts: 2
  });
  const queueEquivalent = await dispatchStrategy("strategy.queue_policy.evaluate", {
    queueDefinitionId: " queue-a ",
    operationId: " jobs.create ",
    maxAttempts: 2
  });
  const queueChanged = await dispatchStrategy("strategy.queue_policy.evaluate", {
    queueDefinitionId: "queue-a",
    operationId: "jobs.create",
    maxAttempts: 3
  });
  assert.deepEqual(stableDecision(queue.payload), stableDecision(queueEquivalent.payload));
  assert.notDeepEqual(stableDecision(queue.payload), stableDecision(queueChanged.payload));

  const previewPolicyCallsBefore = operationPermissionPolicyCallCount;
  const toolPreview = await dispatchStrategy("strategy.tool_policy.preview", { toolId: "lico.jobs.list" });
  const toolPreviewEquivalent = await dispatchStrategy("strategy.tool_policy.preview", { toolId: "  lico.jobs.list  " });
  const toolPreviewChanged = await dispatchStrategy("strategy.tool_policy.preview", { toolId: "lico.jobs.get" });
  const toolPreviewCallCount = operationPermissionPolicyCallCount - previewPolicyCallsBefore;
  assert.equal(toolPreview.status, 200);
  assert.equal(toolPreview.payload.decision.policyType, "tool-policy");
  assert.equal(toolPreview.payload.decision.reasonCode, "current_policy_denied");
  assert.deepEqual(stableDecision(toolPreview.payload.decision), stableDecision(toolPreviewEquivalent.payload.decision));
  assert.notDeepEqual(stableDecision(toolPreview.payload.decision), stableDecision(toolPreviewChanged.payload.decision));
  assert.equal(toolPreviewCallCount, 3, "each tool preview must reach the current Operation Permission policy exactly once");
  assertNoPrivateKeys(toolPreview.payload.decision, "toolPreview.decision");
  assert.deepEqual(Object.keys(toolPreview.payload.decision.governancePolicyRevision).sort(), [
    "protocolVersion",
    "revision",
    "updatedAt"
  ]);

  const policyColumns = operationPermissionPlatform.store.db
    .prepare("PRAGMA table_info(tool_policy_decisions)")
    .all()
    .map((column) => String(column.name));
  assert.deepEqual(policyColumns, EXPECTED_POLICY_DECISION_COLUMNS);
  const previewAuditRows = operationPermissionPlatform.store.db.prepare(`
    SELECT decision_id, tool_execution_id, trace_id, tool_id, grant_id, effect, reason_code,
           missing_scopes_json, missing_toolsets_json, evaluated_layers_json, ledger_event_id, created_at
    FROM tool_policy_decisions
    ORDER BY rowid
  `).all();
  assert.equal(previewAuditRows.length, toolPreviewCallCount);
  assert.equal(new Set(previewAuditRows.map((row) => row.decision_id)).size, previewAuditRows.length);
  assert.deepEqual(previewAuditRows.map((row) => row.tool_id), [
    "lico.jobs.list",
    "lico.jobs.list",
    "lico.jobs.get"
  ]);
  for (const row of previewAuditRows) {
    assert.equal(typeof row.decision_id, "string");
    assert.ok(row.decision_id.length > 0);
    assert.equal(row.effect, "deny");
    assert.equal(row.reason_code, "current_policy_denied");
    assert.equal(typeof row.created_at, "string");
    assert.ok(row.created_at.length > 0);
    parseArrayMetadata(row.missing_scopes_json, "missing_scopes_json");
    parseArrayMetadata(row.missing_toolsets_json, "missing_toolsets_json");
    parseArrayMetadata(row.evaluated_layers_json, "evaluated_layers_json");
  }

  const governedPolicyCallsBefore = operationPermissionPolicyCallCount;
  const governedFollowUp = await operationPermissionPlatform.runtime.executeTool({
    toolId: "lico.gateway.forward",
    input: {
      serviceId: "strategy-verifier-service",
      previewDecision: toolPreview.payload.decision
    },
    request: { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
    authorizedGrant: {
      id: "strategy-verifier-current-grant",
      label: "Strategy verifier current grant",
      scopes: ["gateway:write"],
      toolsets: ["lico.gateway.write"]
    }
  });
  assert.equal(operationPermissionPolicyCallCount - governedPolicyCallsBefore, 1);
  assert.equal(governedFollowUp.ok, false);
  assert.equal(governedFollowUp.status, 403);
  assert.equal(governedFollowUp.payload.error.code, "current_policy_denied");
  assert.notEqual(governedFollowUp.payload.error.details.decisionId, toolPreview.payload.decision.decisionId);
  assert.equal(governedExecutionCallCount, 0, "a denied current decision must not reach operation execution");
  const allAuditRowCount = operationPermissionPlatform.store.db
    .prepare("SELECT COUNT(*) AS count FROM tool_policy_decisions")
    .get().count;
  assert.equal(allAuditRowCount, toolPreviewCallCount + 1);

  const replayMethod = PROVIDER_METHOD_BY_OPERATION["strategy.workflow_policy.evaluate"];
  const providerBeforeReplay = providerCallCounts[replayMethod];
  const replayAttempt = await dispatchStrategy("strategy.workflow_policy.evaluate", {
    workflowId: "workflow-follow-up",
    previewDecision: workflow.payload
  });
  assert.equal(replayAttempt.status, 400);
  assert.equal(providerCallCounts[replayMethod], providerBeforeReplay);

  const coreRuntime = resolveFeatureRuntime({ edition: "core" });
  assert.ok(coreRuntime.activeFeatureIds.includes("strategy-management"));
  const activeCoreOperationIds = new Set(
    filterOperationsForFeatures(SERVER_API_OPERATIONS, coreRuntime).map((operation) => operation.id)
  );
  for (const operationId of EXPECTED_OPERATION_IDS) {
    assert.ok(activeCoreOperationIds.has(operationId), `core edition must include ${operationId}`);
  }

  const versionRegistry = JSON.parse(fsSync.readFileSync(VERSION_REGISTRY_PATH, "utf8"));
  const activeVersions = collectVersionRegistryActiveVersions(versionRegistry);
  assert.equal(
    activeVersions.get("lico.strategy.strategy-management"),
    STRATEGY_PROTOCOL_VERSION,
    "strategy provider protocol version must match the version registry"
  );
  assert.equal(
    activeVersions.get("lico.strategy.strategy-management-verification-report"),
    STRATEGY_REPORT_SCHEMA_VERSION,
    "strategy verification report schema must match the version registry"
  );
  assert.equal(
    activeVersions.get("lico.strategy.strategy-management-browser-report"),
    STRATEGY_BROWSER_REPORT_SCHEMA_VERSION,
    "strategy browser report schema must match the version registry"
  );

  assertPreviewOnlyDocumentation();

  const acceptanceReduction = reduceStrategyAcceptanceMachine();
  assert.equal(acceptanceReduction.readyForReleaseReduction, true, "strategy acceptance machine must have zero open criteria");
  assert.equal(acceptanceReduction.openCheckpoints.length, 0);
  assert.equal(acceptanceReduction.uncheckedCriteria.length, 0);
  assert.equal(acceptanceReduction.currentState, "verified");
  assert.ok(
    !Object.prototype.hasOwnProperty.call(acceptanceReduction, "ready") &&
      !Object.prototype.hasOwnProperty.call(acceptanceReduction, "genericReady"),
    "strategy acceptance reduction must not rely on a generic ready alias"
  );

  const namedAssertions = [
    assertion("strategy.preview.operations.registered", sourceIds.length === EXPECTED_OPERATION_IDS.length, {
      operationIds: sourceIds,
      requirements: ["REQ-REL-005", "REQ-REL-010"]
    }),
    assertion("strategy.preview.input.closed", true, {
      invalidInputBoundaryCount: EXPECTED_OPERATION_IDS.length - 1,
      requirements: ["REQ-REL-010"]
    }),
    assertion("strategy.preview.deterministic.normalization", true, {
      semanticPolicyCount: 5,
      requirements: ["REQ-REL-021"]
    }),
    assertion("strategy.preview.configuration.explicit", true, {
      providerSurface: EXPECTED_PROVIDER_SURFACE,
      requirements: ["REQ-REL-005"]
    }),
    assertion("strategy.preview.authorization.denied", true, {
      unauthorizedBoundaryCount: EXPECTED_OPERATION_IDS.length,
      requirements: ["REQ-REL-010", "REQ-REL-024"]
    }),
    assertion("strategy.preview.privacy.safe", true, {
      prohibitedFieldCount: 0,
      requirements: ["REQ-REL-024"]
    }),
    assertion("strategy.preview.side_effects.none", governedExecutionCallCount === 0, {
      governedExecutionCount: governedExecutionCallCount,
      requirements: ["REQ-REL-021"]
    }),
    assertion("strategy.preview.later_reauthorization", true, {
      laterReauthorizationVerified: true,
      requirements: ["REQ-REL-010", "REQ-REL-024"]
    }),
    assertion("strategy.version_registry.identities.current", true, {
      protocolVersion: STRATEGY_PROTOCOL_VERSION,
      verificationReportSchemaVersion: STRATEGY_REPORT_SCHEMA_VERSION,
      browserReportSchemaVersion: STRATEGY_BROWSER_REPORT_SCHEMA_VERSION,
      requirements: ["REQ-REL-005"]
    }),
    assertion("strategy.acceptance.machine.zero_open", acceptanceReduction.readyForReleaseReduction === true, {
      openCheckpointCount: acceptanceReduction.openCheckpoints.length,
      uncheckedCriteriaCount: acceptanceReduction.uncheckedCriteria.length,
      currentState: acceptanceReduction.currentState,
      requirements: ["REQ-REL-005", "REQ-REL-021"]
    }),
    assertion("strategy.docs.preview_only", true, {
      requirements: ["REQ-REL-005"]
    })
  ];
  assert.deepEqual(
    namedAssertions.map((item) => item.id).sort(),
    [...EXPECTED_NAMED_ASSERTIONS].sort()
  );
  assert.ok(namedAssertions.every((item) => item.passed === true), "every named strategy assertion must pass");

  const report = {
    schemaVersion: STRATEGY_REPORT_SCHEMA_VERSION,
    verifier: "tools/server-scripts/verify-strategy-management.mjs",
    generatedAt: new Date().toISOString(),
    verificationPassed: true,
    releaseReady: false,
    sourceRevision: {
      checkpointPath: CHECKPOINT_PATH,
      protocolVersion: STRATEGY_PROTOCOL_VERSION,
      verificationReportSchemaVersion: STRATEGY_REPORT_SCHEMA_VERSION,
      browserReportSchemaVersion: STRATEGY_BROWSER_REPORT_SCHEMA_VERSION
    },
    assertions: namedAssertions,
    acceptanceMachine: {
      capabilityId: "strategy-management",
      currentState: acceptanceReduction.currentState,
      readyForReleaseReduction: acceptanceReduction.readyForReleaseReduction,
      openCheckpointCount: acceptanceReduction.openCheckpoints.length,
      uncheckedCriteriaCount: acceptanceReduction.uncheckedCriteria.length,
      completedCheckpointCount: acceptanceReduction.completedCheckpointCount,
      platformReadinessClaimed: false
    },
    summary: {
      verificationPassed: true,
      reportLeakScan: true,
      operationCount: EXPECTED_OPERATION_IDS.length,
      providerSurfaceCount: EXPECTED_PROVIDER_SURFACE.length,
      unauthorizedBoundaryCount: EXPECTED_OPERATION_IDS.length,
      invalidInputBoundaryCount: EXPECTED_OPERATION_IDS.length - 1,
      semanticPolicyCount: 5,
      laterReauthorizationVerified: true,
      currentPolicyDecisionCount: operationPermissionPolicyCallCount,
      governedExecutionCount: governedExecutionCallCount,
      toolPreviewCallCount,
      toolPreviewAuditRowCount: previewAuditRows.length,
      policyDecisionMetadataColumnCount: policyColumns.length,
      namedAssertionCount: namedAssertions.length,
      namedAssertionPassedCount: namedAssertions.filter((item) => item.passed).length,
      acceptanceMachineReady: acceptanceReduction.readyForReleaseReduction === true
    },
    privacyEvidence: {
      passed: true,
      prohibitedFieldCount: 0
    }
  };
  assertNoPrivateKeys(report);
  assert.equal(report.releaseReady, false, "strategy report must not claim platform readiness");
  await fs.mkdir("build/reports", { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`[strategy-management] ok: ${REPORT_PATH}`);
} finally {
  operationPermissionPlatform?.close?.();
  await fs.rm(userDataPath, { recursive: true, force: true });
}
