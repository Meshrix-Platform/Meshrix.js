import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  capabilityBindingGuardStatePath,
  capabilityBindingKeyHash,
  capabilityBindingSubjectHash,
  createCapabilityBindingGuard,
  createMemoryCapabilityBindingGuard,
  normalizeCapabilityBindingContext
} from "../../../packages/foundation/src/security/authorization/capability-binding-guard.mjs";
import { createCapabilityKey } from "../../../packages/foundation/src/security/authorization/opaque-capability-key.mjs";

const tempRoots = [];

async function tempDir(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("authorization capability binding guard boundary behavior", () => {
  it("normalizes context aliases and hashes consistently across string and buffer lookup keys", () => {
    const normalized = normalizeCapabilityBindingContext({
      binding_namespace: "tenant-east",
      bound_user_id: "user-1",
      agent_profile_id: "agent-1",
      client_name: "client-1"
    });

    expect(normalized).toMatchObject({
      namespace: "tenant-east",
      userId: "user-1",
      boundUserId: "user-1",
      agentId: "agent-1",
      agentProfileId: "agent-1",
      clientId: "client-1"
    });
    expect(normalizeCapabilityBindingContext(null)).toMatchObject({
      namespace: "operation-permission",
      userId: "",
      agentId: "",
      clientId: ""
    });

    const lookupKey = Buffer.alloc(32, 23);
    const lookupKeyBase64 = lookupKey.toString("base64");
    expect(capabilityBindingKeyHash(lookupKey, "cap-key")).toBe(capabilityBindingKeyHash(lookupKeyBase64, "cap-key"));
    expect(capabilityBindingSubjectHash(lookupKey, "namespace", "tenant-east"))
      .toBe(capabilityBindingSubjectHash(lookupKeyBase64, "namespace", "tenant-east"));

    expect(() => capabilityBindingKeyHash(Buffer.alloc(31), "cap-key"))
      .toThrow("Capability binding guard requires a 256-bit lookup key.");
    expect(() => capabilityBindingSubjectHash(Buffer.alloc(31), "namespace", "tenant-east"))
      .toThrow("Capability binding guard requires a 256-bit lookup key.");

    expect(capabilityBindingGuardStatePath({
      dataDir: "/tmp/unit data",
      alias: "guard alias with spaces"
    })).toContain("guard_alias_with_spaces.sealed.json");
  });

  it("binds from aliased context fields, verifies wildcard-free matches, and leaves no-op invalidations untouched", async () => {
    const dataDir = await tempDir("meshrix-binding-guard-extra-");
    const guard = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir,
      alias: "authorization guard extra"
    });
    const capabilityKey = createCapabilityKey();

    const bound = await guard.bindCapabilityKey({
      capabilityKey,
      credentialId: "bound-credential",
      context: {
        binding_namespace: "tenant-west",
        bound_user_id: "user-1",
        agent_profile_id: "agent-1",
        client_name: "client-1"
      }
    });
    expect(bound).toMatchObject({
      credentialId: "bound-credential",
      bindingStrength: "user+agent+client",
      requireUser: true,
      requireAgent: true,
      requireClient: true
    });

    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey,
      credentialId: "bound-credential",
      context: {
        namespace: "tenant-west",
        userId: "user-1",
        agentId: "agent-1",
        clientId: "client-1"
      }
    })).resolves.toMatchObject({
      ok: true,
      applicable: true,
      credentialId: "bound-credential",
      bindingStrength: "user+agent+client"
    });

    await expect(guard.verifyCapabilityKeyBinding({})).resolves.toMatchObject({
      ok: false,
      reasonCode: "capability_key_missing"
    });

    await expect(guard.invalidateCapabilityKeyBinding({
      capabilityKey: createCapabilityKey(),
      credentialId: "missing-credential",
      reason: "not-found"
    })).resolves.toEqual([]);

    const description = await guard.describe();
    expect(description).toMatchObject({
      provider: "local-file",
      degraded: true,
      bindingCount: 1,
      activeBindingCount: 1
    });
    expect(description.statePath).toBe(capabilityBindingGuardStatePath({
      dataDir,
      alias: "authorization guard extra"
    }));
  });

  it("supports memory guards with default namespace bindings and leaves alias sanitization intact", async () => {
    const guard = createMemoryCapabilityBindingGuard({
      alias: "memory guard extra"
    });

    const capabilityKey = createCapabilityKey();
    const bound = await guard.bindCapabilityKey({
      capabilityKey,
      credentialId: "memory-credential"
    });
    expect(bound).toMatchObject({
      credentialId: "memory-credential",
      bindingStrength: "namespace",
      requireUser: false,
      requireAgent: false,
      requireClient: false
    });

    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey,
      context: {
        namespace: "operation-permission"
      }
    })).resolves.toMatchObject({
      ok: true,
      applicable: true,
      bindingStrength: "namespace"
    });

    const description = await guard.describe();
    expect(description).toMatchObject({
      provider: "memory",
      securityMode: "memory",
      alias: "memory_guard_extra",
      degraded: false
    });
    expect(description.statePath).toBe("");
  });
});
