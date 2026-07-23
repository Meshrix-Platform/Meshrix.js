export const M7_REGIONAL_DR_PROFILE = "regional-dr";

export const M7_REGIONAL_DR_ENVIRONMENT_VAR = "LICO_M7_REGIONAL_DR_ENVIRONMENT";

export const M7_REGIONAL_DR_DISCIPLINE = Object.freeze({
  id: "m7-regional-dr-capacity-fault",
  profile: M7_REGIONAL_DR_PROFILE,
  requirement: "REQ-SCALE-M7-REGIONAL-DR",
  environment: Object.freeze({
    variable: M7_REGIONAL_DR_ENVIRONMENT_VAR,
    schemaVersion: "licomesh.m7-regional-dr-environment.v1",
    requiredFields: Object.freeze(["profile", "classification", "primary", "secondary"]),
  }),
  reports: Object.freeze({
    capacity: Object.freeze({
      path: "build/reports/m7-regional-dr/capacity.json",
      schemaVersion: "licomesh.m7-regional-dr-capacity-report.v1",
      claim: "capacity_profile",
      verifier: "tools/server-scripts/verify-m7-regional-dr-capacity.mjs",
    }),
    memory: Object.freeze({
      path: "build/reports/m7-regional-dr/memory.json",
      schemaVersion: "licomesh.m7-regional-dr-memory-report.v1",
      claim: "memory_leak_gate",
      verifier: "tools/server-scripts/verify-m7-regional-dr-memory.mjs",
    }),
    fault: Object.freeze({
      path: "build/reports/m7-regional-dr/fault.json",
      schemaVersion: "licomesh.m7-regional-dr-fault-report.v1",
      claim: "fault_profile",
      verifier: "tools/server-scripts/verify-m7-regional-dr-fault.mjs",
    }),
  }),
  processIsolation: Object.freeze({
    capacity: "fresh-process",
    memory: "fresh-process",
    fault: "fresh-process",
    crossReportReuse: "forbidden",
    crossProfilePromotion: "forbidden",
  }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function assertM7RegionalDrEnvironmentReceipt(receipt) {
  if (!isPlainObject(receipt)) {
    throw new Error("Regional-DR M7 environment receipt must be an object.");
  }
  if (receipt.schema_version !== M7_REGIONAL_DR_DISCIPLINE.environment.schemaVersion) {
    throw new Error("Regional-DR M7 environment receipt schema version is not current.");
  }
  if (receipt.profile !== M7_REGIONAL_DR_PROFILE) {
    throw new Error("Regional-DR M7 environment receipt profile must be regional-dr.");
  }
  if (!hasNonEmptyString(receipt.classification)) {
    throw new Error("Regional-DR M7 environment receipt classification is missing.");
  }
  for (const field of ["primary", "secondary"]) {
    if (!isPlainObject(receipt[field]) || !hasNonEmptyString(receipt[field].serviceUrl)) {
      throw new Error(`Regional-DR M7 environment receipt ${field}.serviceUrl is missing.`);
    }
  }
  return true;
}

export function assertM7RegionalDrReportShape(report, kind) {
  const spec = M7_REGIONAL_DR_DISCIPLINE.reports[kind];
  if (!spec) {
    throw new Error(`Unknown regional-DR M7 report kind: ${String(kind)}.`);
  }
  if (!isPlainObject(report)) {
    throw new Error(`${kind} report must be an object.`);
  }
  if (report.schema_version !== spec.schemaVersion) {
    throw new Error(`${kind} report schema version is not current.`);
  }
  if (report.profile !== M7_REGIONAL_DR_PROFILE) {
    throw new Error(`${kind} report profile must be regional-dr.`);
  }
  if (report.claim !== spec.claim) {
    throw new Error(`${kind} report claim must remain ${spec.claim}.`);
  }
  if (typeof report.processPid !== "number" || report.processPid <= 0) {
    throw new Error(`${kind} report must record the fresh verification process identity.`);
  }
  if (report.processPid === process.pid) {
    throw new Error(`${kind} report must not be produced by the parent acceptance process.`);
  }
  if (typeof report.accepted !== "boolean") {
    throw new Error(`${kind} report accepted flag is missing.`);
  }
  return true;
}

export function assertM7RegionalDrReports(reports) {
  if (!isPlainObject(reports)) {
    throw new Error("Regional-DR M7 reports must be an object.");
  }
  for (const kind of Object.keys(M7_REGIONAL_DR_DISCIPLINE.reports)) {
    assertM7RegionalDrReportShape(reports[kind], kind);
    if (reports[kind].accepted !== true) {
      throw new Error(`${kind} report is not accepted.`);
    }
  }
  return true;
}
