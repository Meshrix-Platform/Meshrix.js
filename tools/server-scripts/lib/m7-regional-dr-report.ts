import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoSensitiveReportLeak } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import {
  M7_REGIONAL_DR_DISCIPLINE,
  M7_REGIONAL_DR_ENVIRONMENT_VAR,
  M7_REGIONAL_DR_PROFILE,
  assertM7RegionalDrEnvironmentReceipt,
} from "../../../packages/foundation/src/scale/m7-regional-dr-discipline.ts";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
type ReportKind = keyof typeof M7_REGIONAL_DR_DISCIPLINE.reports;
type UnknownRecord = Record<string, unknown>;

export type DeclaredEnvironmentReceiptResult =
  | { accepted: false; reasonCode: string; message: string }
  | { accepted: true; receipt: UnknownRecord; receiptPath: string };

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

export async function loadDeclaredEnvironmentReceipt(repoRoot = defaultRepoRoot): Promise<DeclaredEnvironmentReceiptResult> {
  const receiptPath = process.env[M7_REGIONAL_DR_ENVIRONMENT_VAR];
  if (!receiptPath || !String(receiptPath).trim()) {
    return {
      accepted: false,
      reasonCode: "missing_declared_environment",
      message: `${M7_REGIONAL_DR_ENVIRONMENT_VAR} must point to a declared regional-DR environment receipt.`,
    };
  }
  const resolved = path.isAbsolute(receiptPath)
    ? receiptPath
    : path.join(repoRoot, receiptPath);
  const receipt = await readJson(resolved);
  assertM7RegionalDrEnvironmentReceipt(receipt);
  return {
    accepted: true,
    receipt: receipt as UnknownRecord,
    receiptPath: path.relative(repoRoot, resolved).split(path.sep).join("/"),
  };
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
  const spec = M7_REGIONAL_DR_DISCIPLINE.reports[kind];
  return {
    schema_version: spec.schemaVersion,
    profile: M7_REGIONAL_DR_PROFILE,
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
  const spec = M7_REGIONAL_DR_DISCIPLINE.reports[kind];
  return {
    schema_version: spec.schemaVersion,
    profile: M7_REGIONAL_DR_PROFILE,
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
