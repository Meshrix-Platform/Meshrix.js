#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SERVER_API_OPERATIONS } from "#lico/operation-registry";
import { listStorageBackups } from "../../packages/foundation/src/storage/backup-query.mjs";
import { createStorageBackup } from "../../packages/foundation/src/storage/backup-snapshot.mjs";
import { BACKUP_RESTORE_PROTOCOL_VERSION } from "../../packages/foundation/src/storage/backup-contract.mjs";
import { restoreStorageBackup } from "../../packages/foundation/src/storage/restore-execution.mjs";
import { applyStorageBackupRetention } from "../../packages/foundation/src/storage/backup-retention.mjs";
import { assertPrivacySafeStorageEvidence } from "../../packages/foundation/src/storage/storage-evidence.mjs";
import { createServiceManifestStore } from "../../packages/foundation/src/storage/service-manifest-store.mjs";
import { SERVICE_MANIFEST_SCHEMA_VERSION } from "../../packages/foundation/src/storage/storage-ports.mjs";
import {
  classifyProtocolSubstrateStorageArtifact,
  PROTOCOL_SUBSTRATE_STORAGE_CATEGORY
} from "#lico/foundation/checkpoint/tree/data-structure-substrate";
import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.mjs";

async function writeFixture(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

async function verifyBackupRestore(tempRoot) {
  await writeFixture(tempRoot, "settings.json", JSON.stringify({ version: 1, name: "before" }, null, 2));
  await writeFixture(tempRoot, "jobs/job-a/meta.json", JSON.stringify({ status: "completed" }, null, 2));
  await writeFixture(tempRoot, "objects/raw-a.txt", "canonical raw object\n");
  await writeFixture(tempRoot, "protocol/core/runtime-state.json", JSON.stringify({ value: { ok: true } }, null, 2));
  await writeFixture(tempRoot, "logs/runtime/ignored.jsonl", "must not enter backup\n");

  const backup = await createStorageBackup({
    userDataPath: tempRoot,
    label: "verify",
    artifactClassifiers: [classifyProtocolSubstrateStorageArtifact]
  });
  assert.equal(backup.protocolVersion, BACKUP_RESTORE_PROTOCOL_VERSION);
  assert.ok(backup.backupId.startsWith("backup_"));
  assert.equal(backup.consistency.sqlite, "sqlite-online-backup");
  assert.equal(backup.consistency.manifestIntegrity, "size-and-sha256-per-file");
  assert.equal(Object.hasOwn(backup, "sourceRoot"), false);
  assert.equal(Object.hasOwn(backup, "backupPath"), false);
  assert.equal(Object.hasOwn(backup, "filesRoot"), false);
  assert.equal(backup.summary.fileCount, 4);
  assert.equal(backup.summary.byCategory["json-state"], 1);
  assert.equal(backup.summary.byCategory.jobs, 1);
  assert.equal(backup.summary.byCategory.object, 1);
  assert.equal(backup.summary.byCategory[PROTOCOL_SUBSTRATE_STORAGE_CATEGORY], 1);
  assert.ok(!backup.files.some((entry) => entry.relativePath.startsWith("logs/")));

  const listed = await listStorageBackups({ userDataPath: tempRoot });
  assert.equal(listed.protocolVersion, BACKUP_RESTORE_PROTOCOL_VERSION);
  assert.equal(listed.backups.length, 1);
  assert.equal(listed.backups[0].backupId, backup.backupId);

  await writeFixture(tempRoot, "settings.json", JSON.stringify({ version: 2, name: "after" }, null, 2));
  await fs.rm(path.join(tempRoot, "objects/raw-a.txt"), { force: true });

  const preview = await restoreStorageBackup({
    userDataPath: tempRoot,
    backupId: backup.backupId,
    includePaths: ["settings.json", "objects"]
  });
  assert.equal(preview.protocolVersion, BACKUP_RESTORE_PROTOCOL_VERSION);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.integrity.verified, true);
  assert.equal(preview.integrity.verifiedFileCount, 2);
  assert.equal(preview.summary.replace, 1);
  assert.equal(preview.summary.create, 1);
  assert.equal(preview.summary.noop, 0);

  const restored = await restoreStorageBackup({
    userDataPath: tempRoot,
    backupId: backup.backupId,
    dryRun: false,
    apply: true,
    includePaths: ["settings.json", "objects"]
  });
  assert.equal(restored.applied, true);
  assert.equal(restored.integrity.verified, true);
  assert.ok(restored.reportPath.endsWith(".json"));
  assert.match(await fs.readFile(path.join(tempRoot, "settings.json"), "utf8"), /"before"/);
  assert.equal(await fs.readFile(path.join(tempRoot, "objects/raw-a.txt"), "utf8"), "canonical raw object\n");

  const unconfiguredRetention = await applyStorageBackupRetention({ userDataPath: tempRoot });
  assert.equal(unconfiguredRetention.status, "not_configured");
  assert.equal(unconfiguredRetention.deletedBackupIds.length, 0);
  assert.equal(assertPrivacySafeStorageEvidence(unconfiguredRetention.receipt), true);

  await writeFixture(tempRoot, "settings.json", JSON.stringify({ version: 3, name: "retention" }, null, 2));
  const retainedBackup = await createStorageBackup({ userDataPath: tempRoot, label: "retention-target" });
  const retention = await applyStorageBackupRetention({
    userDataPath: tempRoot,
    policy: { keepLast: 1 }
  });
  assert.equal(retention.status, "applied");
  assert.equal(retention.deletedBackupIds.length, 1);
  assert.equal(retention.deletedBackupIds[0], backup.backupId);
  assert.equal(assertPrivacySafeStorageEvidence(retention.receipt), true);
  assert.equal(JSON.stringify(retention.receipt).includes("settings.json"), false);
  const afterRetention = await listStorageBackups({ userDataPath: tempRoot });
  assert.deepEqual(afterRetention.backups.map((entry) => entry.backupId), [retainedBackup.backupId]);

  await assert.rejects(
    () => restoreStorageBackup({ userDataPath: tempRoot, backupId: "../../outside" }),
    /Invalid backupId/
  );
}

