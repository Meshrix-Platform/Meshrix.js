
import {
  errorPayload,
  requireDevopsProvider,
  requireStorageProvider,
  result
} from "./shared.mjs";
import { buildConsoleStorageSummary } from "@lico/protocols/http/api-facade";

const STORAGE_DOCTOR_SUMMARY_FIELDS = Object.freeze([
  "objectCount",
  "ownedObjectCount",
  "deletionOperationCount",
  "objectFileCount",
  "objectBytes",
  "jobDirectoryCount"
]);
const STORAGE_DOCTOR_ISSUE_FIELDS = Object.freeze([
  "directoryName",
  "tableName",
  "objectId",
  "jobId",
  "metadataJobId",
  "storageRelativePath",
  "expectedByteSize",
  "actualByteSize",
  "operationId",
  "status",
  "updatedAt"
]);

function projectOwnedFields(value, fields) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const projected = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      projected[field] = source[field];
    }
  }
  return projected;
}

function buildConsoleStorageDoctorReport(report = {}) {
  const source = report && typeof report === "object" && !Array.isArray(report) ? report : {};
  const issues = source.issues && typeof source.issues === "object" && !Array.isArray(source.issues)
    ? source.issues
    : {};
  const projected = {
    summary: projectOwnedFields(source.summary, STORAGE_DOCTOR_SUMMARY_FIELDS),
    issues: Object.fromEntries(Object.entries(issues).map(([category, entries]) => [
      category,
      Array.isArray(entries)
        ? entries.map((entry) => projectOwnedFields(entry, STORAGE_DOCTOR_ISSUE_FIELDS))
        : []
    ]))
  };
  if (Object.prototype.hasOwnProperty.call(source, "databasePresent")) {
    projected.databasePresent = source.databasePresent === true;
  }
  if (Object.prototype.hasOwnProperty.call(source, "healthy")) {
    projected.healthy = source.healthy === true;
  }
  return projected;
}

function storageFailureStatus(error) {
  const reasonCode = String(error?.reasonCode || error?.code || "");
  if ([
    "storage_restore_runtime_active",
    "storage_restore_runtime_state_unknown",
    "storage_operation_busy"
  ].includes(reasonCode)) return 409;
  if (reasonCode === "storage_restore_integrity_failed") return 422;
  return 400;
}

function storageFailurePayload(error, fallbackMessage) {
  return errorPayload(error, fallbackMessage, {
    reasonCode: String(error?.reasonCode || error?.code || "storage_operation_failed"),
    ...(error?.detailReasonCode
      ? { detailReasonCode: String(error.detailReasonCode) }
      : {})
  });
}

function storageExecutionInput(input, context) {
  const signal = context?.operationLock?.signal || context?.signal || null;
  return signal ? { ...(input || {}), signal } : (input || {});
}

export async function executeStorageOperation({ operationId, input, context }) {
  const id = String(operationId || "");
  const handledOperations = new Set([
    "storage.summary",
    "storage.doctor",
    "storage.reconcile",
    "storage.backups.list",
    "storage.backups.create",
    "storage.backups.retention",
    "storage.backups.restore_preview",
    "storage.backups.restore"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }

  const { storageProvider, error } = requireStorageProvider(context);
  if (error) {
    return error;
  }

  if (id === "storage.summary") {
    return result(200, buildConsoleStorageSummary(storageProvider));
  }
  if (id === "storage.doctor") {
    return result(200, buildConsoleStorageDoctorReport(await storageProvider.runDoctor()));
  }
  if (id === "storage.reconcile") {
    return result(200, await storageProvider.reconcile(input || {}));
  }
  if (id === "storage.backups.list") {
    return result(200, await storageProvider.listBackups());
  }
  if (id === "storage.backups.create") {
    try {
      return result(200, await storageProvider.createBackup(storageExecutionInput(input, context)));
    } catch (error) {
      return result(storageFailureStatus(error), storageFailurePayload(error, "Storage backup creation failed."));
    }
  }
  if (id === "storage.backups.retention") {
    try {
      return result(200, await storageProvider.applyBackupRetention(storageExecutionInput(input, context)));
    } catch (error) {
      return result(storageFailureStatus(error), storageFailurePayload(error, "Storage backup retention failed."));
    }
  }
  if (id === "storage.backups.restore_preview") {
    try {
      return result(200, await storageProvider.restoreBackupPreview(storageExecutionInput(input, context)));
    } catch (error) {
      return result(storageFailureStatus(error), storageFailurePayload(error, "Storage restore preview failed."));
    }
  }
  if (id === "storage.backups.restore") {
    try {
      return result(200, await storageProvider.restoreBackup(storageExecutionInput(input, context)));
    } catch (error) {
      return result(storageFailureStatus(error), storageFailurePayload(error, "Storage restore failed."));
    }
  }

  return null;
}

export async function executeMonitorAlertOperation({ operationId, input = {}, context }) {
  const id = String(operationId || "");
  const handledOperations = new Set([
    "system.monitor_alerts.get",
    "system.monitor_alerts.set",
    "system.monitor_alerts.ack",
    "system.background_supervisor.recover"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }

  const { devopsProvider, error } = requireDevopsProvider(context);
  if (error) {
    return error;
  }
  if (id === "system.monitor_alerts.get") {
    if (typeof devopsProvider.getMonitorAlertState !== "function") {
      return result(503, { error: "监控报警状态接口不可用。" });
    }
    return result(200, await devopsProvider.getMonitorAlertState({
      ...(input || {}),
      refresh: false,
      workQueueObservation: context.workQueueObservation
    }));
  }
  if (id === "system.monitor_alerts.set") {
    if (typeof devopsProvider.saveMonitorAlertConfig !== "function" || typeof devopsProvider.getMonitorAlertState !== "function") {
      return result(503, { error: "监控报警配置接口不可用。" });
    }
    const config = await devopsProvider.saveMonitorAlertConfig(input.config || input);
    const state = await devopsProvider.getMonitorAlertState({ ...(input || {}), workQueueObservation: context.workQueueObservation });
    return result(200, {
      ...state,
      config
    });
  }
  if (id === "system.monitor_alerts.ack") {
    if (typeof devopsProvider.acknowledgeMonitorAlert !== "function") {
      return result(503, { error: "监控报警确认接口不可用。" });
    }
    const alertId = String(input.alertId || input["alert-id"] || input.id || "").trim();
    return result(200, await devopsProvider.acknowledgeMonitorAlert({ ...input, alertId, workQueueObservation: context.workQueueObservation }));
  }
  if (id === "system.background_supervisor.recover") {
    if (typeof devopsProvider.recoverBackgroundSupervisor !== "function") {
      return result(503, { error: "后台 Worker 管理进程恢复接口不可用。" });
    }
    const recovery = await devopsProvider.recoverBackgroundSupervisor({
      ...input,
      userDataPath: context.userDataPath
    });
    const backgroundProcessStatus =
      typeof devopsProvider.getBackgroundProcessStatus === "function"
        ? await devopsProvider.getBackgroundProcessStatus({ userDataPath: context.userDataPath })
        : null;
    const monitorAlertState =
      typeof devopsProvider.getMonitorAlertState === "function"
        ? await devopsProvider.getMonitorAlertState({
            ...input,
            userDataPath: context.userDataPath,
            workQueueObservation: context.workQueueObservation
          })
        : null;
    return result(200, {
      recovery,
      backgroundProcessStatus,
      monitorAlertState
    });
  }

  return null;
}
