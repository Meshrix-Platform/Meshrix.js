export const M7_SCALE_PROFILE = "scale";

export const M7_SCALE_DISCIPLINE = Object.freeze({
  id: "m7-scale-capacity-fault",
  profile: M7_SCALE_PROFILE,
  requirement: "REQ-SCALE-M7-SCALE",
  reports: Object.freeze({
    capacity: Object.freeze({
      path: "build/reports/m7-scale/capacity.json",
      schemaVersion: "v0.0.1:meshrix:m7-scale-capacity-report-1",
      claim: "capacity_profile",
      verifier: "tools/server-scripts/verify-m7-scale-capacity.mjs",
      childEntry: "tools/server-scripts/lib/scale-profile-capacity-child.mjs",
    }),
    memory: Object.freeze({
      path: "build/reports/m7-scale/memory.json",
      schemaVersion: "v0.0.1:meshrix:m7-scale-memory-report-1",
      claim: "memory_leak_gate",
      verifier: "tools/server-scripts/verify-m7-scale-memory.mjs",
      childEntry: "tools/server-scripts/lib/scale-profile-memory-child.mjs",
    }),
    fault: Object.freeze({
      path: "build/reports/m7-scale/fault.json",
      schemaVersion: "v0.0.1:meshrix:m7-scale-fault-report-1",
      claim: "fault_profile",
      verifier: "tools/server-scripts/verify-m7-scale-fault.mjs",
      childEntry: "tools/server-scripts/lib/scale-profile-fault-child.mjs",
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

export function assertM7ScaleReportShape(report, kind) {
  const spec = M7_SCALE_DISCIPLINE.reports[kind];
  if (!spec) {
    throw new Error(`Unknown scale M7 report kind: ${String(kind)}.`);
  }
  if (!isPlainObject(report)) {
    throw new Error(`${kind} report must be an object.`);
  }
  if (report.schema_version !== spec.schemaVersion) {
    throw new Error(`${kind} report schema version is not current.`);
  }
  if (report.profile !== M7_SCALE_PROFILE) {
    throw new Error(`${kind} report profile must be scale.`);
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

export function assertM7ScaleReports(reports) {
  if (!isPlainObject(reports)) {
    throw new Error("Scale M7 reports must be an object.");
  }
  for (const kind of Object.keys(M7_SCALE_DISCIPLINE.reports)) {
    assertM7ScaleReportShape(reports[kind], kind);
    if (reports[kind].accepted !== true) {
      throw new Error(`${kind} report is not accepted.`);
    }
  }
  return true;
}
