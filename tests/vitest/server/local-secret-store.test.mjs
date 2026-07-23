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
  validateLocalSecretTarget
} from "../../../packages/foundation/src/security/secrets/local-secret-store.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const cliEntrypoint = path.join(repoRoot, "apps", "server", "bin", "lico.mjs");
const SECRET_REF = "secret://fixture/service-material";
const MATERIAL_ALPHA = "fixture-material-alpha";
const MATERIAL_BETA = "fixture-material-beta";
const MATERIAL_GAMMA = "fixture-material-gamma";

let dataDir;
let target;
let targetFile;

function targetContract(overrides = {}) {
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

function expectedScope(overrides = {}) {
  return {
    serviceId: "fixture-service",
    requiredScopes: ["gateway:read"],
    host: "api.example.test",
    protocol: "https",
    ...overrides
  };
}

function cliArgs(action, extra = []) {
  return [cliEntrypoint, "secret", action, "--data-dir", dataDir, ...extra];
}

function runCli(action, extra = [], input = "") {
  return spawnSync(process.execPath, cliArgs(action, extra), {
    cwd: repoRoot,
    encoding: "utf8",
    input
  });
}

function runCliAsync(action, extra = [], input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cliArgs(action, extra), {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
    child.stdin.end(input);
  });
}

async function readRegistry() {
  return JSON.parse(await fs.readFile(path.join(dataDir, "secrets", "registry.json"), "utf8"));
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lico-local-secret-"));
  target = targetContract();
  targetFile = path.join(dataDir, "target.json");
  await fs.writeFile(targetFile, `${JSON.stringify(target, null, 2)}\n`, { mode: 0o600 });
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("local secret target contract", () => {
  it("requires a complete canonical target without inferred fields", () => {
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
      expect(() => validateLocalSecretTarget(invalid)).toThrowError();
    }
  });

  it("fails closed when registry and immutable value identity diverge", async () => {
    await initializeLocalSecret({ dataDir, target, payload: { token: MATERIAL_ALPHA } });
    const registry = await readRegistry();
    const entry = registry.refs[SECRET_REF];
    const valuePath = path.join(dataDir, "secrets", "values", entry.storageRef.slice("local:".length));
    const valueRecord = JSON.parse(await fs.readFile(valuePath, "utf8"));
    valueRecord.revision = 99;
    await fs.writeFile(valuePath, `${JSON.stringify(valueRecord, null, 2)}\n`, { mode: 0o600 });

    await expect(resolveLocalSecretPayload({
      dataDir,
      secretRef: SECRET_REF,
      expectedScope: expectedScope()
    })).rejects.toMatchObject({ code: "local_secret_value_mismatch" });
  });
});

