import {
  capabilityKernelStatePath,
  createOpaqueCapabilityKeyProvider,
  OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION
} from "./opaque-capability-key.ts";
import {
  capabilityBindingGuardStatePath,
  createCapabilityBindingGuard,
  CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION
} from "./capability-binding-guard.ts";

const DEFAULT_ALIAS: any = "meshrix-tool-grants";

function text(value?: any) : any {
  return String(value || "").trim();
}

function resolveBackend(input: Record<string, any> = {}) : any {
  return text(input.backend) ||
    process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_PROVIDER ||
    process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER ||
    "auto";
}

function resolveAlias(input: Record<string, any> = {}) : any {
  return text(input.alias) ||
    process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_ALIAS ||
    process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_ALIAS ||
    DEFAULT_ALIAS;
}

function resolveBindingBackend(input: Record<string, any> = {}) : any {
  return text(input.backend) ||
    process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_PROVIDER ||
    process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER ||
    "auto";
}

function resolveBindingAlias(input: Record<string, any> = {}) : any {
  return text(input.alias) ||
    process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_ALIAS ||
    process.env.MESHRIX_CAPABILITY_BINDING_GUARD_ALIAS ||
    "meshrix-tool-bindings";
}

export async function describeCapabilityKernelStatus(input: Record<string, any> = {}) : Promise<any> {
  const dataDir: any = text(input.userDataPath || input.dataDir);
  const backend: any = resolveBackend(input);
  const alias: any = resolveAlias(input);
  const provider: any = createOpaqueCapabilityKeyProvider({ dataDir, backend, alias });
  try {
    const description: any = await provider.describe();
    const providerName: any = description.keySource?.provider || description.provider || backend;
    const securityMode: any = description.securityMode || description.keySource?.securityMode || "";
    const degraded: any = securityMode === "degraded_file_fallback";
    return {
      ok: true,
      protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
      status: degraded ? "degraded" : "healthy",
      tone: degraded ? "warning" : "success",
      alias: description.alias || alias,
      provider: providerName,
      configuredBackend: backend,
      securityMode,
      degraded,
      runtimeLookupLoaded: Boolean(description.runtimeLookupLoaded),
      runtimeLookupGeneration: Number(description.runtimeLookupGeneration || description.keySource?.generation || 0),
      bindingCount: Number(description.bindingCount || 0),
      permissionBindingCount: Number(description.permissionBindingCount || 0),
      stateRoot: description.stateRoot || "",
      statePath: providerName === "local-file" || securityMode === "degraded_file_fallback"
        ? capabilityKernelStatePath({ dataDir, alias })
        : "",
      linuxDetectedBackends: Array.isArray(description.linuxDetectedBackends) ? description.linuxDetectedBackends : [],
      recoverySupported: true,
      message: degraded
        ? "Capability Kernel is using file fallback; availability is preserved but this is not a hardened security boundary."
        : "Capability Kernel is available."
    };
  } catch (error: any) {
    return {
      ok: false,
      protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
      status: "error",
      tone: "danger",
      alias,
      provider: "",
      configuredBackend: backend,
      securityMode: "",
      degraded: false,
      runtimeLookupLoaded: false,
      runtimeLookupGeneration: 0,
      bindingCount: 0,
      permissionBindingCount: 0,
      stateRoot: "",
      statePath: "",
      linuxDetectedBackends: [],
      recoverySupported: false,
      message: error instanceof Error ? error.message : String(error)
    };
  } finally {
    provider.close?.();
  }
}

export async function describeCapabilityBindingGuardStatus(input: Record<string, any> = {}) : Promise<any> {
  const dataDir: any = text(input.userDataPath || input.dataDir);
  const backend: any = resolveBindingBackend(input);
  const alias: any = resolveBindingAlias(input);
  const guard: any = createCapabilityBindingGuard({ dataDir, backend, alias });
  try {
    const description: any = await guard.describe();
    const providerName: any = description.provider || backend;
    const securityMode: any = description.securityMode || "";
    const degraded: any = securityMode === "degraded_file_fallback";
    return {
      ok: true,
      protocolVersion: CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION,
      status: degraded ? "degraded" : "healthy",
      tone: degraded ? "warning" : "success",
      alias: description.alias || alias,
      provider: providerName,
      configuredBackend: backend,
      securityMode,
      degraded,
      bindingCount: Number(description.bindingCount || 0),
      activeBindingCount: Number(description.activeBindingCount || 0),
      stateRoot: description.stateRoot || "",
      statePath: providerName === "local-file" || securityMode === "degraded_file_fallback"
        ? capabilityBindingGuardStatePath({ dataDir, alias })
        : "",
      message: degraded
        ? "Capability Binding Guard is using file fallback; binding semantics are preserved but this is not a hardened security boundary."
        : "Capability Binding Guard is available."
    };
  } catch (error: any) {
    return {
      ok: false,
      protocolVersion: CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION,
      status: "error",
      tone: "danger",
      alias,
      provider: "",
      configuredBackend: backend,
      securityMode: "",
      degraded: false,
      bindingCount: 0,
      activeBindingCount: 0,
      stateRoot: "",
      statePath: "",
      message: error instanceof Error ? error.message : String(error)
    };
  } finally {
    guard.close?.();
  }
}
