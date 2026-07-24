#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.mjs";
import { MemoryLockManager } from "../../packages/foundation/src/concurrency/lock-manager.mjs";
import { assertNoSensitiveReportLeak } from "../../packages/foundation/src/observability/sensitive-report-scan.mjs";
import { BACKUP_RESTORE_PROTOCOL_VERSION } from "../../packages/foundation/src/storage/backup-contract.mjs";
import { createStorageKernel } from "../../packages/foundation/src/storage/storage-kernel.mjs";
import { createStorageProvider, STORAGE_PROTOCOL_VERSION } from "../../packages/foundation/src/storage/storage-provider.mjs";
import { createSystemControllerRuntimeHandlers } from "../../packages/protocols/http/controllers/system-controller-runtime-handlers.mjs";
import { dispatchOperation } from "../../packages/server-runtime/src/composition/dispatch-operation.mjs";
import { executeConsoleDomainOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executor.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reportRoot = path.join(repoRoot, "build", "reports", "storage-production-restore-drill");
const latestReportPath = path.join(reportRoot, "latest.json");
const workRoot = path.join(repoRoot, "build", "tmp", "storage-production-restore-drill");
const REPORT_SCHEMA_VERSION = "v0.0.1:storage:production-restore-drill-report-1";
const VERIFIER = "tools/server-scripts/verify-storage-production-restore-drill.mjs";
const RUNBOOK_PATH = "docs/RUNBOOK.md";
const REQUIRED_RUNBOOK_TOKENS = Object.freeze([
  "Storage Backup Restore Production Drill",
  "storage.backups.create",
  "storage.backups.retention",
  "storage.backups.restore_preview",
  "storage.backups.restore",
  "confirm",
  "tools/server-scripts/verify-storage-production-restore-drill.mjs",
  "build/reports/storage-production-restore-drill/latest.json",
  "storage_restore_runtime_active",
  "SQLite online backup",
  "size and SHA-256",
  "staging and rollback",
  "parent evidence reducer",
  "tools/server-scripts/lib/release-evidence-readiness.mjs"
]);
const REQUIRED_STORAGE_OPERATIONS = Object.freeze([
  "storage.backups.list",
  "storage.backups.create",
  "storage.backups.retention",
  "storage.backups.restore_preview",
  "storage.backups.restore"
]);

function createRunId() {
  return `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z")}-${process.pid}`;
}

function toRepoPath(targetPath) {
  return path.relative(repoRoot, targetPath).split(path.sep).join("/");
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readRepoText(relativePath) {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

async function writeFixture(rootPath, relativePath, value) {
  const targetPath = path.join(rootPath, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const content = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(targetPath, content, "utf8");
  return targetPath;
}

function storageOperationMap() {
  return new Map(SERVER_API_OPERATIONS.map((operation) => [operation.id, operation]));
}

async function verifyRunbookPromotion() {
  const text = await readRepoText(RUNBOOK_PATH);
  const missingTokens = REQUIRED_RUNBOOK_TOKENS.filter((token) => !text.includes(token));
  assert.deepEqual(missingTokens, [], `storage production restore runbook is missing tokens: ${missingTokens.join(", ")}`);
  return {
    runbook: RUNBOOK_PATH,
    tokenCount: REQUIRED_RUNBOOK_TOKENS.length,
    missingTokenCount: missingTokens.length
  };
}

function verifyStorageOperationRegistry() {
  const operations = storageOperationMap();
  const operationEvidence = Object.fromEntries(REQUIRED_STORAGE_OPERATIONS.map((operationId) => {
    const operation = operations.get(operationId);
    assert.ok(operation, `${operationId} must be registered`);
    return [
      operationId,
      {
        registered: true,
        readOnly: operation.readOnly === true,
        risk: operation.safety?.risk || "",
        requiresConfirmation: operation.safety?.requiresConfirmation === true,
        scopeCount: Array.isArray(operation.requiredScopes) ? operation.requiredScopes.length : 0
      }
    ];
  }));
  assert.equal(operationEvidence["storage.backups.restore_preview"].readOnly, true);
  assert.equal(operationEvidence["storage.backups.restore"].risk, "repair_write");
  assert.equal(operationEvidence["storage.backups.restore"].requiresConfirmation, true);
  assert.equal(operationEvidence["storage.backups.retention"].risk, "repair_write");
  assert.equal(operationEvidence["storage.backups.retention"].requiresConfirmation, true);
  return operationEvidence;
}

function createResponse() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    write(chunk) {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    end(chunk) {
      this.write(chunk);
      this.ended = true;
    },
    json() {
      return JSON.parse(Buffer.concat(this.chunks).toString("utf8") || "{}");
    }
  };
}

function createProofRecorder() {
  const calls = [];
  return {
    calls,
    async beginLifecycle(input = {}) {
      const entry = { ledgerEventId: `storage-proof-${calls.length + 1}`, operationId: input.operationId };
      calls.push({ kind: "begin", operationId: input.operationId });
      return entry;
    },
    async finishLifecycle(input = {}) {
      calls.push({ kind: "finish", operationId: input.entry?.operationId || "", status: input.status || "" });
      return { ...(input.entry || {}), status: input.status || "" };
    },
    async recordReceipt(input = {}) {
      calls.push({ kind: "receipt", operationId: input.operationId || "" });
      return { ledgerEventId: `storage-receipt-${calls.length}` };
    }
  };
}

function createAuditRecorder() {
  const records = [];
  return {
    records,
    append(entry = {}) {
      const record = { auditId: `storage-audit-${records.length + 1}`, ...entry };
      records.push(record);
      return record;
    }
  };
}

function createStorageOperationHarness(storageProvider, dispatchEvidence) {
  const lockManager = new MemoryLockManager();
  const proof = createProofRecorder();
  const audit = createAuditRecorder();
  const sendConsoleDomainOperation = async ({ operationId, input = {}, response, context = {} }) => {
    const result = await executeConsoleDomainOperation({ operationId, input, context });
    assert.ok(result, `${operationId} must be handled by the production console domain executor`);
    response.writeHead(result.status || 200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(result.payload ?? result));
  };
  const controllers = {
    system: createSystemControllerRuntimeHandlers({
      sendConsoleDomainOperation,
      storageProvider
    })
  };
  const allow = async () => ({
    ok: true,
    session: {
      user: {
        userId: "storage-drill-operator",
        scopes: ["runtime:admin", "console:read", "storage:retention", "storage:restore"]
      }
    },
    authorizationDecision: { reasonCode: "storage_drill_authorized" }
  });
  return {
    proof,
    audit,
    async execute({ operationId, input = {}, authorizeOperation = allow, expectedStatus = 200 }) {
      const operation = storageOperationMap().get(operationId);
      assert.ok(operation, `${operationId} must be registered`);
      const response = createResponse();
      const proofCallCountBefore = proof.calls.length;
      const auditCountBefore = audit.records.length;
      const result = await dispatchOperation({
        operation,
        controllers,
        request: {},
        response,
        requestBody: Buffer.from(JSON.stringify(input)),
        url: new URL(operation.http.path, "http://127.0.0.1"),
        transport: "http",
        method: operation.http.method,
        authorizeOperation,
        operationAuditStore: audit,
        operationProofSubstrate: proof,
        lockManager,
        concurrencyScope: "storage-production-restore-drill",
        logger: { debug() {}, info() {}, warn() {}, error() {} }
      });
      assert.equal(response.statusCode, expectedStatus, JSON.stringify(response.json()));
      const proofCalls = proof.calls.slice(proofCallCountBefore);
      const gates = Array.isArray(result.riskControl?.gateRecords) ? result.riskControl.gateRecords : [];
      const authorizationGate = gates.find((gate) => gate.controlRef?.controlId === "client.operation-permission.authorize") ||
        gates.find((gate) => gate.controlRef?.controlId === "client.operator-identity.bind" && gate.decision === "deny");
      const approvalGate = gates.find((gate) => gate.controlRef?.controlId === "client.high-risk-confirmation.approve");
      dispatchEvidence.operationSequence.push(operationId);
      dispatchEvidence.dispatchResults.push({
        operationId,
        authorizationDecision: authorizationGate?.decision || "",
        approvalDecision: approvalGate?.decision || "",
        executed: gates.some((gate) => gate.controlRef?.controlId === "platform.operation-proof.execute" && gate.decision === "allow"),
        statusCode: response.statusCode
      });
      dispatchEvidence.proofBeginCount += proofCalls.filter((call) => call.kind === "begin").length;
      dispatchEvidence.proofFinishCount += proofCalls.filter((call) => call.kind === "finish").length;
      dispatchEvidence.auditRecordCount += audit.records.length - auditCountBefore;
      return { payload: response.json(), result };
    },
    close() {
      lockManager.destroy();
    }
  };
}

async function main() {
  const runId = createRunId();
  const runDir = path.join(workRoot, runId);
  const reportPath = path.join(runDir, "report.json");
  const userDataPath = path.join(workRoot, runId, "user-data");
  const selectedRestorePaths = ["metadata", "objects", "settings.json", "jobs", "upload-sessions"];
  const dispatchEvidence = {
    operationSequence: [],
    dispatchResults: [],
    proofBeginCount: 0,
    proofFinishCount: 0,
    auditRecordCount: 0
  };

  await fs.mkdir(userDataPath, { recursive: true });

  let baselineKernel = null;
  let driftKernel = null;
  let restoredKernel = null;
  let operationHarness = null;

  try {
    baselineKernel = createStorageKernel({ userDataPath });
    const baselineProvider = createStorageProvider({ userDataPath, storageKernel: baselineKernel });
    const journalMode = String(baselineKernel.db.pragma("journal_mode", { simple: true })).toLowerCase();
    assert.equal(journalMode, "wal");
    assert.equal(baselineProvider.protocolVersion, STORAGE_PROTOCOL_VERSION);

    const settingsBefore = {
      deployment: "private",
      backend: "sqlite-first",
      restoreDrill: { version: 1, mode: "baseline" }
    };
    const uploadSessionBefore = {
      sessionId: "restore-drill-session",
      status: "ready",
      expectedOffset: 4096
    };
    const jobMetaBefore = {
      jobId: "restore-drill-job",
      status: "completed",
      artifact: "restore-drill"
    };

    await writeFixture(userDataPath, "settings.json", settingsBefore);
    await writeFixture(userDataPath, "jobs/restore-drill-job/meta.json", jobMetaBefore);
    await writeFixture(userDataPath, "upload-sessions/restore-drill-session/manifest.json", uploadSessionBefore);
    const storedObject = await baselineProvider.putObject({
      namespace: "restore-drill",
      fileName: "mail.eml",
      mediaType: "message/rfc822",
      buffer: [
        "From: restore-drill@example.com",
        "To: operator@example.com",
        "Subject: restore drill baseline",
        "",
        "baseline payload"
      ].join("\n"),
      metadata: {
        sourceType: "mail-forward",
        scenario: "storage-kernel"
      }
    });

    const baselineSummary = baselineProvider.getStorageSummary();
    assert.equal(baselineSummary.databaseExists, true);
    assert.equal(baselineSummary.objectCount >= 1, true);
    assert.equal((await baselineProvider.readObject({ storageRelativePath: storedObject.storageRelativePath })).length > 0, true);

    baselineKernel.close();
    baselineKernel = null;

    const backupProvider = createStorageProvider({ userDataPath });
    operationHarness = createStorageOperationHarness(backupProvider, dispatchEvidence);
    const capabilities = backupProvider.listCapabilities();
    const runbookPromotion = await verifyRunbookPromotion();
    const operationRegistryEvidence = verifyStorageOperationRegistry();
    const { payload: listBefore } = await operationHarness.execute({ operationId: "storage.backups.list" });
    assert.equal(listBefore.protocolVersion, BACKUP_RESTORE_PROTOCOL_VERSION);
    const deniedCreate = await operationHarness.execute({
      operationId: "storage.backups.create",
      input: {},
      authorizeOperation: async () => ({
        ok: false,
        status: 403,
        error: "storage drill authorization denial",
        authorizationDecision: { reasonCode: "storage_drill_denied" }
      }),
      expectedStatus: 403
    });
    assert.equal(deniedCreate.result.ok, false);
    const { payload: listAfterDeniedCreate } = await operationHarness.execute({ operationId: "storage.backups.list" });
    assert.equal(listAfterDeniedCreate.backups.length, listBefore.backups.length, "denied backup creation must have zero storage side effects");
    const { payload: backup } = await operationHarness.execute({
      operationId: "storage.backups.create",
      input: {}
    });
    assert.equal(backup.protocolVersion, BACKUP_RESTORE_PROTOCOL_VERSION);
    const { payload: retention } = await operationHarness.execute({
      operationId: "storage.backups.retention",
      input: {
        policy: { keepLast: 1, protectedBackupIds: [backup.backupId] },
        confirm: true
      }
    });
    assert.equal(retention.status, "applied");
    const { payload: listedBackups } = await operationHarness.execute({ operationId: "storage.backups.list" });
    assert.equal(listedBackups.backups.some((entry) => entry.backupId === backup.backupId), true);

    const backupManifestPath = path.join(userDataPath, "backups", backup.backupId, "backup-manifest.json");
    const backupManifest = await readJson(backupManifestPath);
    assert.equal(backupManifest.protocolVersion, BACKUP_RESTORE_PROTOCOL_VERSION);
    assert.equal(backupManifest.consistency?.sqlite, "copy-on-write-baseline-with-sqlite-online-page-backup");
    assert.equal(backupManifest.consistency?.manifestIntegrity, "size-and-sha256-per-file");
    assert.equal(
      backupManifest.files.some((entry) => entry.relativePath === "metadata/meshrix.sqlite"),
      true,
      "backup manifest must retain the SQLite metadata file"
    );
    assert.equal(
      backupManifest.files.some((entry) => entry.relativePath === storedObject.storageRelativePath),
      true,
      "backup manifest must retain the stored object payload"
    );

    driftKernel = createStorageKernel({ userDataPath });
    const driftProvider = createStorageProvider({ userDataPath, storageKernel: driftKernel });
    driftKernel.db.prepare("DELETE FROM storage_objects WHERE object_id = ?").run(storedObject.objectId);
    const driftSummary = driftProvider.getStorageSummary();
    assert.equal(driftSummary.objectCount, Math.max(0, baselineSummary.objectCount - 1));
    driftKernel.close();
    driftKernel = null;

    await writeFixture(userDataPath, "settings.json", {
      deployment: "private",
      backend: "sqlite-first",
      restoreDrill: { version: 2, mode: "drifted" }
    });
    await writeFixture(userDataPath, "jobs/restore-drill-job/meta.json", {
      jobId: "restore-drill-job",
      status: "failed",
      artifact: "drifted"
    });
    await writeFixture(userDataPath, "upload-sessions/restore-drill-session/manifest.json", {
      sessionId: "restore-drill-session",
      status: "drifted",
      expectedOffset: 0
    });
    await writeFixture(userDataPath, "runtime/drift-note.txt", "left intentionally outside selected restore paths\n");
    await fs.rm(path.join(userDataPath, storedObject.storageRelativePath), { force: true });

    const previewProvider = createStorageProvider({ userDataPath });
    operationHarness.close();
    operationHarness = createStorageOperationHarness(previewProvider, dispatchEvidence);
    const guardedRestore = await operationHarness.execute({
      operationId: "storage.backups.restore",
      input: {
        backupId: backup.backupId,
        includePaths: selectedRestorePaths
      },
      expectedStatus: 428
    });
    assert.equal(guardedRestore.result.ok, false);
    assert.equal(guardedRestore.payload.safety?.requiresConfirmation, true);

    const { payload: preview } = await operationHarness.execute({
      operationId: "storage.backups.restore_preview",
      input: {
        backupId: backup.backupId,
        includePaths: selectedRestorePaths
      }
    });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.summary.blocked, 0);
    assert.equal(preview.integrity?.verified, true);
    assert.equal(preview.integrity?.verifiedFileCount, preview.selectedFileCount);
    assert.equal(preview.summary.replace >= 3, true);
    assert.equal(preview.summary.create >= 1, true);

    const { payload: restoreApplied } = await operationHarness.execute({
      operationId: "storage.backups.restore",
      input: {
        backupId: backup.backupId,
        includePaths: selectedRestorePaths,
        confirm: true
      }
    });
    assert.equal(restoreApplied.applied, true);
    assert.equal(restoreApplied.dryRun, false);
    assert.equal(restoreApplied.integrity?.verified, true);
    assert.equal(Object.prototype.hasOwnProperty.call(restoreApplied, "reportPath"), false, "public restore output must not expose a local report path");
    const restoreReportRoot = path.join(userDataPath, "backups", backup.backupId, "restore-reports");
    const restoreReportNames = (await fs.readdir(restoreReportRoot)).filter((name) => name.endsWith(".json"));
    assert.equal(restoreReportNames.length, 1, "confirmed restore must persist exactly one receipt");
    const restoreReceipt = await readJson(path.join(restoreReportRoot, restoreReportNames[0]));
    assert.equal(restoreReceipt.applied, true);
    assert.equal(restoreReceipt.summary.blocked, 0);
    assert.equal(restoreReceipt.integrity?.verified, true);

    restoredKernel = createStorageKernel({ userDataPath });
    const restoredProvider = createStorageProvider({ userDataPath, storageKernel: restoredKernel });
    const restoredSummary = restoredProvider.getStorageSummary();
    const restoredSettings = await readJson(path.join(userDataPath, "settings.json"));
    const restoredJobMeta = await readJson(path.join(userDataPath, "jobs/restore-drill-job/meta.json"));
    const restoredUploadSession = await readJson(
      path.join(userDataPath, "upload-sessions/restore-drill-session/manifest.json")
    );
    const restoredObject = await restoredProvider.readObject({ storageRelativePath: storedObject.storageRelativePath });
    const unrelatedDrift = await fs.readFile(path.join(userDataPath, "runtime/drift-note.txt"), "utf8");

    operationHarness.close();
    operationHarness = createStorageOperationHarness(restoredProvider, dispatchEvidence);
    const onlineRestoreResponse = await operationHarness.execute({
      operationId: "storage.backups.restore",
      input: {
        backupId: backup.backupId,
        includePaths: selectedRestorePaths,
        confirm: true
      },
      expectedStatus: 409
    });
    assert.equal(onlineRestoreResponse.payload?.reasonCode, "storage_restore_runtime_active");

    assert.deepEqual(restoredSettings, settingsBefore);
    assert.deepEqual(restoredJobMeta, jobMetaBefore);
    assert.deepEqual(restoredUploadSession, uploadSessionBefore);
    assert.match(restoredObject.toString("utf8"), /baseline payload/);
    assert.equal(restoredSummary.objectCount, baselineSummary.objectCount);
    assert.match(unrelatedDrift, /left intentionally outside selected restore paths/);
    const auditedOperationCount = dispatchEvidence.operationSequence.filter(
      (operationId) => operationId !== "storage.backups.list"
    ).length;
    const operatorDrillReady = runbookPromotion.missingTokenCount === 0 &&
      guardedRestore.result.ok === false &&
      guardedRestore.payload.safety?.requiresConfirmation === true &&
      preview.dryRun === true &&
      preview.summary.blocked === 0 &&
      preview.integrity?.verified === true &&
      restoreApplied.applied === true &&
      restoreApplied.integrity?.verified === true &&
      restoreReceipt.applied === true &&
      restoreReceipt.summary.blocked === 0 &&
      restoreReceipt.integrity?.verified === true &&
      onlineRestoreResponse.payload?.reasonCode === "storage_restore_runtime_active" &&
      restoredSummary.objectCount === baselineSummary.objectCount &&
      listAfterDeniedCreate.backups.length === listBefore.backups.length &&
      retention.status === "applied" &&
      dispatchEvidence.proofBeginCount === dispatchEvidence.proofFinishCount &&
      dispatchEvidence.auditRecordCount === auditedOperationCount;

    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      verifier: VERIFIER,
      ok: true,
      redacted: true,
      rawPayloadIncluded: false,
      generatedAt: new Date().toISOString(),
      artifactKind: "storage-production-restore-drill",
      summary: {
        operatorRunbookPromoted: runbookPromotion.missingTokenCount === 0,
        backupManifestIntegrityVerified: backupManifest.consistency?.manifestIntegrity === "size-and-sha256-per-file",
        restoreIntegrityVerified: restoreReceipt.integrity?.verified === true,
        onlineRestoreRejected: onlineRestoreResponse.payload?.reasonCode === "storage_restore_runtime_active",
        restoredSettingsMatchBaseline: true,
        restoredJobMetaMatchBaseline: true,
        restoredUploadSessionMatchBaseline: true,
        restoredObjectMatchBaseline: true,
        storageKernelReopenedAfterRestore: true,
        unrelatedDriftOutsideRestoreScopePreserved: true,
        authorizationDeniedWithoutSideEffects: listAfterDeniedCreate.backups.length === listBefore.backups.length,
        registeredDispatcherVerified: dispatchEvidence.operationSequence.length > 0,
        proofLifecycleBalanced: dispatchEvidence.proofBeginCount === dispatchEvidence.proofFinishCount,
        retentionOperationApplied: retention.status === "applied"
      },
      selectedBackend: {
        deploymentMode: "private-deployment",
        backendKind: "sqlite-first-private-deployment",
        providerBoundary: "storage-provider",
        protocolVersion: STORAGE_PROTOCOL_VERSION,
        backupProtocolVersion: BACKUP_RESTORE_PROTOCOL_VERSION,
        journalMode
      },
      drill: {
        selectedRestorePaths,
        guardedRestoreWithoutApply: {
          statusCode: guardedRestore.result.statusCode,
          confirmationRequired: guardedRestore.payload.safety?.requiresConfirmation === true
        },
        preview: {
          dryRun: preview.dryRun,
          selectedFileCount: preview.selectedFileCount,
          summary: preview.summary,
          integrity: preview.integrity
        },
        restore: {
          applied: restoreApplied.applied,
          selectedFileCount: restoreApplied.selectedFileCount,
          summary: restoreApplied.summary,
          integrity: restoreApplied.integrity
        },
        onlineRestoreGuard: {
          status: onlineRestoreResponse.status,
          reasonCode: onlineRestoreResponse.payload?.reasonCode || ""
        }
      },
      operatorEvidence: {
        runbookPromotion,
        operationRegistry: operationRegistryEvidence,
        dispatchBoundary: "server-runtime.dispatchOperation",
        controllerBoundary: "system-controller-runtime-handlers",
        domainBoundary: "console-domain-operation-executor",
        operationSequence: dispatchEvidence.operationSequence,
        dispatchResults: dispatchEvidence.dispatchResults,
        proofBeginCount: dispatchEvidence.proofBeginCount,
        proofFinishCount: dispatchEvidence.proofFinishCount,
        auditRecordCount: dispatchEvidence.auditRecordCount,
        authorizationDeniedWithoutSideEffects: listAfterDeniedCreate.backups.length === listBefore.backups.length,
        guardedRestoreWithoutConfirm: {
          statusCode: guardedRestore.result.statusCode,
          confirmationRequired: guardedRestore.payload.safety?.requiresConfirmation === true
        },
        confirmedRestore: {
          dryRun: restoreApplied.dryRun,
          applied: restoreApplied.applied,
          blocked: restoreApplied.summary.blocked
        }
      },
      evidence: {
        storageCapabilities: capabilities.capabilities,
        baselineObjectCount: baselineSummary.objectCount,
        driftObjectCount: driftSummary.objectCount,
        restoredObjectCount: restoredSummary.objectCount,
        restoredSettingsMatchBaseline: true,
        restoredJobMetaMatchBaseline: true,
        restoredUploadSessionMatchBaseline: true,
        restoredObjectMatchBaseline: true,
        storageKernelReopenedAfterRestore: true,
        backupManifestIntegrityVerified: backupManifest.consistency?.manifestIntegrity === "size-and-sha256-per-file",
        restoreIntegrityVerified: restoreReceipt.integrity?.verified === true,
        onlineRestoreRejected: onlineRestoreResponse.payload?.reasonCode === "storage_restore_runtime_active",
        unrelatedDriftOutsideRestoreScopePreserved: true
      }
    };

    assert.equal(operatorDrillReady, true, "storage production restore drill facts must all pass");
    assertNoSensitiveReportLeak(report, "storage production restore drill report");
    await writeJson(reportPath, report);
    await writeJson(latestReportPath, report);

    console.log(JSON.stringify({
      ok: true,
      reportPath: toRepoPath(reportPath),
      latestReportPath: toRepoPath(latestReportPath)
    }, null, 2));
  } finally {
    operationHarness?.close();
    restoredKernel?.close();
    driftKernel?.close();
    baselineKernel?.close();
  }
}

await main();
