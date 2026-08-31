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

import { listStorageBackups } from "../../../packages/foundation/src/storage/backup-query.ts";
import { createStorageBackup } from "../../../packages/foundation/src/storage/backup-snapshot.ts";
import { BACKUP_RESTORE_PROTOCOL_VERSION } from "../../../packages/foundation/src/storage/backup-contract.ts";
import { restoreStorageBackup } from "../../../packages/foundation/src/storage/restore-execution.ts";
import { createStorageKernel } from "../../../packages/foundation/src/storage/storage-kernel.ts";
import { createStorageProvider } from "../../../packages/foundation/src/storage/storage-provider.ts";
import { acquireStorageRuntimeLease } from "../../../packages/foundation/src/storage/storage-lifecycle-lock.ts";
import { executeStorageOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/storage-client-monitor-executors.ts";
import {
  classifyProtocolStorageArtifact,
  PROTOCOL_STORAGE_CATEGORY
} from "#meshrix/foundation/checkpoint/tree/data-structure-substrate";
import { createMeshrixPactiumRuntime } from "#meshrix/foundation/checkpoint/tree/pactium-runtime";

const tempRoots: any[] = [];

async function tempDir(prefix?: any) : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeFixture(root?: any, relativePath?: any, content: any = "") : Promise<any> {
  const filePath: any = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, String(content), "utf8");
  return filePath;
}

function backupFilePath(root?: any, backupId?: any, relativePath?: any) : any {
  return path.join(root, "backups", backupId, "files", relativePath);
}

function pendingBackupFilePath(root?: any, backupId?: any, relativePath?: any) : any {
  return path.join(root, "backups", `.${backupId}.pending`, "files", relativePath);
}

async function terminatedProcessPid() : Promise<any> {
  const child: any = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid: any = child.pid;
  await new Promise((resolve?: any, reject?: any) : any => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return pid;
}

async function currentProcessLeaseIdentity() : Promise<any> {
  const userDataPath: any = await tempDir("meshrix-storage-process-identity-");
  const lease: any = acquireStorageRuntimeLease(userDataPath);
  try {
    const record: any = JSON.parse(await fs.readFile(
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

function differentProcessIdentity(identity?: any) : any {
  return `${identity.startsWith("0") ? "1" : "0"}${identity.slice(1)}`;
}

async function waitForPath(filePath?: any, attempts: any = 250) : Promise<any> {
  for (let attempt: any = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.access(filePath);
      return true;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve?: any) : any => setTimeout(resolve, 20));
  }
  return false;
}

async function createFifo(filePath?: any) : Promise<any> {
  const child: any = spawn("mkfifo", [filePath], { stdio: "ignore" });
  const exit: any = await new Promise((resolve?: any, reject?: any) : any => {
    child.once("error", reject);
    child.once("exit", (code?: any, signal?: any) : any => resolve({ code, signal }));
  });
  if (exit.code !== 0 || exit.signal) throw new Error("FIFO fixture creation failed.");
}

afterEach(async () : Promise<any> => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true }))
  );
});

