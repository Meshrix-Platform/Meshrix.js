import { assertM7Reports, assertM7ReportShape } from "./m7-report-discipline.ts";

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
      verifier: "tools/server-scripts/verify-m7-scale-capacity.ts",
      childEntry: "tools/server-scripts/lib/scale-profile-capacity-child.ts",
    }),
    memory: Object.freeze({
      path: "build/reports/m7-scale/memory.json",
      schemaVersion: "v0.0.1:meshrix:m7-scale-memory-report-1",
      claim: "memory_leak_gate",
      verifier: "tools/server-scripts/verify-m7-scale-memory.ts",
      childEntry: "tools/server-scripts/lib/scale-profile-memory-child.ts",
    }),
    fault: Object.freeze({
      path: "build/reports/m7-scale/fault.json",
      schemaVersion: "v0.0.1:meshrix:m7-scale-fault-report-1",
      claim: "fault_profile",
      verifier: "tools/server-scripts/verify-m7-scale-fault.ts",
      childEntry: "tools/server-scripts/lib/scale-profile-fault-child.ts",
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

export function assertM7ScaleReportShape(report?: unknown, kind?: unknown): true {
  return assertM7ReportShape(M7_SCALE_DISCIPLINE, report, kind, "Scale");
}

export function assertM7ScaleReports(reports?: unknown): true {
  return assertM7Reports(M7_SCALE_DISCIPLINE, reports, "Scale");
}