async function verifyServiceManifestAuthority(tempRoot) {
  const store = createServiceManifestStore({ storageRoot: tempRoot });
  const serviceId = "svc_01J0000000000000000000VFY";
  const requestDigest = createHash("sha256").update("storage-verifier-manifest").digest("hex");
  const input = {
    serviceId,
    expectedServiceRevision: 0,
    expectedSetRevision: 0,
    requestDigest,
    manifest: {
      schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
      references: [{
        type: "credential",
        reference: "credential://storage-verifier/service",
        revision: 1,
        use: "request-auth"
      }],
      payload: { operations: [{ key: "probe", method: "POST" }] },
      metadata: { source: "verified-input" }
    }
  };
  const committed = await store.writerPort.commitManifestSet(input);
  assert.equal(committed.serviceRevision, 1);
  assert.equal(committed.setRevision, 1);
  assert.equal(committed.replayed, false);
  assert.equal((await store.writerPort.commitManifestSet(input)).replayed, true);
  const snapshot = await store.readerPort.getSnapshot();
  assert.equal(snapshot.setRevision, 1);
  assert.equal(snapshot.getService(serviceId).manifest.payload.operations[0].key, "probe");
  await assert.rejects(
    () => store.commitManifestSet({
      ...input,
      expectedServiceRevision: 1,
      expectedSetRevision: 1,
      requestDigest: createHash("sha256").update("unsafe-manifest").digest("hex"),
      manifest: {
        schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
        references: [],
        payload: { accessToken: "must-not-persist" }
      }
    }),
    (error) => error?.code === "storage_manifest_sensitive_material"
  );
}

function verifyOperationsAndTools() {
  const operations = new Map(SERVER_API_OPERATIONS.map((operation) => [operation.id, operation]));
  for (const id of [
    "storage.backups.list",
    "storage.backups.create",
    "storage.backups.retention",
    "storage.backups.restore_preview",
    "storage.backups.restore"
  ]) {
    assert.ok(operations.has(id), `${id} must be registered`);
  }
  assert.equal(operations.get("storage.backups.create").http.path, "/api/storage/backups");
  assert.equal(operations.get("storage.backups.restore").safety.risk, "repair_write");
  assert.equal(operations.get("storage.backups.retention").safety.risk, "repair_write");
  assert.equal(operations.get("storage.backups.retention").safety.requiresConfirmation, true);
  assert.equal(operations.get("storage.backups.retention").audit.recordInput, false);
  assert.equal(operations.get("storage.backups.retention").log.recordInput, false);
  assert.equal(operations.get("storage.backups.restore_preview").readOnly, true);

  const catalog = createToolCatalog({ operations: SERVER_API_OPERATIONS });
  const restoreTool = catalog.tools.find((tool) => tool.id === "lico.storageBackups.restore");
  assert.ok(restoreTool, "storage restore tool must be exposed");
  assert.equal(restoreTool.operationId, "storage.backups.restore");
  assert.ok(restoreTool.toolsets.includes("lico.runtime.maintain"));
  assert.ok(restoreTool.requiredScopes.includes("runtime:admin"));
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lico-backup-restore-"));
  try {
    await verifyBackupRestore(tempRoot);
    await verifyServiceManifestAuthority(tempRoot);
    verifyOperationsAndTools();
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
  console.log("[backup-restore] ok");
}

await main();
