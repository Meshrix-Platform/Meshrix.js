import {
  SERVER_API_OPERATIONS as CORE_SERVER_API_OPERATIONS,
  SERVER_NON_OPERATION_API_CAPABILITIES
} from "../../packages/contracts/src/operations/operation-registry.ts";
import { SERVER_API_OPERATIONS as GENERATED_SERVER_API_OPERATIONS } from "../../packages/contracts/src/generated/operations.generated.ts";
import {
  KERNEL_API_OPERATION_IDS as GENERATED_KERNEL_API_OPERATION_IDS,
  KERNEL_TOOL_IDS as GENERATED_KERNEL_TOOL_IDS
} from "../../packages/foundation/src/security/authorization/generated-capabilities.ts";
import {
  KERNEL_API_OPERATION_IDS as AUTH_KERNEL_API_OPERATION_IDS,
  KERNEL_TOOL_IDS as AUTH_KERNEL_TOOL_IDS
} from "../../packages/foundation/src/security/authorization/authorization-capabilities.ts";
import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.ts";

const CORE_OPERATION_REGISTRY: any = "packages/contracts/src/operations/operation-registry.ts";

function riskOf(operation: Record<string, any> = {}) : any {
  const risk: any = String(operation.risk || operation.safety?.risk || "").trim();
  return ["read_only", "safe_write", "repair_write", "destructive"].includes(risk)
    ? risk
    : operation.readOnly === false
      ? "safe_write"
      : "read_only";
}

function sortedStrings(values: any = []) : any {
  return [...values].map((value?: any) : any => String(value || "").trim()).filter(Boolean).sort();
}

function sameStringArray(left: any = [], right: any = []) : any {
  return JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));
}

function compareIdSet(issues?: any, label?: any, expected: any = [], actual: any = []) : any {
  const expectedIds: any = sortedStrings(expected);
  const actualIds: any = sortedStrings(actual);
  const expectedSet: any = new Set<any>(expectedIds);
  const actualSet: any = new Set<any>(actualIds);
  const missing: any = expectedIds.filter((id?: any) : any => !actualSet.has(id));
  const extra: any = actualIds.filter((id?: any) : any => !expectedSet.has(id));
  if (missing.length > 0 || extra.length > 0 || expectedIds.length !== actualIds.length) {
    issues.push(`${label}: expected ${expectedIds.length} ids, got ${actualIds.length}; missing=${missing.slice(0, 12).join(",") || "none"} extra=${extra.slice(0, 12).join(",") || "none"}`);
  }
}

function compareOperationProjection(issues?: any, label?: any, sourceOperations: any = [], projectedOperations: any = []) : any {
  const projectedById: any = new Map<any, any>(projectedOperations.map((operation?: any) : any => [operation.id, operation]));
  for (const source of sourceOperations) {
    const projected: any = projectedById.get(source.id);
    if (!projected) {
      continue;
    }
    for (const [field, sourceValue, projectedValue] of [
      ["risk", riskOf(source), riskOf(projected)],
      ["readOnly", source.readOnly === true, projected.readOnly === true],
      ["concurrency", JSON.stringify(source.concurrency), JSON.stringify(projected.concurrency)],
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

export function validateOperationRegistryProjectionParity(dataCache?: any) : any {
  const issues: any[] = [];
  const operationRegistry: any = dataCache.get("operations/operations.registry.json");
  const capabilityRegistry: any = dataCache.get("capabilities/capabilities.registry.json");
  if (!operationRegistry || !capabilityRegistry) {
    return issues;
  }

  const sourceIds: any = CORE_SERVER_API_OPERATIONS.map((operation?: any) : any => operation.id);
  const expectedApiCapabilityIds: any[] = [
    ...sourceIds,
    ...SERVER_NON_OPERATION_API_CAPABILITIES.map((capability?: any) : any => capability.operationId)
  ];
  const registryOperations: any = operationRegistry.operations || [];
  const registryIds: any = registryOperations.map((operation?: any) : any => operation.id);
  const generatedIds: any = GENERATED_SERVER_API_OPERATIONS.map((operation?: any) : any => operation.id);
  const capabilityOperationIds: any = (capabilityRegistry.capabilities || []).map((capability?: any) : any => capability.operationId);
  const expectedToolIds: any = createToolCatalog({ operations: CORE_SERVER_API_OPERATIONS }).tools.map((tool?: any) : any => tool.id);
  const registryToolIds: any = (capabilityRegistry.toolCapabilities || []).map((capability?: any) : any => capability.toolId);

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

  const capabilityByOperation: any = new Map<any, any>((capabilityRegistry.capabilities || []).map((capability?: any) : any => [capability.operationId, capability]));
  for (const capabilitySource of [...CORE_SERVER_API_OPERATIONS, ...SERVER_NON_OPERATION_API_CAPABILITIES]) {
    const operationId: any = capabilitySource.id || capabilitySource.operationId;
    const capability: any = capabilityByOperation.get(operationId);
    if (capability && capability.risk !== riskOf(capabilitySource)) {
      issues.push(`capability registry: operation "${operationId}" risk mismatch: expected ${riskOf(capabilitySource)}, got ${capability.risk}`);
    }
  }

  return issues;
}
