import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createStorageBackup } from "../../../packages/foundation/src/storage/backup-snapshot.ts";
import { createStorageKernel } from "../../../packages/foundation/src/storage/storage-kernel.ts";
import { acquireStorageRuntimeLease } from "../../../packages/foundation/src/storage/storage-lifecycle-lock.ts";
import { restoreOfflineStorage } from "../../../packages/foundation/src/storage/restore-offline.ts";

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cliEntry = path.join(repositoryRoot, "apps/server/bin/meshrix.ts");
const tempRoots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeFixture(root: string, relativePath: string, contents: string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, "utf8");
}

function runCli(args: readonly string[], backupRoot: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--conditions=source", cliEntry, ...args], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        MESHRIX_BACKUP_ROOT: backupRoot,
        MESHRIX_REQUIRE_INDEPENDENT_BACKUP_ROOT: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 8192) {
        child.kill("SIGKILL");
        reject(new Error("storage restore CLI exceeded its output bound"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 8192) {
        child.kill("SIGKILL");
        reject(new Error("storage restore CLI exceeded its output bound"));
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}

function parseOutput(result: CliResult): Record<string, any> {
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as Record<string, any>;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("meshrix storage restore CLI", () => {
  it("rejects invalid direct API input with a stable storage error", async () => {
    await expect(restoreOfflineStorage(null as never)).rejects.toMatchObject({
      code: "storage_restore_request_invalid"
    });
  });

  it("previews without mutation, applies through the durable authority, and refuses unsafe states", async () => {
    const sourceRoot = await tempDir("meshrix-cli-restore-source-");
    const dataRoot = await tempDir("meshrix-cli-restore-target-");
    const backupRoot = await tempDir("meshrix-cli-restore-backups-");
    const sourceKernel = createStorageKernel({ userDataPath: sourceRoot });
    sourceKernel.close();

    const originalBackupRoot = process.env.MESHRIX_BACKUP_ROOT;
    const originalRequiredBackupRoot = process.env.MESHRIX_REQUIRE_INDEPENDENT_BACKUP_ROOT;
    process.env.MESHRIX_BACKUP_ROOT = backupRoot;
    process.env.MESHRIX_REQUIRE_INDEPENDENT_BACKUP_ROOT = "1";

    let runtimeLease: ReturnType<typeof acquireStorageRuntimeLease> | null = null;
    try {
      await writeFixture(sourceRoot, "settings.json", "{\"generation\":1}\n");
      await writeFixture(sourceRoot, "auth/grants.json", "{\"grants\":[\"read\"]}\n");
      await writeFixture(sourceRoot, "auth/revocations.json", "{\"revoked\":[\"old-key\"]}\n");
      await writeFixture(sourceRoot, "jobs/job_001/meta.json", "{\"status\":\"effect-uncertain\"}\n");
      await writeFixture(sourceRoot, "secrets/values/provider.json", "source-custody-must-stay-separate");
      await writeFixture(sourceRoot, "security/execution-sandbox-custody/master-key", "source-key-must-stay-separate");
      for (let index = 0; index < 200; index += 1) {
        await writeFixture(sourceRoot, `notes/item-${String(index).padStart(3, "0")}.txt`, `item-${index}`);
      }

      const backup = await createStorageBackup({ userDataPath: sourceRoot, label: "offline-cli" });
      await writeFixture(dataRoot, "settings.json", "{\"generation\":0}\n");
      await writeFixture(dataRoot, "auth/grants.json", "{\"grants\":[\"none\"]}\n");
      await writeFixture(dataRoot, "auth/revocations.json", "{\"revoked\":[]}\n");
      await writeFixture(dataRoot, "jobs/job_001/meta.json", "{\"status\":\"running\"}\n");
      await writeFixture(dataRoot, "secrets/values/provider.json", "target-custody-remains-independent");
      await writeFixture(dataRoot, "security/execution-sandbox-custody/master-key", "target-key-remains-independent");

      const baseArgs = ["storage", "restore", "--data-dir", dataRoot, "--backup-id", backup.backupId];
      const preview = await runCli(baseArgs, backupRoot);
      expect(preview.status, `${preview.stdout}${preview.stderr}`).toBe(0);
      const previewPayload = parseOutput(preview);
      expect(previewPayload).toMatchObject({
        ok: true,
        result: {
          mode: "preview",
          backupId: backup.backupId,
          applied: false,
          integrity: { verified: true, failedFileCount: 0 },
          summary: { blocked: 0 }
        }
      });
      expect(preview.stdout.length).toBeLessThan(2048);
      expect(preview.stdout).not.toContain(dataRoot);
      expect(preview.stdout).not.toContain(backupRoot);
      expect(preview.stdout).not.toContain("item-000.txt");
      expect(await fs.readFile(path.join(dataRoot, "settings.json"), "utf8")).toBe("{\"generation\":0}\n");
      await expect(fs.access(path.join(dataRoot, "locks"))).rejects.toMatchObject({ code: "ENOENT" });

      const symlinkedDataRoot = path.join(await tempDir("meshrix-cli-restore-link-"), "data-root");
      await fs.symlink(dataRoot, symlinkedDataRoot, process.platform === "win32" ? "junction" : "dir");
      const symlinkRoot = await runCli([
        "storage", "restore", "--data-dir", symlinkedDataRoot, "--backup-id", backup.backupId
      ], backupRoot);
      expect(symlinkRoot.status).toBe(1);
      expect(parseOutput(symlinkRoot).error.code).toBe("storage_data_root_invalid");
      expect(symlinkRoot.stdout).not.toContain(dataRoot);

      const unconfirmed = await runCli([...baseArgs, "--apply"], backupRoot);
      expect(unconfirmed.status).toBe(1);
      expect(parseOutput(unconfirmed).error.code).toBe("storage_restore_confirmation_required");
      expect(await fs.readFile(path.join(dataRoot, "settings.json"), "utf8")).toBe("{\"generation\":0}\n");

      const invalidIdentity = await runCli([
        "storage", "restore", "--data-dir", dataRoot, "--backup-id", "../outside", "--apply", "--confirm"
      ], backupRoot);
      expect(invalidIdentity.status).toBe(1);
      expect(parseOutput(invalidIdentity).error.code).toBe("backup_id_invalid");
      expect(await fs.readFile(path.join(dataRoot, "settings.json"), "utf8")).toBe("{\"generation\":0}\n");

      const mismatchedBackup = await runCli([
        "storage", "restore", "--data-dir", dataRoot, "--backup-id", `${backup.backupId}_missing`, "--apply", "--confirm"
      ], backupRoot);
      expect(mismatchedBackup.status).toBe(1);
      expect(parseOutput(mismatchedBackup).error.code).toBe("backup_manifest_invalid");
      expect(await fs.readFile(path.join(dataRoot, "settings.json"), "utf8")).toBe("{\"generation\":0}\n");

      const backupSettingsPath = path.join(backupRoot, backup.backupId, "files", "settings.json");
      const backupSettingsBeforePreview = await fs.readFile(backupSettingsPath);
      await fs.writeFile(backupSettingsPath, "{\"generation\":99}\n", "utf8");
      const changedAfterPreview = await runCli([...baseArgs, "--apply", "--confirm"], backupRoot);
      expect(changedAfterPreview.status).toBe(1);
      expect(parseOutput(changedAfterPreview).error.code).toBe("storage_restore_integrity_failed");
      expect(changedAfterPreview.stdout).not.toContain(dataRoot);
      expect(await fs.readFile(path.join(dataRoot, "settings.json"), "utf8")).toBe("{\"generation\":0}\n");
      await fs.writeFile(backupSettingsPath, backupSettingsBeforePreview);

      const applied = await runCli([...baseArgs, "--apply", "--confirm"], backupRoot);
      expect(applied.status).toBe(0);
      expect(parseOutput(applied)).toMatchObject({
        ok: true,
        result: {
          mode: "apply",
          applied: true,
          integrity: { verified: true, failedFileCount: 0 },
          summary: { blocked: 0 }
        }
      });
      expect(await fs.readFile(path.join(dataRoot, "settings.json"), "utf8")).toBe("{\"generation\":1}\n");
      expect(await fs.readFile(path.join(dataRoot, "auth/grants.json"), "utf8")).toBe("{\"grants\":[\"read\"]}\n");
      expect(await fs.readFile(path.join(dataRoot, "auth/revocations.json"), "utf8")).toBe("{\"revoked\":[\"old-key\"]}\n");
      expect(await fs.readFile(path.join(dataRoot, "jobs/job_001/meta.json"), "utf8")).toBe("{\"status\":\"effect-uncertain\"}\n");
      expect(await fs.readFile(path.join(dataRoot, "secrets/values/provider.json"), "utf8")).toBe("target-custody-remains-independent");
      expect(await fs.readFile(path.join(dataRoot, "security/execution-sandbox-custody/master-key"), "utf8")).toBe("target-key-remains-independent");

      const reopenedKernel = createStorageKernel({ userDataPath: dataRoot });
      try {
        expect(reopenedKernel.db.prepare("PRAGMA user_version").get()).toBeDefined();
      } finally {
        reopenedKernel.close();
      }

      runtimeLease = acquireStorageRuntimeLease(dataRoot);
      const activeOwner = await runCli([...baseArgs, "--apply", "--confirm"], backupRoot);
      expect(activeOwner.status).toBe(1);
      expect(parseOutput(activeOwner).error.code).toBe("storage_restore_runtime_active");
      expect(await fs.readFile(path.join(dataRoot, "settings.json"), "utf8")).toBe("{\"generation\":1}\n");
      runtimeLease.release();
      runtimeLease = null;

    } finally {
      runtimeLease?.release();
      if (originalBackupRoot === undefined) delete process.env.MESHRIX_BACKUP_ROOT;
      else process.env.MESHRIX_BACKUP_ROOT = originalBackupRoot;
      if (originalRequiredBackupRoot === undefined) delete process.env.MESHRIX_REQUIRE_INDEPENDENT_BACKUP_ROOT;
      else process.env.MESHRIX_REQUIRE_INDEPENDENT_BACKUP_ROOT = originalRequiredBackupRoot;
    }
  });
});
