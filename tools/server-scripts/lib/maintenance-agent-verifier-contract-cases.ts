import assert from "node:assert/strict";

import { withModuleAgentProfileInput } from "../../../packages/agents/src/agent-gateway/policy-validation.ts";
import { createToolCatalog } from "../../../packages/capabilities/src/operation-permission-core/catalog.ts";
import { SERVER_API_OPERATIONS as GENERATED_SERVER_API_OPERATIONS } from "../../../packages/contracts/src/generated/operations.generated.ts";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";
import { KERNEL_API_OPERATION_IDS } from "../../../packages/foundation/src/security/authorization/generated-capabilities.ts";
import {
  filterOperationsForFeatures,
  operationFeatureId,
  resolveFeatureRuntime
} from "../../../packages/server-runtime/src/composition/features/feature-manifest.ts";

export const EXPECTED_MAINTENANCE_OPERATION_IDS: readonly any[] = Object.freeze([
  "maintenance_agent.config.get",
  "maintenance_agent.config.set",
  "maintenance_agent.chat",
  "maintenance_agent.runs.create",
  "maintenance_agent.runs.list",
  "maintenance_agent.runs.get",
  "maintenance_agent.runs.approve",
  "maintenance_agent.runs.cancel"
]);

function operationById(operations?: any, id?: any) : any {
  return operations.find((operation?: any) : any => operation.id === id) || null;
}

export function assertMaintenanceAgentContracts() : any {
  const sourceIds: any = EXPECTED_MAINTENANCE_OPERATION_IDS.filter((id?: any) : any => operationById(SERVER_API_OPERATIONS, id));
  const generatedIds: any = EXPECTED_MAINTENANCE_OPERATION_IDS.filter((id?: any) : any => operationById(GENERATED_SERVER_API_OPERATIONS, id));
  assert.deepEqual(sourceIds, EXPECTED_MAINTENANCE_OPERATION_IDS);
  assert.deepEqual(generatedIds, EXPECTED_MAINTENANCE_OPERATION_IDS);
  for (const operationId of EXPECTED_MAINTENANCE_OPERATION_IDS) {
    assert.ok(KERNEL_API_OPERATION_IDS.includes(operationId), `${operationId} must have generated capability`);
    const sourceOperation: any = operationById(SERVER_API_OPERATIONS, operationId);
    const generatedOperation: any = operationById(GENERATED_SERVER_API_OPERATIONS, operationId);
    assert.equal(operationFeatureId(sourceOperation), "maintenance-agent-runbooks");
    assert.equal(generatedOperation.http.path, sourceOperation.http.path);
    assert.deepEqual(generatedOperation.requiredScopes, sourceOperation.requiredScopes);
  }

  for (const operationId of ["maintenance_agent.config.get", "maintenance_agent.runs.list", "maintenance_agent.runs.get"]) {
    const operation: any = operationById(SERVER_API_OPERATIONS, operationId);
    assert.equal(operation.readOnly, true);
    assert.equal(operation.safety.risk, "read_only");
    assert.deepEqual(operation.requiredScopes, ["maintenance:read"]);
  }
  assert.deepEqual(operationById(SERVER_API_OPERATIONS, "maintenance_agent.config.set").requiredScopes, ["maintenance:admin"]);
  assert.equal(operationById(SERVER_API_OPERATIONS, "maintenance_agent.config.set").safety.risk, "repair_write");
  assert.deepEqual(operationById(SERVER_API_OPERATIONS, "maintenance_agent.runs.approve").requiredScopes, ["maintenance:approve"]);
  assert.equal(operationById(SERVER_API_OPERATIONS, "maintenance_agent.runs.approve").safety.risk, "repair_write");
  for (const operationId of ["maintenance_agent.chat", "maintenance_agent.runs.create", "maintenance_agent.runs.cancel"]) {
    const operation: any = operationById(SERVER_API_OPERATIONS, operationId);
    assert.equal(operation.safety.risk, "safe_write");
    assert.deepEqual(operation.requiredScopes, ["maintenance:run"]);
  }
  const chatOperation: any = operationById(SERVER_API_OPERATIONS, "maintenance_agent.chat");
  assert.equal(chatOperation.audit.recordInput, false);
  assert.equal(chatOperation.audit.metadataOnly, true);
  assert.equal(chatOperation.log.recordInput, false);

  const missingModuleProfile: any = withModuleAgentProfileInput(
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

  const standardRuntime: any = resolveFeatureRuntime({ edition: "standard" });
  const standardOperationIds: any = new Set<any>(
    filterOperationsForFeatures(SERVER_API_OPERATIONS, standardRuntime).map((operation?: any) : any => operation.id)
  );
  for (const operationId of EXPECTED_MAINTENANCE_OPERATION_IDS) {
    assert.equal(standardOperationIds.has(operationId), false, `${operationId} must remain default-disabled`);
  }

  const enabledRuntime: any = resolveFeatureRuntime({
    edition: "standard",
    enableFeatures: ["maintenance-agent-runbooks"]
  });
  const enabledOperationIds: any = new Set<any>(
    filterOperationsForFeatures(SERVER_API_OPERATIONS, enabledRuntime).map((operation?: any) : any => operation.id)
  );
  for (const operationId of EXPECTED_MAINTENANCE_OPERATION_IDS) {
    assert.ok(enabledOperationIds.has(operationId), `${operationId} must be active when maintenance-agent-runbooks is enabled`);
  }

  const catalog: any = createToolCatalog({
    operations: SERVER_API_OPERATIONS,
    activeFeatureIds: enabledRuntime.activeFeatureIds
  });
  const toolsByOperation: any = new Map<any, any>(catalog.tools.map((tool?: any) : any => [tool.operationId, tool]));
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
