import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BACKUP_ROOT_ENV,
  REQUIRE_INDEPENDENT_BACKUP_ROOT_ENV,
  assertIndependentBackupRootReady,
  backupPath
} from "../../../packages/foundation/src/storage/backup-contract.ts";
import { createStorageBackup } from "../../../packages/foundation/src/storage/backup-snapshot.ts";
import { restoreStorageBackup } from "../../../packages/foundation/src/storage/restore-execution.ts";

const originalBackupRoot: any = process.env[BACKUP_ROOT_ENV];
const originalRequired: any = process.env[REQUIRE_INDEPENDENT_BACKUP_ROOT_ENV];
const tempRoots: any[] = [];

async function tempDir(prefix?: any) : Promise<any> {
  const selected: any = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(selected);
  return selected;
}

async function writeFixture(root?: any, relativePath?: any, value?: any) : Promise<any> {
  const target: any = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value, "utf8");
}

afterEach(async () : Promise<any> => {
  if (originalBackupRoot === undefined) delete process.env[BACKUP_ROOT_ENV];
  else process.env[BACKUP_ROOT_ENV] = originalBackupRoot;
  if (originalRequired === undefined) delete process.env[REQUIRE_INDEPENDENT_BACKUP_ROOT_ENV];
  else process.env[REQUIRE_INDEPENDENT_BACKUP_ROOT_ENV] = originalRequired;
  await Promise.all(
    tempRoots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true }))
  );
});

describe("independent backup root", () : any => {
  it("fails closed when enterprise backup custody is absent, overlapping, or unavailable", async () : Promise<any> => {
    const liveRoot: any = await tempDir("meshrix-live-storage-");
    process.env[REQUIRE_INDEPENDENT_BACKUP_ROOT_ENV] = "1";
    delete process.env[BACKUP_ROOT_ENV];
    await expect(assertIndependentBackupRootReady({
      userDataPath: liveRoot
    })).rejects.toMatchObject({ code: "storage_independent_backup_root_required" });

    const overlapping: any = path.join(liveRoot, "backups-external");
    await fs.mkdir(overlapping, { recursive: true });
    process.env[BACKUP_ROOT_ENV] = overlapping;
    await expect(assertIndependentBackupRootReady({
      userDataPath: liveRoot
    })).rejects.toMatchObject({ code: "storage_backup_root_not_independent" });

    process.env[BACKUP_ROOT_ENV] = path.join(path.dirname(liveRoot), "missing-backup-root");
    await expect(assertIndependentBackupRootReady({
      userDataPath: liveRoot
    })).rejects.toMatchObject({ code: "storage_backup_root_unavailable" });
  });

  it("restores governed state into an empty replacement data root from independent custody", async () : Promise<any> => {
    const sourceRoot: any = await tempDir("meshrix-source-storage-");
    const replacementRoot: any = await tempDir("meshrix-replacement-storage-");
    const independentRoot: any = await tempDir("meshrix-independent-backups-");
    process.env[BACKUP_ROOT_ENV] = independentRoot;
    process.env[REQUIRE_INDEPENDENT_BACKUP_ROOT_ENV] = "1";

    await expect(assertIndependentBackupRootReady({
      userDataPath: sourceRoot
    })).resolves.toEqual({ configured: true, independent: true });
    await writeFixture(sourceRoot, "settings.json", "{\"generation\":1}\n");
    await writeFixture(sourceRoot, "jobs/job_fixture/meta.json", "{\"status\":\"completed\"}\n");
    await writeFixture(sourceRoot, "secrets/values/provider.json", "must-not-enter-backup");

    const manifest: any = await createStorageBackup({
      userDataPath: sourceRoot,
      label: "clean-host"
    });
    expect(backupPath(sourceRoot, manifest.backupId).startsWith(independentRoot)).toBe(true);
    expect(manifest.files.some((entry?: any) : any => entry.relativePath.startsWith("secrets/"))).toBe(false);

    const restored: any = await restoreStorageBackup({
      userDataPath: replacementRoot,
      backupId: manifest.backupId,
      dryRun: false,
      apply: true
    });
    expect(restored.applied).toBe(true);
    await expect(fs.readFile(path.join(replacementRoot, "settings.json"), "utf8"))
      .resolves.toBe("{\"generation\":1}\n");
    await expect(fs.readFile(
      path.join(replacementRoot, "jobs/job_fixture/meta.json"),
      "utf8"
    )).resolves.toBe("{\"status\":\"completed\"}\n");
    await expect(fs.access(path.join(replacementRoot, "secrets/values/provider.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
