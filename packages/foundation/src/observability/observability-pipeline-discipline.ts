const TELEMETRY_EXPORT_OPERATIONS: readonly any[] = Object.freeze([
  "exportMetricBatch",
  "exportTraceBatch",
  "listExportPartitions",
  "finalizeExportBatch",
]);

const OPERATIONAL_EVIDENCE_OPERATIONS: readonly any[] = Object.freeze([
  "storeEvidenceReport",
  "readEvidenceReport",
  "listEvidenceReports",
  "finalizeSensitiveReport",
]);

const OPERATIONAL_ALERT_OPERATIONS: readonly any[] = Object.freeze([
  "createAlertRecord",
  "transitionAlertRecord",
  "activateAlertRecord",
  "alertLifecycleDefinition",
]);

export const OBSERVABILITY_PIPELINE_DISCIPLINE: Readonly<Record<string, any>> = Object.freeze({
  id: "observability-pipeline",
  telemetryExport: Object.freeze({
    capabilityId: "telemetry-export",
    kind: "telemetry",
    operations: TELEMETRY_EXPORT_OPERATIONS,
  }),
  operationalEvidence: Object.freeze({
    capabilityId: "operational-evidence",
    kind: "evidence",
    operations: OPERATIONAL_EVIDENCE_OPERATIONS,
  }),
  operationalAlerts: Object.freeze({
    capabilityId: "operational-alerts",
    kind: "alerts",
    operations: OPERATIONAL_ALERT_OPERATIONS,
  }),
  separation: Object.freeze({
    telemetryExport: "telemetry-export",
    evidenceStorage: "operational-evidence",
    alertLifecycle: "operational-alerts",
    rawEvidencePromotion: "forbidden",
  }),
});

function capabilityById(capabilities?: any, capabilityId?: any) : any {
  return capabilities.find((entry?: any) : any => entry?.id === capabilityId) ?? null;
}

function operationsMatch(actual?: any, expected?: any) : any {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((operation?: any, index?: any) : any => actual[index] === operation);
}

export function assertObservabilityPipelineCapabilities(capabilities?: any) : any {
  if (!Array.isArray(capabilities)) {
    throw new Error("Observability pipeline capabilities must be an array.");
  }
  const telemetry: any = capabilityById(
    capabilities,
    OBSERVABILITY_PIPELINE_DISCIPLINE.telemetryExport.capabilityId,
  );
  const evidence: any = capabilityById(
    capabilities,
    OBSERVABILITY_PIPELINE_DISCIPLINE.operationalEvidence.capabilityId,
  );
  const alerts: any = capabilityById(
    capabilities,
    OBSERVABILITY_PIPELINE_DISCIPLINE.operationalAlerts.capabilityId,
  );
  if (!telemetry || telemetry.kind !== OBSERVABILITY_PIPELINE_DISCIPLINE.telemetryExport.kind) {
    throw new Error("Bounded telemetry export must remain behind the governed telemetry capability.");
  }
  if (!evidence || evidence.kind !== OBSERVABILITY_PIPELINE_DISCIPLINE.operationalEvidence.kind) {
    throw new Error("Operational evidence must remain behind the governed evidence capability.");
  }
  if (!alerts || alerts.kind !== OBSERVABILITY_PIPELINE_DISCIPLINE.operationalAlerts.kind) {
    throw new Error("Operational alerts must remain behind the governed alerts capability.");
  }
  if (!operationsMatch(telemetry.operations, OBSERVABILITY_PIPELINE_DISCIPLINE.telemetryExport.operations)) {
    throw new Error("Telemetry export operations changed without updating the export contract.");
  }
  if (!operationsMatch(evidence.operations, OBSERVABILITY_PIPELINE_DISCIPLINE.operationalEvidence.operations)) {
    throw new Error("Operational evidence operations changed without updating the evidence contract.");
  }
  if (!operationsMatch(alerts.operations, OBSERVABILITY_PIPELINE_DISCIPLINE.operationalAlerts.operations)) {
    throw new Error("Operational alert operations changed without updating the alert contract.");
  }
  return true;
}

export function assertObservabilityPipelineBoundaries({
  telemetryExport,
  evidenceStorage,
  alertLifecycle,
}: Record<string, any> = {}) : any {
  if (!telemetryExport || typeof telemetryExport.exportMetricBatch !== "function") {
    throw new Error("Bounded telemetry export requires an exporter with exportMetricBatch.");
  }
  if (typeof telemetryExport.finalizeExportBatch !== "function") {
    throw new Error("Bounded telemetry export requires finalizeExportBatch.");
  }
  if (!evidenceStorage || typeof evidenceStorage.storeEvidenceReport !== "function") {
    throw new Error("Privacy-safe evidence storage requires storeEvidenceReport.");
  }
  if (typeof evidenceStorage.finalizeSensitiveReport !== "function") {
    throw new Error("Privacy-safe evidence requires finalizeSensitiveReport.");
  }
  if (!alertLifecycle || typeof alertLifecycle.createAlertRecord !== "function") {
    throw new Error("Operational alerts require createAlertRecord.");
  }
  if (typeof alertLifecycle.transitionAlertRecord !== "function") {
    throw new Error("Operational alerts require transitionAlertRecord.");
  }
  return true;
}
