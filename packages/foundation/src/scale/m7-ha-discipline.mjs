export const M7_HA_PROFILE = "ha";

export const M7_HA_DISCIPLINE = Object.freeze({
  id: "m7-ha-capacity-fault",
  profile: M7_HA_PROFILE,
  requirement: "REQ-SCALE-M7-HA",
  reports: Object.freeze({
    capacity: Object.freeze({
      path: "build/reports/m7-ha/capacity.json",
      schemaVersion: "licomesh.m7-ha-capacity-report.v1",
      claim: "capacity_profile",
      verifier: "tools/server-scripts/verify-m7-ha-capacity.mjs",
      childEntry: "tools/server-scripts/lib/ha-profile-capacity-child.mjs",
    }),
    memory: Object.freeze({
      path: "build/reports/m7-ha/memory.json",
      schemaVersion: "licomesh.m7-ha-memory-report.v1",
      claim: "memory_leak_gate",
      verifier: "tools/server-scripts/verify-m7-ha-memory.mjs",
      childEntry: "tools/server-scripts/lib/ha-profile-memory-child.mjs",
    }),
    fault: Object.freeze({
      path: "build/reports/m7-ha/fault.json",
      schemaVersion: "licomesh.m7-ha-fault-report.v1",
      claim: "fault_profile",
      verifier: "tools/server-scripts/verify-m7-ha-fault.mjs",
      childEntry: "tools/server-scripts/lib/ha-profile-fault-child.mjs",
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

export function assertM7HaReportShape(report, kind) {
  const spec = M7_HA_DISCIPLINE.reports[kind];
  if (!spec) {
    throw new Error(`Unknown HA M7 report kind: ${String(kind)}.`);
  }
  if (!isPlainObject(report)) {
    throw new Error(`${kind} report must be an object.`);
  }
  if (report.schema_version !== spec.schemaVersion) {
    throw new Error(`${kind} report schema version is not current.`);
  }
  if (report.profile !== M7_HA_PROFILE) {
    throw new Error(`${kind} report profile must be ha.`);
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

export function assertM7HaReports(reports) {
  if (!isPlainObject(reports)) {
    throw new Error("HA M7 reports must be an object.");
  }
  for (const kind of Object.keys(M7_HA_DISCIPLINE.reports)) {
    assertM7HaReportShape(reports[kind], kind);
    if (reports[kind].accepted !== true) {
      throw new Error(`${kind} report is not accepted.`);
    }
  }
  return true;
}
