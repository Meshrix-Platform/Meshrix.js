import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import { listStorageBackups } from "../../../packages/foundation/src/storage/backup-query.mjs";
import { createStorageBackup } from "../../../packages/foundation/src/storage/backup-snapshot.mjs";
import { BACKUP_RESTORE_PROTOCOL_VERSION } from "../../../packages/foundation/src/storage/backup-contract.mjs";
import { restoreStorageBackup } from "../../../packages/foundation/src/storage/restore-execution.mjs";
import { createStorageKernel } from "../../../packages/foundation/src/storage/storage-kernel.mjs";
import { createStorageProvider } from "../../../packages/foundation/src/storage/storage-provider.mjs";
import { acquireStorageRuntimeLease } from "../../../packages/foundation/src/storage/storage-lifecycle-lock.mjs";
import { executeStorageOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/storage-client-monitor-executors.mjs";
import {
  classifyProtocolSubstrateStorageArtifact,
  PROTOCOL_SUBSTRATE_STORAGE_CATEGORY
} from "#lico/foundation/checkpoint/tree/data-structure-substrate";
import { createLicoPactiumRuntime } from "#lico/foundation/checkpoint/tree/pactium-substrate-preflight";

const tempRoots = [];

async function tempDir(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeFixture(root, relativePath, content = "") {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, String(content), "utf8");
  return filePath;
}

function backupFilePath(root, backupId, relativePath) {
  return path.join(root, "backups", backupId, "files", relativePath);
}

async function terminatedProcessPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return pid;
}

async function currentProcessLeaseIdentity() {
  const userDataPath = await tempDir("lico-storage-process-identity-");
  const lease = acquireStorageRuntimeLease(userDataPath);
  try {
    const record = JSON.parse(await fs.readFile(
      path.join(userDataPath, "locks", "storage-runtime.lease"),
      "utf8"
    ));
    return {
      value: String(record.processIdentity || ""),
      source: String(record.processIdentitySource || "")
    };
  } finally {
    lease.release();
  }
}

function differentProcessIdentity(identity) {
  return `${identity.startsWith("0") ? "1" : "0"}${identity.slice(1)}`;
}

