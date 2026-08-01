#!/usr/bin/env node
import {
  CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION,
  createCapabilityBindingGuard
} from "../../packages/foundation/src/security/authorization/capability-binding-guard.ts";
import {
  CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION
} from "../../packages/foundation/src/security/authorization/capability-security-helper-client.ts";
import {
  OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
  createOpaqueCapabilityKeyProvider
} from "../../packages/foundation/src/security/authorization/opaque-capability-key.ts";

function text(value?: any) : any {
  return String(value || "").trim();
}

function bool(value?: any, fallback: any = false) : any {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return !/^(false|0|no)$/i.test(String(value));
}

async function readStdinJson() : Promise<any> {
  let raw: any = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString();
  }
  return raw.trim() ? JSON.parse(raw) : {};
}

function providerInput(input: Record<string, any> = {}) : any {
  return {
    backend: text(input.backend || input.capabilityBackend || "auto"),
    alias: text(input.alias || input.capabilityAlias || "meshrix-tool-grants"),
    dataDir: text(input.dataDir || "")
  };
}

function bindingInput(input: Record<string, any> = {}) : any {
  return {
    backend: text(input.bindingBackend || input.backend || "auto"),
    alias: text(input.bindingAlias || "meshrix-tool-bindings"),
    dataDir: text(input.dataDir || "")
  };
}

function createProvider(input: Record<string, any> = {}) : any {
  return createOpaqueCapabilityKeyProvider(providerInput(input));
}

function createGuard(input: Record<string, any> = {}) : any {
  return createCapabilityBindingGuard(bindingInput(input));
}

function capabilityDecision(decision: Record<string, any> = {}) : any {
  return {
    ok: decision.ok === true,
    reasonCode: text(decision.reasonCode),
    credentialId: text(decision.credentialId),
    missingCapabilities: Array.isArray(decision.missingCapabilities)
      ? decision.missingCapabilities.map(text).filter(Boolean)
      : [],
    runtimeLookupGeneration: Number(decision.runtimeLookupGeneration || 0)
  };
}

function bindingDecision(decision: Record<string, any> = {}) : any {
  return {
    ok: decision.ok === true,
    applicable: decision.applicable !== false,
    reasonCode: text(decision.reasonCode),
    credentialId: text(decision.credentialId),
    bindingId: text(decision.bindingId),
    bindingStrength: text(decision.bindingStrength),
    requireUser: decision.requireUser === true,
    requireAgent: decision.requireAgent === true,
    requireClient: decision.requireClient === true
  };
}

function issueResult(result: Record<string, any> = {}) : any {
  return {
    protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
    helperProtocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION,
    capabilityKey: text(result.capabilityKey),
    credentialId: text(result.credentialId),
    status: text(result.status),
    capabilitySetHash: text(result.capabilitySetHash),
    capabilityCount: Number(result.capabilityCount || 0),
    expiresAt: text(result.expiresAt),
    runtimeLookupGeneration: Number(result.runtimeLookupGeneration || 0)
  };
}

async function withProvider(input?: any, handler?: any) : Promise<any> {
  const provider: any = createProvider(input);
  try {
    return await handler(provider);
  } finally {
    provider.close?.();
  }
}

async function withGuard(input?: any, handler?: any) : Promise<any> {
  const guard: any = createGuard(input);
  try {
    return await handler(guard);
  } finally {
    guard.close?.();
  }
}

async function issueCapabilityKey(input: Record<string, any> = {}) : Promise<any> {
  return withProvider(input, async (provider?: any) : Promise<any> => issueResult(await provider.issue(input)));
}

async function verifyCapability(input: Record<string, any> = {}) : Promise<any> {
  return withProvider(input, async (provider?: any) : Promise<any> => ({
    protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION,
    ...capabilityDecision(await provider.verify(input))
  }));
}

async function bindCapabilityKey(input: Record<string, any> = {}) : Promise<any> {
  return withGuard(input, async (guard?: any) : Promise<any> => {
    const binding: any = await guard.bindCapabilityKey(input);
    return {
      ...binding,
      helperProtocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION,
      protocolVersion: binding.protocolVersion || CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION
    };
  });
}

async function verifyBinding(input: Record<string, any> = {}) : Promise<any> {
  return withGuard(input, async (guard?: any) : Promise<any> => ({
    protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION,
    ...bindingDecision(await guard.verifyCapabilityKeyBinding(input))
  }));
}

