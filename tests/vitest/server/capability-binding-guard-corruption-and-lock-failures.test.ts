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
} from "../../../packages/foundation/src/security/authorization/capability-binding-guard.ts";
const canned1 = "correct horse battery staple";
const canned2 = "wrong passphrase";
const canned90 = "missing-key";
const canned91 = "subject-hit-key";
const canned3 = "subject-hit-credential";
const canned4 = "credential-hit-key-1";
const canned5 = "shared-credential";
const canned6 = "credential-hit-key-2";
const canned7 = "recovery-memory-key";
const canned8 = "recovery-memory-credential";
const canned9 = "lock-timeout-key";
const canned10 = "lock-timeout-credential";





const tempRoots: any[] = [];

async function tempDir(prefix?: any) : Promise<any> {
  const root: any = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () : Promise<any> => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root?: any) : any => fs.promises.rm(root, { recursive: true, force: true })));
});

describe("capability binding guard behavior", () : any => {

  it("covers subject hash boundaries and invalidate by key or credential with empty and hit results", async () : Promise<any> => {
    const lookupKey: any = Buffer.alloc(32, 19);
    const lookupKeyBase64: any = lookupKey.toString("base64");

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
    expect(() : any => capabilityBindingSubjectHash(Buffer.alloc(31), "user", "subject-user")).toThrow(
      "Capability binding guard requires a 256-bit lookup key."
    );

    const emptyGuard: any = createMemoryCapabilityBindingGuard({ alias: "subject hash empty result" });
    await expect(emptyGuard.invalidateCapabilityKeyBinding({})).resolves.toEqual([]);
    await expect(emptyGuard.invalidateCapabilityKeyBinding({ capabilityKey: canned1 })).resolves.toEqual([]);
    await expect(emptyGuard.describe()).resolves.toMatchObject({
      provider: "memory",
      securityMode: "memory",
      statePath: ""
    });

    const firstGuard: any = createMemoryCapabilityBindingGuard({ alias: "subject hash key hit" });
    await firstGuard.bindCapabilityKey({
      key: canned2,
      credentialId: canned3,
      context: {
        namespace: "operation-permission",
        userId: "subject-hit-user"
      }
    });

    const keyInvalidated: any = await firstGuard.invalidateCapabilityKeyBinding({
      capabilityKey: canned2,
      reason: "key-revocation"
    });
    expect(keyInvalidated).toHaveLength(1);
    expect(keyInvalidated[0]).toMatchObject({
      credentialId: canned3,
      invalidationReason: "key-revocation",
      status: "invalid"
    });

    await expect(firstGuard.verifyCapabilityKeyBinding({
      capabilityKey: canned2,
      credentialId: canned3,
      context: {
        namespace: "operation-permission",
        userId: "subject-hit-user"
      }
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: "binding_invalid"
    });

    const secondGuard: any = createMemoryCapabilityBindingGuard({ alias: "subject hash credential hit" });
    await secondGuard.bindCapabilityKey({
      key: canned4,
      credentialId: canned5,
      context: {
        namespace: "operation-permission",
        userId: "shared-user"
      }
    });
    await secondGuard.bindCapabilityKey({
      key: canned6,
      credentialId: canned5,
      context: {
        namespace: "operation-permission"
      }
    });

    const credentialInvalidated: any = await secondGuard.invalidateCapabilityKeyBinding({
      credentialId: canned5,
      reason: "credential-revocation"
    });
    expect(credentialInvalidated).toHaveLength(2);
    expect(credentialInvalidated.every((record?: any) : any => record.status === "invalid")).toBe(true);
    expect(credentialInvalidated.map((record?: any) : any => record.credentialId)).toEqual([
      "shared-credential",
      "shared-credential"
    ]);
  });

  it("rejects unsupported recovery packages and passphrase failures", async () : Promise<any> => {
    const memoryGuard: any = createMemoryCapabilityBindingGuard({ alias: "recovery failure memory" });
    await memoryGuard.bindCapabilityKey({
      key: canned7,
      credentialId: canned8,
      context: {
        namespace: "operation-permission",
        userId: "recovery-memory-user"
      }
    });

    await expect(memoryGuard.exportRecoveryPackage({})).rejects.toThrow(
      "Capability binding guard recovery export requires a passphrase."
    );

    const recoveryPackage: any = await memoryGuard.exportRecoveryPackage({
      passphrase: canned1,
      reason: "unit test"
    });

    await expect(memoryGuard.importRecoveryPackage({
      recoveryPackage: { protocolVersion: "unsupported" },
      passphrase: canned1
    })).rejects.toThrow("Unsupported capability binding guard recovery package.");

    await expect(memoryGuard.importRecoveryPackage({
      recoveryPackage,
      passphrase: canned2
    })).rejects.toThrow();

    await expect(memoryGuard.importRecoveryPackage({
      recoveryPackage: {
        ...recoveryPackage,
        sealedRecovery: {
          ...recoveryPackage.sealedRecovery,
          algorithm: "bogus"
        }
      },
      passphrase: canned1
    })).rejects.toThrow();

    const localDataDir: any = await tempDir("meshrix-cap-binding-recovery-local-");
    const localGuard: any = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir: localDataDir,
      alias: "recovery local"
    });
    await expect(localGuard.importRecoveryPackage({
      recoveryPackage,
      passphrase: canned1
    })).resolves.toMatchObject({
      ok: true,
      provider: "local-file",
      securityMode: "degraded_file_fallback"
    });

    await expect(localGuard.verifyCapabilityKeyBinding({
      capabilityKey: canned7,
      credentialId: canned8,
      context: {
        namespace: "operation-permission",
        userId: "recovery-memory-user"
      }
    })).resolves.toMatchObject({
      ok: true,
      applicable: true,
      credentialId: canned8
    });
  });

  it("surfaces local-file lock timeout and state read errors", async () : Promise<any> => {
    const lockDataDir: any = await tempDir("meshrix-cap-binding-lock-");
    const lockAlias: any = "lock error alias";
    const lockGuard: any = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir: lockDataDir,
      alias: lockAlias
    });

    const originalOpen: any = fs.promises.open.bind(fs.promises);
    const lockOpenSpy: any = vi.spyOn(fs.promises, "open").mockImplementation(async (...args: any[]) : Promise<any> => {
      const filePath: any = String(args[0] || "");
      const flags: any = String(args[1] || "");
      if (filePath.endsWith(".lock") && flags.includes("wx")) {
        const error: any = new Error("capability binding guard lock busy");
        error.code = "EEXIST";
        throw error;
      }
      return originalOpen(...args);
    });
    const originalNow: any = Date.now;
    const nowValues: any[] = [0, 10001];
    const nowSpy: any = vi.spyOn(Date, "now").mockImplementation(() : any => nowValues.shift() ?? 10001);

    try {
      await expect(lockGuard.bindCapabilityKey({
        key: canned9,
        credentialId: canned10,
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

    const stateDataDir: any = await tempDir("meshrix-cap-binding-state-error-");
    const stateAlias: any = "state error alias";
    const statePath: any = capabilityBindingGuardStatePath({ dataDir: stateDataDir, alias: stateAlias });
    await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
    await fs.promises.writeFile(statePath, "{}\n");

    const stateGuard: any = createCapabilityBindingGuard({
      backend: "local-file",
      dataDir: stateDataDir,
      alias: stateAlias
    });
    const originalReadFile: any = fs.promises.readFile.bind(fs.promises);
    const readFileSpy: any = vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args: any[]) : Promise<any> => {
      if (String(args[0] || "") === statePath) {
        const error: any = new Error("state read broken");
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
