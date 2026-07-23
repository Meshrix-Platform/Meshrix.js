import {
  SERVER_API_OPERATIONS as CORE_SERVER_API_OPERATIONS,
  SERVER_NON_OPERATION_API_CAPABILITIES
} from "../../packages/contracts/src/operations/operation-registry.mjs";
import { SERVER_API_OPERATIONS as GENERATED_SERVER_API_OPERATIONS } from "../../packages/contracts/src/generated/operations.generated.mjs";
import {
  KERNEL_API_OPERATION_IDS as GENERATED_KERNEL_API_OPERATION_IDS,
  KERNEL_TOOL_IDS as GENERATED_KERNEL_TOOL_IDS
} from "../../packages/foundation/src/security/authorization/generated-capabilities.mjs";
import {
  KERNEL_API_OPERATION_IDS as AUTH_KERNEL_API_OPERATION_IDS,
  KERNEL_TOOL_IDS as AUTH_KERNEL_TOOL_IDS
} from "../../packages/foundation/src/security/authorization/authorization-capabilities.mjs";
import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.mjs";

const CORE_OPERATION_REGISTRY = "packages/contracts/src/operations/operation-registry.mjs";

function riskOf(operation = {}) {
  const risk = String(operation.risk || operation.safety?.risk || "").trim();
  return ["read_only", "safe_write", "repair_write", "destructive"].includes(risk)
    ? risk
    : operation.readOnly === false
      ? "safe_write"
      : "read_only";
}

function sortedStrings(values = []) {
  return [...values].map((value) => String(value || "").trim()).filter(Boolean).sort();
}

function sameStringArray(left = [], right = []) {
  return JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));
}

function compareIdSet(issues, label, expected = [], actual = []) {
  const expectedIds = sortedStrings(expected);
  const actualIds = sortedStrings(actual);
  const expectedSet = new Set(expectedIds);
  const actualSet = new Set(actualIds);
  const missing = expectedIds.filter((id) => !actualSet.has(id));
  const extra = actualIds.filter((id) => !expectedSet.has(id));
  if (missing.length > 0 || extra.length > 0 || expectedIds.length !== actualIds.length) {
    issues.push(`${label}: expected ${expectedIds.length} ids, got ${actualIds.length}; missing=${missing.slice(0, 12).join(",") || "none"} extra=${extra.slice(0, 12).join(",") || "none"}`);
  }
}

function compareOperationProjection(issues, label, sourceOperations = [], projectedOperations = []) {
  const projectedById = new Map(projectedOperations.map((operation) => [operation.id, operation]));
  for (const source of sourceOperations) {
    const projected = projectedById.get(source.id);
    if (!projected) {
      continue;
    }
    for (const [field, sourceValue, projectedValue] of [
      ["risk", riskOf(source), riskOf(projected)],
      ["readOnly", source.readOnly === true, projected.readOnly === true],
      ["concurrencySafe", source.concurrencySafe === true, projected.concurrencySafe === true],
      ["http.method", String(source.http?.method || "").toUpperCase(), String(projected.http?.method || "").toUpperCase()],
      ["http.path", String(source.http?.path || ""), String(projected.http?.path || "")],
      ["rpc.method", String(source.rpc?.method || ""), String(projected.rpc?.method || "")]
    ]) {
      if (sourceValue !== projectedValue) {
        issues.push(`${label}: operation "${source.id}" ${field} mismatch: expected ${sourceValue}, got ${projectedValue}`);
      }
    }
    if (!sameStringArray(source.requiredScopes || [], projected.requiredScopes || [])) {
      issues.push(`${label}: operation "${source.id}" requiredScopes mismatch`);
    }
  }
}

export function validateOperationRegistryProjectionParity(dataCache) {
  const issues = [];
  const operationRegistry = dataCache.get("operations/operations.registry.json");
  const capabilityRegistry = dataCache.get("capabilities/capabilities.registry.json");
  if (!operationRegistry || !capabilityRegistry) {
    return issues;
  }

  const sourceIds = CORE_SERVER_API_OPERATIONS.map((operation) => operation.id);
  const expectedApiCapabilityIds = [
    ...sourceIds,
    ...SERVER_NON_OPERATION_API_CAPABILITIES.map((capability) => capability.operationId)
  ];
  const registryOperations = operationRegistry.operations || [];
  const registryIds = registryOperations.map((operation) => operation.id);
  const generatedIds = GENERATED_SERVER_API_OPERATIONS.map((operation) => operation.id);
  const capabilityOperationIds = (capabilityRegistry.capabilities || []).map((capability) => capability.operationId);
  const expectedToolIds = createToolCatalog({ operations: CORE_SERVER_API_OPERATIONS }).tools.map((tool) => tool.id);
  const registryToolIds = (capabilityRegistry.toolCapabilities || []).map((capability) => capability.toolId);

  if (operationRegistry.canonicalSource !== false || operationRegistry.canonicalSourcePath !== CORE_OPERATION_REGISTRY) {
    issues.push(`operation registry projection must declare ${CORE_OPERATION_REGISTRY} as the canonical source`);
  }
  if (capabilityRegistry.canonicalSource !== false || capabilityRegistry.canonicalSourcePath !== CORE_OPERATION_REGISTRY) {
    issues.push(`capability registry projection must declare ${CORE_OPERATION_REGISTRY} as the canonical source`);
  }

  compareIdSet(issues, "operation-registry projection ids", sourceIds, registryIds);
  compareIdSet(issues, "generated operation ids", sourceIds, generatedIds);
  compareIdSet(issues, "capability registry API ids", expectedApiCapabilityIds, capabilityOperationIds);
  compareIdSet(issues, "generated API capability ids", expectedApiCapabilityIds, GENERATED_KERNEL_API_OPERATION_IDS);
  compareIdSet(issues, "runtime authorization API capability ids", expectedApiCapabilityIds, AUTH_KERNEL_API_OPERATION_IDS);
  compareIdSet(issues, "capability registry tool ids", expectedToolIds, registryToolIds);
  compareIdSet(issues, "generated tool capability ids", expectedToolIds, GENERATED_KERNEL_TOOL_IDS);
  compareIdSet(issues, "runtime authorization tool capability ids", expectedToolIds, AUTH_KERNEL_TOOL_IDS);
  compareOperationProjection(issues, "operation-registry projection", CORE_SERVER_API_OPERATIONS, registryOperations);
  compareOperationProjection(issues, "generated operation projection", CORE_SERVER_API_OPERATIONS, GENERATED_SERVER_API_OPERATIONS);

  const capabilityByOperation = new Map((capabilityRegistry.capabilities || []).map((capability) => [capability.operationId, capability]));
  for (const capabilitySource of [...CORE_SERVER_API_OPERATIONS, ...SERVER_NON_OPERATION_API_CAPABILITIES]) {
    const operationId = capabilitySource.id || capabilitySource.operationId;
    const capability = capabilityByOperation.get(operationId);
    if (capability && capability.risk !== riskOf(capabilitySource)) {
      issues.push(`capability registry: operation "${operationId}" risk mismatch: expected ${riskOf(capabilitySource)}, got ${capability.risk}`);
    }
  }

  return issues;
}
