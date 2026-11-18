import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoSensitiveReportLeak } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import {
  M7_SCALE_DISCIPLINE,
  M7_SCALE_PROFILE,
} from "../../../packages/foundation/src/scale/m7-scale-discipline.ts";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
type ReportKind = keyof typeof M7_SCALE_DISCIPLINE.reports;
type UnknownRecord = Record<string, unknown>;

export function resolveRepoRoot(value = defaultRepoRoot): string {
  return path.resolve(value);
}

export async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function writeReportAtomically(repoRoot: string, relativePath: string, report: unknown): Promise<string> {
  const targetPath = path.join(repoRoot, relativePath);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporary = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, targetPath);
  assertNoSensitiveReportLeak(report, relativePath);
  return targetPath;
}

export function createBlockedReport({
  kind,
  reasonCode,
  message,
  finishedAt = new Date().toISOString(),
}: {
  kind: ReportKind;
  reasonCode: unknown;
  message: unknown;
  finishedAt?: string;
}): UnknownRecord {
  const spec = M7_SCALE_DISCIPLINE.reports[kind];
  return {
    schema_version: spec.schemaVersion,
    profile: M7_SCALE_PROFILE,
    claim: spec.claim,
    verifier: spec.verifier,
    processPid: process.pid,
    finishedAt,
    accepted: false,
    summary: {
      ready: false,
      reasonCode,
      message,
    },
  };
}

export function createAcceptedReport({
  kind,
  summary,
  finishedAt = new Date().toISOString(),
}: {
  kind: ReportKind;
  summary: UnknownRecord;
  finishedAt?: string;
}): UnknownRecord {
  const spec = M7_SCALE_DISCIPLINE.reports[kind];
  return {
    schema_version: spec.schemaVersion,
    profile: M7_SCALE_PROFILE,
    claim: spec.claim,
    verifier: spec.verifier,
    processPid: process.pid,
    finishedAt,
    accepted: true,
    summary: {
      ready: true,
      ...summary,
    },
  };
}
