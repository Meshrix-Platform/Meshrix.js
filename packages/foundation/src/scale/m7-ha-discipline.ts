import { assertM7Reports, assertM7ReportShape } from "./m7-report-discipline.ts";

export const M7_HA_PROFILE = "ha";

export const M7_HA_DISCIPLINE = Object.freeze({
  id: "m7-ha-capacity-fault",
  profile: M7_HA_PROFILE,
  requirement: "REQ-SCALE-M7-HA",
  reports: Object.freeze({
    capacity: Object.freeze({
      path: "build/reports/m7-ha/capacity.json",
      schemaVersion: "v0.0.1:meshrix:m7-ha-capacity-report-1",
      claim: "capacity_profile",
      verifier: "tools/server-scripts/verify-m7-ha-capacity.ts",
      childEntry: "tools/server-scripts/lib/ha-profile-capacity-child.ts",
    }),
    memory: Object.freeze({
      path: "build/reports/m7-ha/memory.json",
      schemaVersion: "v0.0.1:meshrix:m7-ha-memory-report-1",
      claim: "memory_leak_gate",
      verifier: "tools/server-scripts/verify-m7-ha-memory.ts",
      childEntry: "tools/server-scripts/lib/ha-profile-memory-child.ts",
    }),
    fault: Object.freeze({
      path: "build/reports/m7-ha/fault.json",
      schemaVersion: "v0.0.1:meshrix:m7-ha-fault-report-1",
      claim: "fault_profile",
      verifier: "tools/server-scripts/verify-m7-ha-fault.ts",
      childEntry: "tools/server-scripts/lib/ha-profile-fault-child.ts",
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

export function assertM7HaReportShape(report?: unknown, kind?: unknown): true {
  return assertM7ReportShape(M7_HA_DISCIPLINE, report, kind, "HA");
}

export function assertM7HaReports(reports?: unknown): true {
  return assertM7Reports(M7_HA_DISCIPLINE, reports, "HA");
}
