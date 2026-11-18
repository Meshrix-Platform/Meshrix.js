import {
  assertM7Reports,
  assertM7ReportShape,
  isPlainObject
} from "./m7-report-discipline.ts";

export const M7_REGIONAL_DR_PROFILE = "regional-dr";

export const M7_REGIONAL_DR_ENVIRONMENT_VAR = "MESHRIX_M7_REGIONAL_DR_ENVIRONMENT";

export const M7_REGIONAL_DR_DISCIPLINE = Object.freeze({
  id: "m7-regional-dr-capacity-fault",
  profile: M7_REGIONAL_DR_PROFILE,
  requirement: "REQ-SCALE-M7-REGIONAL-DR",
  environment: Object.freeze({
    variable: M7_REGIONAL_DR_ENVIRONMENT_VAR,
    schemaVersion: "v0.0.1:meshrix:m7-regional-dr-environment-1",
    requiredFields: Object.freeze(["profile", "classification", "primary", "secondary"]),
  }),
  reports: Object.freeze({
    capacity: Object.freeze({
      path: "build/reports/m7-regional-dr/capacity.json",
      schemaVersion: "v0.0.1:meshrix:m7-regional-dr-capacity-report-1",
      claim: "capacity_profile",
      verifier: "tools/server-scripts/verify-m7-regional-dr-capacity.ts",
    }),
    memory: Object.freeze({
      path: "build/reports/m7-regional-dr/memory.json",
      schemaVersion: "v0.0.1:meshrix:m7-regional-dr-memory-report-1",
      claim: "memory_leak_gate",
      verifier: "tools/server-scripts/verify-m7-regional-dr-memory.ts",
    }),
    fault: Object.freeze({
      path: "build/reports/m7-regional-dr/fault.json",
      schemaVersion: "v0.0.1:meshrix:m7-regional-dr-fault-report-1",
      claim: "fault_profile",
      verifier: "tools/server-scripts/verify-m7-regional-dr-fault.ts",
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

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function assertM7RegionalDrEnvironmentReceipt(receipt?: unknown): true {
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
    const endpoint = receipt[field];
    if (!isPlainObject(endpoint) || !hasNonEmptyString(endpoint.serviceUrl)) {
      throw new Error(`Regional-DR M7 environment receipt ${field}.serviceUrl is missing.`);
    }
  }
  return true;
}

export function assertM7RegionalDrReportShape(report?: unknown, kind?: unknown): true {
  return assertM7ReportShape(M7_REGIONAL_DR_DISCIPLINE, report, kind, "regional-DR");
}

export function assertM7RegionalDrReports(reports?: unknown): true {
  return assertM7Reports(M7_REGIONAL_DR_DISCIPLINE, reports, "Regional-DR");
}
