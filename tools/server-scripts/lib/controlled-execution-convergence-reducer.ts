import {
  containsSensitiveReportData,
  reportPayloadDigest,
} from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import { validateReleaseCandidateIdentity } from "../verify-release-candidate-identity.ts";

export const CONTROLLED_EXECUTION_FINAL_SCHEMA: any =
  "v0.0.1:execution-sandbox:controlled-execution-convergence-final-report-2";

export const CONTROLLED_EXECUTION_LEAF_SPECS: readonly any[] = Object.freeze([
  Object.freeze({
    key: "sandbox",
    path: "build/reports/controlled-execution-sandbox.json",
    schemaVersion: "v0.0.1:execution-sandbox:acceptance-report-1",
    verifier: "tools/server-scripts/verify-controlled-execution-sandbox.ts",
    readyPath: ["sandboxAcceptanceReady"]
  }),
  Object.freeze({
    key: "oci",
    path: "build/reports/execution-sandbox-oci-conformance.json",
    schemaVersion: "v0.0.1:execution-sandbox:oci-conformance-report-1",
    verifier: "tools/server-scripts/verify-execution-sandbox-oci-conformance.ts",
    readyPath: ["productionBackendConformance"]
  }),
  Object.freeze({
    key: "custody",
    path: "build/reports/opaque-sandbox-custody.json",
    schemaVersion: "v0.0.1:execution-sandbox:opaque-custody-acceptance-report-1",
    verifier: "tools/server-scripts/verify-opaque-sandbox-custody.ts",
    readyPath: ["custodyAcceptanceReady"]
  }),
  Object.freeze({
    key: "launcher",
    path: "build/reports/execution-launcher-boundary.json",
    schemaVersion: "v0.0.1:execution-sandbox:launcher-boundary-report-1",
    verifier: "tools/verifiers/execution-launcher-boundary.ts",
    readyPath: ["boundaryClosed"]
  })
]);

function requireCondition(condition?: any, message?: any) : any {
  if (!condition) throw new Error(message);
}

function valueAt(value?: any, path?: any) : any {
  return path.reduce((current?: any, key?: any) : any => current?.[key], value);
}

export function reduceControlledExecutionConvergence({
  generatedAt,
  sourceContext,
  candidate,
  leafReports
}: Record<string, any> = {}) : any {
  let currentCandidate: any;
  try {
    currentCandidate = validateReleaseCandidateIdentity(candidate);
  } catch {
    throw new Error("Controlled execution release candidate is invalid");
  }
  requireCondition(
    currentCandidate.source_revision === sourceContext?.sourceRevision,
    "Controlled execution release candidate is not current",
  );
  requireCondition(
    currentCandidate.supported_profiles.length === 1 &&
      currentCandidate.supported_profiles[0] === "enterprise-single-node",
    "Enterprise single-node release candidate profile is missing",
  );
  requireCondition(!containsSensitiveReportData(currentCandidate), "Controlled execution release candidate is privacy-unsafe");
  const leafEvidence: any[] = [];
  for (const spec of CONTROLLED_EXECUTION_LEAF_SPECS) {
    const report: any = leafReports?.[spec.key];
    requireCondition(report, `Controlled execution leaf report is missing: ${spec.path}`);
    requireCondition(report.schemaVersion === spec.schemaVersion, `Controlled execution leaf schema is mismatched: ${spec.path}`);
    requireCondition(report.verifier === spec.verifier, `Controlled execution leaf verifier is mismatched: ${spec.path}`);
    requireCondition(valueAt(report, spec.readyPath) === true, `Controlled execution leaf is not ready: ${spec.path}`);
    requireCondition(report.summary?.reportLeakScan === true, `Controlled execution leaf privacy scan is missing: ${spec.path}`);
    requireCondition(report.sourceContext?.sourceRevision === sourceContext.sourceRevision, `Controlled execution leaf revision is stale: ${spec.path}`);
    requireCondition(report.sourceContext?.sourceTreeDigest === sourceContext.sourceTreeDigest, `Controlled execution leaf source tree is stale: ${spec.path}`);
    requireCondition(report.sourceContext?.verifier === spec.verifier, `Controlled execution leaf source verifier is mismatched: ${spec.path}`);
    requireCondition(/^sha256:[a-f0-9]{64}$/u.test(String(report.sourceContext?.verifierDigest || "")), `Controlled execution leaf verifier digest is invalid: ${spec.path}`);
    requireCondition(!containsSensitiveReportData(report), `Controlled execution leaf is privacy-unsafe: ${spec.path}`);
    leafEvidence.push(Object.freeze({
      key: spec.key,
      path: spec.path,
      reportDigest: reportPayloadDigest(report),
      verifierDigest: report.sourceContext.verifierDigest
    }));
  }
  requireCondition(leafReports.oci.checks?.linuxRuntime === true, "Production provider was not verified on Linux");
  requireCondition(leafReports.oci.checks?.independentInstancesDestroyed === true, "Production provider clean-instance cleanup is incomplete");

  const report: Record<string, any> = {
    schemaVersion: CONTROLLED_EXECUTION_FINAL_SCHEMA,
    verifier: "tools/server-scripts/verify-controlled-execution-convergence.ts",
    generatedAt: String(generatedAt || ""),
    sourceContext,
    candidate: Object.freeze({
      schemaVersion: currentCandidate.schema_version,
      candidateDigest: currentCandidate.candidate_digest,
      sourceRevision: currentCandidate.source_revision,
      repositoryTreeDigest: currentCandidate.repository_tree_digest,
      reportInventoryDigest: currentCandidate.report_inventory_digest,
      supportedProfiles: Object.freeze([...currentCandidate.supported_profiles]),
    }),
    leafEvidence,
    summary: {
      controlledExecutionConvergenceReady: true,
      candidateProfileCount: currentCandidate.supported_profiles.length,
      leafReportCount: leafEvidence.length,
      reportLeakScan: true
    }
  };
  requireCondition(!containsSensitiveReportData(report), "Controlled execution final report is privacy-unsafe");
  return Object.freeze(report);
}
