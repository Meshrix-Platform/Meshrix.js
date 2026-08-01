import { stringSet, stringsFrom, uniqueStrings } from "./authorization-engine-common.ts";
import {
  KERNEL_API_OPERATION_IDS,
  KERNEL_TOOL_IDS,
  KERNEL_CAPABILITY_WILDCARDS,
  KERNEL_API_CAPABILITY_PERMISSIONS,
  KERNEL_TOOL_CAPABILITY_PERMISSIONS,
  KERNEL_CAPABILITY_PERMISSIONS,
  apiCapabilityId,
  toolExecuteCapabilityId
} from "./generated-capabilities.ts";

export {
  KERNEL_API_OPERATION_IDS,
  KERNEL_TOOL_IDS,
  apiCapabilityId,
  toolExecuteCapabilityId,
  KERNEL_API_CAPABILITY_PERMISSIONS,
  KERNEL_TOOL_CAPABILITY_PERMISSIONS,
  KERNEL_CAPABILITY_WILDCARDS,
  KERNEL_CAPABILITY_PERMISSIONS
} from "./generated-capabilities.ts";

const KERNEL_API_OPERATION_ID_SET: any = new Set<any>(KERNEL_API_OPERATION_IDS);
const KERNEL_TOOL_ID_SET: any = new Set<any>(KERNEL_TOOL_IDS);
const KERNEL_CAPABILITY_PERMISSION_SET: any = new Set<any>(KERNEL_CAPABILITY_PERMISSIONS);
const KERNEL_CAPABILITY_WILDCARD_SET: any = new Set<any>(KERNEL_CAPABILITY_WILDCARDS);
const REGISTERED_TOOL_CAPABILITY_PATTERN: any = /^cap:tool:[a-z][A-Za-z0-9._-]{0,159}:execute$/u;

export function isKernelCapabilityPermission(value?: any) : any {
  const capability: any = String(value || "").trim();
  return KERNEL_CAPABILITY_PERMISSION_SET.has(capability) || KERNEL_CAPABILITY_WILDCARD_SET.has(capability);
}

export function unknownKernelCapabilities(...values: any[]) : any {
  return uniqueStrings(stringsFrom(...values).filter((capability?: any) : any => !isKernelCapabilityPermission(capability)));
}

export function assertKnownKernelCapabilities(...values: any[]) : any {
  const unknown: any = unknownKernelCapabilities(...values);
  if (unknown.length > 0) {
    throw new Error(`Unknown kernel capability permission: ${unknown.join(", ")}`);
  }
  return normalizeKernelCapabilities(...values);
}

export function normalizeKernelCapabilities(...values: any[]) : any {
  return uniqueStrings(stringsFrom(...values).filter(isKernelCapabilityPermission));
}

export function isRegisteredToolCapabilityPermission(value?: any) : any {
  return REGISTERED_TOOL_CAPABILITY_PATTERN.test(String(value || "").trim());
}

export function normalizeRegisteredToolCapabilities(...values: any[]) : any {
  return uniqueStrings(stringsFrom(...values).filter(isRegisteredToolCapabilityPermission));
}

export function listKernelCapabilityPermissions() : any {
  return [...KERNEL_CAPABILITY_PERMISSIONS];
}

export function requiredCapabilitiesFor(operation: Record<string, any> = {}, tool: any = null) : any {
  const explicit: any = uniqueStrings(stringsFrom(
    operation.requiredCapabilities,
    operation.capabilities,
    tool?.requiredCapabilities,
    tool?.capabilities
  ));
  if (explicit.length > 0) {
    return explicit;
  }
  const toolId: any = String(tool?.id || "").trim();
  if (toolId && KERNEL_TOOL_ID_SET.has(toolId)) {
    return [toolExecuteCapabilityId(toolId)];
  }
  const operationId: any = String(operation?.id || tool?.operationId || "").trim();
  return operationId && KERNEL_API_OPERATION_ID_SET.has(operationId)
    ? [apiCapabilityId(operationId)]
    : [];
}

export function subjectCapabilities(subject: Record<string, any> = {}, actor: any = null, authSession: any = null, grant: any = null) : any {
  return normalizeKernelCapabilities(
    subject.capabilities,
    subject.capabilityIds,
    subject.permissions,
    actor?.capabilities,
    actor?.capabilityIds,
    actor?.permissions,
    actor?.user?.capabilities,
    actor?.user?.capabilityIds,
    authSession?.user?.capabilities,
    authSession?.user?.capabilityIds,
    grant?.capabilities,
    grant?.capabilityIds,
    grant?.metadata?.capabilities,
    grant?.metadata?.capabilityIds
  );
}

export function hasCapability(capabilities: any = [], capability: any = "") : any {
  const capabilityId: any = String(capability || "").trim();
  if (!capabilityId) {
    return true;
  }
  const capabilitySet: any = stringSet(capabilities);
  if (capabilitySet.has("cap:*") || capabilitySet.has(capabilityId)) {
    return true;
  }
  if (capabilityId.startsWith("cap:api:") && capabilitySet.has("cap:api:*")) {
    return true;
  }
  if (capabilityId.startsWith("cap:tool:") && capabilitySet.has("cap:tool:*")) {
    return true;
  }
  return false;
}
