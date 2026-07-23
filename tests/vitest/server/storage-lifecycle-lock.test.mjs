import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const lifecycleModuleUrl = new URL(
  "../../../packages/foundation/src/storage/storage-lifecycle-lock.mjs",
  import.meta.url
).href;

const resolverFailureProbe = String.raw`
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

function unavailableError() {
  const error = new Error("process metadata unavailable");
  error.code = "EPERM";
  return error;
}

const originalReadFileSync = fsSync.readFileSync.bind(fsSync);
const originalExistsSync = fsSync.existsSync.bind(fsSync);
fsSync.readFileSync = (filePath, ...args) => {
  if (String(filePath).startsWith("/proc/")) throw unavailableError();
  return originalReadFileSync(filePath, ...args);
};
fsSync.existsSync = (filePath) =>
  String(filePath) === "/bin/ps" ? false : originalExistsSync(filePath);
childProcess.spawnSync = () => ({
  status: null,
  signal: null,
  stdout: "",
  stderr: "",
  error: unavailableError()
});
syncBuiltinESMExports();

const {
  acquireStorageMaintenanceLock,
  acquireStorageRuntimeLease
} = await import(process.argv[1]);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-storage-lifecycle-failure-"));
const lockRoot = path.join(root, "locks");
const leasePath = path.join(lockRoot, "storage-runtime.lease");
const maintenancePath = path.join(lockRoot, "storage-backup-restore.lock");
const acquireReason = () => {
  try {
    const lease = acquireStorageRuntimeLease(root);
    lease.release();
    return "acquired";
  } catch (error) {
    return String(error?.code || "unknown");
  }
};
const acquireMaintenanceReason = async () => {
  try {
    const lock = await acquireStorageMaintenanceLock(root);
    await lock.release();
    return "acquired";
  } catch (error) {
    return String(error?.code || "unknown");
  }
};

try {
  const first = acquireReason();
  const leaseAfterFirst = fsSync.existsSync(leasePath);
  const second = acquireReason();
  const leaseAfterSecond = fsSync.existsSync(leasePath);

  const foreignLease = JSON.stringify({
    schemaVersion: "v0.0.1:schema:definition-1",
    pid: process.pid,
    token: crypto.randomUUID(),
    processIdentity: crypto.createHash("sha256").update("unverifiable-owner").digest("hex"),
    createdAt: "2026-01-01T00:00:00.000Z"
  }) + "\n";
  await fs.writeFile(leasePath, foreignLease, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const foreignReason = acquireReason();
  const foreignUnchanged = fsSync.existsSync(leasePath) &&
    await fs.readFile(leasePath, "utf8") === foreignLease;

  const firstMaintenance = await acquireMaintenanceReason();
  const maintenanceAfterFirst = fsSync.existsSync(maintenancePath);
  const secondMaintenance = await acquireMaintenanceReason();
  const maintenanceAfterSecond = fsSync.existsSync(maintenancePath);
  await fs.writeFile(maintenancePath, foreignLease, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  const foreignMaintenanceReason = await acquireMaintenanceReason();
  const foreignMaintenanceUnchanged = fsSync.existsSync(maintenancePath) &&
    await fs.readFile(maintenancePath, "utf8") === foreignLease;

  console.log(JSON.stringify({
    first,
    leaseAfterFirst,
    second,
    leaseAfterSecond,
    foreignReason,
    foreignUnchanged,
    firstMaintenance,
    maintenanceAfterFirst,
    secondMaintenance,
    maintenanceAfterSecond,
    foreignMaintenanceReason,
    foreignMaintenanceUnchanged
  }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
`;

describe("storage lifecycle lock", () => {
  it("uses the Node process time origin for current ownership and fails closed for unverifiable foreign ownership", () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", resolverFailureProbe, lifecycleModuleUrl],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 15_000,
        windowsHide: true
      }
    );
    if (result.status !== 0 || result.signal || result.error) {
      throw new Error("Storage lifecycle resolver-failure probe did not complete.");
    }

    expect(JSON.parse(String(result.stdout || "").trim())).toEqual({
      first: "acquired",
      leaseAfterFirst: false,
      second: "acquired",
      leaseAfterSecond: false,
      foreignReason: "storage_runtime_state_unknown",
      foreignUnchanged: true,
      firstMaintenance: "acquired",
      maintenanceAfterFirst: false,
      secondMaintenance: "acquired",
      maintenanceAfterSecond: false,
      foreignMaintenanceReason: "storage_operation_busy",
      foreignMaintenanceUnchanged: true
    });
  });
});