async function verifyCapabilityAndBinding(input: Record<string, any> = {}) : Promise<any> {
  const capability: any = await withProvider(input, async (provider?: any) : Promise<any> => capabilityDecision(await provider.verify(input)));
  if (!capability.ok) {
    return {
      protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION,
      ok: false,
      decision: "deny",
      reasonCode: capability.reasonCode,
      credentialId: capability.credentialId,
      capability
    };
  }
  const expectedCredentialId: any = text(input.credentialId);
  if (expectedCredentialId && capability.credentialId && capability.credentialId !== expectedCredentialId) {
    return {
      protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION,
      ok: false,
      decision: "deny",
      reasonCode: "credential_binding_mismatch",
      credentialId: capability.credentialId,
      capability
    };
  }
  const requireBinding: any = bool(input.requireBinding, true);
  const binding: any = await withGuard(input, async (guard?: any) : Promise<any> => bindingDecision(await guard.verifyCapabilityKeyBinding(input)));
  if (!binding.ok || (requireBinding && binding.applicable === false)) {
    return {
      protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION,
      ok: false,
      decision: "deny",
      reasonCode: binding.applicable === false ? "capability_binding_required" : binding.reasonCode,
      credentialId: capability.credentialId,
      capability,
      binding
    };
  }
  return {
    protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION,
    ok: true,
    decision: "allow",
    reasonCode: "capability_security_valid",
    credentialId: capability.credentialId,
    capability,
    binding
  };
}

async function invalidateCapabilityKey(input: Record<string, any> = {}) : Promise<any> {
  const invalidated: any = await withProvider(input, async (provider?: any) : Promise<any> => provider.invalidate(input));
  return {
    protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION,
    invalidated: invalidated ? 1 : 0
  };
}

async function invalidateCapabilityCredential(input: Record<string, any> = {}) : Promise<any> {
  const invalidated: any = await withProvider(input, async (provider?: any) : Promise<any> => provider.invalidateCredential(input));
  return {
    protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION,
    invalidated: Array.isArray(invalidated) ? invalidated.length : 0
  };
}

async function invalidateCapabilityBinding(input: Record<string, any> = {}) : Promise<any> {
  const invalidated: any = await withGuard(input, async (guard?: any) : Promise<any> => guard.invalidateCapabilityKeyBinding(input));
  return {
    protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION,
    invalidated: Array.isArray(invalidated) ? invalidated.length : 0
  };
}

async function invalidateCredential(input: Record<string, any> = {}) : Promise<any> {
  const capabilityInvalidated: any = await withProvider(input, async (provider?: any) : Promise<any> => provider.invalidateCredential(input));
  const bindingInvalidated: any = await withGuard(input, async (guard?: any) : Promise<any> => guard.invalidateCapabilityKeyBinding(input));
  return {
    protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION,
    capabilityInvalidated: Array.isArray(capabilityInvalidated) ? capabilityInvalidated.length : 0,
    bindingInvalidated: Array.isArray(bindingInvalidated) ? bindingInvalidated.length : 0
  };
}

async function describe(input: Record<string, any> = {}) : Promise<any> {
  const capabilityKernel: any = await withProvider(input, async (provider?: any) : Promise<any> => provider.describe());
  const capabilityBindingGuard: any = await withGuard(input, async (guard?: any) : Promise<any> => guard.describe());
  return {
    protocolVersion: CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION,
    capabilityKernel,
    capabilityBindingGuard
  };
}

async function handle(input: Record<string, any> = {}) : Promise<any> {
  if (input.protocolVersion !== CAPABILITY_SECURITY_HELPER_PROTOCOL_VERSION) {
    throw new Error("Unsupported capability security helper protocol version.");
  }
  const action: any = text(input.action);
  if (action === "issueCapabilityKey") return issueCapabilityKey(input);
  if (action === "verifyCapability") return verifyCapability(input);
  if (action === "bindCapabilityKey") return bindCapabilityKey(input);
  if (action === "verifyBinding") return verifyBinding(input);
  if (action === "verifyCapabilityAndBinding") return verifyCapabilityAndBinding(input);
  if (action === "invalidateCapabilityKey") return invalidateCapabilityKey(input);
  if (action === "invalidateCapabilityCredential") return invalidateCapabilityCredential(input);
  if (action === "invalidateCapabilityBinding") return invalidateCapabilityBinding(input);
  if (action === "invalidateCredential") return invalidateCredential(input);
  if (action === "describe") return describe(input);
  throw new Error(`Unsupported capability security helper action: ${action}`);
}

try {
  const input: any = await readStdinJson();
  const output: any = await handle(input);
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error: any) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
