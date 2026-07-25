import assert from "node:assert/strict";

import { withModuleAgentProfileInput } from "../../../packages/agents/src/agent-gateway/policy-validation.mjs";
import { createToolCatalog } from "../../../packages/capabilities/src/operation-permission-core/catalog.mjs";
import { SERVER_API_OPERATIONS as GENERATED_SERVER_API_OPERATIONS } from "../../../packages/contracts/src/generated/operations.generated.mjs";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.mjs";
import { KERNEL_API_OPERATION_IDS } from "../../../packages/foundation/src/security/authorization/generated-capabilities.mjs";
import {
  filterOperationsForFeatures,
  operationFeatureId,
  resolveFeatureRuntime
} from "../../../packages/server-runtime/src/composition/features/feature-manifest.mjs";

export const EXPECTED_MAINTENANCE_OPERATION_IDS = Object.freeze([
  "maintenance_agent.config.get",
  "maintenance_agent.config.set",
  "maintenance_agent.chat",
  "maintenance_agent.runs.create",
  "maintenance_agent.runs.list",
  "maintenance_agent.runs.get",
  "maintenance_agent.runs.approve",
  "maintenance_agent.runs.cancel"
]);

function operationById(operations, id) {
  return operations.find((operation) => operation.id === id) || null;
}

export function assertMaintenanceAgentContracts() {
  const sourceIds = EXPECTED_MAINTENANCE_OPERATION_IDS.filter((id) => operationById(SERVER_API_OPERATIONS, id));
  const generatedIds = EXPECTED_MAINTENANCE_OPERATION_IDS.filter((id) => operationById(GENERATED_SERVER_API_OPERATIONS, id));
  assert.deepEqual(sourceIds, EXPECTED_MAINTENANCE_OPERATION_IDS);
  assert.deepEqual(generatedIds, EXPECTED_MAINTENANCE_OPERATION_IDS);
  for (const operationId of EXPECTED_MAINTENANCE_OPERATION_IDS) {
    assert.ok(KERNEL_API_OPERATION_IDS.includes(operationId), `${operationId} must have generated capability`);
    const sourceOperation = operationById(SERVER_API_OPERATIONS, operationId);
    const generatedOperation = operationById(GENERATED_SERVER_API_OPERATIONS, operationId);
    assert.equal(operationFeatureId(sourceOperation), "maintenance-agent-runbooks");
    assert.equal(generatedOperation.http.path, sourceOperation.http.path);
    assert.deepEqual(generatedOperation.requiredScopes, sourceOperation.requiredScopes);
  }

  for (const operationId of ["maintenance_agent.config.get", "maintenance_agent.runs.list", "maintenance_agent.runs.get"]) {
    const operation = operationById(SERVER_API_OPERATIONS, operationId);
    assert.equal(operation.readOnly, true);
    assert.equal(operation.safety.risk, "read_only");
    assert.deepEqual(operation.requiredScopes, ["maintenance:read"]);
  }
  assert.deepEqual(operationById(SERVER_API_OPERATIONS, "maintenance_agent.config.set").requiredScopes, ["maintenance:admin"]);
  assert.equal(operationById(SERVER_API_OPERATIONS, "maintenance_agent.config.set").safety.risk, "repair_write");
  assert.deepEqual(operationById(SERVER_API_OPERATIONS, "maintenance_agent.runs.approve").requiredScopes, ["maintenance:approve"]);
  assert.equal(operationById(SERVER_API_OPERATIONS, "maintenance_agent.runs.approve").safety.risk, "repair_write");
  for (const operationId of ["maintenance_agent.chat", "maintenance_agent.runs.create", "maintenance_agent.runs.cancel"]) {
    const operation = operationById(SERVER_API_OPERATIONS, operationId);
    assert.equal(operation.safety.risk, "safe_write");
    assert.deepEqual(operation.requiredScopes, ["maintenance:run"]);
  }
  const chatOperation = operationById(SERVER_API_OPERATIONS, "maintenance_agent.chat");
  assert.equal(chatOperation.audit.recordInput, false);
  assert.equal(chatOperation.audit.metadataOnly, true);
  assert.equal(chatOperation.log.recordInput, false);

  const missingModuleProfile = withModuleAgentProfileInput(
    { moduleAgentProfiles: {} },
    {
      moduleId: "maintenance-agent-runbooks",
      alias: "maintenance-planner-stub",
      question: "verify missing module profile"
    },
    { alias: "maintenance-planner-stub" }
  );
  assert.equal(missingModuleProfile.profile, null);
  assert.equal(missingModuleProfile.input.moduleAgentProfile, undefined);

  const standardRuntime = resolveFeatureRuntime({ edition: "standard" });
  const standardOperationIds = new Set(
    filterOperationsForFeatures(SERVER_API_OPERATIONS, standardRuntime).map((operation) => operation.id)
  );
  for (const operationId of EXPECTED_MAINTENANCE_OPERATION_IDS) {
    assert.equal(standardOperationIds.has(operationId), false, `${operationId} must remain default-disabled`);
  }

  const enabledRuntime = resolveFeatureRuntime({
    edition: "standard",
    enableFeatures: ["maintenance-agent-runbooks"]
  });
  const enabledOperationIds = new Set(
    filterOperationsForFeatures(SERVER_API_OPERATIONS, enabledRuntime).map((operation) => operation.id)
  );
  for (const operationId of EXPECTED_MAINTENANCE_OPERATION_IDS) {
    assert.ok(enabledOperationIds.has(operationId), `${operationId} must be active when maintenance-agent-runbooks is enabled`);
  }

  const catalog = createToolCatalog({
    operations: SERVER_API_OPERATIONS,
    activeFeatureIds: enabledRuntime.activeFeatureIds
  });
  const toolsByOperation = new Map(catalog.tools.map((tool) => [tool.operationId, tool]));
  assert.equal(toolsByOperation.get("maintenance_agent.config.get")?.id, "meshrix.maintenanceAgent.config.get");
  assert.deepEqual(toolsByOperation.get("maintenance_agent.config.get")?.requiredScopes, ["maintenance:read"]);
  assert.ok(toolsByOperation.get("maintenance_agent.config.get")?.toolsets.includes("meshrix.maintenance.read"));
  assert.deepEqual(toolsByOperation.get("maintenance_agent.config.set")?.requiredScopes, ["maintenance:admin"]);
  assert.ok(toolsByOperation.get("maintenance_agent.config.set")?.toolsets.includes("meshrix.maintenance.maintain"));
  assert.deepEqual(toolsByOperation.get("maintenance_agent.runs.approve")?.requiredScopes, ["maintenance:approve"]);
  assert.ok(toolsByOperation.get("maintenance_agent.runs.approve")?.toolsets.includes("meshrix.maintenance.maintain"));
  assert.deepEqual(toolsByOperation.get("maintenance_agent.runs.create")?.requiredScopes, ["maintenance:run"]);
  assert.ok(toolsByOperation.get("maintenance_agent.runs.create")?.toolsets.includes("meshrix.maintenance.run"));
}
