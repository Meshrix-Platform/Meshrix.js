import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  capabilityBindingKeyHash,
  capabilityBindingSubjectHash,
  capabilityBindingGuardStatePath,
  createCapabilityBindingGuard,
  createMemoryCapabilityBindingGuard,
  normalizeCapabilityBindingContext
} from "../../../packages/foundation/src/security/authorization/capability-binding-guard.mjs";
import { createCapabilityKey } from "../../../packages/foundation/src/security/authorization/opaque-capability-key.mjs";

describe("capability binding guard boundary behavior", () => {
  it("persists local-file bindings through sealed state and sidecar sealing key", async () => {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lico-binding-guard-"));
    const alias = "unit/local file alias";
    const capabilityKey = createCapabilityKey();
    const guard = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir,
      alias
    });

    const bound = await guard.bindCapabilityKey({
      key: capabilityKey,
      credentialId: "local-credential",
      ttlMs: 5000,
      context: {
        namespace: "operation-permission",
        userId: "local-user"
      }
    });

    expect(bound).toMatchObject({
      credentialId: "local-credential",
      bindingStrength: "user",
      requireUser: true,
      requireAgent: false,
      requireClient: false
    });

    const description = await guard.describe();
    expect(description).toMatchObject({
      provider: "local-file",
      securityMode: "degraded_file_fallback",
      degraded: true,
      bindingCount: 1,
      activeBindingCount: 1
    });
    expect(description.statePath).toBe(capabilityBindingGuardStatePath({ dataDir, alias }));

    const statePath = capabilityBindingGuardStatePath({ dataDir, alias });
    const keyPath = statePath.replace(/\.sealed\.json$/, ".sealing-key");
    const persisted = JSON.parse(await fs.promises.readFile(statePath, "utf8"));
    expect(persisted).toMatchObject({
      protocolVersion: "v0.0.1:risk-control:capability-binding-guard-1",
      alias: "unit_local_file_alias",
      provider: "local-file"
    });
    expect(persisted.sealingKeyBase64).toBeUndefined();
    expect((await fs.promises.readFile(keyPath, "utf8")).trim()).toHaveLength(44);

    const reloadedGuard = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir,
      alias
    });
    await expect(reloadedGuard.verifyCapabilityKeyBinding({
      capabilityKey,
      credentialId: "local-credential",
      context: {
        namespace: "operation-permission",
        userId: "local-user"
      }
    })).resolves.toMatchObject({
      ok: true,
      applicable: true,
      credentialId: "local-credential",
      bindingStrength: "user"
    });
  });

  it("reports user, agent and client binding mismatch reasons", async () => {
    const guard = createMemoryCapabilityBindingGuard({ alias: "unit-binding-mismatch-extra" });
    const capabilityKey = createCapabilityKey();
    await guard.bindCapabilityKey({
      capabilityKey,
      credentialId: "mismatch-credential",
      context: {
        namespace: "operation-permission",
        userId: "expected-user",
        agentId: "expected-agent",
        clientId: "expected-client"
      }
    });

    const base = {
      capabilityKey,
      credentialId: "mismatch-credential"
    };

    await expect(guard.verifyCapabilityKeyBinding({
      ...base,
      context: { namespace: "operation-permission", agentId: "expected-agent", clientId: "expected-client" }
    })).resolves.toMatchObject({ ok: false, reasonCode: "binding_user_missing" });

    await expect(guard.verifyCapabilityKeyBinding({
      ...base,
      context: {
        namespace: "operation-permission",
        userId: "wrong-user",
        agentId: "expected-agent",
        clientId: "expected-client"
      }
    })).resolves.toMatchObject({ ok: false, reasonCode: "binding_user_mismatch" });

    await expect(guard.verifyCapabilityKeyBinding({
      ...base,
      context: { namespace: "operation-permission", userId: "expected-user", clientId: "expected-client" }
    })).resolves.toMatchObject({ ok: false, reasonCode: "binding_agent_missing" });

    await expect(guard.verifyCapabilityKeyBinding({
      ...base,
      context: {
        namespace: "operation-permission",
        userId: "expected-user",
        agentId: "wrong-agent",
        clientId: "expected-client"
      }
    })).resolves.toMatchObject({ ok: false, reasonCode: "binding_agent_mismatch" });

    await expect(guard.verifyCapabilityKeyBinding({
      ...base,
      context: { namespace: "operation-permission", userId: "expected-user", agentId: "expected-agent" }
    })).resolves.toMatchObject({ ok: false, reasonCode: "binding_client_missing" });

    await expect(guard.verifyCapabilityKeyBinding({
      ...base,
      context: {
        namespace: "operation-permission",
        userId: "expected-user",
        agentId: "expected-agent",
        clientId: "wrong-client"
      }
    })).resolves.toMatchObject({ ok: false, reasonCode: "binding_client_mismatch" });
  });

  it("exports and imports encrypted recovery packages", async () => {
    const sourceGuard = createMemoryCapabilityBindingGuard({ alias: "unit-binding-recovery-source" });
    const importedGuard = createMemoryCapabilityBindingGuard({ alias: "unit-binding-recovery-import" });
    const capabilityKey = createCapabilityKey();

    await sourceGuard.bindCapabilityKey({
      key: capabilityKey,
      credentialId: "recovery-credential",
      context: {
        namespace: "operation-permission",
        userId: "recovery-user"
      }
    });

    await expect(sourceGuard.exportRecoveryPackage()).rejects.toThrow("requires a passphrase");
    const recoveryPackage = await sourceGuard.exportRecoveryPackage({
      passphrase: "correct horse battery staple",
      reason: "unit test"
    });
    expect(recoveryPackage).toMatchObject({
      protocolVersion: "v0.0.1:risk-control:capability-binding-guard-recovery-1",
      alias: "unit-binding-recovery-source",
      kdf: { name: "scrypt" }
    });
    expect(recoveryPackage.sealedRecovery.ciphertextBase64).toEqual(expect.any(String));

    await expect(importedGuard.importRecoveryPackage({
      recoveryPackage: { protocolVersion: "unsupported" },
      passphrase: "correct horse battery staple"
    })).rejects.toThrow("Unsupported capability binding guard recovery package");

    await expect(importedGuard.importRecoveryPackage({
      recoveryPackage,
      passphrase: "wrong passphrase"
    })).rejects.toThrow();

    await expect(importedGuard.importRecoveryPackage({
      recoveryPackage,
      passphrase: "correct horse battery staple"
    })).resolves.toMatchObject({
      ok: true,
      provider: "memory",
      securityMode: "memory"
    });

    await expect(importedGuard.verifyCapabilityKeyBinding({
      capabilityKey,
      credentialId: "recovery-credential",
      context: {
        namespace: "operation-permission",
        userId: "recovery-user"
      }
    })).resolves.toMatchObject({
      ok: true,
      applicable: true,
      credentialId: "recovery-credential"
    });
  });

  it("returns deterministic deny/error paths for missing inputs and unregistered bindings", async () => {
    const guard = createMemoryCapabilityBindingGuard({ alias: "unit-binding-boundary-inputs" });

    await expect(guard.bindCapabilityKey({
      credentialId: "missing-capability-key"
    })).rejects.toThrow("Capability binding guard requires an opaque capability key.");

    await expect(guard.verifyCapabilityKeyBinding({
      context: {
        namespace: "operation-permission"
      }
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: "capability_key_missing"
    });

    const unregistered = await guard.verifyCapabilityKeyBinding({
      capabilityKey: createCapabilityKey(),
      context: {
        namespace: "operation-permission"
      }
    });
    expect(unregistered).toMatchObject({
      ok: true,
      applicable: false,
      reasonCode: "capability_binding_not_registered"
    });
  });

  it("enforces namespace boundaries and supports default namespace binding context", async () => {
    const guard = createMemoryCapabilityBindingGuard({ alias: "unit-binding-namespace-extra" });

    const namedSpaceKey = createCapabilityKey();
    await guard.bindCapabilityKey({
      key: namedSpaceKey,
      credentialId: "tenant-bound-credential",
      context: {
        namespace: "tenant-east"
      }
    });
    const tenantMismatch = await guard.verifyCapabilityKeyBinding({
      capabilityKey: namedSpaceKey,
      context: {
        namespace: "tenant-west"
      }
    });
    expect(tenantMismatch).toMatchObject({
      ok: false,
      reasonCode: "binding_namespace_mismatch"
    });

    const tenantMatch = await guard.verifyCapabilityKeyBinding({
      capabilityKey: namedSpaceKey,
      context: {
        namespace: "tenant-east"
      }
    });
    expect(tenantMatch).toMatchObject({
      ok: true,
      applicable: true,
      bindingStrength: "namespace"
    });

    const defaultNamespaceKey = createCapabilityKey();
    await guard.bindCapabilityKey({
      key: defaultNamespaceKey,
      credentialId: "default-namespace-credential"
    });
    const defaultNamespaceDecision = await guard.verifyCapabilityKeyBinding({
      capabilityKey: defaultNamespaceKey
    });
    expect(defaultNamespaceDecision).toMatchObject({
      ok: true,
      applicable: true,
      bindingStrength: "namespace"
    });
    expect(defaultNamespaceDecision.bindingId).toBeTruthy();
  });

  it("treats bindings as expired exactly at boundary time and records invalidation events", async () => {
    const guard = createMemoryCapabilityBindingGuard({ alias: "unit-binding-boundary-expiry" });
    const expiredAt = "2000-01-01T00:00:00.000Z";
    const expiredKey = createCapabilityKey();

    await guard.bindCapabilityKey({
      key: expiredKey,
      credentialId: "expired-credential",
      context: {
        namespace: "operation-permission",
        userId: "expiry-user"
      },
      expiresAt: expiredAt
    });

    const expiredNow = await guard.verifyCapabilityKeyBinding({
      capabilityKey: expiredKey,
      credentialId: "expired-credential",
      context: {
        namespace: "operation-permission",
        userId: "expiry-user"
      },
      now: expiredAt
    });
    expect(expiredNow).toMatchObject({
      ok: false,
      reasonCode: "binding_expired"
    });

    const invalidated = await guard.invalidateCapabilityKeyBinding({
      capabilityKey: expiredKey,
      credentialId: "expired-credential",
      reason: "policy-rotation"
    });
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0]).toMatchObject({
      status: "invalid",
      invalidationReason: "policy-rotation",
      credentialId: "expired-credential"
    });

    const invalidDecision = await guard.verifyCapabilityKeyBinding({
      capabilityKey: expiredKey,
      credentialId: "expired-credential",
      context: {
        namespace: "operation-permission",
        userId: "expiry-user"
      }
    });
    expect(invalidDecision).toMatchObject({
      ok: false,
      reasonCode: "binding_invalid"
    });
  });

  it("atomically replaces every valid binding for a reissued credential", async () => {
    const guard = createMemoryCapabilityBindingGuard({ alias: "unit-binding-credential-replacement" });
    const originalKey = createCapabilityKey();
    const replacementKey = createCapabilityKey();
    const context = {
      namespace: "operation-permission",
      userId: "replacement-user"
    };

    await guard.bindCapabilityKey({
      capabilityKey: originalKey,
      credentialId: "replacement-credential",
      context
    });
    const replacement = await guard.bindCapabilityKey({
      capabilityKey: replacementKey,
      credentialId: "replacement-credential",
      context,
      replaceCredential: true,
      replacementReason: "coverage-reissue"
    });

    expect(replacement.replacedBindingCount).toBe(1);
    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey: originalKey,
      credentialId: "replacement-credential",
      context
    })).resolves.toMatchObject({ ok: false, reasonCode: "binding_invalid" });
    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey: replacementKey,
      credentialId: "replacement-credential",
      context
    })).resolves.toMatchObject({ ok: true, applicable: true });
  });

  it("supports environment defaults for missing options and sanitizes alias-based persistence fields", async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lico-binding-guard-env-"));
    const oldBackend = process.env.LICO_CAPABILITY_BINDING_GUARD_PROVIDER;
    const oldAlias = process.env.LICO_CAPABILITY_BINDING_GUARD_ALIAS;
    const oldDataDir = process.env.LICO_CAPABILITY_BINDING_GUARD_DATA_DIR;
    const restore = () => {
      if (oldBackend === undefined) {
        delete process.env.LICO_CAPABILITY_BINDING_GUARD_PROVIDER;
      } else {
        process.env.LICO_CAPABILITY_BINDING_GUARD_PROVIDER = oldBackend;
      }
      if (oldAlias === undefined) {
        delete process.env.LICO_CAPABILITY_BINDING_GUARD_ALIAS;
      } else {
        process.env.LICO_CAPABILITY_BINDING_GUARD_ALIAS = oldAlias;
      }
      if (oldDataDir === undefined) {
        delete process.env.LICO_CAPABILITY_BINDING_GUARD_DATA_DIR;
      } else {
        process.env.LICO_CAPABILITY_BINDING_GUARD_DATA_DIR = oldDataDir;
      }
    };

    try {
      process.env.LICO_CAPABILITY_BINDING_GUARD_PROVIDER = "local-file";
      process.env.LICO_CAPABILITY_BINDING_GUARD_ALIAS = "unit env alias";
      process.env.LICO_CAPABILITY_BINDING_GUARD_DATA_DIR = tempDir;

      const guard = createCapabilityBindingGuard({});
      const capabilityKey = createCapabilityKey();

      const bound = await guard.bindCapabilityKey({
        key: capabilityKey,
        credentialId: "env-default-credential"
      });

      const description = await guard.describe();
      const statePath = capabilityBindingGuardStatePath({
        dataDir: tempDir,
        alias: "unit env alias"
      });

      expect(bound).toMatchObject({
        credentialId: "env-default-credential",
        bindingStrength: "namespace"
      });
      expect(description).toMatchObject({
        provider: "local-file",
        alias: "unit_env_alias",
        bindingCount: 1
      });
      expect(statePath).toContain("unit_env_alias");

      const onDisk = JSON.parse(await fs.promises.readFile(statePath, "utf8"));
      expect(onDisk.provider).toBe("local-file");
    } finally {
      restore();
    }
  });

  it("normalizes context fields and guards hash inputs in boundary cases", () => {
    expect(normalizeCapabilityBindingContext({
      bound_user_id: "user-bound",
      agentId: "agent-bound",
      client_name: "client-bound",
      namespace: "namespace-bound"
    })).toMatchObject({
      namespace: "namespace-bound",
      userId: "user-bound",
      agentId: "agent-bound",
      clientId: "client-bound"
    });

    const fallback = normalizeCapabilityBindingContext({});
    expect(fallback.namespace).toBe("operation-permission");

    expect(() => {
      capabilityBindingKeyHash(Buffer.from([0x01, 0x02, 0x03]), "x");
    }).toThrow("Capability binding guard requires a 256-bit lookup key.");
    expect(() => {
      capabilityBindingSubjectHash(Buffer.from([0x01, 0x02, 0x03]), "namespace", "value");
    }).toThrow("Capability binding guard requires a 256-bit lookup key.");

    expect(capabilityBindingSubjectHash(Buffer.alloc(32, 7), "namespace", "").length).toBeGreaterThan(0);
    expect(capabilityBindingKeyHash(Buffer.alloc(32, 8), createCapabilityKey())).toBeTruthy();
  });

  it("rejects local-file records that do not contain the current sealed state", async () => {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lico-binding-guard-invalid-seal-"));
    const alias = "unit-local-invalid-seal";
    const statePath = capabilityBindingGuardStatePath({ dataDir, alias });
    const keyPath = statePath.replace(/\.sealed\.json$/, ".sealing-key");

    await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
    await fs.promises.writeFile(statePath, JSON.stringify({
      protocolVersion: "v0.0.1:risk-control:capability-binding-guard-1",
      provider: "local-file",
      securityMode: "degraded_file_fallback",
      stateRoot: "invalid-root"
    }, null, 2));
    await fs.promises.writeFile(keyPath, `${Buffer.alloc(32, 7).toString("base64")}\n`);
    const guard = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir,
      alias
    });

    await expect(guard.describe()).rejects.toThrow("Unsupported capability binding guard sealed state payload.");
  });

  it("writes recovery package into local-file stores during import", async () => {
    const memorySource = createMemoryCapabilityBindingGuard({ alias: "unit-binding-recovery-src-local" });
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lico-binding-guard-recover-local-"));
    const localImport = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir,
      alias: "unit-binding-recovery-local"
    });
    const key = createCapabilityKey();

    await memorySource.bindCapabilityKey({
      key,
      credentialId: "recovery-source",
      context: {
        namespace: "operation-permission",
        userId: "recovery-user"
      }
    });
    const pkg = await memorySource.exportRecoveryPackage({
      passphrase: "recovery-passphrase",
      reason: "boundary recovery test"
    });

    await expect(localImport.importRecoveryPackage({
      recoveryPackage: { ...pkg, stateRoot: "" },
      passphrase: "recovery-passphrase"
    })).rejects.toThrow("Capability binding guard recovery state root mismatch.");

    const imported = await localImport.importRecoveryPackage({
      recoveryPackage: pkg,
      passphrase: "recovery-passphrase"
    });

    expect(imported).toMatchObject({
      ok: true,
      provider: "local-file",
      securityMode: "degraded_file_fallback"
    });

    const verify = await localImport.verifyCapabilityKeyBinding({
      capabilityKey: key,
      credentialId: "recovery-source",
      context: {
        namespace: "operation-permission",
        userId: "recovery-user"
      }
    });
    expect(verify).toMatchObject({
      ok: true,
      applicable: true
    });

    const reloaded = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir,
      alias: "unit-binding-recovery-local"
    });
    await expect(reloaded.verifyCapabilityKeyBinding({
      capabilityKey: key,
      credentialId: "recovery-source",
      context: {
        namespace: "operation-permission",
        userId: "recovery-user"
      }
    })).resolves.toMatchObject({
      ok: true,
      applicable: true
    });
  });

  it("treats repeated invalidation of already-invalid bindings as no-op", async () => {
    const guard = createMemoryCapabilityBindingGuard({ alias: "unit-binding-double-invalidate" });
    const key = createCapabilityKey();
    await guard.bindCapabilityKey({
      key,
      credentialId: "double-invalidate",
      context: {
        namespace: "operation-permission",
        userId: "double-user"
      }
    });

    const first = await guard.invalidateCapabilityKeyBinding({
      capabilityKey: key,
      credentialId: "double-invalidate"
    });
    const second = await guard.invalidateCapabilityKeyBinding({
      capabilityKey: key,
      credentialId: "double-invalidate"
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("serializes concurrent mutations before loading state", async () => {
    const guard = createMemoryCapabilityBindingGuard({ alias: "unit-binding-queue" });
    const key1 = createCapabilityKey();
    const key2 = createCapabilityKey();

    const bindFirst = guard.bindCapabilityKey({
      key: key1,
      credentialId: "queue-first",
      context: {
        namespace: "operation-permission",
        userId: "queue-user-1"
      }
    });
    const bindSecond = guard.bindCapabilityKey({
      key: key2,
      credentialId: "queue-second",
      context: {
        namespace: "operation-permission",
        userId: "queue-user-2"
      }
    });

    const [first, second] = await Promise.all([bindFirst, bindSecond]);

    expect(first.bindingId).toBeTruthy();
    expect(second.bindingId).toBeTruthy();

    const invalid = await guard.invalidateCapabilityKeyBinding({
      capabilityKey: key1,
      credentialId: "queue-first"
    });
    expect(invalid).toHaveLength(1);
  });

  it("waits for in-flight state loads before applying file-backed mutations", async () => {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lico-binding-guard-load-"));
    const alias = "unit-binding-await-load";
    const bootstrap = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir,
      alias
    });
    const seedKey = createCapabilityKey();

    await bootstrap.bindCapabilityKey({
      key: seedKey,
      credentialId: "seed-credential",
      context: {
        namespace: "operation-permission",
        userId: "seed-user"
      }
    });

    const guard = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir,
      alias
    });

    const statePath = capabilityBindingGuardStatePath({ dataDir, alias });
    const originalReadFile = fs.promises.readFile.bind(fs.promises);
    let delayedReads = 0;
    let releaseReads;
    const blockReads = new Promise((resolve) => {
      releaseReads = resolve;
    });

    const readFileSpy = vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args) => {
      const filePath = String(args[0] || "");
      if (filePath.endsWith(".sealed.json")) {
        delayedReads += 1;
        await blockReads;
      }
      return originalReadFile(...args);
    });

    try {
      const loading = guard.describe();
      const binding = guard.bindCapabilityKey({
        key: createCapabilityKey(),
        credentialId: "concurrent-credential",
        context: {
          namespace: "operation-permission",
          userId: "concurrent-user"
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(delayedReads).toBeGreaterThanOrEqual(1);

      releaseReads();
      const [description, bound] = await Promise.all([loading, binding]);

      expect(description.provider).toBe("local-file");
      expect(bound.bindingStrength).toBe("user");

      const verify = await guard.verifyCapabilityKeyBinding({
        capabilityKey: seedKey,
        credentialId: "seed-credential",
        context: {
          namespace: "operation-permission",
          userId: "seed-user"
        }
      });
      expect(verify).toMatchObject({
        ok: true,
        applicable: true
      });
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("rejects a local-file record whose state root does not match the current sealed state", async () => {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lico-binding-guard-invalid-root-"));
    const alias = "unit-local-file-invalid-root";
    const statePath = capabilityBindingGuardStatePath({ dataDir, alias });
    const bootstrap = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir,
      alias
    });
    await bootstrap.bindCapabilityKey({
      key: createCapabilityKey(),
      credentialId: "root-mismatch-credential",
      context: {
        namespace: "operation-permission",
        userId: "root-mismatch-user"
      }
    });

    const persisted = JSON.parse(await fs.promises.readFile(statePath, "utf8"));
    persisted.stateRoot = "invalid-current-root";
    await fs.promises.writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`);

    const guard = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir,
      alias
    });
    await expect(guard.describe()).rejects.toThrow("Capability binding guard sealed state root mismatch.");
  });

  it("falls back to local-file storage when pass-gpg write fails in auto backend flow", async () => {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lico-binding-guard-passgpg-"));
    const alias = "unit-binding-passgpg-fallback";
    const bootstrap = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir,
      alias
    });

    const existingKey = createCapabilityKey();
    await bootstrap.bindCapabilityKey({
      key: existingKey,
      credentialId: "passgpg-bootstrap",
      context: {
        namespace: "operation-permission"
      }
    });

    const statePath = capabilityBindingGuardStatePath({ dataDir, alias });

    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux" });

    try {
      const guard = createCapabilityBindingGuard({
        backend: "auto",
        dataDir,
        alias
      });
      const key = createCapabilityKey();

      const bound = await guard.bindCapabilityKey({
        key,
        credentialId: "passgpg-fallback-bound",
        context: {
          namespace: "operation-permission",
          userId: "passgpg-user"
        }
      });

      const description = await guard.describe();
      expect(bound.bindingStrength).toBe("user");
      expect(description.provider).toBe("local-file");

      const restored = JSON.parse(await fs.promises.readFile(statePath, "utf8"));
      expect(restored.provider).toBe("local-file");
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      } else {
        Object.defineProperty(process, "platform", {
          value: "darwin",
          configurable: true,
          writable: false
        });
      }
    }
  });

});
