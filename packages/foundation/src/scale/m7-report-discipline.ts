export type M7ReportKind = "capacity" | "memory" | "fault";

export interface M7ReportSpec {
  readonly path: string;
  readonly schemaVersion: string;
  readonly claim: string;
  readonly verifier: string;
  readonly childEntry?: string;
}

export interface M7ReportDiscipline {
  readonly profile: string;
  readonly reports: Readonly<Record<M7ReportKind, M7ReportSpec>>;
}

export type UnknownRecord = Record<string, unknown>;

export function isPlainObject(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function assertM7ReportShape(
  discipline: M7ReportDiscipline,
  report: unknown,
  kind: unknown,
  label: string
): true {
  if (kind !== "capacity" && kind !== "memory" && kind !== "fault") {
    throw new Error(`Unknown ${label} M7 report kind: ${String(kind)}.`);
  }
  const spec = discipline.reports[kind];
  if (!isPlainObject(report)) throw new Error(`${kind} report must be an object.`);
  if (report.schema_version !== spec.schemaVersion) throw new Error(`${kind} report schema version is not current.`);
  if (report.profile !== discipline.profile) throw new Error(`${kind} report profile must be ${discipline.profile}.`);
  if (report.claim !== spec.claim) throw new Error(`${kind} report claim must remain ${spec.claim}.`);
  if (typeof report.processPid !== "number" || report.processPid <= 0) {
    throw new Error(`${kind} report must record the fresh verification process identity.`);
  }
  if (report.processPid === process.pid) {
    throw new Error(`${kind} report must not be produced by the parent acceptance process.`);
  }
  if (typeof report.accepted !== "boolean") throw new Error(`${kind} report accepted flag is missing.`);
  return true;
}

export function assertM7Reports(discipline: M7ReportDiscipline, reports: unknown, label: string): true {
  if (!isPlainObject(reports)) throw new Error(`${label} M7 reports must be an object.`);
  for (const kind of Object.keys(discipline.reports) as M7ReportKind[]) {
    const report = reports[kind];
    assertM7ReportShape(discipline, report, kind, label);
    if (!isPlainObject(report) || report.accepted !== true) throw new Error(`${kind} report is not accepted.`);
  }
  return true;
}
