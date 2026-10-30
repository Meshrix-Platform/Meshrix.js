import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  initializeLocalSecret,
  ensureOperationAuditProjectionKey,
  listLocalSecretEntries,
  resolveLocalSecretPayload,
  revokeLocalSecret,
  rotateLocalSecret,
  rotateLocalSecretMasterKey,
  validateLocalSecretTarget
} from "../../../packages/foundation/src/security/secret-store/local-secret-store.ts";
import {
  createMemoryLocalSecretKeyProvider
} from "../../../packages/foundation/src/security/secret-store/local-secret-key-provider.ts";
import {
  createOperationAuditStore
} from "../../../packages/foundation/src/security/operation-audit.ts";
import {
  operationAuditProjectionKeyId
} from "../../../packages/foundation/src/security/operation-audit-projection.ts";
const canned1 = "bearer";
const canned2 = "secret://Fixture/service-material";
const canned3 = "secret://fixture/service-material/";
const canned4 = "secret://fixture//service-material";
const canned5 = "secret://fixture/../service-material";
const canned6 = "secret://meshrix/system/operation-audit-projection";
const canned7 = "hmac-projection-key";
const canned8 = "replacement-must-be-rejected";
const canned9 = "secret://fixture/secondary-material";
const canned10 = "abandoned-lock-fixture";




const repoRoot: any = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const cliEntrypoint: any = path.join(repoRoot, "apps", "server", "bin", "meshrix.ts");
const FIXTURE_REF: any = "secret://fixture/service-material";
const MATERIAL_ALPHA: any = "fixture-material-alpha";
const MATERIAL_BETA: any = "fixture-material-beta";
const MATERIAL_GAMMA: any = "fixture-material-gamma";

let dataDir: any;
let keyDir: any;
let keyFile: any;
let previousKeyFile: any;
let target: any;
let targetFile: any;

function targetContract(overrides: Record<string, any> = {}) : any {
  return {
    provider: "fixture-provider",
    family: "upstream-gateway",
    authType: canned1,
    secretRef: FIXTURE_REF,
    scope: {
      serviceId: "fixture-service",
      scopes: ["gateway:read", "gateway:write"],
      allowedHosts: ["api.example.test"],
      allowedProtocols: ["https"],
      allowedOrigins: ["https://api.example.test"]
    },
    ...overrides
  };
}

function expectedScope(overrides: Record<string, any> = {}) : any {
  return {
    serviceId: "fixture-service",
    requiredScopes: ["gateway:read"],
    origin: "https://api.example.test",
    host: "api.example.test",
    protocol: "https",
    ...overrides
  };
}

function cliArgs(action?: any, extra: any = []) : any {
  return [cliEntrypoint, "secret", action, "--data-dir", dataDir, ...extra];
}

function runCli(action?: any, extra: any = [], input: any = "") : any {
  return spawnSync(process.execPath, cliArgs(action, extra), {
    cwd: repoRoot,
    encoding: "utf8",
    input
  });
}

