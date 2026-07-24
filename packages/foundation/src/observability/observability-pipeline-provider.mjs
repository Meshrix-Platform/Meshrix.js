import {
  activateAlertRecord,
  alertLifecycleDefinition,
  createAlertRecord,
  transitionAlertRecord,
} from "./alert-service.mjs";
import { createBoundedMetricRegistry } from "./metric-registry.mjs";
import {
  assertNoSensitiveReportLeak,
  finalizeSensitiveReport,
} from "./sensitive-report-scan.mjs";
import {
  assertObservabilityPipelineBoundaries,
  assertObservabilityPipelineCapabilities,
  OBSERVABILITY_PIPELINE_DISCIPLINE,
} from "./observability-pipeline-discipline.mjs";

export const OBSERVABILITY_PIPELINE_PROTOCOL_VERSION = "v0.0.1:observability:pipeline-1";

export function createObservabilityPipelineProvider({
  metricFamilies = ["observability"],
  metricStatuses = ["ok", "failed"],
  metricReasons = ["accepted", "rejected"],
} = {}) {
  const metrics = createBoundedMetricRegistry({
    families: metricFamilies,
    statuses: metricStatuses,
    reasons: metricReasons,
  });

  return Object.freeze({
    protocolVersion: OBSERVABILITY_PIPELINE_PROTOCOL_VERSION,
    listCapabilities() {
      const capabilities = [
        {
          id: OBSERVABILITY_PIPELINE_DISCIPLINE.telemetryExport.capabilityId,
          kind: OBSERVABILITY_PIPELINE_DISCIPLINE.telemetryExport.kind,
          operations: [...OBSERVABILITY_PIPELINE_DISCIPLINE.telemetryExport.operations],
        },
        {
          id: OBSERVABILITY_PIPELINE_DISCIPLINE.operationalEvidence.capabilityId,
          kind: OBSERVABILITY_PIPELINE_DISCIPLINE.operationalEvidence.kind,
          operations: [...OBSERVABILITY_PIPELINE_DISCIPLINE.operationalEvidence.operations],
        },
        {
          id: OBSERVABILITY_PIPELINE_DISCIPLINE.operationalAlerts.capabilityId,
          kind: OBSERVABILITY_PIPELINE_DISCIPLINE.operationalAlerts.kind,
          operations: [...OBSERVABILITY_PIPELINE_DISCIPLINE.operationalAlerts.operations],
        },
      ];
      assertObservabilityPipelineCapabilities(capabilities);
      return {
        protocolVersion: OBSERVABILITY_PIPELINE_PROTOCOL_VERSION,
        capabilities,
      };
    },
    resolveBoundaries() {
      const boundaries = Object.freeze({
        telemetryExport: Object.freeze({
          exportMetricBatch: (batch = {}) => metrics.record(batch),
          exportTraceBatch: async () => Object.freeze({ exported: 0 }),
          listExportPartitions: async () => Object.freeze([]),
          finalizeExportBatch: async (batch = {}) => Object.freeze({
            ...batch,
            finalized: true,
          }),
        }),
        evidenceStorage: Object.freeze({
          storeEvidenceReport: async (report = {}) => finalizeSensitiveReport(report),
          readEvidenceReport: async (reportId = "") => Object.freeze({ reportId }),
          listEvidenceReports: async () => Object.freeze([]),
          finalizeSensitiveReport,
          assertNoSensitiveReportLeak,
        }),
        alertLifecycle: Object.freeze({
          createAlertRecord,
          transitionAlertRecord,
          activateAlertRecord,
          alertLifecycleDefinition,
        }),
      });
      assertObservabilityPipelineBoundaries(boundaries);
      return boundaries;
    },
  });
}
