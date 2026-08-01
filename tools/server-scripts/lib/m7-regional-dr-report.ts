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

const defaultRepoRoot: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function resolveRepoRoot(value: any = defaultRepoRoot) : any {
  return path.resolve(value);
}

export async function readJson(filePath?: any) : Promise<any> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function writeReportAtomically(repoRoot?: any, relativePath?: any, report?: any) : Promise<any> {
  const targetPath: any = path.join(repoRoot, relativePath);
  const serialized: any = `${JSON.stringify(report, null, 2)}\n`;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporary: any = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, targetPath);
  assertNoSensitiveReportLeak(report, relativePath);
  return targetPath;
}

export async function loadDeclaredEnvironmentReceipt(repoRoot: any = defaultRepoRoot) : Promise<any> {
  const receiptPath: any = process.env[M7_REGIONAL_DR_ENVIRONMENT_VAR];
  if (!receiptPath || !String(receiptPath).trim()) {
    return {
      accepted: false,
      reasonCode: "missing_declared_environment",
      message: `${M7_REGIONAL_DR_ENVIRONMENT_VAR} must point to a declared regional-DR environment receipt.`,
    };
  }
  const resolved: any = path.isAbsolute(receiptPath)
    ? receiptPath
    : path.join(repoRoot, receiptPath);
  const receipt: any = await readJson(resolved);
  assertM7RegionalDrEnvironmentReceipt(receipt);
  return {
    accepted: true,
    receipt,
    receiptPath: path.relative(repoRoot, resolved).split(path.sep).join("/"),
  };
}

export function createBlockedReport({
  kind,
  reasonCode,
  message,
  finishedAt = new Date().toISOString(),
}: Record<string, any>) : any {
  const spec: any = M7_REGIONAL_DR_DISCIPLINE.reports[kind];
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
}: Record<string, any>) : any {
  const spec: any = M7_REGIONAL_DR_DISCIPLINE.reports[kind];
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