async function waitForPath(filePath, attempts = 250) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function createFifo(filePath) {
  const child = spawn("mkfifo", [filePath], { stdio: "ignore" });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (exit.code !== 0 || exit.signal) throw new Error("FIFO fixture creation failed.");
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe("storage backup restore", () => {
  it("createStorageBackup skips excluded top-level directories and classifies files", async () => {
    const userDataPath = await tempDir("lico-backup-classify-");
    await writeFixture(userDataPath, "auth/token.json", JSON.stringify({ token: "abc" }));
    await writeFixture(userDataPath, "jobs/queue.json", JSON.stringify({ state: "queued" }));
    await writeFixture(userDataPath, "objects/index.dat", "objects");
    await writeFixture(userDataPath, "generic-files/blob.bin", "raw data");
    await writeFixture(userDataPath, "protocol/core/runtime-state.json", JSON.stringify({ value: { ok: true } }));
    const fixtureDatabase = new Database(path.join(userDataPath, "state.sqlite"));
    fixtureDatabase.exec("CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO fixture (value) VALUES ('ready');");
    fixtureDatabase.close();
    await writeFixture(userDataPath, "state.json", "{\"ok\":true}");
    await writeFixture(userDataPath, "app.yaml", "node: 1");
    await writeFixture(userDataPath, "notes/readme.txt", "plain text");
    await writeFixture(userDataPath, "nested/a/b/c.md", "# markdown");
    await writeFixture(userDataPath, "backups/old/should-not-backup.txt", "ignored");
    await writeFixture(userDataPath, "logs/error.log", "ignored");
    await writeFixture(userDataPath, "tmp/cache.dat", "ignored");

    const manifest = await createStorageBackup({
      userDataPath,
      label: "scope",
      artifactClassifiers: [classifyProtocolSubstrateStorageArtifact]
    });

    expect(manifest.protocolVersion).toBe(BACKUP_RESTORE_PROTOCOL_VERSION);
    expect(manifest.label).toBe("scope");
    expect(manifest.summary.fileCount).toBe(10);
    expect(manifest.summary.byCategory).toMatchObject({
      auth: 1,
      jobs: 1,
      object: 1,
      [PROTOCOL_SUBSTRATE_STORAGE_CATEGORY]: 1,
      database: 1,
      "json-state": 1,
      config: 1,
      file: 3
    });

    const paths = new Set(manifest.files.map((item) => item.relativePath));
    expect(paths.has("backups/old/should-not-backup.txt")).toBe(false);
    expect(paths.has("logs/error.log")).toBe(false);
    expect(paths.has("tmp/cache.dat")).toBe(false);

    expect(paths.has("auth/token.json")).toBe(true);
    expect(paths.has("jobs/queue.json")).toBe(true);
    expect(paths.has("objects/index.dat")).toBe(true);
    expect(paths.has("generic-files/blob.bin")).toBe(true);
    expect(paths.has("protocol/core/runtime-state.json")).toBe(true);
    expect(paths.has("state.sqlite")).toBe(true);
    expect(paths.has("state.json")).toBe(true);
    expect(paths.has("app.yaml")).toBe(true);
    expect(paths.has("notes/readme.txt")).toBe(true);
    expect(paths.has("nested/a/b/c.md")).toBe(true);
  });

  it("listStorageBackups returns empty for missing backup root and ignores malformed entries", async () => {
    const userDataPath = await tempDir("lico-backup-list-missing-");
    const emptyListing = await listStorageBackups({ userDataPath });
    expect(emptyListing).toEqual({
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: BACKUP_RESTORE_PROTOCOL_VERSION,
      catalogRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      backups: []
    });

    const validBackup = await createStorageBackup({ userDataPath, label: "valid" });
    const invalidBackupId = "not-a-backup-id";
    const invalidDir = path.join(userDataPath, "backups", invalidBackupId);
    await fs.mkdir(invalidDir, { recursive: true });
    await writeFixture(invalidDir, "backup-manifest.json", JSON.stringify({
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: "other.protocol",
      backupId: invalidBackupId,
      createdAt: "1999-01-01T00:00:00.000Z",
      summary: { fileCount: 0, bytes: 0, byCategory: {} },
      files: []
    }));
    await fs.mkdir(path.join(invalidDir, "files"), { recursive: true });

    const catalogPath = path.join(userDataPath, "backups", "backup-catalog.json");
    const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
    expect(catalog.backups.map((entry) => entry.backupId)).toEqual([validBackup.backupId]);
    await fs.writeFile(catalogPath, "{invalid", "utf8");

    const listing = await listStorageBackups({ userDataPath });
    expect(listing.backups).toHaveLength(1);
    expect(listing.backups[0].backupId).toBe(validBackup.backupId);
    expect(new Date(listing.backups[0].createdAt).getTime()).toBeGreaterThan(0);
    expect(JSON.parse(await fs.readFile(catalogPath, "utf8")).backups)
      .toHaveLength(1);
  });

  it("restoreStorageBackup validates backupId and include path constraints", async () => {
    const userDataPath = await tempDir("lico-backup-restore-validate-");
    const manifest = await createStorageBackup({ userDataPath, label: "validated" });

    await expect(
      restoreStorageBackup({
        userDataPath,
        backupId: "bad backup id",
        includePaths: []
      })
    ).rejects.toThrow("Invalid backupId.");

    await expect(
      restoreStorageBackup({
        userDataPath,
        backupId: manifest.backupId,
        includePaths: ["../outside", "notes/readme.txt"]
      })
    ).rejects.toMatchObject({ code: "backup_path_invalid" });
  });

  it("restoreStorageBackup dry-run classifies create, replace and noop actions with include filtering", async () => {
    const userDataPath = await tempDir("lico-backup-restore-dryrun-");
    await writeFixture(userDataPath, "scope/keep.txt", "same-content");
    await writeFixture(userDataPath, "scope/replace.txt", "old-content");
    await writeFixture(userDataPath, "scope/create.txt", "will-be-removed");

    const manifest = await createStorageBackup({ userDataPath, label: "dry-run" });
    await writeFixture(userDataPath, "scope/replace.txt", "changed-content");
    await fs.rm(path.join(userDataPath, "scope/create.txt"), { force: true });

    const report = await restoreStorageBackup({
      userDataPath,
      backupId: manifest.backupId,
      includePaths: ["scope"]
    });

    expect(report.dryRun).toBe(true);
    expect(report.applied).toBe(false);
    expect(report.selectedFileCount).toBe(3);
    expect(report.summary).toMatchObject({
      create: 1,
      replace: 1,
      noop: 1,
      blocked: 0
    });

    const actions = Object.fromEntries(report.plannedActions.map((item) => [item.relativePath, item]));
    expect(actions["scope/create.txt"]).toMatchObject({
      action: "create",
      reason: "target_missing",
      expectedSha256: expect.any(String)
    });
    expect(actions["scope/replace.txt"]).toMatchObject({
      action: "replace",
      reason: "hash_mismatch",
      currentSha256: expect.any(String),
      expectedSha256: expect.any(String)
    });
    expect(actions["scope/keep.txt"]).toMatchObject({
      action: "noop",
      reason: "hash_match"
    });
  });

  it("restoreStorageBackup marks blocked entries when backup files are missing", async () => {
    const userDataPath = await tempDir("lico-backup-restore-blocked-");
    await writeFixture(userDataPath, "scope/blocked.txt", "missing-backup-file");

    const manifest = await createStorageBackup({ userDataPath, label: "blocked" });
    await fs.rm(backupFilePath(userDataPath, manifest.backupId, "scope/blocked.txt"), { force: true });

    const preview = await restoreStorageBackup({
      userDataPath,
      backupId: manifest.backupId,
      includePaths: ["scope/blocked.txt"]
    });

    expect(preview.summary.blocked).toBe(1);
    expect(preview.plannedActions).toHaveLength(1);
    expect(preview.plannedActions[0]).toMatchObject({
      relativePath: "scope/blocked.txt",
      action: "blocked",
      reason: "backup_file_missing"
    });

    await expect(
      restoreStorageBackup({
        userDataPath,
        backupId: manifest.backupId,
        dryRun: false,
        apply: true,
        includePaths: ["scope/blocked.txt"]
      })
    ).rejects.toMatchObject({
      code: "storage_restore_integrity_failed",
      detailReasonCode: "backup_file_missing"
    });
  });

  it("restoreStorageBackup apply branch writes report and performs target updates", async () => {
    const userDataPath = await tempDir("lico-backup-restore-apply-");
    await writeFixture(userDataPath, "restore/keep.txt", "stable");
    await writeFixture(userDataPath, "restore/replace.txt", "old-content");
    await writeFixture(userDataPath, "restore/create.txt", "will be recreated");

    const manifest = await createStorageBackup({ userDataPath, label: "apply" });
    await fs.writeFile(path.join(userDataPath, "restore/replace.txt"), "changed", "utf8");
    await fs.rm(path.join(userDataPath, "restore/create.txt"), { force: true });

    const report = await restoreStorageBackup({
      userDataPath,
      backupId: manifest.backupId,
      dryRun: false,
      apply: true,
      includePaths: ["restore"]
    });

    expect(report.applied).toBe(true);
    expect(report.dryRun).toBe(false);
    expect(report.summary).toMatchObject({
      create: 1,
      replace: 1,
      noop: 1
    });
    expect(typeof report.reportPath).toBe("string");

    await expect(fs.access(report.reportPath)).resolves.toBeUndefined();
    const reportData = JSON.parse(await fs.readFile(report.reportPath, "utf8"));
    expect(reportData.applied).toBe(true);
    expect(reportData.dryRun).toBe(false);
    expect(reportData.selectedFileCount).toBe(3);

    expect(await fs.readFile(path.join(userDataPath, "restore/create.txt"), "utf8")).toBe("will be recreated");
    expect(await fs.readFile(path.join(userDataPath, "restore/replace.txt"), "utf8")).toBe("old-content");
    expect(await fs.readFile(path.join(userDataPath, "restore/keep.txt"), "utf8")).toBe("stable");
  });

  it("creates a verified online SQLite snapshot without copying transient WAL sidecars", async () => {
    const userDataPath = await tempDir("lico-backup-sqlite-online-");
    const databasePath = path.join(userDataPath, "metadata", "runtime.sqlite");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const liveDatabase = new Database(databasePath);
    try {
      liveDatabase.pragma("journal_mode = WAL");
      liveDatabase.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      liveDatabase.prepare("INSERT INTO records (value) VALUES (?)").run("snapshot-row");

      const manifest = await createStorageBackup({ userDataPath, label: "sqlite-online" });
      const snapshotPath = backupFilePath(userDataPath, manifest.backupId, "metadata/runtime.sqlite");
      const snapshotDatabase = new Database(snapshotPath, { readonly: true, fileMustExist: true });
      try {
        expect(snapshotDatabase.prepare("SELECT value FROM records").pluck().all())
          .toEqual(["snapshot-row"]);
        expect(snapshotDatabase.pragma("quick_check", { simple: true })).toBe("ok");
      } finally {
        snapshotDatabase.close();
      }
      expect(manifest.files.map((entry) => entry.relativePath)).toContain("metadata/runtime.sqlite");
      expect(manifest.files.some((entry) => entry.relativePath.endsWith("-wal"))).toBe(false);
      expect(manifest.consistency.sqlite).toBe("copy-on-write-baseline-with-sqlite-online-page-backup");
    } finally {
      liveDatabase.close();
    }
  });

  it("replaces a byte-identical SQLite main file when recovery sidecars contain post-backup state", async () => {
    const userDataPath = await tempDir("lico-backup-sqlite-sidecar-restore-");
    const databasePath = path.join(userDataPath, "metadata", "runtime.sqlite");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const liveDatabase = new Database(databasePath);
    let walBytes = null;
    let shmBytes = null;
    let manifest = null;
    try {
      liveDatabase.pragma("journal_mode = WAL");
      liveDatabase.pragma("wal_autocheckpoint = 0");
      liveDatabase.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      liveDatabase.prepare("INSERT INTO records (value) VALUES (?)").run("backup-row");
      liveDatabase.pragma("wal_checkpoint(TRUNCATE)");
      manifest = await createStorageBackup({ userDataPath, label: "sqlite-sidecar-restore" });
      liveDatabase.prepare("INSERT INTO records (value) VALUES (?)").run("post-backup-row");
      walBytes = await fs.readFile(`${databasePath}-wal`);
      shmBytes = await fs.readFile(`${databasePath}-shm`);
    } finally {
      liveDatabase.close();
    }

    const snapshotPath = backupFilePath(userDataPath, manifest.backupId, "metadata/runtime.sqlite");
    await fs.copyFile(snapshotPath, databasePath);
    await fs.writeFile(`${databasePath}-wal`, walBytes);
    await fs.writeFile(`${databasePath}-shm`, shmBytes);
    const databaseEntry = manifest.files.find((entry) => entry.relativePath === "metadata/runtime.sqlite");
    expect(createHash("sha256").update(await fs.readFile(databasePath)).digest("hex"))
      .toBe(databaseEntry.sha256);

    const crashView = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      expect(crashView.prepare("SELECT value FROM records ORDER BY id").pluck().all())
        .toEqual(["backup-row", "post-backup-row"]);
    } finally {
      crashView.close();
    }

    const preview = await restoreStorageBackup({
      userDataPath,
      backupId: manifest.backupId,
      includePaths: ["metadata/runtime.sqlite"]
    });
    expect(preview.plannedActions).toEqual([
      expect.objectContaining({
        relativePath: "metadata/runtime.sqlite",
        action: "replace",
        reason: "sqlite_sidecar_present"
      })
    ]);

    await restoreStorageBackup({
      userDataPath,
      backupId: manifest.backupId,
      dryRun: false,
      apply: true,
      includePaths: ["metadata/runtime.sqlite"]
    });
    await expect(fs.stat(`${databasePath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${databasePath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    const restored = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      expect(restored.prepare("SELECT value FROM records ORDER BY id").pluck().all())
        .toEqual(["backup-row"]);
    } finally {
      restored.close();
    }
  });

  it("uses SQLite online backup and sidecar-safe restore for nested auth and Pactium databases", async () => {
    const userDataPath = await tempDir("lico-backup-nested-sqlite-");
    const databasePaths = [
      path.join(userDataPath, "auth", "sessions.sqlite"),
      path.join(userDataPath, "pactium.sqlite")
    ];
    const openDatabases = [];
    const recoveryBytes = new Map();
    let manifest = null;
    try {
      for (const databasePath of databasePaths) {
        await fs.mkdir(path.dirname(databasePath), { recursive: true });
        const database = new Database(databasePath);
        database.pragma("journal_mode = WAL");
        database.pragma("wal_autocheckpoint = 0");
        database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
        database.prepare("INSERT INTO records (value) VALUES (?)").run("backup-row");
        database.pragma("wal_checkpoint(TRUNCATE)");
        openDatabases.push({ database, databasePath });
      }

      manifest = await createStorageBackup({ userDataPath, label: "nested-sqlite" });
      for (const { database, databasePath } of openDatabases) {
        database.prepare("INSERT INTO records (value) VALUES (?)").run("post-backup-row");
        recoveryBytes.set(databasePath, {
          wal: await fs.readFile(`${databasePath}-wal`),
          shm: await fs.readFile(`${databasePath}-shm`)
        });
      }
    } finally {
      for (const { database } of openDatabases) database.close();
    }

    const entries = Object.fromEntries(manifest.files.map((entry) => [entry.relativePath, entry]));
    expect(entries["auth/sessions.sqlite"].category).toBe("auth");
    expect(entries["pactium.sqlite"].category).toBe("database");
    for (const databasePath of databasePaths) {
      const relativePath = path.relative(userDataPath, databasePath).replace(/\\/g, "/");
      const snapshotPath = backupFilePath(userDataPath, manifest.backupId, relativePath);
      const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
      try {
        expect(snapshot.prepare("SELECT value FROM records ORDER BY id").pluck().all())
          .toEqual(["backup-row"]);
      } finally {
        snapshot.close();
      }
      await fs.copyFile(snapshotPath, databasePath);
      await fs.writeFile(`${databasePath}-wal`, recoveryBytes.get(databasePath).wal);
      await fs.writeFile(`${databasePath}-shm`, recoveryBytes.get(databasePath).shm);
    }

    const preview = await restoreStorageBackup({
      userDataPath,
      backupId: manifest.backupId,
      includePaths: ["auth/sessions.sqlite", "pactium.sqlite"]
    });
    expect(preview.restoreSemantics).toBe("overlay");
    expect(preview.plannedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "auth/sessions.sqlite", action: "replace", reason: "sqlite_sidecar_present" }),
      expect.objectContaining({ relativePath: "pactium.sqlite", action: "replace", reason: "sqlite_sidecar_present" })
    ]));

    await restoreStorageBackup({
      userDataPath,
      backupId: manifest.backupId,
      dryRun: false,
      apply: true,
      includePaths: ["auth/sessions.sqlite", "pactium.sqlite"]
    });
    for (const databasePath of databasePaths) {
      await expect(fs.stat(`${databasePath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(`${databasePath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
      const restored = new Database(databasePath, { readonly: true, fileMustExist: true });
      try {
        expect(restored.prepare("SELECT value FROM records ORDER BY id").pluck().all())
          .toEqual(["backup-row"]);
      } finally {
        restored.close();
      }
    }
  });

  it("uses replacement semantics for full restore and overlay semantics for filtered restore", async () => {
    const userDataPath = await tempDir("lico-backup-replacement-");
    await writeFixture(userDataPath, "scope/baseline.txt", "backup-scope");
    await writeFixture(userDataPath, "other/baseline.txt", "backup-other");
    const manifest = await createStorageBackup({ userDataPath, label: "replacement" });
    await fs.writeFile(path.join(userDataPath, "scope", "baseline.txt"), "drifted-scope", "utf8");
    await writeFixture(userDataPath, "scope/post-backup.txt", "keep-during-overlay");
    await writeFixture(userDataPath, "other/post-backup.txt", "remove-during-replacement");

    const overlay = await restoreStorageBackup({
      userDataPath,
      backupId: manifest.backupId,
      dryRun: false,
      apply: true,
      includePaths: ["scope"]
    });
    expect(overlay.restoreSemantics).toBe("overlay");
    expect(overlay.summary.delete).toBe(0);
    expect(await fs.readFile(path.join(userDataPath, "scope", "post-backup.txt"), "utf8"))
      .toBe("keep-during-overlay");
    expect(await fs.readFile(path.join(userDataPath, "other", "post-backup.txt"), "utf8"))
      .toBe("remove-during-replacement");

    const preview = await restoreStorageBackup({
      userDataPath,
      backupId: manifest.backupId
    });
    expect(preview.restoreSemantics).toBe("replacement");
    expect(preview.summary.delete).toBe(2);
    expect(preview.plannedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "scope/post-backup.txt", action: "delete", reason: "not_in_backup" }),
      expect.objectContaining({ relativePath: "other/post-backup.txt", action: "delete", reason: "not_in_backup" })
    ]));

    const replacement = await restoreStorageBackup({
      userDataPath,
      backupId: manifest.backupId,
      dryRun: false,
      apply: true
    });
    expect(replacement.restoreSemantics).toBe("replacement");
    expect(replacement.summary.delete).toBe(2);
    await expect(fs.stat(path.join(userDataPath, "scope", "post-backup.txt")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(userDataPath, "other", "post-backup.txt")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects malformed includePaths without expanding to replacement semantics", async () => {
    const userDataPath = await tempDir("lico-backup-invalid-include-paths-");
    await writeFixture(userDataPath, "scope/baseline.txt", "backup-scope");
    const manifest = await createStorageBackup({ userDataPath, label: "invalid-include-paths" });
    await writeFixture(userDataPath, "outside/post-backup.txt", "must-survive");

    await expect(restoreStorageBackup({
      userDataPath,
      backupId: manifest.backupId,
      dryRun: false,
      apply: true,
      includePaths: "scope"
    })).rejects.toMatchObject({ code: "restore_include_paths_invalid" });

    expect(await fs.readFile(path.join(userDataPath, "outside/post-backup.txt"), "utf8"))
      .toBe("must-survive");
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when replacement restore encounters an ungoverned symlink or FIFO",
    async () => {
      const userDataPath = await tempDir("lico-backup-special-artifact-");
      const outsideRoot = await tempDir("lico-backup-special-target-");
      await writeFixture(userDataPath, "scope/baseline.txt", "backup-generation");
      const manifest = await createStorageBackup({ userDataPath, label: "special-artifact" });
      const outsidePath = await writeFixture(outsideRoot, "external.json", "external-generation");
      const symlinkPath = path.join(userDataPath, "settings.json");
      await fs.symlink(outsidePath, symlinkPath);

      await expect(restoreStorageBackup({
        userDataPath,
        backupId: manifest.backupId,
        dryRun: false,
        apply: true
      })).rejects.toMatchObject({ code: "storage_artifact_type_unsupported" });
      expect((await fs.lstat(symlinkPath)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(outsidePath, "utf8")).toBe("external-generation");

      await fs.unlink(symlinkPath);
      const fifoPath = path.join(userDataPath, "post-backup.pipe");
      await createFifo(fifoPath);
      await expect(restoreStorageBackup({
        userDataPath,
        backupId: manifest.backupId,
        dryRun: false,
        apply: true
      })).rejects.toMatchObject({ code: "storage_artifact_type_unsupported" });
      expect((await fs.lstat(fifoPath)).isFIFO()).toBe(true);
    }
  );

  it("recovers a SIGKILL-interrupted restore before the storage kernel opens", async () => {
    const userDataPath = await tempDir("lico-backup-crash-recovery-");
    await writeFixture(userDataPath, "scope/a.txt", "backup-a");
    await writeFixture(userDataPath, "scope/b.txt", "backup-b");
    const manifest = await createStorageBackup({ userDataPath, label: "crash-recovery" });
    await fs.writeFile(path.join(userDataPath, "scope/a.txt"), "active-a", "utf8");
    await fs.writeFile(path.join(userDataPath, "scope/b.txt"), "active-b", "utf8");
    const signalPath = path.join(userDataPath, "logs", "restore-crash-ready");
    const moduleUrl = new URL(
      "../../../packages/foundation/src/storage/restore-execution.mjs",
      import.meta.url
    ).href;
    const childSource = `
      import fs from "node:fs/promises";
      const originalRename = fs.rename.bind(fs);
      fs.rename = async (sourcePath, targetPath) => {
        const result = await originalRename(sourcePath, targetPath);
        const source = String(sourcePath).replace(/\\\\/g, "/");
        const target = String(targetPath).replace(/\\\\/g, "/");
        if (source.includes("/tmp/storage-restore-") && source.endsWith("/files/scope/a.txt") && target.endsWith("/scope/a.txt")) {
          await fs.mkdir(new URL(".", "file://" + process.env.SIGNAL_PATH).pathname, { recursive: true }).catch(() => {});
          await fs.writeFile(process.env.SIGNAL_PATH, "ready", "utf8");
          await new Promise(() => setInterval(() => {}, 1_000));
        }
        return result;
      };
      const { restoreStorageBackup } = await import(process.env.BACKUP_MODULE_URL);
      await restoreStorageBackup({
        userDataPath: process.env.USER_DATA_PATH,
        backupId: process.env.BACKUP_ID,
        dryRun: false,
        apply: true,
        includePaths: ["scope"]
      });
    `;
    await fs.mkdir(path.dirname(signalPath), { recursive: true });
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BACKUP_MODULE_URL: moduleUrl,
        USER_DATA_PATH: userDataPath,
        BACKUP_ID: manifest.backupId,
        SIGNAL_PATH: signalPath
      },
      stdio: "ignore"
    });
    let exited = false;
    const exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        exited = true;
        resolve({ code, signal });
      });
    });
    let signalled = false;
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await fs.access(signalPath);
        signalled = true;
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (exited) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(signalled).toBe(true);
    child.kill("SIGKILL");
    const exit = await exitPromise;
    expect(exit.signal).toBe("SIGKILL");

    expect(await fs.readFile(path.join(userDataPath, "scope/a.txt"), "utf8")).toBe("backup-a");
    expect(await fs.readFile(path.join(userDataPath, "scope/b.txt"), "utf8")).toBe("active-b");
    const storageKernel = createStorageKernel({ userDataPath });
    storageKernel.close();
    expect(await fs.readFile(path.join(userDataPath, "scope/a.txt"), "utf8")).toBe("active-a");
    expect(await fs.readFile(path.join(userDataPath, "scope/b.txt"), "utf8")).toBe("active-b");
    const transactionEntries = await fs.readdir(path.join(userDataPath, "tmp"));
    expect(transactionEntries.filter((name) => name.includes("storage-restore-"))).toEqual([]);
  }, 15_000);

  it("finalizes a durable committed generation after SIGKILL before receipt publication", async () => {
    const userDataPath = await tempDir("lico-backup-commit-recovery-");
    await writeFixture(userDataPath, "scope/value.txt", "backup-generation");
    const manifest = await createStorageBackup({ userDataPath, label: "commit-recovery" });
    await fs.writeFile(path.join(userDataPath, "scope/value.txt"), "active-generation", "utf8");
    const signalPath = path.join(userDataPath, "logs", "restore-commit-ready");
    const moduleUrl = new URL(
      "../../../packages/foundation/src/storage/restore-execution.mjs",
      import.meta.url
    ).href;
    const childSource = `
      import fs from "node:fs/promises";
      import path from "node:path";
      const originalRename = fs.rename.bind(fs);
      fs.rename = async (sourcePath, targetPath) => {
        const result = await originalRename(sourcePath, targetPath);
        if (String(targetPath).endsWith("/restore-transaction.json")) {
          const journal = JSON.parse(await fs.readFile(targetPath, "utf8"));
          if (journal.phase === "commit-complete") {
            const directory = await fs.open(path.dirname(targetPath), "r");
            await directory.sync();
            await directory.close();
            await fs.writeFile(process.env.SIGNAL_PATH, "ready", "utf8");
            await new Promise(() => setInterval(() => {}, 1_000));
          }
        }
        return result;
      };
      const { restoreStorageBackup } = await import(process.env.BACKUP_MODULE_URL);
      await restoreStorageBackup({
        userDataPath: process.env.USER_DATA_PATH,
        backupId: process.env.BACKUP_ID,
        dryRun: false,
        apply: true,
        includePaths: ["scope"]
      });
    `;
    await fs.mkdir(path.dirname(signalPath), { recursive: true });
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BACKUP_MODULE_URL: moduleUrl,
        USER_DATA_PATH: userDataPath,
        BACKUP_ID: manifest.backupId,
        SIGNAL_PATH: signalPath
      },
      stdio: "ignore"
    });
    let exited = false;
    const exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        exited = true;
        resolve({ code, signal });
      });
    });
    let signalled = false;
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await fs.access(signalPath);
        signalled = true;
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (exited) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(signalled).toBe(true);
    child.kill("SIGKILL");
    const exit = await exitPromise;
    expect(exit.signal).toBe("SIGKILL");
    expect(await fs.readFile(path.join(userDataPath, "scope/value.txt"), "utf8"))
      .toBe("backup-generation");

    const storageKernel = createStorageKernel({ userDataPath });
    storageKernel.close();
    expect(await fs.readFile(path.join(userDataPath, "scope/value.txt"), "utf8"))
      .toBe("backup-generation");
    const receipts = await fs.readdir(
      path.join(userDataPath, "backups", manifest.backupId, "restore-reports")
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatch(/^restore_.+\.json$/u);
    const transactionEntries = await fs.readdir(path.join(userDataPath, "tmp"));
    expect(transactionEntries.filter((name) => name.includes("storage-restore-"))).toEqual([]);
  }, 15_000);

  it("fails the entire unpublished backup when a source mutates during its copy", async () => {
    const userDataPath = await tempDir("lico-backup-concurrent-mutation-");
    const sourcePath = await writeFixture(userDataPath, "state/live.json", JSON.stringify({ generation: 1 }));
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (filePath, ...args) => {
      const handle = await originalOpen(filePath, ...args);
      if (path.resolve(String(filePath)) === path.resolve(sourcePath)) {
        const originalStat = handle.stat.bind(handle);
        let statCount = 0;
        Object.defineProperty(handle, "stat", {
          configurable: true,
          value: async (...statArgs) => {
            statCount += 1;
            if (statCount === 2) await fs.appendFile(sourcePath, "\nmutation", "utf8");
            return originalStat(...statArgs);
          }
        });
      }
      return handle;
    });

    await expect(createStorageBackup({ userDataPath, label: "mutation" }))
      .rejects.toMatchObject({ code: "backup_source_changed" });
    expect((await listStorageBackups({ userDataPath })).backups).toEqual([]);
  });

  it("rejects insufficient filesystem capacity before creating snapshot files", async () => {
    const userDataPath = await tempDir("lico-backup-capacity-preflight-");
    await writeFixture(userDataPath, "state/large.bin", "x".repeat(1024));
    vi.spyOn(fs, "statfs").mockResolvedValue({
      bavail: 1n,
      bsize: 4096n
    });

    await expect(createStorageBackup({ userDataPath, label: "capacity" }))
      .rejects.toMatchObject({ code: "storage_backup_capacity_insufficient" });
    const backupEntries = await fs.readdir(path.join(userDataPath, "backups"));
    expect(backupEntries.some((name) => name.endsWith(".pending"))).toBe(false);
    expect((await listStorageBackups({ userDataPath })).backups).toEqual([]);
  });

  it("uses copy-on-write cloning when the filesystem supports reflinks", async () => {
    const userDataPath = await tempDir("lico-backup-copy-on-write-");
    await writeFixture(userDataPath, "state/value.bin", "stable-content");
    const copyFile = vi.spyOn(fs, "copyFile");

    const manifest = await createStorageBackup({ userDataPath, label: "copy-on-write" });
    const entry = manifest.files.find((item) => item.relativePath === "state/value.bin");
    expect(entry.copyMethod).toMatch(/^(copy-on-write|stream-copy)$/);
    if (entry.copyMethod === "copy-on-write") {
      expect(copyFile).toHaveBeenCalledWith(
        path.join(userDataPath, "state/value.bin"),
        backupFilePath(userDataPath, manifest.backupId, "state/value.bin"),
        fsSync.constants.COPYFILE_FICLONE_FORCE
      );
    }
  });

  it("removes abandoned unpublished backup staging before the next snapshot", async () => {
    const userDataPath = await tempDir("lico-backup-pending-recovery-");
    const pendingPath = path.join(userDataPath, "backups", ".backup_stale.pending");
    await fs.mkdir(pendingPath, { recursive: true });
    await fs.writeFile(path.join(pendingPath, "partial"), "partial", "utf8");
    await writeFixture(userDataPath, "state/value.json", "{}");

    const manifest = await createStorageBackup({ userDataPath, label: "recovered" });
    await expect(fs.stat(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await listStorageBackups({ userDataPath })).backups.map((item) => item.backupId))
      .toEqual([manifest.backupId]);
  });

  it("verifies manifest size and digest for every selected restore file", async () => {
    const userDataPath = await tempDir("lico-backup-tamper-");
    await writeFixture(userDataPath, "scope/hash.txt", "original");
    await writeFixture(userDataPath, "scope/size.txt", "stable");
    const manifest = await createStorageBackup({ userDataPath, label: "tamper" });
    await fs.writeFile(backupFilePath(userDataPath, manifest.backupId, "scope/hash.txt"), "tampered", "utf8");
    await fs.writeFile(backupFilePath(userDataPath, manifest.backupId, "scope/size.txt"), "different-size", "utf8");
    await fs.writeFile(path.join(userDataPath, "scope/hash.txt"), "active-hash", "utf8");
    await fs.writeFile(path.join(userDataPath, "scope/size.txt"), "active-size", "utf8");

    const preview = await restoreStorageBackup({
      userDataPath,
      backupId: manifest.backupId,
      includePaths: ["scope"]
    });
    const actions = Object.fromEntries(preview.plannedActions.map((action) => [action.relativePath, action]));
    expect(preview.integrity).toEqual({ verified: false, verifiedFileCount: 0, failedFileCount: 2 });
    expect(actions["scope/hash.txt"]).toMatchObject({ action: "blocked", reason: "backup_hash_mismatch" });
    expect(actions["scope/size.txt"]).toMatchObject({ action: "blocked", reason: "backup_size_mismatch" });

    await expect(restoreStorageBackup({
      userDataPath,
      backupId: manifest.backupId,
      dryRun: false,
      apply: true,
      includePaths: ["scope"]
    })).rejects.toMatchObject({ code: "storage_restore_integrity_failed" });
    expect(await fs.readFile(path.join(userDataPath, "scope/hash.txt"), "utf8")).toBe("active-hash");
    expect(await fs.readFile(path.join(userDataPath, "scope/size.txt"), "utf8")).toBe("active-size");
  });

  it("rejects online restore with a safe API reason code while leaving active state untouched", async () => {
    const userDataPath = await tempDir("lico-backup-online-restore-");
    await writeFixture(userDataPath, "settings.json", "baseline");
    const manifest = await createStorageBackup({ userDataPath, label: "offline-boundary" });
    await fs.writeFile(path.join(userDataPath, "settings.json"), "active", "utf8");
    const storageKernel = createStorageKernel({ userDataPath });
    const storageProvider = createStorageProvider({ userDataPath, storageKernel });
    try {
      const response = await executeStorageOperation({
        operationId: "storage.backups.restore",
        input: { backupId: manifest.backupId, confirm: true },
        context: { storageProvider }
      });
      expect(response).toMatchObject({
        status: 409,
        payload: {
          ok: false,
          reasonCode: "storage_restore_runtime_active"
        }
      });
      expect(await fs.readFile(path.join(userDataPath, "settings.json"), "utf8")).toBe("active");
    } finally {
      storageKernel.close();
    }
  });

  it("keeps the shared runtime lease until every standalone Pactium runtime closes", async () => {
    const userDataPath = await tempDir("lico-backup-pactium-shared-lease-");
    const seedRuntime = createLicoPactiumRuntime({ dataDir: userDataPath, storageBackend: "sqlite" });
    await seedRuntime.storage.putProtocolObject("test", "generation", { value: "backup" });
    await seedRuntime.close();
    const manifest = await createStorageBackup({ userDataPath, label: "pactium-shared-lease" });

    const firstRuntime = createLicoPactiumRuntime({ dataDir: userDataPath, storageBackend: "sqlite" });
    const secondRuntime = createLicoPactiumRuntime({ dataDir: userDataPath, storageBackend: "sqlite" });
    try {
      await Promise.all([firstRuntime.storage.initialize(), secondRuntime.storage.initialize()]);
      await expect(restoreStorageBackup({
        userDataPath,
        backupId: manifest.backupId,
        dryRun: false,
        apply: true
      })).rejects.toMatchObject({ code: "storage_restore_runtime_active" });

      await firstRuntime.close();
      await expect(restoreStorageBackup({
        userDataPath,
        backupId: manifest.backupId,
        dryRun: false,
        apply: true
      })).rejects.toMatchObject({ code: "storage_restore_runtime_active" });

      await secondRuntime.close();
      await expect(restoreStorageBackup({
        userDataPath,
        backupId: manifest.backupId,
        dryRun: false,
        apply: true
      })).resolves.toMatchObject({ applied: true });
    } finally {
      await firstRuntime.close().catch(() => {});
      await secondRuntime.close().catch(() => {});
    }
  });

  it("rejects confirmed restore while a standalone Pactium runtime is open in another process", async () => {
    const userDataPath = await tempDir("lico-backup-pactium-process-lease-");
    const seedRuntime = createLicoPactiumRuntime({ dataDir: userDataPath, storageBackend: "sqlite" });
    await seedRuntime.storage.putProtocolObject("test", "generation", { value: "backup" });
    await seedRuntime.close();
    const manifest = await createStorageBackup({ userDataPath, label: "pactium-process-lease" });
    const readyPath = path.join(userDataPath, "logs", "pactium-runtime-ready");
    const stopPath = path.join(userDataPath, "logs", "pactium-runtime-stop");
    const moduleUrl = new URL(
      "../../../packages/foundation/src/checkpoint/tree/pactium-substrate-preflight.mjs",
      import.meta.url
    ).href;
    const childSource = `
      import fs from "node:fs/promises";
      const { createLicoPactiumRuntime } = await import(process.env.PACTIUM_RUNTIME_MODULE_URL);
      const runtime = createLicoPactiumRuntime({
        dataDir: process.env.USER_DATA_PATH,
        storageBackend: "sqlite"
      });
      try {
        await runtime.storage.initialize();
        await fs.mkdir(new URL(".", "file://" + process.env.READY_PATH).pathname, { recursive: true });
        await fs.writeFile(process.env.READY_PATH, "ready", "utf8");
        while (true) {
          try {
            await fs.access(process.env.STOP_PATH);
            break;
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        await runtime.close();
      }
    `;
    await fs.mkdir(path.dirname(readyPath), { recursive: true });
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PACTIUM_RUNTIME_MODULE_URL: moduleUrl,
        USER_DATA_PATH: userDataPath,
        READY_PATH: readyPath,
        STOP_PATH: stopPath
      },
      stdio: "ignore"
    });
    const exitPromise = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    try {
      expect(await waitForPath(readyPath)).toBe(true);
      await expect(restoreStorageBackup({
        userDataPath,
        backupId: manifest.backupId,
        dryRun: false,
        apply: true
      })).rejects.toSatisfy((error) => [
        "storage_restore_runtime_active",
        "storage_restore_runtime_state_unknown"
      ].includes(error?.code));
      await fs.writeFile(stopPath, "stop", "utf8");
      await expect(exitPromise).resolves.toMatchObject({ code: 0, signal: null });
      await expect(restoreStorageBackup({
        userDataPath,
        backupId: manifest.backupId,
        dryRun: false,
        apply: true
      })).resolves.toMatchObject({ applied: true });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 15_000);

  it("rolls back every committed file when a later atomic install fails", async () => {
    const userDataPath = await tempDir("lico-backup-rollback-");
    await writeFixture(userDataPath, "scope/a.txt", "backup-a");
    await writeFixture(userDataPath, "scope/b.txt", "backup-b");
    const manifest = await createStorageBackup({ userDataPath, label: "rollback" });
    await fs.writeFile(path.join(userDataPath, "scope/a.txt"), "active-a", "utf8");
    await fs.writeFile(path.join(userDataPath, "scope/b.txt"), "active-b", "utf8");

    const originalRename = fs.rename.bind(fs);
    let injectedFailure = false;
    vi.spyOn(fs, "rename").mockImplementation(async (sourcePath, targetPath) => {
      const normalizedSource = String(sourcePath).replace(/\\/g, "/");
      const normalizedTarget = String(targetPath).replace(/\\/g, "/");
      if (
        !injectedFailure &&
        normalizedSource.includes("/tmp/storage-restore-") &&
        normalizedSource.endsWith("/files/scope/b.txt") &&
        normalizedTarget.endsWith("/scope/b.txt")
      ) {
        injectedFailure = true;
        const error = new Error("injected rename failure");
        error.code = "EIO";
        throw error;
      }
      return originalRename(sourcePath, targetPath);
    });

    await expect(restoreStorageBackup({
      userDataPath,
      backupId: manifest.backupId,
      dryRun: false,
      apply: true,
      includePaths: ["scope"]
    })).rejects.toMatchObject({ code: "storage_restore_commit_failed" });
    expect(injectedFailure).toBe(true);
    expect(await fs.readFile(path.join(userDataPath, "scope/a.txt"), "utf8")).toBe("active-a");
    expect(await fs.readFile(path.join(userDataPath, "scope/b.txt"), "utf8")).toBe("active-b");
  });

  it("cleans only a verifiable stale maintenance lease during runtime startup", async () => {
    const userDataPath = await tempDir("lico-storage-stale-maintenance-");
    const lockRoot = path.join(userDataPath, "locks");
    const maintenancePath = path.join(lockRoot, "storage-backup-restore.lock");
    const runtimePath = path.join(lockRoot, "storage-runtime.lease");
    await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const stalePid = await terminatedProcessPid();
    const currentIdentity = await currentProcessLeaseIdentity();
    await fs.writeFile(maintenancePath, JSON.stringify({
      schemaVersion: "v0.0.1:schema:definition-1",
      pid: stalePid,
      token: "11111111-1111-4111-8111-111111111111",
      processIdentity: "1".repeat(64),
      createdAt: new Date().toISOString()
    }), { mode: 0o600 });

    const lease = acquireStorageRuntimeLease(userDataPath);
    await expect(fs.stat(maintenancePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(runtimePath)).resolves.toMatchObject({ size: expect.any(Number) });
    lease.release();
    await expect(fs.stat(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });

    await fs.writeFile(maintenancePath, JSON.stringify({
      schemaVersion: "v0.0.1:schema:definition-1",
      pid: process.pid,
      token: "22222222-2222-4222-8222-222222222222",
      processIdentity: currentIdentity.value,
      processIdentitySource: currentIdentity.source,
      createdAt: new Date().toISOString()
    }), { mode: 0o600 });
    let activeError = null;
    try {
      acquireStorageRuntimeLease(userDataPath);
    } catch (error) {
      activeError = error;
    }
    expect(activeError).toMatchObject({ code: "storage_maintenance_active" });
    await expect(fs.stat(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });

    await fs.writeFile(maintenancePath, JSON.stringify({
      schemaVersion: "v0.0.1:schema:definition-1",
      pid: stalePid,
      token: "unverifiable-owner",
      processIdentity: "2".repeat(64),
      createdAt: new Date().toISOString()
    }), { mode: 0o600 });
    let unknownError = null;
    try {
      acquireStorageRuntimeLease(userDataPath);
    } catch (error) {
      unknownError = error;
    }
    expect(unknownError).toMatchObject({ code: "storage_maintenance_state_unknown" });
    await expect(fs.stat(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(maintenancePath)).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it("does not remove a replacement runtime lease during stale-owner cleanup", async () => {
    const userDataPath = await tempDir("lico-storage-runtime-lease-race-");
    const lockRoot = path.join(userDataPath, "locks");
    const runtimePath = path.join(lockRoot, "storage-runtime.lease");
    await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const stalePid = await terminatedProcessPid();
    const currentIdentity = await currentProcessLeaseIdentity();
    await fs.writeFile(runtimePath, JSON.stringify({
      schemaVersion: "v0.0.1:schema:definition-1",
      pid: stalePid,
      token: "33333333-3333-4333-8333-333333333333",
      processIdentity: "3".repeat(64),
      createdAt: new Date().toISOString()
    }), { mode: 0o600 });

    const replacementToken = "44444444-4444-4444-8444-444444444444";
    const originalLstatSync = fsSync.lstatSync.bind(fsSync);
    let replaced = false;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((filePath, options) => {
      if (!replaced && path.resolve(String(filePath)) === path.resolve(runtimePath)) {
        replaced = true;
        const replacementPath = `${runtimePath}.replacement`;
        fsSync.writeFileSync(replacementPath, JSON.stringify({
          schemaVersion: "v0.0.1:schema:definition-1",
          pid: process.pid,
          token: replacementToken,
          processIdentity: currentIdentity.value,
          processIdentitySource: currentIdentity.source,
          createdAt: new Date().toISOString()
        }), { mode: 0o600 });
        fsSync.renameSync(replacementPath, runtimePath);
      }
      return originalLstatSync(filePath, options);
    });

    expect(() => acquireStorageRuntimeLease(userDataPath)).toThrow(
      expect.objectContaining({ code: "storage_runtime_state_unknown" })
    );
    expect(replaced).toBe(true);
    expect(JSON.parse(await fs.readFile(runtimePath, "utf8"))).toMatchObject({
      pid: process.pid,
      token: replacementToken
    });
  });

  it("treats a reused PID with a different process-start identity as stale", async () => {
    const userDataPath = await tempDir("lico-storage-runtime-pid-reuse-");
    const lockRoot = path.join(userDataPath, "locks");
    const runtimePath = path.join(lockRoot, "storage-runtime.lease");
    await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const currentIdentity = await currentProcessLeaseIdentity();
    await fs.writeFile(runtimePath, JSON.stringify({
      schemaVersion: "v0.0.1:schema:definition-1",
      pid: process.pid,
      token: "55555555-5555-4555-8555-555555555555",
      processIdentity: differentProcessIdentity(currentIdentity.value),
      processIdentitySource: currentIdentity.source,
      createdAt: new Date().toISOString()
    }), { mode: 0o600 });

    const lease = acquireStorageRuntimeLease(userDataPath);
    try {
      const active = JSON.parse(await fs.readFile(runtimePath, "utf8"));
      expect(active).toMatchObject({
        pid: process.pid,
        processIdentity: currentIdentity.value,
        processIdentitySource: currentIdentity.source
      });
      expect(active.token).not.toBe("55555555-5555-4555-8555-555555555555");
    } finally {
      lease.release();
    }
  });
});