describe("local secret lifecycle", () => {
  it("initializes, rotates and revokes with scoped resolution and minimal public output", async () => {
    const initialized = await initializeLocalSecret({
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
    const initializedText = JSON.stringify(initialized);
    expect(initializedText).not.toContain(MATERIAL_ALPHA);
    expect(initializedText).not.toContain(dataDir);
    expect(initializedText).not.toContain("storageRef");

    const initializedRegistry = await readRegistry();
    const initializedValuePath = path.join(
      dataDir,
      "secrets",
      "values",
      initializedRegistry.refs[SECRET_REF].storageRef.slice("local:".length)
    );
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

    const resolved = await resolveLocalSecretPayload({
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

    const rotated = await rotateLocalSecret({
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

    const revoked = await revokeLocalSecret({ dataDir, secretRef: SECRET_REF, expectedRevision: 2 });
    expect(revoked.secret).toMatchObject({ status: "revoked", revision: 3, credentialConfigured: false });
    await expect(resolveLocalSecretPayload({
      dataDir,
      secretRef: SECRET_REF,
      expectedScope: expectedScope()
    })).rejects.toMatchObject({ code: "local_secret_revoked" });

    const entries = await listLocalSecretEntries({ dataDir });
    expect(entries).toEqual([revoked.secret]);
    const values = await fs.readdir(path.join(dataDir, "secrets", "values"));
    expect(values).toEqual([]);
    const auditText = await fs.readFile(path.join(dataDir, "secrets", "audit.jsonl"), "utf8");
    expect(auditText).not.toContain(MATERIAL_ALPHA);
    expect(auditText).not.toContain(MATERIAL_BETA);
    expect(auditText).not.toContain(dataDir);
  });

  it("serializes cross-process rotations so one expected revision commits once", async () => {
    await initializeLocalSecret({ dataDir, target, payload: { token: MATERIAL_ALPHA } });
    const rotationArgs = ["--target-file", targetFile, "--expected-revision", "1", "--token-stdin"];
    const attempts = await Promise.all([
      runCliAsync("rotate", rotationArgs, MATERIAL_BETA),
      runCliAsync("rotate", rotationArgs, MATERIAL_GAMMA)
    ]);
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([0, 1]);
    const success = attempts.find((attempt) => attempt.status === 0);
    const conflict = attempts.find((attempt) => attempt.status === 1);
    expect(JSON.parse(success.stdout).secret.revision).toBe(2);
    expect(conflict.stderr).toContain("revision conflict");
    expect(conflict.stderr).not.toContain(MATERIAL_BETA);
    expect(conflict.stderr).not.toContain(MATERIAL_GAMMA);

    const resolved = await resolveLocalSecretPayload({
      dataDir,
      secretRef: SECRET_REF,
      expectedScope: expectedScope()
    });
    expect([MATERIAL_BETA, MATERIAL_GAMMA]).toContain(resolved.payload.token);
    expect(resolved.revision).toBe(2);
    const valueFiles = await fs.readdir(path.join(dataDir, "secrets", "values"));
    expect(valueFiles).toHaveLength(1);
    await expect(fs.access(path.join(dataDir, "secrets", ".mutation.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims an abandoned mutation lock before committing a write", async () => {
    const secretDir = path.join(dataDir, "secrets");
    const lockPath = path.join(secretDir, ".mutation.lock");
    await fs.mkdir(secretDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(lockPath, `${JSON.stringify({
      token: "abandoned-lock-fixture",
      pid: 0,
      createdAt: "2000-01-01T00:00:00.000Z"
    })}\n`, { mode: 0o600 });

    const initialized = await initializeLocalSecret({
      dataDir,
      target,
      payload: { token: MATERIAL_ALPHA }
    });

    expect(initialized.secret).toMatchObject({ secretRef: SECRET_REF, revision: 1, status: "active" });
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("local secret CLI", () => {
  it("uses the explicit target file and keeps secret material and storage paths out of stdout", async () => {
    const initialized = runCli("init", ["--target-file", targetFile, "--token-stdin"], `${MATERIAL_ALPHA}\n`);
    expect(initialized.status).toBe(0);
    expect(initialized.stderr).toBe("");
    const initializedJson = JSON.parse(initialized.stdout);
    expect(initializedJson.secret).toMatchObject({ secretRef: SECRET_REF, revision: 1, status: "active" });
    expect(initialized.stdout).not.toContain(MATERIAL_ALPHA);
    expect(initialized.stdout).not.toContain(dataDir);
    expect(initialized.stdout).not.toContain("storageRef");

    const listed = runCli("list");
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ count: 1 });
    expect(listed.stdout).not.toContain(dataDir);

    const status = runCli("status");
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ count: 1, activeCount: 1, revokedCount: 0 });
  });

  it("rejects secret-bearing argv bodies and requires an explicit env payload key", () => {
    const argvPayload = runCli("init", ["--target-file", targetFile, "--body", MATERIAL_ALPHA]);
    expect(argvPayload.status).toBe(1);
    expect(argvPayload.stderr).toContain("--body is not supported");
    expect(argvPayload.stderr).not.toContain(MATERIAL_ALPHA);

    const envPayload = spawnSync(process.execPath, cliArgs("init", [
      "--target-file",
      targetFile,
      "--from-env",
      "LICO_TEST_SECRET_MATERIAL"
    ]), {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, LICO_TEST_SECRET_MATERIAL: MATERIAL_ALPHA }
    });
    expect(envPayload.status).toBe(1);
    expect(envPayload.stderr).toContain("--payload-key is required");
    expect(envPayload.stderr).not.toContain(MATERIAL_ALPHA);
  });
});
