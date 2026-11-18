import {
  activateAlertRecord,
  alertLifecycleDefinition,
  createAlertRecord,
  transitionAlertRecord,
} from "./alert-service.ts";
import { createBoundedMetricRegistry } from "./metric-registry.ts";
import {
  assertNoSensitiveReportLeak,
  finalizeSensitiveReport,
} from "./sensitive-report-scan.ts";
import {
  assertObservabilityPipelineBoundaries,
  assertObservabilityPipelineCapabilities,
  OBSERVABILITY_PIPELINE_DISCIPLINE,
} from "./observability-pipeline-discipline.ts";

export const OBSERVABILITY_PIPELINE_PROTOCOL_VERSION: any = "v0.0.1:observability:pipeline-1";

export function createObservabilityPipelineProvider({
  metricFamilies = ["observability"],
  metricStatuses = ["ok", "failed"],
  metricReasons = ["accepted", "rejected"],
}: Record<string, any> = {}) : any {
  const metrics: any = createBoundedMetricRegistry({
    families: metricFamilies,
    statuses: metricStatuses,
    reasons: metricReasons,
  });

  return Object.freeze({
    protocolVersion: OBSERVABILITY_PIPELINE_PROTOCOL_VERSION,
    listCapabilities() : any {
      const capabilities: any[] = [
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
    resolveBoundaries() : any {
      const boundaries: Readonly<Record<string, any>> = Object.freeze({
        telemetryExport: Object.freeze({
          exportMetricBatch: (batch: Record<string, any> = {}) : any => metrics.record(batch),
          exportTraceBatch: async () : Promise<any> => Object.freeze({ exported: 0 }),
          listExportPartitions: async () : Promise<any> => Object.freeze([]),
          finalizeExportBatch: async (batch: Record<string, any> = {}) : Promise<any> => Object.freeze({
            ...batch,
            finalized: true,
          }),
        }),
        evidenceStorage: Object.freeze({
          storeEvidenceReport: async (report: Record<string, any> = {}) : Promise<any> => finalizeSensitiveReport(report),
          readEvidenceReport: async (reportId: any = "") : Promise<any> => Object.freeze({ reportId }),
          listEvidenceReports: async () : Promise<any> => Object.freeze([]),
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
