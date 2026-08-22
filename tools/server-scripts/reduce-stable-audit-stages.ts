#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoLeak } from "./lib/report-evidence-safety.ts";

const REPO_ROOT: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REGISTRY_PATH: any = path.join(REPO_ROOT, "tools/registry/tests.registry.json");
const DEFAULT_INPUT_DIR: any = path.join(REPO_ROOT, "build/test-reports/stable-audit-stages");
const DEFAULT_OUTPUT_PATH: any = path.join(REPO_ROOT, "build/test-reports/audit-public.json");
const REVISION: any = /^[a-f0-9]{40}$/u;

export const STABLE_AUDIT_PROFILES: readonly string[] = Object.freeze([
  "audit-stable-repository",
  "audit-stable-governance",
  "audit-stable-runtime",
  "audit-stable-downstream",
  "audit-stable-sandbox",
  "audit-stable-data",
  "audit-stable-services",
  "audit-stable-console",
]);

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

export function resolveProfileSuiteIds(registry: any, profileName: string, seen = new Set<string>()): string[] {
  if (seen.has(profileName)) fail("stable_audit_profile_cycle");
  const profile: any = registry?.profiles?.[profileName];
  if (!profile) fail("stable_audit_profile_missing");
  const nextSeen: any = new Set(seen).add(profileName);
  const inherited: any[] = profile.extends
    ? resolveProfileSuiteIds(registry, String(profile.extends), nextSeen)
    : [];
  return [...inherited, ...(Array.isArray(profile.suites) ? profile.suites.map(String) : [])]
    .filter((suiteId: string, index: number, values: string[]) => values.indexOf(suiteId) === index);
}

export function validateStableAuditPartition(registry: any): Readonly<Record<string, readonly string[]>> {
  const expected: any[] = resolveProfileSuiteIds(registry, "audit-public");
  const stages: Record<string, readonly string[]> = {};
  const owners: any = new Map<string, string>();
  for (const profile of STABLE_AUDIT_PROFILES) {
    const suites: any[] = resolveProfileSuiteIds(registry, profile);
    if (suites.length === 0) fail("stable_audit_stage_empty");
    stages[profile] = Object.freeze(suites);
    for (const suiteId of suites) {
      if (owners.has(suiteId)) fail("stable_audit_stage_overlap");
      owners.set(suiteId, profile);
    }
  }
  if (expected.some((suiteId) => !owners.has(suiteId)) || [...owners].some(([suiteId]) => !expected.includes(suiteId))) {
    fail("stable_audit_stage_coverage_mismatch");
  }
  return Object.freeze(stages);
}

function requirePassingStageReport(report: any, profile: string, suites: readonly string[]): string {
  if (report?.runner !== "meshrix-unified-test-runner" || report?.profile !== profile) {
    fail("stable_audit_stage_report_invalid");
  }
  if (!REVISION.test(String(report.sourceRevision || ""))) fail("stable_audit_stage_revision_invalid");
  if (JSON.stringify(report.selectedSuites) !== JSON.stringify(suites)) {
    fail("stable_audit_stage_suite_mismatch");
  }
  if (
    report?.summary?.failed !== 0 ||
    report?.summary?.dryRun !== 0 ||
    report?.summary?.timedOut !== 0 ||
    report?.summary?.coverageReady !== true ||
    report?.summary?.releaseReady !== true ||
    report?.summary?.reportLeakScan !== true
  ) fail("stable_audit_stage_not_ready");
  return report.sourceRevision;
}

export function reduceStableAuditReports({ registry, reports }: { registry: any; reports: any[] }): any {
  const stages: any = validateStableAuditPartition(registry);
  const reportsByProfile: any = new Map<string, any>();
  for (const report of reports) {
    const profile: any = String(report?.profile || "");
    if (!STABLE_AUDIT_PROFILES.includes(profile)) continue;
    if (reportsByProfile.has(profile)) fail("stable_audit_stage_report_duplicate");
    reportsByProfile.set(profile, report);
  }
  if (reportsByProfile.size !== STABLE_AUDIT_PROFILES.length) fail("stable_audit_stage_report_missing");

  let sourceRevision: any = "";
  const orderedReports: any[] = [];
  for (const profile of STABLE_AUDIT_PROFILES) {
    const report: any = reportsByProfile.get(profile);
    const revision: any = requirePassingStageReport(report, profile, stages[profile]);
    if (sourceRevision && sourceRevision !== revision) fail("stable_audit_stage_revision_mismatch");
    sourceRevision = revision;
    orderedReports.push(report);
  }

  const expectedSuites: any[] = resolveProfileSuiteIds(registry, "audit-public");
  const startedAt: any = new Date(Math.min(...orderedReports.map((report) => Date.parse(report.startedAt))));
  const finishedAt: any = new Date(Math.max(...orderedReports.map((report) => Date.parse(report.finishedAt))));
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(finishedAt.getTime())) {
    fail("stable_audit_stage_timestamp_invalid");
  }
  const total = (field: string) => orderedReports.reduce(
    (sum, report) => sum + Number(report?.summary?.[field] || 0),
    0,
  );
  const report: any = {
    schemaVersion: "v0.0.1:schema:definition-1",
    verifier: "tools/server-scripts/reduce-stable-audit-stages.ts",
    runner: "meshrix-stable-audit-reducer",
    profile: "audit-public",
    selectedSuites: expectedSuites,
    sourceRevision,
    stages: STABLE_AUDIT_PROFILES.map((profile) => ({
      profile,
      selectedSuites: stages[profile],
      summary: reportsByProfile.get(profile).summary,
    })),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: total("durationMs") || orderedReports.reduce(
      (sum, stage) => sum + Number(stage.durationMs || 0),
      0,
    ),
    summary: {
      passed: total("passed"),
      failed: 0,
      skipped: total("skipped"),
      dryRun: 0,
      timedOut: 0,
      coverageReady: true,
      releaseReady: true,
      reportLeakScan: true,
      selectedSuiteCount: expectedSuites.length,
      completedStageCount: STABLE_AUDIT_PROFILES.length,
    },
    suites: orderedReports.flatMap((stage) => stage.suites || []),
  };
  assertNoLeak(report, "stable audit reduction report");
  return report;
}

function parseArguments(argv: string[]): { inputDir: string; outputPath: string } {
  let inputDir: any = DEFAULT_INPUT_DIR;
  let outputPath: any = DEFAULT_OUTPUT_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const argument: any = argv[index];
    if (argument === "--input-dir") inputDir = path.resolve(REPO_ROOT, argv[++index] || "");
    else if (argument === "--output") outputPath = path.resolve(REPO_ROOT, argv[++index] || "");
    else fail("stable_audit_reducer_arguments_invalid");
  }
  return { inputDir, outputPath };
}

async function main(): Promise<void> {
  const { inputDir, outputPath } = parseArguments(process.argv.slice(2));
  const registry: any = JSON.parse(await fs.readFile(REGISTRY_PATH, "utf8"));
  const files: any[] = (await fs.readdir(inputDir)).filter((name) => name.endsWith(".json")).sort();
  const reports: any[] = await Promise.all(files.map(async (name) =>
    JSON.parse(await fs.readFile(path.join(inputDir, name), "utf8"))));
  const report: any = reduceStableAuditReports({ registry, reports });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[stable-audit] stages=${report.summary.completedStageCount} suites=${report.summary.selectedSuiteCount} status=passed`);
}

const invoked: any = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((error: any) => {
    console.error(String(error?.code || "stable_audit_reducer_failed"));
    process.exitCode = 1;
  });
}
