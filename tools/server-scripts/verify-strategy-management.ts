#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import fsSync from "node:fs";

import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.ts";
import { createOperationPermissionPlatform } from "../../packages/capabilities/src/operation-permission-core/index.ts";
import { SERVER_API_OPERATIONS as GENERATED_SERVER_API_OPERATIONS } from "../../packages/contracts/src/generated/operations.generated.ts";
import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.ts";
import { KERNEL_API_OPERATION_IDS } from "../../packages/foundation/src/security/authorization/generated-capabilities.ts";
import { createSystemControllerCapabilityEcosystemHandlers } from "../../packages/protocols/http/controllers/system-controller-capability-ecosystem-handlers.ts";
import {
  STRATEGY_MANAGEMENT_PROTOCOL_VERSION,
  createStrategyManagementProvider
} from "../../packages/server-runtime/src/composition/strategy-management-provider.ts";
import {
  filterOperationsForFeatures,
  operationFeatureId,
  resolveFeatureRuntime
} from "../../packages/server-runtime/src/composition/features/feature-manifest.ts";
import { executeStrategyManagementOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executors/runtime-admin-executors.ts";
import { dispatchOperation } from "#meshrix/server-runtime/composition/dispatch-operation";
import { reduceCapabilityCheckpoints } from "./capability-acceptance-checkpoint-reducer.ts";
import { PLATFORM_ACCEPTANCE_COMMANDS } from "./lib/platform-acceptance-command-catalog.ts";

const REPORT_PATH: any = "build/reports/strategy-management.json";
const CHECKPOINT_PATH: any = "tools/registry/capability-acceptance-checkpoints/strategy-management.json";
const VERSION_REGISTRY_PATH: any = "packages/foundation/src/version-control/version-registry.json";
const STRATEGY_REPORT_SCHEMA_VERSION: any = "v0.0.1:strategy-management:verification-report-1";
const STRATEGY_BROWSER_REPORT_SCHEMA_VERSION: any = "v0.0.1:schema:strategy-management-browser-report-1";
const STRATEGY_PROTOCOL_VERSION: any = STRATEGY_MANAGEMENT_PROTOCOL_VERSION;
const EXPECTED_NAMED_ASSERTIONS: readonly any[] = Object.freeze([
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
const EXPECTED_OPERATION_IDS: readonly any[] = Object.freeze([
  "strategy.describe",
  "strategy.workflow_policy.evaluate",
  "strategy.agent_policy.evaluate",
  "strategy.route_policy.evaluate",
  "strategy.queue_policy.evaluate",
  "strategy.tool_policy.preview"
]);
const EXPECTED_PROVIDER_SURFACE: any = Object.freeze([
  "describe",
  "evaluateAgentPolicy",
  "evaluateQueuePolicy",
  "evaluateRoutePolicy",
  "evaluateToolPolicy",
  "evaluateWorkflowPolicy",
  "protocolVersion"
].sort());
const EXPECTED_POLICY_DECISION_COLUMNS: readonly any[] = Object.freeze([
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
const PROVIDER_METHOD_BY_OPERATION: Readonly<Record<string, any>> = Object.freeze({
  "strategy.describe": "describe",
  "strategy.workflow_policy.evaluate": "evaluateWorkflowPolicy",
  "strategy.agent_policy.evaluate": "evaluateAgentPolicy",
  "strategy.route_policy.evaluate": "evaluateRoutePolicy",
  "strategy.queue_policy.evaluate": "evaluateQueuePolicy",
  "strategy.tool_policy.preview": "evaluateToolPolicy"
});
const VALID_INPUT_BY_OPERATION: Readonly<Record<string, any>> = Object.freeze({
  "strategy.workflow_policy.evaluate": { workflowId: "workflow-a", risk: "repair_write" },
  "strategy.agent_policy.evaluate": { roleId: "role-a" },
  "strategy.route_policy.evaluate": { routeId: "route-a", internalCapabilityId: "capability-a" },
  "strategy.queue_policy.evaluate": { queueDefinitionId: "queue-a", operationId: "jobs.create" },
  "strategy.tool_policy.preview": { toolId: "meshrix.jobs.list" }
});
const PRIVATE_REPORT_KEYS: any = new Set<any>([
  "grantId",
  "profileId",
  "subject",
  "effectivePolicySnapshot",
  "context",
  "credential",
  "secret",
  "token"
]);

function stableDecision(value?: any) : any {
  if (Array.isArray(value)) return value.map(stableDecision);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries((Object.entries(value) as [string, any][])
    .filter(([key]: any[]) : any => key !== "decisionId" && key !== "createdAt")
    .sort(([left]: any[], [right]: any[]) : any => left.localeCompare(right))
    .map(([key, item]: any[]) : any => [key, stableDecision(item)]));
}

function strategyOperationIds(operations?: any) : any {
  return operations
    .filter((operation?: any) : any => String(operation.id || "").startsWith("strategy."))
    .map((operation?: any) : any => operation.id)
    .sort();
}

function captureResponse() : any {
  return {
    statusCode: 200,
    body: "",
    writeHead(statusCode?: any) : any {
      this.statusCode = statusCode;
    },
    end(chunk: any = "") : any {
      this.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
    }
  };
}

function writeJson(response?: any, status?: any, payload: Record<string, any> = {}) : any {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function parseResponse(response?: any) : any {
  return response.body ? JSON.parse(response.body) : {};
}

function assertNoPrivateKeys(value?: any, location: any = "report") : any {
  if (Array.isArray(value)) {
    value.forEach((item?: any, index?: any) : any => assertNoPrivateKeys(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of (Object.entries(value) as [string, any][])) {
    assert.equal(PRIVATE_REPORT_KEYS.has(key), false, `${location}.${key} must not be emitted`);
    assertNoPrivateKeys(item, `${location}.${key}`);
  }
}

function parseArrayMetadata(value?: any, field?: any) : any {
  const parsed: any = JSON.parse(String(value || "[]"));
  assert.ok(Array.isArray(parsed), `${field} must be a JSON array`);
  assert.ok(parsed.every((item?: any) : any => typeof item === "string"), `${field} must contain only strings`);
  return parsed;
}

function assertion(id?: any, passed?: any, details: Record<string, any> = {}) : any {
  return Object.freeze({
    id,
    passed: passed === true,
    ...details
  });
}

function collectVersionRegistryActiveVersions(registry?: any) : any {
  const versions: any = new Map<any, any>();
  const walk: any = (value?: any) : any => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.artifactId === "string" && typeof value.activeVersion === "string") {
      versions.set(value.artifactId, value.activeVersion);
    }
    (Object.values(value) as any[]).forEach(walk);
  };
  walk(registry);
  return versions;
}

function reduceStrategyAcceptanceMachine() : any {
  const evidenceCommandAuthority: any = new Map<any, any>(
    PLATFORM_ACCEPTANCE_COMMANDS.map((command?: any) : any => [command.id, Object.freeze({
      acceptanceCommandId: command.id,
      ownedReports: Object.freeze([...(command.ownedReports || [])])
    })])
  );
  const checkpoints: any = JSON.parse(fsSync.readFileSync(CHECKPOINT_PATH, "utf8"));
  return reduceCapabilityCheckpoints(checkpoints, { evidenceCommandAuthority });
}

function assertPreviewOnlyDocumentation() : any {
  const doc: any = fsSync.readFileSync("docs/functionality/STRATEGY-MANAGEMENT.md", "utf8");
  const consoleClient: any = fsSync.readFileSync("apps/console/lib/strategy-management.ts", "utf8");
  const prohibited: any = /\b(rollout|rollback|active revision|activeRevision)\b/i;
  assert.equal(prohibited.test(doc), false, "STRATEGY-MANAGEMENT.md must not claim rollout/active revision/rollback");
  assert.equal(prohibited.test(consoleClient), false, "console strategy client must not claim rollout/active revision/rollback");
  assert.match(doc, /read-only preview/i);
}

const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-strategy-verifier-"));
let operationPermissionPlatform: any = null;

try {
  let decisionSequence: any = 0;
  let strategyAuthorizationCallCount: any = 0;
  let operationPermissionPolicyCallCount: any = 0;
  let governedExecutionCallCount: any = 0;
  const providerCallCounts: any = Object.fromEntries((Object.values(PROVIDER_METHOD_BY_OPERATION) as any[]).map((name?: any) : any => [name, 0]));
  const fixedPolicyRevision: Readonly<Record<string, any>> = Object.freeze({
    protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z"
  });
  const securityPermissions: Record<string, any> = {
    evaluatePolicy({ tool = null }: Record<string, any> = {}) : any {
      operationPermissionPolicyCallCount += 1;
      const toolId: any = String(tool?.id || "");
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
    getGovernancePolicyRevision() : any {
      return fixedPolicyRevision;
    },
    appendDecision() : any {}
  };
  operationPermissionPlatform = createOperationPermissionPlatform({
    userDataPath,
    operations: SERVER_API_OPERATIONS,
    controllers: {},
    operationDispatcher: async () : Promise<any> => {
      governedExecutionCallCount += 1;
      return { ok: true, status: 200, payload: { ok: true } };
    },
    securityPermissions,
    logger: { debug() : any {}, info() : any {}, warn() : any {}, error() : any {} }
  });

  const baseProvider: any = createStrategyManagementProvider({
    getOperationPermissionPlatform: () : any => operationPermissionPlatform,
    createDecisionId: (policyType?: any) : any => `${policyType}-${++decisionSequence}`,
    now: () : any => "2026-01-01T00:00:00.000Z"
  });
  assert.deepEqual(Object.keys(baseProvider).sort(), EXPECTED_PROVIDER_SURFACE);
  const strategyManagementProvider: any = Object.freeze(Object.fromEntries(
    (Object.entries(baseProvider) as [string, any][]).map(([name, value]: any[]) : any => {
      if (typeof value !== "function") return [name, value];
      return [name, (...args: any[]) : any => {
        providerCallCounts[name] += 1;
        return value(...args);
      }];
    })
  ));
  assert.deepEqual(Object.keys(strategyManagementProvider).sort(), EXPECTED_PROVIDER_SURFACE);

  const handlers: any = createSystemControllerCapabilityEcosystemHandlers({
    parseJsonBody: (buffer?: any) : any => JSON.parse(buffer.toString("utf8")),
    getStrategyManagementProvider: () : any => strategyManagementProvider,
    sendConsoleDomainOperation: async ({ operationId, input = {}, context = {}, response, errorMessage }: Record<string, any>) : Promise<any> => {
      const operationResult: any = await executeStrategyManagementOperation({ operationId, input, context });
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
  const operationById: any = new Map<any, any>(SERVER_API_OPERATIONS.map((operation?: any) : any => [operation.id, operation]));

  async function dispatchStrategy(operationId?: any, payload: Record<string, any> = {}, { scopes = ["console:read"] }: Record<string, any> = {}) : Promise<any> {
    const authSession: Record<string, any> = { user: { userId: "strategy-verifier", scopes } };
    const operation: any = operationById.get(operationId);
    assert.ok(operation, `${operationId} must be registered`);
    const response: any = captureResponse();
    const method: any = String(operation.http?.method || "POST").toUpperCase();
    await dispatchOperation({
      operation,
      controllers: { system: handlers },
      request: { headers: {}, method },
      response,
      requestBody: method === "GET" ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload)),
      url: new URL(operation.http?.path || "/", "http://127.0.0.1"),
      authorizeOperation: async () : Promise<any> => {
        strategyAuthorizationCallCount += 1;
        const allowed: any = scopes.includes("console:read");
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

  const sourceIds: any = strategyOperationIds(SERVER_API_OPERATIONS);
  const generatedIds: any = strategyOperationIds(GENERATED_SERVER_API_OPERATIONS);
  const capabilityIds: any = KERNEL_API_OPERATION_IDS.filter((id?: any) : any => id.startsWith("strategy.")).sort();
  const catalogTools: any = createToolCatalog({ operations: SERVER_API_OPERATIONS })
    .tools
    .filter((tool?: any) : any => tool.operationId.startsWith("strategy."))
    .sort((left?: any, right?: any) : any => left.operationId.localeCompare(right.operationId));

  assert.deepEqual(sourceIds, [...EXPECTED_OPERATION_IDS].sort());
  assert.deepEqual(sourceIds, generatedIds);
  assert.deepEqual(sourceIds, capabilityIds);
  assert.equal(catalogTools.length, EXPECTED_OPERATION_IDS.length);
  assert.ok(catalogTools.every((tool?: any) : any => tool.id.startsWith("meshrix.strategy.")));
  assert.ok(catalogTools.every((tool?: any) : any => tool.requiredScopes.includes("console:read")));
  assert.ok(catalogTools.every((tool?: any) : any => tool.readOnly === true));

  for (const operationId of EXPECTED_OPERATION_IDS) {
    const operation: any = operationById.get(operationId);
    const generatedOperation: any = GENERATED_SERVER_API_OPERATIONS.find((item?: any) : any => item.id === operationId);
    assert.ok(generatedOperation, `${operationId} must exist in generated operations`);
    assert.deepEqual(generatedOperation.inputSchema, operation.inputSchema, `${operationId} input schema must be generated exactly`);
    assert.equal(operationFeatureId(operation), "strategy-management");
    assert.equal(operation.readOnly, true);
    assert.equal(operation.safety?.risk || "read_only", "read_only");
    assert.equal(operation.requiredScopes.includes("console:read"), true);

    const method: any = PROVIDER_METHOD_BY_OPERATION[operationId];
    const before: any = providerCallCounts[method];
    const unauthorized: any = await dispatchStrategy(operationId, VALID_INPUT_BY_OPERATION[operationId] || {}, { scopes: [] });
    assert.equal(unauthorized.status, 403);
    assert.equal(providerCallCounts[method], before, `${operationId} must authorize before provider entry`);
  }

  for (const operationId of EXPECTED_OPERATION_IDS.filter((id?: any) : any => id !== "strategy.describe")) {
    const method: any = PROVIDER_METHOD_BY_OPERATION[operationId];
    const before: any = providerCallCounts[method];
    const invalid: any = await dispatchStrategy(operationId, {});
    assert.equal(invalid.status, 400);
    assert.equal(providerCallCounts[method], before, `${operationId} must validate before provider entry`);
  }

  const describe: any = await dispatchStrategy("strategy.describe");
  assert.equal(describe.status, 200);
  assert.equal(describe.payload.protocolVersion, STRATEGY_MANAGEMENT_PROTOCOL_VERSION);
  assert.deepEqual(describe.payload.capabilities, [...EXPECTED_OPERATION_IDS].sort());

  const workflow: any = await dispatchStrategy("strategy.workflow_policy.evaluate", {
    workflowId: "workflow-a",
    risk: "repair_write"
  });
  const workflowEquivalent: any = await dispatchStrategy("strategy.workflow_policy.evaluate", {
    workflowId: "  workflow-a  ",
    risk: " repair_write "
  });
  const workflowChanged: any = await dispatchStrategy("strategy.workflow_policy.evaluate", {
    workflowId: "workflow-a",
    risk: "read_only"
  });
  assert.deepEqual(stableDecision(workflow.payload), stableDecision(workflowEquivalent.payload));
  assert.notDeepEqual(stableDecision(workflow.payload), stableDecision(workflowChanged.payload));

  const agent: any = await dispatchStrategy("strategy.agent_policy.evaluate", { roleId: "role-a" });
  const agentEquivalent: any = await dispatchStrategy("strategy.agent_policy.evaluate", { roleId: "  role-a  " });
  const agentChanged: any = await dispatchStrategy("strategy.agent_policy.evaluate", { roleId: "role-b" });
  assert.deepEqual(stableDecision(agent.payload), stableDecision(agentEquivalent.payload));
  assert.notDeepEqual(stableDecision(agent.payload), stableDecision(agentChanged.payload));

  const route: any = await dispatchStrategy("strategy.route_policy.evaluate", {
    routeId: "route-a",
    internalCapabilityId: "capability-a"
  });
  const routeEquivalent: any = await dispatchStrategy("strategy.route_policy.evaluate", {
    routeId: " route-a ",
    internalCapabilityId: " capability-a "
  });
  const routeChanged: any = await dispatchStrategy("strategy.route_policy.evaluate", { routeId: "route-a" });
  assert.deepEqual(stableDecision(route.payload), stableDecision(routeEquivalent.payload));
  assert.notDeepEqual(stableDecision(route.payload), stableDecision(routeChanged.payload));

  const queue: any = await dispatchStrategy("strategy.queue_policy.evaluate", {
    queueDefinitionId: "queue-a",
    operationId: "jobs.create",
    maxAttempts: 2
  });
  const queueEquivalent: any = await dispatchStrategy("strategy.queue_policy.evaluate", {
    queueDefinitionId: " queue-a ",
    operationId: " jobs.create ",
    maxAttempts: 2
  });
  const queueChanged: any = await dispatchStrategy("strategy.queue_policy.evaluate", {
    queueDefinitionId: "queue-a",
    operationId: "jobs.create",
    maxAttempts: 3
  });
  assert.deepEqual(stableDecision(queue.payload), stableDecision(queueEquivalent.payload));
  assert.notDeepEqual(stableDecision(queue.payload), stableDecision(queueChanged.payload));

  const previewPolicyCallsBefore: any = operationPermissionPolicyCallCount;
  const toolPreview: any = await dispatchStrategy("strategy.tool_policy.preview", { toolId: "meshrix.jobs.list" });
  const toolPreviewEquivalent: any = await dispatchStrategy("strategy.tool_policy.preview", { toolId: "  meshrix.jobs.list  " });
  const toolPreviewChanged: any = await dispatchStrategy("strategy.tool_policy.preview", { toolId: "meshrix.jobs.get" });
  const toolPreviewCallCount: any = operationPermissionPolicyCallCount - previewPolicyCallsBefore;
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

  const policyColumns: any = operationPermissionPlatform.store.db
    .prepare("PRAGMA table_info(tool_policy_decisions)")
    .all()
    .map((column?: any) : any => String(column.name));
  assert.deepEqual(policyColumns, EXPECTED_POLICY_DECISION_COLUMNS);
  const previewAuditRows: any = operationPermissionPlatform.store.db.prepare(`
    SELECT decision_id, tool_execution_id, trace_id, tool_id, grant_id, effect, reason_code,
           missing_scopes_json, missing_toolsets_json, evaluated_layers_json, ledger_event_id, created_at
    FROM tool_policy_decisions
    ORDER BY rowid
  `).all();
  assert.equal(previewAuditRows.length, toolPreviewCallCount);
  assert.equal(new Set<any>(previewAuditRows.map((row?: any) : any => row.decision_id)).size, previewAuditRows.length);
  assert.deepEqual(previewAuditRows.map((row?: any) : any => row.tool_id), [
    "meshrix.jobs.list",
    "meshrix.jobs.list",
    "meshrix.jobs.get"
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

  const governedPolicyCallsBefore: any = operationPermissionPolicyCallCount;
  const governedFollowUp: any = await operationPermissionPlatform.runtime.executeTool({
    toolId: "meshrix.gateway.forward",
    input: {
      serviceId: "strategy-verifier-service",
      previewDecision: toolPreview.payload.decision
    },
    request: { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
    authorizedGrant: {
      id: "strategy-verifier-current-grant",
      label: "Strategy verifier current grant",
      scopes: ["gateway:write"],
      toolsets: ["meshrix.gateway.write"]
    }
  });
  assert.equal(operationPermissionPolicyCallCount - governedPolicyCallsBefore, 1);
  assert.equal(governedFollowUp.ok, false);
  assert.equal(governedFollowUp.status, 403);
  assert.equal(governedFollowUp.payload.error.code, "current_policy_denied");
  assert.notEqual(governedFollowUp.payload.error.details.decisionId, toolPreview.payload.decision.decisionId);
  assert.equal(governedExecutionCallCount, 0, "a denied current decision must not reach operation execution");
  const allAuditRowCount: any = operationPermissionPlatform.store.db
    .prepare("SELECT COUNT(*) AS count FROM tool_policy_decisions")
    .get().count;
  assert.equal(allAuditRowCount, toolPreviewCallCount + 1);

  const replayMethod: any = PROVIDER_METHOD_BY_OPERATION["strategy.workflow_policy.evaluate"];
  const providerBeforeReplay: any = providerCallCounts[replayMethod];
  const replayAttempt: any = await dispatchStrategy("strategy.workflow_policy.evaluate", {
    workflowId: "workflow-follow-up",
    previewDecision: workflow.payload
  });
  assert.equal(replayAttempt.status, 400);
  assert.equal(providerCallCounts[replayMethod], providerBeforeReplay);

  const coreRuntime: any = resolveFeatureRuntime({ edition: "core" });
  assert.ok(coreRuntime.activeFeatureIds.includes("strategy-management"));
  const activeCoreOperationIds: any = new Set<any>(
    filterOperationsForFeatures(SERVER_API_OPERATIONS, coreRuntime).map((operation?: any) : any => operation.id)
  );
  for (const operationId of EXPECTED_OPERATION_IDS) {
    assert.ok(activeCoreOperationIds.has(operationId), `core edition must include ${operationId}`);
  }

  const versionRegistry: any = JSON.parse(fsSync.readFileSync(VERSION_REGISTRY_PATH, "utf8"));
  const activeVersions: any = collectVersionRegistryActiveVersions(versionRegistry);
  assert.equal(
    activeVersions.get("meshrix.strategy.strategy-management"),
    STRATEGY_PROTOCOL_VERSION,
    "strategy provider protocol version must match the version registry"
  );
  assert.equal(
    activeVersions.get("meshrix.strategy.strategy-management-verification-report"),
    STRATEGY_REPORT_SCHEMA_VERSION,
    "strategy verification report schema must match the version registry"
  );
  assert.equal(
    activeVersions.get("meshrix.strategy.strategy-management-browser-report"),
    STRATEGY_BROWSER_REPORT_SCHEMA_VERSION,
    "strategy browser report schema must match the version registry"
  );

  assertPreviewOnlyDocumentation();

  const acceptanceReduction: any = reduceStrategyAcceptanceMachine();
  assert.equal(acceptanceReduction.readyForReleaseReduction, true, "strategy acceptance machine must have zero open criteria");
  assert.equal(acceptanceReduction.openCheckpoints.length, 0);
  assert.equal(acceptanceReduction.uncheckedCriteria.length, 0);
  assert.equal(acceptanceReduction.currentState, "verified");
  assert.ok(
    !Object.prototype.hasOwnProperty.call(acceptanceReduction, "ready") &&
      !Object.prototype.hasOwnProperty.call(acceptanceReduction, "genericReady"),
    "strategy acceptance reduction must not rely on a generic ready alias"
  );

  const namedAssertions: any[] = [
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
    namedAssertions.map((item?: any) : any => item.id).sort(),
    [...EXPECTED_NAMED_ASSERTIONS].sort()
  );
  assert.ok(namedAssertions.every((item?: any) : any => item.passed === true), "every named strategy assertion must pass");

  const report: Record<string, any> = {
    schemaVersion: STRATEGY_REPORT_SCHEMA_VERSION,
    verifier: "tools/server-scripts/verify-strategy-management.ts",
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
      namedAssertionPassedCount: namedAssertions.filter((item?: any) : any => item.passed).length,
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
