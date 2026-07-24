import {
  capabilityKernelStatePath,
  createOpaqueCapabilityKeyProvider,
  OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION
} from "./opaque-capability-key.mjs";
import {
  capabilityBindingGuardStatePath,
  createCapabilityBindingGuard,
  CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION
} from "./capability-binding-guard.mjs";

const DEFAULT_ALIAS = "meshrix-tool-grants";

function text(value) {
  return String(value || "").trim();
}

function resolveBackend(input = {}) {
  return text(input.backend) ||
    process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_PROVIDER ||
    process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_PROVIDER ||
    "auto";
}

function resolveAlias(input = {}) {
  return text(input.alias) ||
    process.env.MESHRIX_TOOL_GRANT_CAPABILITY_KEY_ALIAS ||
    process.env.MESHRIX_OPAQUE_CAPABILITY_KEY_ALIAS ||
    DEFAULT_ALIAS;
}

function resolveBindingBackend(input = {}) {
  return text(input.backend) ||
    process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_PROVIDER ||
    process.env.MESHRIX_CAPABILITY_BINDING_GUARD_PROVIDER ||
    "auto";
}

function resolveBindingAlias(input = {}) {
  return text(input.alias) ||
    process.env.MESHRIX_TOOL_GRANT_BINDING_GUARD_ALIAS ||
    process.env.MESHRIX_CAPABILITY_BINDING_GUARD_ALIAS ||
    "meshrix-tool-bindings";
}

export async function describeCapabilityKernelStatus(input = {}) {
  const dataDir = text(input.userDataPath || input.dataDir);
  const backend = resolveBackend(input);
  const alias = resolveAlias(input);
  const provider = createOpaqueCapabilityKeyProvider({ dataDir, backend, alias });
  try {
    const description = await provider.describe();
    const providerName = description.keySource?.provider || description.provider || backend;
    const securityMode = description.securityMode || description.keySource?.securityMode || "";
    const degraded = securityMode === "degraded_file_fallback";
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
  } catch (error) {
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

export async function describeCapabilityBindingGuardStatus(input = {}) {
  const dataDir = text(input.userDataPath || input.dataDir);
  const backend = resolveBindingBackend(input);
  const alias = resolveBindingAlias(input);
  const guard = createCapabilityBindingGuard({ dataDir, backend, alias });
  try {
    const description = await guard.describe();
    const providerName = description.provider || backend;
    const securityMode = description.securityMode || "";
    const degraded = securityMode === "degraded_file_fallback";
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
  } catch (error) {
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