function runCliAsync(action?: any, extra: any = [], input: any = "") : any {
  return new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn(process.execPath, cliArgs(action, extra), {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: any[] = [];
    const stderr: any[] = [];
    child.stdout.on("data", (chunk?: any) : any => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk?: any) : any => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (status?: any) : any => resolve({
      status,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
    child.stdin.end(input);
  });
}

async function readRegistry() : Promise<any> {
  return JSON.parse(await fs.readFile(path.join(dataDir, "secrets", "registry.json"), "utf8"));
}

beforeEach(async () : Promise<any> => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-local-secret-"));
  keyDir = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-local-secret-key-"));
  keyFile = path.join(keyDir, "master-key");
  await fs.writeFile(keyFile, `${"a1".repeat(32)}\n`, { mode: 0o600 });
  previousKeyFile = process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE;
  process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE = keyFile;
  target = targetContract();
  targetFile = path.join(dataDir, "target.json");
  await fs.writeFile(targetFile, `${JSON.stringify(target, null, 2)}\n`, { mode: 0o600 });
});

afterEach(async () : Promise<any> => {
  if (previousKeyFile === undefined) {
    delete process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE;
  } else {
    process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE = previousKeyFile;
  }
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(keyDir, { recursive: true, force: true });
});

describe("local secret target contract", () : any => {
  it("requires a complete canonical target without inferred fields", () : any => {
    expect(validateLocalSecretTarget(target)).toEqual(target);

    for (const invalid of [
      { ...target, provider: "Fixture-Provider" },
      { ...target, secretRef: canned2 },
      { ...target, secretRef: canned3 },
      { ...target, secretRef: canned4 },
      { ...target, secretRef: canned5 },
      { ...target, scope: { ...target.scope, allowedHosts: undefined } },
      { ...target, scope: { ...target.scope, unverifiedBinding: "value" } },
      { ...target, inferredDefault: true }
    ]) {
      expect(() : any => validateLocalSecretTarget(invalid)).toThrowError();
    }
  });

  it("fails closed when registry and immutable value identity diverge", async () : Promise<any> => {
    await initializeLocalSecret({ dataDir, target, payload: { token: MATERIAL_ALPHA } });
    const registry: any = await readRegistry();
    const entry: any = registry.refs[FIXTURE_REF];
    const valuePath: any = path.join(dataDir, "secrets", "values", entry.storageRef.slice("local:".length));
    const valueRecord: any = JSON.parse(await fs.readFile(valuePath, "utf8"));
    valueRecord.revision = 99;
    await fs.writeFile(valuePath, `${JSON.stringify(valueRecord, null, 2)}\n`, { mode: 0o600 });

    await expect(resolveLocalSecretPayload({
      dataDir,
      secretRef: FIXTURE_REF,
      expectedScope: expectedScope()
    })).rejects.toMatchObject({ code: "local_secret_value_mismatch" });
  });
});

describe("local secret lifecycle", () : any => {
  it("keeps the internal audit projection key hidden and stable through master-key rotation", async () : Promise<any> => {
    const currentKeyProvider: any = createMemoryLocalSecretKeyProvider({
      key: Buffer.alloc(32, 0x41)
    });
    const nextKeyProvider: any = createMemoryLocalSecretKeyProvider({
      key: Buffer.alloc(32, 0x42)
    });
    let initialAuditKey: Buffer | null = null;
    try {
      const initial: any = await ensureOperationAuditProjectionKey({
        dataDir,
        keyProvider: currentKeyProvider,
        allowInitialize: true
      });
      initialAuditKey = Buffer.from(initial.key);
      expect(initial.key).toHaveLength(32);
      expect(initial.keyId).toMatch(/^sha256:[0-9a-f]{64}$/u);
      initial.key.fill(0);

      await initializeLocalSecret({
        dataDir,
        target,
        payload: { token: MATERIAL_ALPHA },
        keyProvider: currentKeyProvider
      });
      expect(await listLocalSecretEntries({ dataDir })).toHaveLength(1);
      await expect(resolveLocalSecretPayload({
        dataDir,
        secretRef: canned6,
        expectedScope: {
          serviceId: "meshrix-core",
          requiredScopes: ["internal:operation-audit-projection"]
        },
        keyProvider: currentKeyProvider
      })).rejects.toMatchObject({ code: "local_secret_not_configured" });
      await expect(initializeLocalSecret({
        dataDir,
        target: {
          provider: "meshrix",
          family: "internal-key",
          authType: canned7,
          secretRef: canned6,
          scope: {
            serviceId: "meshrix-core",
            scopes: ["internal:operation-audit-projection"],
            allowedHosts: [],
            allowedProtocols: []
          }
        },
        payload: { seed: canned8 },
        keyProvider: currentKeyProvider
      })).rejects.toMatchObject({ code: "local_secret_not_configured" });

      const rotation: any = await rotateLocalSecretMasterKey({
        dataDir,
        currentKeyProvider,
        nextKeyProvider
      });
      expect(rotation).toMatchObject({ ok: true, action: "rotate-master-key" });
      const afterRotation: any = await ensureOperationAuditProjectionKey({
        dataDir,
        keyProvider: nextKeyProvider,
        allowInitialize: false
      });
      expect(afterRotation.keyId).toBe(initial.keyId);
      expect(afterRotation.key).toEqual(initialAuditKey);
      afterRotation.key.fill(0);
      await expect(resolveLocalSecretPayload({
        dataDir,
        secretRef: FIXTURE_REF,
        expectedScope: expectedScope(),
        keyProvider: nextKeyProvider
      })).resolves.toMatchObject({ payload: { token: MATERIAL_ALPHA } });
    } finally {
      initialAuditKey?.fill(0);
      currentKeyProvider.close();
      nextKeyProvider.close();
    }
  });

  it("preserves audit filtering and idempotent replay after actual master-key rotation", async () : Promise<any> => {
    const currentKeyProvider: any = createMemoryLocalSecretKeyProvider({ key: Buffer.alloc(32, 0x51) });
    const nextKeyProvider: any = createMemoryLocalSecretKeyProvider({ key: Buffer.alloc(32, 0x52) });
    const entry: any = {
      auditId: "audit-after-master-rotation",
      operationId: "synthetic.rotation.probe",
      transport: "test",
      status: "ok",
      tenantId: "synthetic-tenant",
      traceId: "synthetic-trace",
      actor: { userId: "synthetic-user" },
      input: { value: "synthetic-input" }
    };
    let before: any = null;
    let after: any = null;
    let firstStore: any = null;
    let rotatedStore: any = null;
    try {
      before = await ensureOperationAuditProjectionKey({
        dataDir,
        keyProvider: currentKeyProvider,
        allowInitialize: true
      });
      firstStore = createOperationAuditStore({
        userDataPath: dataDir,
        projectionKey: before.key,
        projectionKeyId: before.keyId
      });
      await firstStore.ready();
      await firstStore.appendIdempotent(entry);
      await firstStore.close();
      firstStore = null;
      before.key.fill(0);

      await rotateLocalSecretMasterKey({ dataDir, currentKeyProvider, nextKeyProvider });
      after = await ensureOperationAuditProjectionKey({
        dataDir,
        keyProvider: nextKeyProvider,
        allowInitialize: false
      });
      expect(after.keyId).toBe(operationAuditProjectionKeyId(after.key));
      rotatedStore = createOperationAuditStore({
        userDataPath: dataDir,
        projectionKey: after.key,
        projectionKeyId: after.keyId
      });
      await rotatedStore.ready();
      await expect(rotatedStore.list({
        userId: "synthetic-user",
        tenantId: "synthetic-tenant",
        traceId: "synthetic-trace",
        limit: 10
      })).resolves.toMatchObject([{
        auditId: entry.auditId,
        operationId: entry.operationId
      }]);
      await expect(rotatedStore.appendIdempotent(entry)).resolves.toMatchObject({
        auditId: entry.auditId,
        replayed: true
      });
    } finally {
      await firstStore?.close().catch(() => undefined);
      await rotatedStore?.close().catch(() => undefined);
      before?.key.fill(0);
      after?.key.fill(0);
      currentKeyProvider.close();
      nextKeyProvider.close();
    }
  });

  it("does not create an internal audit seed when the caller disallows initialization", async () : Promise<any> => {
    const provider: any = createMemoryLocalSecretKeyProvider({
      key: Buffer.alloc(32, 0x43)
    });
    try {
      await expect(ensureOperationAuditProjectionKey({
        dataDir,
        keyProvider: provider,
        allowInitialize: false
      })).rejects.toMatchObject({ code: "operation_audit_projection_key_unavailable" });
      await expect(fs.access(path.join(dataDir, "secrets", "registry.json"))).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      provider.close();
    }
  });

  it("atomically re-encrypts every active value under a distinct master key", async () : Promise<any> => {
    const currentKeyProvider: any = createMemoryLocalSecretKeyProvider({
      key: Buffer.alloc(32, 0x11)
    });
    const nextKeyProvider: any = createMemoryLocalSecretKeyProvider({
      key: Buffer.alloc(32, 0x22)
    });
    const secondTarget: any = targetContract({
      secretRef: canned9
    });
    try {
      await initializeLocalSecret({
        dataDir,
        target,
        payload: { token: MATERIAL_ALPHA },
        keyProvider: currentKeyProvider
      });
      await initializeLocalSecret({
        dataDir,
        target: secondTarget,
        payload: { token: MATERIAL_BETA },
        keyProvider: currentKeyProvider
      });
      const result: any = await rotateLocalSecretMasterKey({
        dataDir,
        currentKeyProvider,
        nextKeyProvider
      });
      expect(result).toMatchObject({
        ok: true,
        action: "rotate-master-key",
        rotatedSecretCount: 2,
        staleValueCleanupPending: 0
      });
      await expect(resolveLocalSecretPayload({
        dataDir,
        secretRef: FIXTURE_REF,
        expectedScope: expectedScope(),
        keyProvider: currentKeyProvider
      })).rejects.toMatchObject({ code: "local_secret_decryption_failed" });
      await expect(resolveLocalSecretPayload({
        dataDir,
        secretRef: FIXTURE_REF,
        expectedScope: expectedScope(),
        keyProvider: nextKeyProvider
      })).resolves.toMatchObject({ payload: { token: MATERIAL_ALPHA } });
      await expect(resolveLocalSecretPayload({
        dataDir,
        secretRef: secondTarget.secretRef,
        expectedScope: expectedScope(),
        keyProvider: nextKeyProvider
      })).resolves.toMatchObject({ payload: { token: MATERIAL_BETA } });
      expect(await fs.readdir(path.join(dataDir, "secrets", "values"))).toHaveLength(2);
    } finally {
      currentKeyProvider.close();
      nextKeyProvider.close();
    }
  });

  it("rejects master-key reuse before changing registry or values", async () : Promise<any> => {
    const provider: any = createMemoryLocalSecretKeyProvider({
      key: Buffer.alloc(32, 0x33)
    });
    try {
      await initializeLocalSecret({
        dataDir,
        target,
        payload: { token: MATERIAL_ALPHA },
        keyProvider: provider
      });
      const before: any = await readRegistry();
      await expect(rotateLocalSecretMasterKey({
        dataDir,
        currentKeyProvider: provider,
        nextKeyProvider: provider
      })).rejects.toMatchObject({ code: "local_secret_master_key_rotation_same_key" });
      expect(await readRegistry()).toEqual(before);
      expect(await fs.readdir(path.join(dataDir, "secrets", "values"))).toHaveLength(1);
    } finally {
      provider.close();
    }
  });

  it("initializes, rotates and revokes with scoped resolution and minimal public output", async () : Promise<any> => {
    const initialized: any = await initializeLocalSecret({
      dataDir,
      target,
      payload: { token: MATERIAL_ALPHA }
    });
    expect(initialized.action).toBe("initialize");
    expect(initialized.secret).toMatchObject({
      secretRef: FIXTURE_REF,
      status: "active",
      revision: 1,
      scopeBinding: { serviceBound: true, scopeCount: 2, hostCount: 1, protocolCount: 1 }
    });
    const initializedText: any = JSON.stringify(initialized);
    expect(initializedText).not.toContain(MATERIAL_ALPHA);
    expect(initializedText).not.toContain(dataDir);
    expect(initializedText).not.toContain("storageRef");

    const initializedRegistry: any = await readRegistry();
    const initializedValuePath: any = path.join(
      dataDir,
      "secrets",
      "values",
      initializedRegistry.refs[FIXTURE_REF].storageRef.slice("local:".length)
    );
    const persistedValue: any = await fs.readFile(initializedValuePath, "utf8");
    expect(persistedValue).not.toContain(MATERIAL_ALPHA);
    expect(persistedValue).not.toContain('"payload"');
    expect(JSON.parse(persistedValue).envelope).toMatchObject({
      protocolVersion: "v0.0.1:security:local-secret-envelope-1",
      algorithm: "aes-256-gcm"
    });
    if (process.platform !== "win32") {
      for (const privateDir of [path.join(dataDir, "secrets"), path.join(dataDir, "secrets", "values")]) {
        expect((await fs.stat(privateDir)).mode & 0o777).toBe(0o700);
      }
      for (const privateFile of [
        path.join(dataDir, "secrets", "registry.json"),
        path.join(dataDir, "secrets", "audit.jsonl"),
        initializedValuePath
      ]) {
        expect((await fs.stat(privateFile)).mode & 0o777).toBe(0o600);
      }
    }

    const resolved: any = await resolveLocalSecretPayload({
      dataDir,
      secretRef: FIXTURE_REF,
      expectedRevision: 1,
      expectedScope: expectedScope()
    });
    expect(resolved.payload).toEqual({ token: MATERIAL_ALPHA });
    await expect(resolveLocalSecretPayload({
      dataDir,
      secretRef: FIXTURE_REF,
      expectedRevision: 2,
      expectedScope: expectedScope()
    })).rejects.toMatchObject({ code: "local_secret_revision_conflict" });

    for (const deniedScope of [
      expectedScope({ serviceId: "other-service" }),
      expectedScope({ host: "" }),
      expectedScope({ host: "other.example.test" }),
      expectedScope({ protocol: "" }),
      expectedScope({ protocol: "http" }),
      expectedScope({ origin: "https://api.example.test:8443" }),
      expectedScope({ requiredScopes: ["gateway:maintain"] })
    ]) {
      await expect(resolveLocalSecretPayload({
        dataDir,
        secretRef: FIXTURE_REF,
        expectedScope: deniedScope
      })).rejects.toMatchObject({ code: "local_secret_scope_denied", statusCode: 403 });
    }

    await expect(initializeLocalSecret({
      dataDir,
      target,
      payload: { token: MATERIAL_BETA }
    })).rejects.toMatchObject({ code: "local_secret_already_configured" });
    await expect(rotateLocalSecret({
      dataDir,
      target,
      payload: { token: MATERIAL_BETA }
    })).rejects.toMatchObject({ code: "local_secret_revision_required" });
    await expect(rotateLocalSecret({
      dataDir,
      target: targetContract({
        scope: { ...target.scope, serviceId: "other-service" }
      }),
      payload: { token: MATERIAL_BETA },
      expectedRevision: 1
    })).rejects.toMatchObject({ code: "local_secret_target_mismatch", field: "scope" });

    const rotated: any = await rotateLocalSecret({
      dataDir,
      target,
      payload: { token: MATERIAL_BETA },
      expectedRevision: 1
    });
    expect(rotated.secret).toMatchObject({ status: "active", revision: 2 });
    await expect(rotateLocalSecret({
      dataDir,
      target,
      payload: { token: MATERIAL_GAMMA },
      expectedRevision: 1
    })).rejects.toMatchObject({ code: "local_secret_revision_conflict", actualRevision: 2 });
    await expect(revokeLocalSecret({ dataDir, secretRef: FIXTURE_REF })).rejects.toMatchObject({
      code: "local_secret_revision_required"
    });

    const revoked: any = await revokeLocalSecret({ dataDir, secretRef: FIXTURE_REF, expectedRevision: 2 });
    expect(revoked.secret).toMatchObject({ status: "revoked", revision: 3, credentialConfigured: false });
    await expect(resolveLocalSecretPayload({
      dataDir,
      secretRef: FIXTURE_REF,
      expectedScope: expectedScope()
    })).rejects.toMatchObject({ code: "local_secret_revoked" });

    const entries: any = await listLocalSecretEntries({ dataDir });
    expect(entries).toEqual([revoked.secret]);
    const values: any = await fs.readdir(path.join(dataDir, "secrets", "values"));
    expect(values).toEqual([]);
    const auditText: any = await fs.readFile(path.join(dataDir, "secrets", "audit.jsonl"), "utf8");
    expect(auditText).not.toContain(MATERIAL_ALPHA);
    expect(auditText).not.toContain(MATERIAL_BETA);
    expect(auditText).not.toContain(dataDir);
  });

  it("fails closed for missing, misplaced, wrong, or tampered key material", async () : Promise<any> => {
    delete process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE;
    await expect(initializeLocalSecret({
      dataDir,
      target,
      payload: { token: MATERIAL_ALPHA }
    })).rejects.toMatchObject({ code: "local_secret_key_unavailable" });

    const inDataKey: any = path.join(dataDir, "master-key");
    await fs.writeFile(inDataKey, `${"b2".repeat(32)}\n`, { mode: 0o600 });
    process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE = inDataKey;
    await expect(initializeLocalSecret({
      dataDir,
      target,
      payload: { token: MATERIAL_ALPHA }
    })).rejects.toMatchObject({ code: "local_secret_key_custody_invalid" });

    process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE = keyFile;
    await initializeLocalSecret({ dataDir, target, payload: { token: MATERIAL_ALPHA } });

    const wrongKeyFile: any = path.join(keyDir, "wrong-key");
    await fs.writeFile(wrongKeyFile, `${"c3".repeat(32)}\n`, { mode: 0o600 });
    process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE = wrongKeyFile;
    await expect(resolveLocalSecretPayload({
      dataDir,
      secretRef: FIXTURE_REF,
      expectedScope: expectedScope()
    })).rejects.toMatchObject({ code: "local_secret_decryption_failed" });

    process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE = keyFile;
    const registry: any = await readRegistry();
    const valuePath: any = path.join(
      dataDir,
      "secrets",
      "values",
      registry.refs[FIXTURE_REF].storageRef.slice("local:".length)
    );
    const valueRecord: any = JSON.parse(await fs.readFile(valuePath, "utf8"));
    valueRecord.envelope.ciphertext =
      `${valueRecord.envelope.ciphertext[0] === "A" ? "B" : "A"}${valueRecord.envelope.ciphertext.slice(1)}`;
    await fs.writeFile(valuePath, `${JSON.stringify(valueRecord, null, 2)}\n`, { mode: 0o600 });
    await expect(resolveLocalSecretPayload({
      dataDir,
      secretRef: FIXTURE_REF,
      expectedScope: expectedScope()
    })).rejects.toMatchObject({ code: "local_secret_decryption_failed" });
  });

  it("serializes cross-process rotations so one expected revision commits once", async () : Promise<any> => {
    await initializeLocalSecret({ dataDir, target, payload: { token: MATERIAL_ALPHA } });
    const rotationArgs: any[] = ["--target-file", targetFile, "--expected-revision", "1", "--token-stdin"];
    const attempts: any = await Promise.all([
      runCliAsync("rotate", rotationArgs, MATERIAL_BETA),
      runCliAsync("rotate", rotationArgs, MATERIAL_GAMMA)
    ]);
    expect(attempts.map((attempt?: any) : any => attempt.status).sort()).toEqual([0, 1]);
    const success: any = attempts.find((attempt?: any) : any => attempt.status === 0);
    const conflict: any = attempts.find((attempt?: any) : any => attempt.status === 1);
    expect(JSON.parse(success.stdout).secret.revision).toBe(2);
    expect(conflict.stderr).toContain("revision conflict");
    expect(conflict.stderr).not.toContain(MATERIAL_BETA);
    expect(conflict.stderr).not.toContain(MATERIAL_GAMMA);

    const resolved: any = await resolveLocalSecretPayload({
      dataDir,
      secretRef: FIXTURE_REF,
      expectedScope: expectedScope()
    });
    expect([MATERIAL_BETA, MATERIAL_GAMMA]).toContain(resolved.payload.token);
    expect(resolved.revision).toBe(2);
    const valueFiles: any = await fs.readdir(path.join(dataDir, "secrets", "values"));
    expect(valueFiles).toHaveLength(1);
    await expect(fs.access(path.join(dataDir, "secrets", ".mutation.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims an abandoned mutation lock before committing a write", async () : Promise<any> => {
    const secretDir: any = path.join(dataDir, "secrets");
    const lockPath: any = path.join(secretDir, ".mutation.lock");
    await fs.mkdir(secretDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(lockPath, `${JSON.stringify({
      token: canned10,
      pid: 0,
      createdAt: "2000-01-01T00:00:00.000Z"
    })}\n`, { mode: 0o600 });

    const initialized: any = await initializeLocalSecret({
      dataDir,
      target,
      payload: { token: MATERIAL_ALPHA }
    });

    expect(initialized.secret).toMatchObject({ secretRef: FIXTURE_REF, revision: 1, status: "active" });
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("local secret CLI", () : any => {
  it("uses the explicit target file and keeps secret material and storage paths out of stdout", async () : Promise<any> => {
    const initialized: any = runCli("init", ["--target-file", targetFile, "--token-stdin"], `${MATERIAL_ALPHA}\n`);
    expect(initialized.status).toBe(0);
    expect(initialized.stderr).toBe("");
    const initializedJson: any = JSON.parse(initialized.stdout);
    expect(initializedJson.secret).toMatchObject({ secretRef: FIXTURE_REF, revision: 1, status: "active" });
    expect(initialized.stdout).not.toContain(MATERIAL_ALPHA);
    expect(initialized.stdout).not.toContain(dataDir);
    expect(initialized.stdout).not.toContain("storageRef");

    const listed: any = runCli("list");
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ count: 1 });
    expect(listed.stdout).not.toContain(dataDir);

    const status: any = runCli("status");
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ count: 1, activeCount: 1, revokedCount: 0 });
  });

  it("rejects secret-bearing argv bodies and requires an explicit env payload key", () : any => {
    const argvPayload: any = runCli("init", ["--target-file", targetFile, "--body", MATERIAL_ALPHA]);
    expect(argvPayload.status).toBe(1);
    expect(argvPayload.stderr).toContain("--body is not supported");
    expect(argvPayload.stderr).not.toContain(MATERIAL_ALPHA);

    const envPayload: any = spawnSync(process.execPath, cliArgs("init", [
      "--target-file",
      targetFile,
      "--from-env",
      "MESHRIX_TEST_SECRET_MATERIAL"
    ]), {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, MESHRIX_TEST_SECRET_MATERIAL: MATERIAL_ALPHA }
    });
    expect(envPayload.status).toBe(1);
    expect(envPayload.stderr).toContain("--payload-key is required");
    expect(envPayload.stderr).not.toContain(MATERIAL_ALPHA);
  });
});