describe("storage backup restore", () : any => {
  it("createStorageBackup skips excluded top-level directories and classifies files", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-classify-");
    await writeFixture(userDataPath, "auth/token.json", JSON.stringify({ token: "abc" }));
    await writeFixture(userDataPath, "jobs/queue.json", JSON.stringify({ state: "queued" }));
    await writeFixture(userDataPath, "objects/index.dat", "objects");
    const pendingObjectPath: any = await writeFixture(
      userDataPath,
      "objects/.pending/in-flight.tmp",
      "partial object"
    );
    await writeFixture(userDataPath, "generic-files/blob.bin", "raw data");
    await writeFixture(userDataPath, "protocol/core/runtime-state.json", JSON.stringify({ value: { ok: true } }));
    const fixtureDatabase: any = new Database(path.join(userDataPath, "state.sqlite"));
    fixtureDatabase.exec("CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO fixture (value) VALUES ('ready');");
    fixtureDatabase.close();
    await writeFixture(userDataPath, "state.json", "{\"ok\":true}");
    await writeFixture(userDataPath, "app.yaml", "node: 1");
    await writeFixture(userDataPath, "notes/readme.txt", "plain text");
    await writeFixture(userDataPath, "nested/a/b/c.md", "# markdown");
    await writeFixture(userDataPath, "backups/old/should-not-backup.txt", "ignored");
    await writeFixture(userDataPath, "logs/error.log", "ignored");
    await writeFixture(userDataPath, "tmp/cache.dat", "ignored");
    await writeFixture(userDataPath, "secrets/values/provider.json", "fixture-secret-material");
    await writeFixture(userDataPath, "security/execution-sandbox-custody/master-key", "fixture-master-key");
    await writeFixture(userDataPath, "security/capability-kernel/runtime.sealing-key", "fixture-sealing-key");
    await writeFixture(userDataPath, "security/process-identity/default/state.sealing-key", "fixture-nested-sealing-key");
    await writeFixture(userDataPath, "security/authorization/policy.json", "{\"revision\":1}");

    const manifest: any = await createStorageBackup({
      userDataPath,
      label: "scope",
      artifactClassifiers: [classifyProtocolStorageArtifact]
    });

    expect(manifest.protocolVersion).toBe(BACKUP_RESTORE_PROTOCOL_VERSION);
    expect(manifest.label).toBe("scope");
    expect(manifest.summary.fileCount).toBe(11);
    expect(manifest.summary.byCategory).toMatchObject({
      auth: 1,
      jobs: 1,
      object: 1,
      [PROTOCOL_STORAGE_CATEGORY]: 1,
      database: 1,
      "json-state": 2,
      config: 1,
      file: 3
    });

    const paths: any = new Set<any>(manifest.files.map((item?: any) : any => item.relativePath));
    expect(paths.has("backups/old/should-not-backup.txt")).toBe(false);
    expect(paths.has("logs/error.log")).toBe(false);
    expect(paths.has("tmp/cache.dat")).toBe(false);
    expect(paths.has("secrets/values/provider.json")).toBe(false);
    expect(paths.has("security/execution-sandbox-custody/master-key")).toBe(false);
    expect(paths.has("security/capability-kernel/runtime.sealing-key")).toBe(false);
    expect(paths.has("security/process-identity/default/state.sealing-key")).toBe(false);
    expect(paths.has("security/authorization/policy.json")).toBe(true);
    expect(paths.has("objects/.pending/in-flight.tmp")).toBe(false);
    expect(await fs.readFile(pendingObjectPath, "utf8")).toBe("partial object");
    expect(manifest.secretCustody).toEqual({
      mode: "separate-custody-required",
      secretMaterialIncluded: false,
      replacementRestorePreservesExcludedCustody: true
    });

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

  it("listStorageBackups returns empty for missing backup root and ignores malformed entries", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-list-missing-");
    const emptyListing: any = await listStorageBackups({ userDataPath });
    expect(emptyListing).toEqual({
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: BACKUP_RESTORE_PROTOCOL_VERSION,
      catalogRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      backups: []
    });

    const validBackup: any = await createStorageBackup({ userDataPath, label: "valid" });
    const invalidBackupId: any = "not-a-backup-id";
    const invalidDir: any = path.join(userDataPath, "backups", invalidBackupId);
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

    const catalogPath: any = path.join(userDataPath, "backups", "backup-catalog.json");
    const catalog: any = JSON.parse(await fs.readFile(catalogPath, "utf8"));
    expect(catalog.backups.map((entry?: any) : any => entry.backupId)).toEqual([validBackup.backupId]);
    await fs.writeFile(catalogPath, "{invalid", "utf8");

    const listing: any = await listStorageBackups({ userDataPath });
    expect(listing.backups).toHaveLength(1);
    expect(listing.backups[0].backupId).toBe(validBackup.backupId);
    expect(new Date(listing.backups[0].createdAt).getTime()).toBeGreaterThan(0);
    expect(JSON.parse(await fs.readFile(catalogPath, "utf8")).backups)
      .toHaveLength(1);
  });

  it("restoreStorageBackup validates backupId and include path constraints", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-restore-validate-");
    const manifest: any = await createStorageBackup({ userDataPath, label: "validated" });

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

    await expect(
      restoreStorageBackup({
        userDataPath,
        backupId: manifest.backupId,
        includePaths: ["objects/./.pending/in-flight.tmp"]
      })
    ).rejects.toMatchObject({ code: "backup_path_invalid" });
  });

  it("restoreStorageBackup dry-run classifies create, replace and noop actions with include filtering", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-restore-dryrun-");
    await writeFixture(userDataPath, "scope/keep.txt", "same-content");
    await writeFixture(userDataPath, "scope/replace.txt", "old-content");
    await writeFixture(userDataPath, "scope/create.txt", "will-be-removed");

    const manifest: any = await createStorageBackup({ userDataPath, label: "dry-run" });
    await writeFixture(userDataPath, "scope/replace.txt", "changed-content");
    await fs.rm(path.join(userDataPath, "scope/create.txt"), { force: true });

    const report: any = await restoreStorageBackup({
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

    const actions: any = Object.fromEntries(report.plannedActions.map((item?: any) : any => [item.relativePath, item]));
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

  it("restoreStorageBackup marks blocked entries when backup files are missing", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-restore-blocked-");
    await writeFixture(userDataPath, "scope/blocked.txt", "missing-backup-file");

    const manifest: any = await createStorageBackup({ userDataPath, label: "blocked" });
    await fs.rm(backupFilePath(userDataPath, manifest.backupId, "scope/blocked.txt"), { force: true });

    const preview: any = await restoreStorageBackup({
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

  it("restoreStorageBackup apply branch writes report and performs target updates", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-restore-apply-");
    await writeFixture(userDataPath, "restore/keep.txt", "stable");
    await writeFixture(userDataPath, "restore/replace.txt", "old-content");
    await writeFixture(userDataPath, "restore/create.txt", "will be recreated");

    const manifest: any = await createStorageBackup({ userDataPath, label: "apply" });
    await fs.writeFile(path.join(userDataPath, "restore/replace.txt"), "changed", "utf8");
    await fs.rm(path.join(userDataPath, "restore/create.txt"), { force: true });

    const report: any = await restoreStorageBackup({
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
    const reportData: any = JSON.parse(await fs.readFile(report.reportPath, "utf8"));
    expect(reportData.applied).toBe(true);
    expect(reportData.dryRun).toBe(false);
    expect(reportData.selectedFileCount).toBe(3);

    expect(await fs.readFile(path.join(userDataPath, "restore/create.txt"), "utf8")).toBe("will be recreated");
    expect(await fs.readFile(path.join(userDataPath, "restore/replace.txt"), "utf8")).toBe("old-content");
    expect(await fs.readFile(path.join(userDataPath, "restore/keep.txt"), "utf8")).toBe("stable");
  });

  it("creates a verified online SQLite snapshot without copying transient WAL sidecars", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-sqlite-online-");
    const databasePath: any = path.join(userDataPath, "metadata", "runtime.sqlite");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const liveDatabase: any = new Database(databasePath);
    try {
      liveDatabase.pragma("journal_mode = WAL");
      liveDatabase.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      liveDatabase.prepare("INSERT INTO records (value) VALUES (?)").run("snapshot-row");

      const manifest: any = await createStorageBackup({ userDataPath, label: "sqlite-online" });
      const snapshotPath: any = backupFilePath(userDataPath, manifest.backupId, "metadata/runtime.sqlite");
      const snapshotDatabase: any = new Database(snapshotPath, { readonly: true, fileMustExist: true });
      try {
        expect(snapshotDatabase.prepare("SELECT value FROM records").pluck().all())
          .toEqual(["snapshot-row"]);
        expect(snapshotDatabase.pragma("quick_check", { simple: true })).toBe("ok");
      } finally {
        snapshotDatabase.close();
      }
      expect(manifest.files.map((entry?: any) : any => entry.relativePath)).toContain("metadata/runtime.sqlite");
      expect(manifest.files.some((entry?: any) : any => entry.relativePath.endsWith("-wal"))).toBe(false);
      expect(manifest.consistency.sqlite).toBe("copy-on-write-baseline-with-sqlite-online-page-backup");
    } finally {
      liveDatabase.close();
    }
  });

  it("replaces a byte-identical SQLite main file when recovery sidecars contain post-backup state", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-sqlite-sidecar-restore-");
    const databasePath: any = path.join(userDataPath, "metadata", "runtime.sqlite");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const liveDatabase: any = new Database(databasePath);
    let walBytes: any = null;
    let shmBytes: any = null;
    let manifest: any = null;
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

    const snapshotPath: any = backupFilePath(userDataPath, manifest.backupId, "metadata/runtime.sqlite");
    await fs.copyFile(snapshotPath, databasePath);
    await fs.writeFile(`${databasePath}-wal`, walBytes);
    await fs.writeFile(`${databasePath}-shm`, shmBytes);
    const databaseEntry: any = manifest.files.find((entry?: any) : any => entry.relativePath === "metadata/runtime.sqlite");
    expect(createHash("sha256").update(await fs.readFile(databasePath)).digest("hex"))
      .toBe(databaseEntry.sha256);

    const crashView: any = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      expect(crashView.prepare("SELECT value FROM records ORDER BY id").pluck().all())
        .toEqual(["backup-row", "post-backup-row"]);
    } finally {
      crashView.close();
    }

    const preview: any = await restoreStorageBackup({
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
    const restored: any = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      expect(restored.prepare("SELECT value FROM records ORDER BY id").pluck().all())
        .toEqual(["backup-row"]);
    } finally {
      restored.close();
    }
  });

  it("uses SQLite online backup and sidecar-safe restore for nested auth and Pactium databases", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-nested-sqlite-");
    const databasePaths: any[] = [
      path.join(userDataPath, "auth", "sessions.sqlite"),
      path.join(userDataPath, "pactium.sqlite")
    ];
    const openDatabases: any[] = [];
    const recoveryBytes: any = new Map<any, any>();
    let manifest: any = null;
    try {
      for (const databasePath of databasePaths) {
        await fs.mkdir(path.dirname(databasePath), { recursive: true });
        const database: any = new Database(databasePath);
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

    const entries: any = Object.fromEntries(manifest.files.map((entry?: any) : any => [entry.relativePath, entry]));
    expect(entries["auth/sessions.sqlite"].category).toBe("auth");
    expect(entries["pactium.sqlite"].category).toBe("database");
    for (const databasePath of databasePaths) {
      const relativePath: any = path.relative(userDataPath, databasePath).replace(/\\/g, "/");
      const snapshotPath: any = backupFilePath(userDataPath, manifest.backupId, relativePath);
      const snapshot: any = new Database(snapshotPath, { readonly: true, fileMustExist: true });
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

    const preview: any = await restoreStorageBackup({
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
      const restored: any = new Database(databasePath, { readonly: true, fileMustExist: true });
      try {
        expect(restored.prepare("SELECT value FROM records ORDER BY id").pluck().all())
          .toEqual(["backup-row"]);
      } finally {
        restored.close();
      }
    }
  });

  it("uses replacement semantics for full restore and overlay semantics for filtered restore", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-replacement-");
    await writeFixture(userDataPath, "scope/baseline.txt", "backup-scope");
    await writeFixture(userDataPath, "other/baseline.txt", "backup-other");
    const manifest: any = await createStorageBackup({ userDataPath, label: "replacement" });
    await fs.writeFile(path.join(userDataPath, "scope", "baseline.txt"), "drifted-scope", "utf8");
    await writeFixture(userDataPath, "scope/post-backup.txt", "keep-during-overlay");
    await writeFixture(userDataPath, "other/post-backup.txt", "remove-during-replacement");
    const pendingObjectPath: any = await writeFixture(
      userDataPath,
      "objects/.pending/in-flight.tmp",
      "partial object"
    );
    await writeFixture(userDataPath, "secrets/values/operator.json", "separately-managed-secret");
    await writeFixture(userDataPath, "security/execution-sandbox-custody/master-key", "separately-managed-key");

    const overlay: any = await restoreStorageBackup({
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

    const preview: any = await restoreStorageBackup({
      userDataPath,
      backupId: manifest.backupId
    });
    expect(preview.restoreSemantics).toBe("replacement");
    expect(preview.summary.delete).toBe(2);
    expect(preview.plannedActions.some((action?: any) : any => action.relativePath.startsWith("secrets/"))).toBe(false);
    expect(preview.plannedActions.some((action?: any) : any => action.relativePath.includes("master-key"))).toBe(false);
    expect(preview.plannedActions.some((action?: any) : any => action.relativePath.startsWith("objects/.pending"))).toBe(false);
    expect(preview.plannedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "scope/post-backup.txt", action: "delete", reason: "not_in_backup" }),
      expect.objectContaining({ relativePath: "other/post-backup.txt", action: "delete", reason: "not_in_backup" })
    ]));

    const replacement: any = await restoreStorageBackup({
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
    expect(await fs.readFile(path.join(userDataPath, "secrets/values/operator.json"), "utf8"))
      .toBe("separately-managed-secret");
    expect(await fs.readFile(path.join(userDataPath, "security/execution-sandbox-custody/master-key"), "utf8"))
      .toBe("separately-managed-key");
    expect(await fs.readFile(pendingObjectPath, "utf8")).toBe("partial object");
  });

  it("rejects malformed includePaths without expanding to replacement semantics", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-invalid-include-paths-");
    await writeFixture(userDataPath, "scope/baseline.txt", "backup-scope");
    const manifest: any = await createStorageBackup({ userDataPath, label: "invalid-include-paths" });
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
    async () : Promise<any> => {
      const userDataPath: any = await tempDir("meshrix-backup-special-artifact-");
      const outsideRoot: any = await tempDir("meshrix-backup-special-target-");
      await writeFixture(userDataPath, "scope/baseline.txt", "backup-generation");
      const manifest: any = await createStorageBackup({ userDataPath, label: "special-artifact" });
      const outsidePath: any = await writeFixture(outsideRoot, "external.json", "external-generation");
      const symlinkPath: any = path.join(userDataPath, "settings.json");
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
      const fifoPath: any = path.join(userDataPath, "post-backup.pipe");
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

  it("recovers a SIGKILL-interrupted restore before the storage kernel opens", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-crash-recovery-");
    await writeFixture(userDataPath, "scope/a.txt", "backup-a");
    await writeFixture(userDataPath, "scope/b.txt", "backup-b");
    const manifest: any = await createStorageBackup({ userDataPath, label: "crash-recovery" });
    await fs.writeFile(path.join(userDataPath, "scope/a.txt"), "active-a", "utf8");
    await fs.writeFile(path.join(userDataPath, "scope/b.txt"), "active-b", "utf8");
    const signalPath: any = path.join(userDataPath, "logs", "restore-crash-ready");
    const moduleUrl: any = new URL(
      "../../../packages/foundation/src/storage/restore-execution.ts",
      import.meta.url
    ).href;
    const childSource: any = `
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
    const child: any = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
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
    let exited: any = false;
    const exitPromise: any = new Promise((resolve?: any) : any => {
      child.once("exit", (code?: any, signal?: any) : any => {
        exited = true;
        resolve({ code, signal });
      });
    });
    let signalled: any = false;
    for (let attempt: any = 0; attempt < 250; attempt += 1) {
      try {
        await fs.access(signalPath);
        signalled = true;
        break;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (exited) break;
      await new Promise((resolve?: any) : any => setTimeout(resolve, 20));
    }
    expect(signalled).toBe(true);
    child.kill("SIGKILL");
    const exit: any = await exitPromise;
    expect(exit.signal).toBe("SIGKILL");

    expect(await fs.readFile(path.join(userDataPath, "scope/a.txt"), "utf8")).toBe("backup-a");
    expect(await fs.readFile(path.join(userDataPath, "scope/b.txt"), "utf8")).toBe("active-b");
    const storageKernel: any = createStorageKernel({ userDataPath });
    storageKernel.close();
    expect(await fs.readFile(path.join(userDataPath, "scope/a.txt"), "utf8")).toBe("active-a");
    expect(await fs.readFile(path.join(userDataPath, "scope/b.txt"), "utf8")).toBe("active-b");
    const transactionEntries: any = await fs.readdir(path.join(userDataPath, "tmp"));
    expect(transactionEntries.filter((name?: any) : any => name.includes("storage-restore-"))).toEqual([]);
  }, 15_000);

  it("finalizes a durable committed generation after SIGKILL before receipt publication", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-commit-recovery-");
    await writeFixture(userDataPath, "scope/value.txt", "backup-generation");
    const manifest: any = await createStorageBackup({ userDataPath, label: "commit-recovery" });
    await fs.writeFile(path.join(userDataPath, "scope/value.txt"), "active-generation", "utf8");
    const signalPath: any = path.join(userDataPath, "logs", "restore-commit-ready");
    const moduleUrl: any = new URL(
      "../../../packages/foundation/src/storage/restore-execution.ts",
      import.meta.url
    ).href;
    const childSource: any = `
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
    const child: any = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
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
    let exited: any = false;
    const exitPromise: any = new Promise((resolve?: any) : any => {
      child.once("exit", (code?: any, signal?: any) : any => {
        exited = true;
        resolve({ code, signal });
      });
    });
    let signalled: any = false;
    for (let attempt: any = 0; attempt < 250; attempt += 1) {
      try {
        await fs.access(signalPath);
        signalled = true;
        break;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (exited) break;
      await new Promise((resolve?: any) : any => setTimeout(resolve, 20));
    }
    expect(signalled).toBe(true);
    child.kill("SIGKILL");
    const exit: any = await exitPromise;
    expect(exit.signal).toBe("SIGKILL");
    expect(await fs.readFile(path.join(userDataPath, "scope/value.txt"), "utf8"))
      .toBe("backup-generation");

    const storageKernel: any = createStorageKernel({ userDataPath });
    storageKernel.close();
    expect(await fs.readFile(path.join(userDataPath, "scope/value.txt"), "utf8"))
      .toBe("backup-generation");
    const receipts: any = await fs.readdir(
      path.join(userDataPath, "backups", manifest.backupId, "restore-reports")
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatch(/^restore_.+\.json$/u);
    const transactionEntries: any = await fs.readdir(path.join(userDataPath, "tmp"));
    expect(transactionEntries.filter((name?: any) : any => name.includes("storage-restore-"))).toEqual([]);
  }, 15_000);

  it("fails the entire unpublished backup when a source mutates during its copy", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-concurrent-mutation-");
    const sourcePath: any = await writeFixture(userDataPath, "state/live.json", JSON.stringify({ generation: 1 }));
    const originalOpen: any = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (filePath: any, ...args: any[]) : Promise<any> => {
      const handle: any = await originalOpen(filePath, ...args);
      if (path.resolve(String(filePath)) === path.resolve(sourcePath)) {
        const originalStat: any = handle.stat.bind(handle);
        let statCount: any = 0;
        Object.defineProperty(handle, "stat", {
          configurable: true,
          value: async (...statArgs: any[]) : Promise<any> => {
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

  it("rejects insufficient filesystem capacity before creating snapshot files", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-capacity-preflight-");
    await writeFixture(userDataPath, "state/large.bin", "x".repeat(1024));
    vi.spyOn(fs, "statfs").mockResolvedValue({
      bavail: 1n,
      bsize: 4096n
    });

    await expect(createStorageBackup({ userDataPath, label: "capacity" }))
      .rejects.toMatchObject({ code: "storage_backup_capacity_insufficient" });
    const backupEntries: any = await fs.readdir(path.join(userDataPath, "backups"));
    expect(backupEntries.some((name?: any) : any => name.endsWith(".pending"))).toBe(false);
    expect((await listStorageBackups({ userDataPath })).backups).toEqual([]);
  });

  it("uses copy-on-write cloning when the filesystem supports reflinks", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-copy-on-write-");
    await writeFixture(userDataPath, "state/value.bin", "stable-content");
    const copyFile: any = vi.spyOn(fs, "copyFile");

    const manifest: any = await createStorageBackup({ userDataPath, label: "copy-on-write" });
    const entry: any = manifest.files.find((item?: any) : any => item.relativePath === "state/value.bin");
    expect(entry.copyMethod).toMatch(/^(copy-on-write|stream-copy)$/);
    if (entry.copyMethod === "copy-on-write") {
      expect(copyFile).toHaveBeenCalledWith(
        path.join(userDataPath, "state/value.bin"),
        pendingBackupFilePath(userDataPath, manifest.backupId, "state/value.bin"),
        fsSync.constants.COPYFILE_FICLONE_FORCE
      );
    }
    await expect(fs.readFile(
      backupFilePath(userDataPath, manifest.backupId, "state/value.bin"),
      "utf8"
    )).resolves.toBe("stable-content");
  });

  it("removes abandoned unpublished backup staging before the next snapshot", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-pending-recovery-");
    const pendingPath: any = path.join(userDataPath, "backups", ".backup_stale.pending");
    await fs.mkdir(pendingPath, { recursive: true });
    await fs.writeFile(path.join(pendingPath, "partial"), "partial", "utf8");
    await writeFixture(userDataPath, "state/value.json", "{}");

    const manifest: any = await createStorageBackup({ userDataPath, label: "recovered" });
    await expect(fs.stat(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await listStorageBackups({ userDataPath })).backups.map((item?: any) : any => item.backupId))
      .toEqual([manifest.backupId]);
  });

  it("verifies manifest size and digest for every selected restore file", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-tamper-");
    await writeFixture(userDataPath, "scope/hash.txt", "original");
    await writeFixture(userDataPath, "scope/size.txt", "stable");
    const manifest: any = await createStorageBackup({ userDataPath, label: "tamper" });
    await fs.writeFile(backupFilePath(userDataPath, manifest.backupId, "scope/hash.txt"), "tampered", "utf8");
    await fs.writeFile(backupFilePath(userDataPath, manifest.backupId, "scope/size.txt"), "different-size", "utf8");
    await fs.writeFile(path.join(userDataPath, "scope/hash.txt"), "active-hash", "utf8");
    await fs.writeFile(path.join(userDataPath, "scope/size.txt"), "active-size", "utf8");

    const preview: any = await restoreStorageBackup({
      userDataPath,
      backupId: manifest.backupId,
      includePaths: ["scope"]
    });
    const actions: any = Object.fromEntries(preview.plannedActions.map((action?: any) : any => [action.relativePath, action]));
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

  it("rejects online restore with a safe API reason code while leaving active state untouched", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-online-restore-");
    await writeFixture(userDataPath, "settings.json", "baseline");
    const manifest: any = await createStorageBackup({ userDataPath, label: "offline-boundary" });
    await fs.writeFile(path.join(userDataPath, "settings.json"), "active", "utf8");
    const storageKernel: any = createStorageKernel({ userDataPath });
    const storageProvider: any = createStorageProvider({ userDataPath, storageKernel });
    try {
      const response: any = await executeStorageOperation({
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

  it("keeps the shared runtime lease until every standalone Pactium runtime closes", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-pactium-shared-lease-");
    const seedRuntime: any = createMeshrixPactiumRuntime({ dataDir: userDataPath, storageBackend: "sqlite" });
    await seedRuntime.storage.putProtocolObject("test", "generation", { value: "backup" });
    await seedRuntime.close();
    const manifest: any = await createStorageBackup({ userDataPath, label: "pactium-shared-lease" });

    const firstRuntime: any = createMeshrixPactiumRuntime({ dataDir: userDataPath, storageBackend: "sqlite" });
    const secondRuntime: any = createMeshrixPactiumRuntime({ dataDir: userDataPath, storageBackend: "sqlite" });
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
      await firstRuntime.close().catch(() : any => {});
      await secondRuntime.close().catch(() : any => {});
    }
  });

  it("rejects confirmed restore while a standalone Pactium runtime is open in another process", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-pactium-process-lease-");
    const seedRuntime: any = createMeshrixPactiumRuntime({ dataDir: userDataPath, storageBackend: "sqlite" });
    await seedRuntime.storage.putProtocolObject("test", "generation", { value: "backup" });
    await seedRuntime.close();
    const manifest: any = await createStorageBackup({ userDataPath, label: "pactium-process-lease" });
    const readyPath: any = path.join(userDataPath, "logs", "pactium-runtime-ready");
    const stopPath: any = path.join(userDataPath, "logs", "pactium-runtime-stop");
    const moduleUrl: any = new URL(
      "../../../packages/foundation/src/checkpoint/tree/pactium-runtime.ts",
      import.meta.url
    ).href;
    const childSource: any = `
      import fs from "node:fs/promises";
      const { createMeshrixPactiumRuntime } = await import(process.env.PACTIUM_RUNTIME_MODULE_URL);
      const runtime = createMeshrixPactiumRuntime({
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
    const child: any = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
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
    const exitPromise: any = new Promise((resolve?: any, reject?: any) : any => {
      child.once("error", reject);
      child.once("exit", (code?: any, signal?: any) : any => resolve({ code, signal }));
    });
    try {
      expect(await waitForPath(readyPath)).toBe(true);
      await expect(restoreStorageBackup({
        userDataPath,
        backupId: manifest.backupId,
        dryRun: false,
        apply: true
      })).rejects.toSatisfy((error?: any) : any => [
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

  it("rolls back every committed file when a later atomic install fails", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-backup-rollback-");
    await writeFixture(userDataPath, "scope/a.txt", "backup-a");
    await writeFixture(userDataPath, "scope/b.txt", "backup-b");
    const manifest: any = await createStorageBackup({ userDataPath, label: "rollback" });
    await fs.writeFile(path.join(userDataPath, "scope/a.txt"), "active-a", "utf8");
    await fs.writeFile(path.join(userDataPath, "scope/b.txt"), "active-b", "utf8");

    const originalRename: any = fs.rename.bind(fs);
    let injectedFailure: any = false;
    vi.spyOn(fs, "rename").mockImplementation(async (sourcePath?: any, targetPath?: any) : Promise<any> => {
      const normalizedSource: any = String(sourcePath).replace(/\\/g, "/");
      const normalizedTarget: any = String(targetPath).replace(/\\/g, "/");
      if (
        !injectedFailure &&
        normalizedSource.includes("/tmp/storage-restore-") &&
        normalizedSource.endsWith("/files/scope/b.txt") &&
        normalizedTarget.endsWith("/scope/b.txt")
      ) {
        injectedFailure = true;
        const error: any = new Error("injected rename failure");
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

  it("cleans only a verifiable stale maintenance lease during runtime startup", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-storage-stale-maintenance-");
    const lockRoot: any = path.join(userDataPath, "locks");
    const maintenancePath: any = path.join(lockRoot, "storage-backup-restore.lock");
    const runtimePath: any = path.join(lockRoot, "storage-runtime.lease");
    await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const stalePid: any = await terminatedProcessPid();
    const currentIdentity: any = await currentProcessLeaseIdentity();
    await fs.writeFile(maintenancePath, JSON.stringify({
      schemaVersion: "v0.0.1:schema:definition-1",
      pid: stalePid,
      token: "11111111-1111-4111-8111-111111111111",
      processIdentity: "1".repeat(64),
      createdAt: new Date().toISOString()
    }), { mode: 0o600 });

    const lease: any = acquireStorageRuntimeLease(userDataPath);
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
    let activeError: any = null;
    try {
      acquireStorageRuntimeLease(userDataPath);
    } catch (error: any) {
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
    let unknownError: any = null;
    try {
      acquireStorageRuntimeLease(userDataPath);
    } catch (error: any) {
      unknownError = error;
    }
    expect(unknownError).toMatchObject({ code: "storage_maintenance_state_unknown" });
    await expect(fs.stat(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(maintenancePath)).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it("does not remove a replacement runtime lease during stale-owner cleanup", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-storage-runtime-lease-race-");
    const lockRoot: any = path.join(userDataPath, "locks");
    const runtimePath: any = path.join(lockRoot, "storage-runtime.lease");
    await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const stalePid: any = await terminatedProcessPid();
    const currentIdentity: any = await currentProcessLeaseIdentity();
    await fs.writeFile(runtimePath, JSON.stringify({
      schemaVersion: "v0.0.1:schema:definition-1",
      pid: stalePid,
      token: "33333333-3333-4333-8333-333333333333",
      processIdentity: "3".repeat(64),
      createdAt: new Date().toISOString()
    }), { mode: 0o600 });

    const replacementToken: any = "44444444-4444-4444-8444-444444444444";
    const originalLstatSync: any = fsSync.lstatSync.bind(fsSync);
    let replaced: any = false;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((filePath?: any, options?: any) : any => {
      if (!replaced && path.resolve(String(filePath)) === path.resolve(runtimePath)) {
        replaced = true;
        const replacementPath: any = `${runtimePath}.replacement`;
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

    expect(() : any => acquireStorageRuntimeLease(userDataPath)).toThrow(
      expect.objectContaining({ code: "storage_runtime_state_unknown" })
    );
    expect(replaced).toBe(true);
    expect(JSON.parse(await fs.readFile(runtimePath, "utf8"))).toMatchObject({
      pid: process.pid,
      token: replacementToken
    });
  });

  it("treats a reused PID with a different process-start identity as stale", async () : Promise<any> => {
    const userDataPath: any = await tempDir("meshrix-storage-runtime-pid-reuse-");
    const lockRoot: any = path.join(userDataPath, "locks");
    const runtimePath: any = path.join(lockRoot, "storage-runtime.lease");
    await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const currentIdentity: any = await currentProcessLeaseIdentity();
    await fs.writeFile(runtimePath, JSON.stringify({
      schemaVersion: "v0.0.1:schema:definition-1",
      pid: process.pid,
      token: "55555555-5555-4555-8555-555555555555",
      processIdentity: differentProcessIdentity(currentIdentity.value),
      processIdentitySource: currentIdentity.source,
      createdAt: new Date().toISOString()
    }), { mode: 0o600 });

    const lease: any = acquireStorageRuntimeLease(userDataPath);
    try {
      const active: any = JSON.parse(await fs.readFile(runtimePath, "utf8"));
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
