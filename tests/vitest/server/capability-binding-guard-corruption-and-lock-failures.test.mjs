import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
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
import {
  capabilityBindingGuardLocalSealingKeyPath
} from "../../../packages/foundation/src/security/authorization/capability-binding-guard-core.mjs";

const tempRoots = [];

async function tempDir(prefix) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe("capability binding guard behavior", () => {
  it("migrates the exact legacy empty local-file record during describe and keeps the state stable after restart", async () => {
    const dataDir = await tempDir("lico-cap-binding-bad-json-");
    const alias = "bad json alias";
    const statePath = capabilityBindingGuardStatePath({ dataDir, alias });
    const sealingKeyPath = capabilityBindingGuardLocalSealingKeyPath({ dataDir, alias });
    const legacySealingKey = Buffer.alloc(32, 7).toString("base64");

    await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
    await fs.promises.writeFile(statePath, `${JSON.stringify({
      protocolVersion: "v0.0.1:risk-control:capability-binding-guard-1",
      alias,
      provider: "local-file",
      securityMode: "degraded_file_fallback",
      generation: 1,
      sealingKeyBase64: legacySealingKey,
      sealedState: null
    }, null, 2)}\n`);

    const guard = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir,
      alias
    });

    const description = await guard.describe();
    expect(description).toMatchObject({
      protocolVersion: "v0.0.1:risk-control:capability-binding-guard-1",
      provider: "local-file",
      securityMode: "degraded_file_fallback",
      alias: "bad_json_alias",
      degraded: true,
      statePath
    });
    expect(description.bindingCount).toBe(0);
    expect(description.activeBindingCount).toBe(0);

    const migrated = JSON.parse(await fs.promises.readFile(statePath, "utf8"));
    expect(migrated).toMatchObject({
      protocolVersion: "v0.0.1:risk-control:capability-binding-guard-1",
      alias: "bad_json_alias",
      provider: "local-file",
      securityMode: "degraded_file_fallback",
      generation: 1,
      stateRoot: description.stateRoot
    });
    expect(migrated.sealedState).toBeTruthy();
    expect(migrated.sealingKeyBase64).toBeUndefined();
    expect((await fs.promises.readFile(sealingKeyPath, "utf8")).trim()).toBe(legacySealingKey);

    const restarted = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir,
      alias
    });
    await expect(restarted.describe()).resolves.toMatchObject({
      stateRoot: description.stateRoot,
      bindingCount: 0,
      activeBindingCount: 0
    });

    const bound = await guard.bindCapabilityKey({
      key: "bad-json-capability-key",
      credentialId: "bad-json-credential",
      context: {
        namespace: "operation-permission",
        userId: "bad-json-user"
      }
    });
    expect(bound).toMatchObject({
      credentialId: "bad-json-credential",
      bindingStrength: "user",
      requireUser: true,
      requireAgent: false,
      requireClient: false
    });

    await expect(guard.verifyCapabilityKeyBinding({
      capabilityKey: "bad-json-capability-key",
      credentialId: "bad-json-credential",
      context: {
        namespace: "operation-permission",
        userId: "bad-json-user"
      }
    })).resolves.toMatchObject({
      ok: true,
      applicable: true,
      credentialId: "bad-json-credential"
    });

    const persisted = JSON.parse(await fs.promises.readFile(statePath, "utf8"));
    expect(persisted).toMatchObject({
      protocolVersion: "v0.0.1:risk-control:capability-binding-guard-1",
      alias: "bad_json_alias",
      provider: "local-file"
    });
    expect(persisted.sealedState).toBeTruthy();
    expect(persisted.sealingKeyBase64).toBeUndefined();
  });

  it.each([
    ["unsupported protocol", { protocolVersion: "unsupported" }],
    ["wrong alias", { alias: "other-alias" }],
    ["wrong provider", { provider: "memory" }],
    ["wrong security mode", { securityMode: "memory" }],
    ["non-initial generation", { generation: 2 }],
    ["blank state root property", { stateRoot: "" }],
    ["null state root property", { stateRoot: null }],
    ["invalid embedded sealing key", { sealingKeyBase64: Buffer.alloc(31, 9).toString("base64") }],
    ["missing sealed state property", { sealedState: undefined }]
  ])("rejects a near-legacy local-file record with %s", async (_label, overrides) => {
    const dataDir = await tempDir("lico-cap-binding-near-legacy-");
    const alias = "near legacy alias";
    const statePath = capabilityBindingGuardStatePath({ dataDir, alias });
    const record = {
      protocolVersion: "v0.0.1:risk-control:capability-binding-guard-1",
      alias,
      provider: "local-file",
      securityMode: "degraded_file_fallback",
      generation: 1,
      sealingKeyBase64: Buffer.alloc(32, 11).toString("base64"),
      sealedState: null,
      ...overrides
    };
    if (record.sealedState === undefined) {
      delete record.sealedState;
    }
    await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
    await fs.promises.writeFile(statePath, `${JSON.stringify(record, null, 2)}\n`);

    const guard = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir,
      alias
    });
    await expect(guard.describe()).rejects.toThrow();
  });

  it("rejects an otherwise legacy-shaped record when the current sealing-key sidecar exists", async () => {
    const dataDir = await tempDir("lico-cap-binding-sidecar-present-");
    const alias = "sidecar present alias";
    const statePath = capabilityBindingGuardStatePath({ dataDir, alias });
    const sealingKeyPath = capabilityBindingGuardLocalSealingKeyPath({ dataDir, alias });
    const sealingKey = Buffer.alloc(32, 13).toString("base64");
    await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
    await fs.promises.writeFile(statePath, `${JSON.stringify({
      protocolVersion: "v0.0.1:risk-control:capability-binding-guard-1",
      alias,
      provider: "local-file",
      securityMode: "degraded_file_fallback",
      generation: 1,
      sealingKeyBase64: sealingKey,
      sealedState: null
    }, null, 2)}\n`);
    await fs.promises.writeFile(sealingKeyPath, `${sealingKey}\n`);

    const guard = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir,
      alias
    });
    await expect(guard.describe()).rejects.toThrow(
      "Capability binding guard record requires the current state root."
    );
  });

  it("covers subject hash boundaries and invalidate by key or credential with empty and hit results", async () => {
    const lookupKey = Buffer.alloc(32, 19);
    const lookupKeyBase64 = lookupKey.toString("base64");

    expect(normalizeCapabilityBindingContext({
      subject_id: "subject-user",
      profile_id: "subject-agent",
      client_name: "subject-client",
      binding_namespace: "tenant-a"
    })).toMatchObject({
      namespace: "tenant-a",
      userId: "subject-user",
      agentId: "subject-agent",
      clientId: "subject-client"
    });
    expect(capabilityBindingKeyHash(lookupKey, "capability-key")).toBe(
      capabilityBindingKeyHash(lookupKeyBase64, "capability-key")
    );
    expect(capabilityBindingSubjectHash(lookupKey, "namespace", "")).toBe(
      capabilityBindingSubjectHash(lookupKeyBase64, "namespace", "")
    );
    expect(capabilityBindingSubjectHash(lookupKey, "", "subject-value")).toBeTruthy();
    expect(() => capabilityBindingSubjectHash(Buffer.alloc(31), "user", "subject-user")).toThrow(
      "Capability binding guard requires a 256-bit lookup key."
    );

    const emptyGuard = createMemoryCapabilityBindingGuard({ alias: "subject hash empty result" });
    await expect(emptyGuard.invalidateCapabilityKeyBinding({})).resolves.toEqual([]);
    await expect(emptyGuard.invalidateCapabilityKeyBinding({ capabilityKey: "missing-key" })).resolves.toEqual([]);
    await expect(emptyGuard.describe()).resolves.toMatchObject({
      provider: "memory",
      securityMode: "memory",
      statePath: ""
    });

    const keyGuard = createMemoryCapabilityBindingGuard({ alias: "subject hash key hit" });
    await keyGuard.bindCapabilityKey({
      key: "subject-hit-key",
      credentialId: "subject-hit-credential",
      context: {
        namespace: "operation-permission",
        userId: "subject-hit-user"
      }
    });

    const keyInvalidated = await keyGuard.invalidateCapabilityKeyBinding({
      capabilityKey: "subject-hit-key",
      reason: "key-revocation"
    });
    expect(keyInvalidated).toHaveLength(1);
    expect(keyInvalidated[0]).toMatchObject({
      credentialId: "subject-hit-credential",
      invalidationReason: "key-revocation",
      status: "invalid"
    });

    await expect(keyGuard.verifyCapabilityKeyBinding({
      capabilityKey: "subject-hit-key",
      credentialId: "subject-hit-credential",
      context: {
        namespace: "operation-permission",
        userId: "subject-hit-user"
      }
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: "binding_invalid"
    });

    const credentialGuard = createMemoryCapabilityBindingGuard({ alias: "subject hash credential hit" });
    await credentialGuard.bindCapabilityKey({
      key: "credential-hit-key-1",
      credentialId: "shared-credential",
      context: {
        namespace: "operation-permission",
        userId: "shared-user"
      }
    });
    await credentialGuard.bindCapabilityKey({
      key: "credential-hit-key-2",
      credentialId: "shared-credential",
      context: {
        namespace: "operation-permission"
      }
    });

    const credentialInvalidated = await credentialGuard.invalidateCapabilityKeyBinding({
      credentialId: "shared-credential",
      reason: "credential-revocation"
    });
    expect(credentialInvalidated).toHaveLength(2);
    expect(credentialInvalidated.every((record) => record.status === "invalid")).toBe(true);
    expect(credentialInvalidated.map((record) => record.credentialId)).toEqual([
      "shared-credential",
      "shared-credential"
    ]);
  });

  it("rejects unsupported recovery packages and passphrase failures", async () => {
    const memoryGuard = createMemoryCapabilityBindingGuard({ alias: "recovery failure memory" });
    await memoryGuard.bindCapabilityKey({
      key: "recovery-memory-key",
      credentialId: "recovery-memory-credential",
      context: {
        namespace: "operation-permission",
        userId: "recovery-memory-user"
      }
    });

    await expect(memoryGuard.exportRecoveryPackage({})).rejects.toThrow(
      "Capability binding guard recovery export requires a passphrase."
    );

    const recoveryPackage = await memoryGuard.exportRecoveryPackage({
      passphrase: "correct horse battery staple",
      reason: "unit test"
    });

    await expect(memoryGuard.importRecoveryPackage({
      recoveryPackage: { protocolVersion: "unsupported" },
      passphrase: "correct horse battery staple"
    })).rejects.toThrow("Unsupported capability binding guard recovery package.");

    await expect(memoryGuard.importRecoveryPackage({
      recoveryPackage,
      passphrase: "wrong passphrase"
    })).rejects.toThrow();

    await expect(memoryGuard.importRecoveryPackage({
      recoveryPackage: {
        ...recoveryPackage,
        sealedRecovery: {
          ...recoveryPackage.sealedRecovery,
          algorithm: "bogus"
        }
      },
      passphrase: "correct horse battery staple"
    })).rejects.toThrow();

    const localDataDir = await tempDir("lico-cap-binding-recovery-local-");
    const localGuard = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir: localDataDir,
      alias: "recovery local"
    });
    await expect(localGuard.importRecoveryPackage({
      recoveryPackage,
      passphrase: "correct horse battery staple"
    })).resolves.toMatchObject({
      ok: true,
      provider: "local-file",
      securityMode: "degraded_file_fallback"
    });

    await expect(localGuard.verifyCapabilityKeyBinding({
      capabilityKey: "recovery-memory-key",
      credentialId: "recovery-memory-credential",
      context: {
        namespace: "operation-permission",
        userId: "recovery-memory-user"
      }
    })).resolves.toMatchObject({
      ok: true,
      applicable: true,
      credentialId: "recovery-memory-credential"
    });
  });

  it("surfaces local-file lock timeout and state read errors", async () => {
    const lockDataDir = await tempDir("lico-cap-binding-lock-");
    const lockAlias = "lock error alias";
    const lockGuard = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir: lockDataDir,
      alias: lockAlias
    });

    const originalOpen = fs.promises.open.bind(fs.promises);
    const lockOpenSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const filePath = String(args[0] || "");
      const flags = String(args[1] || "");
      if (filePath.endsWith(".lock") && flags.includes("wx")) {
        const error = new Error("capability binding guard lock busy");
        error.code = "EEXIST";
        throw error;
      }
      return originalOpen(...args);
    });
    const originalNow = Date.now;
    const nowValues = [0, 10001];
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowValues.shift() ?? 10001);

    try {
      await expect(lockGuard.bindCapabilityKey({
        key: "lock-timeout-key",
        credentialId: "lock-timeout-credential",
        context: {
          namespace: "operation-permission",
          userId: "lock-timeout-user"
        }
      })).rejects.toThrow("Timed out waiting for capability binding guard state lock:");
    } finally {
      nowSpy.mockRestore();
      lockOpenSpy.mockRestore();
      Date.now = originalNow;
    }

    const stateDataDir = await tempDir("lico-cap-binding-state-error-");
    const stateAlias = "state error alias";
    const statePath = capabilityBindingGuardStatePath({ dataDir: stateDataDir, alias: stateAlias });
    await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
    await fs.promises.writeFile(statePath, "{}\n");

    const stateGuard = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir: stateDataDir,
      alias: stateAlias
    });
    const originalReadFile = fs.promises.readFile.bind(fs.promises);
    const readFileSpy = vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args) => {
      if (String(args[0] || "") === statePath) {
        const error = new Error("state read broken");
        error.code = "EIO";
        throw error;
      }
      return originalReadFile(...args);
    });

    try {
      await expect(stateGuard.describe()).rejects.toMatchObject({
        code: "EIO"
      });
    } finally {
      readFileSpy.mockRestore();
    }
  });
});
