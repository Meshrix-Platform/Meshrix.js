import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  initializeLocalSecret,
  listLocalSecretEntries,
  resolveLocalSecretPayload,
  revokeLocalSecret,
  rotateLocalSecret,
  rotateLocalSecretMasterKey,
  validateLocalSecretTarget
} from "../../../packages/foundation/src/security/secrets/local-secret-store.ts";
import {
  createMemoryLocalSecretKeyProvider
} from "../../../packages/foundation/src/security/secrets/local-secret-key-provider.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const cliEntrypoint: any = path.join(repoRoot, "apps", "server", "bin", "meshrix.ts");
const SECRET_REF: any = "secret://fixture/service-material";
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
    authType: "bearer",
    secretRef: SECRET_REF,
    scope: {
      serviceId: "fixture-service",
      scopes: ["gateway:read", "gateway:write"],
      allowedHosts: ["api.example.test"],
      allowedProtocols: ["https"]
    },
    ...overrides
  };
}

function expectedScope(overrides: Record<string, any> = {}) : any {
  return {
    serviceId: "fixture-service",
    requiredScopes: ["gateway:read"],
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
      { ...target, secretRef: "secret://Fixture/service-material" },
      { ...target, secretRef: "secret://fixture/service-material/" },
      { ...target, secretRef: "secret://fixture//service-material" },
      { ...target, secretRef: "secret://fixture/../service-material" },
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
    const entry: any = registry.refs[SECRET_REF];
    const valuePath: any = path.join(dataDir, "secrets", "values", entry.storageRef.slice("local:".length));
    const valueRecord: any = JSON.parse(await fs.readFile(valuePath, "utf8"));
    valueRecord.revision = 99;
    await fs.writeFile(valuePath, `${JSON.stringify(valueRecord, null, 2)}\n`, { mode: 0o600 });

    await expect(resolveLocalSecretPayload({
      dataDir,
      secretRef: SECRET_REF,
      expectedScope: expectedScope()
    })).rejects.toMatchObject({ code: "local_secret_value_mismatch" });
  });
});

describe("local secret lifecycle", () : any => {
  it("atomically re-encrypts every active value under a distinct master key", async () : Promise<any> => {
    const currentKeyProvider: any = createMemoryLocalSecretKeyProvider({
      key: Buffer.alloc(32, 0x11)
    });
    const nextKeyProvider: any = createMemoryLocalSecretKeyProvider({
      key: Buffer.alloc(32, 0x22)
    });
    const secondTarget: any = targetContract({
      secretRef: "secret://fixture/secondary-material"
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
        secretRef: SECRET_REF,
        expectedScope: expectedScope(),
        keyProvider: currentKeyProvider
      })).rejects.toMatchObject({ code: "local_secret_decryption_failed" });
      await expect(resolveLocalSecretPayload({
        dataDir,
        secretRef: SECRET_REF,
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
      secretRef: SECRET_REF,
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
      initializedRegistry.refs[SECRET_REF].storageRef.slice("local:".length)
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
      secretRef: SECRET_REF,
      expectedRevision: 1,
      expectedScope: expectedScope()
    });
    expect(resolved.payload).toEqual({ token: MATERIAL_ALPHA });
    await expect(resolveLocalSecretPayload({
      dataDir,
      secretRef: SECRET_REF,
      expectedRevision: 2,
      expectedScope: expectedScope()
    })).rejects.toMatchObject({ code: "local_secret_revision_conflict" });

    for (const deniedScope of [
      expectedScope({ serviceId: "other-service" }),
      expectedScope({ host: "" }),
      expectedScope({ host: "other.example.test" }),
      expectedScope({ protocol: "" }),
      expectedScope({ protocol: "http" }),
      expectedScope({ requiredScopes: ["gateway:maintain"] })
    ]) {
      await expect(resolveLocalSecretPayload({
        dataDir,
        secretRef: SECRET_REF,
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
    await expect(revokeLocalSecret({ dataDir, secretRef: SECRET_REF })).rejects.toMatchObject({
      code: "local_secret_revision_required"
    });

    const revoked: any = await revokeLocalSecret({ dataDir, secretRef: SECRET_REF, expectedRevision: 2 });
    expect(revoked.secret).toMatchObject({ status: "revoked", revision: 3, credentialConfigured: false });
    await expect(resolveLocalSecretPayload({
      dataDir,
      secretRef: SECRET_REF,
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
      secretRef: SECRET_REF,
      expectedScope: expectedScope()
    })).rejects.toMatchObject({ code: "local_secret_decryption_failed" });

    process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE = keyFile;
    const registry: any = await readRegistry();
    const valuePath: any = path.join(
      dataDir,
      "secrets",
      "values",
      registry.refs[SECRET_REF].storageRef.slice("local:".length)
    );
    const valueRecord: any = JSON.parse(await fs.readFile(valuePath, "utf8"));
    valueRecord.envelope.ciphertext =
      `${valueRecord.envelope.ciphertext[0] === "A" ? "B" : "A"}${valueRecord.envelope.ciphertext.slice(1)}`;
    await fs.writeFile(valuePath, `${JSON.stringify(valueRecord, null, 2)}\n`, { mode: 0o600 });
    await expect(resolveLocalSecretPayload({
      dataDir,
      secretRef: SECRET_REF,
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
      secretRef: SECRET_REF,
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
      token: "abandoned-lock-fixture",
      pid: 0,
      createdAt: "2000-01-01T00:00:00.000Z"
    })}\n`, { mode: 0o600 });

    const initialized: any = await initializeLocalSecret({
      dataDir,
      target,
      payload: { token: MATERIAL_ALPHA }
    });

    expect(initialized.secret).toMatchObject({ secretRef: SECRET_REF, revision: 1, status: "active" });
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("local secret CLI", () : any => {
  it("uses the explicit target file and keeps secret material and storage paths out of stdout", async () : Promise<any> => {
    const initialized: any = runCli("init", ["--target-file", targetFile, "--token-stdin"], `${MATERIAL_ALPHA}\n`);
    expect(initialized.status).toBe(0);
    expect(initialized.stderr).toBe("");
    const initializedJson: any = JSON.parse(initialized.stdout);
    expect(initializedJson.secret).toMatchObject({ secretRef: SECRET_REF, revision: 1, status: "active" });
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
