import { canonicalDigest, isPrivacySafeValue } from "../../plan/plan-final-receipt.mjs";

export const CONTROLLED_EXECUTION_FINAL_SCHEMA =
  "v0.0.1:execution-sandbox:controlled-execution-convergence-final-report-1";

export const CONTROLLED_EXECUTION_LEAF_SPECS = Object.freeze([
  Object.freeze({
    key: "sandbox",
    path: "build/reports/controlled-execution-sandbox.json",
    schemaVersion: "v0.0.1:execution-sandbox:acceptance-report-1",
    verifier: "tools/server-scripts/verify-controlled-execution-sandbox.mjs",
    readyPath: ["sandboxAcceptanceReady"]
  }),
  Object.freeze({
    key: "oci",
    path: "build/reports/execution-sandbox-oci-conformance.json",
    schemaVersion: "v0.0.1:execution-sandbox:oci-conformance-report-1",
    verifier: "tools/server-scripts/verify-execution-sandbox-oci-conformance.mjs",
    readyPath: ["productionBackendConformance"]
  }),
  Object.freeze({
    key: "custody",
    path: "build/reports/opaque-sandbox-custody.json",
    schemaVersion: "v0.0.1:execution-sandbox:opaque-custody-acceptance-report-1",
    verifier: "tools/server-scripts/verify-opaque-sandbox-custody.mjs",
    readyPath: ["custodyAcceptanceReady"]
  }),
  Object.freeze({
    key: "launcher",
    path: "build/reports/execution-launcher-boundary.json",
    schemaVersion: "v0.0.1:execution-sandbox:launcher-boundary-report-1",
    verifier: "tools/verifiers/execution-launcher-boundary.mjs",
    readyPath: ["boundaryClosed"]
  })
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function valueAt(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}

function privacySafeTree(value) {
  if (Array.isArray(value)) return value.every(privacySafeTree);
  if (value && typeof value === "object") return Object.values(value).every(privacySafeTree);
  return isPrivacySafeValue(value);
}

export function reduceControlledExecutionConvergence({
  generatedAt,
  plan,
  sourceContext,
  planReceipt,
  leafReports
} = {}) {
  requireCondition(
    plan?.directory === "end-to-end-release/enterprise-single-node" &&
      plan?.finalNodeId === planReceipt?.finalNodeId,
    "Enterprise single-node final node is mismatched",
  );
  requireCondition(plan?.status === "completed", "Controlled execution final node is not completed");
  requireCondition(Array.isArray(plan.requirements) && plan.requirements.length === 11,
    "Enterprise single-node requirements are incomplete");
  requireCondition(plan.criteriaChecked === true, "Controlled execution acceptance criteria are incomplete");
  requireCondition(planReceipt?.finalNodeId === plan.finalNodeId && planReceipt?.proofVerified === true, "Controlled execution Plan receipt is not current");
  requireCondition(planReceipt?.privacySafe === true, "Controlled execution Plan receipt is privacy-unsafe");
  requireCondition(
    Array.isArray(planReceipt?.profiles) && planReceipt.profiles.includes("enterprise-single-node"),
    "Enterprise single-node profile receipt is missing",
  );
  const leafEvidence = [];
  for (const spec of CONTROLLED_EXECUTION_LEAF_SPECS) {
    const report = leafReports?.[spec.key];
    requireCondition(report, `Controlled execution leaf report is missing: ${spec.path}`);
    requireCondition(report.schemaVersion === spec.schemaVersion, `Controlled execution leaf schema is mismatched: ${spec.path}`);
    requireCondition(report.verifier === spec.verifier, `Controlled execution leaf verifier is mismatched: ${spec.path}`);
    requireCondition(valueAt(report, spec.readyPath) === true, `Controlled execution leaf is not ready: ${spec.path}`);
    requireCondition(report.summary?.reportLeakScan === true, `Controlled execution leaf privacy scan is missing: ${spec.path}`);
    requireCondition(report.sourceContext?.sourceRevision === sourceContext.sourceRevision, `Controlled execution leaf revision is stale: ${spec.path}`);
    requireCondition(report.sourceContext?.sourceTreeDigest === sourceContext.sourceTreeDigest, `Controlled execution leaf source tree is stale: ${spec.path}`);
    requireCondition(report.sourceContext?.verifier === spec.verifier, `Controlled execution leaf source verifier is mismatched: ${spec.path}`);
    requireCondition(/^sha256:[a-f0-9]{64}$/u.test(String(report.sourceContext?.verifierDigest || "")), `Controlled execution leaf verifier digest is invalid: ${spec.path}`);
    requireCondition(privacySafeTree(report), `Controlled execution leaf is privacy-unsafe: ${spec.path}`);
    leafEvidence.push(Object.freeze({
      key: spec.key,
      path: spec.path,
      reportDigest: canonicalDigest(report),
      verifierDigest: report.sourceContext.verifierDigest
    }));
  }
  requireCondition(leafReports.oci.checks?.linuxRuntime === true, "Production provider was not verified on Linux");
  requireCondition(leafReports.oci.checks?.independentInstancesDestroyed === true, "Production provider clean-instance cleanup is incomplete");

  const report = {
    schemaVersion: CONTROLLED_EXECUTION_FINAL_SCHEMA,
    verifier: "tools/server-scripts/verify-controlled-execution-convergence.mjs",
    generatedAt: String(generatedAt || ""),
    sourceContext,
    plan,
    baselineReceipt: planReceipt,
    leafEvidence,
    summary: {
      controlledExecutionConvergenceReady: true,
      baselineReceiptProfileCount: planReceipt.profiles.length,
      leafReportCount: leafEvidence.length,
      reportLeakScan: true
    }
  };
  requireCondition(privacySafeTree(report), "Controlled execution final report is privacy-unsafe");
  return Object.freeze(report);
}
