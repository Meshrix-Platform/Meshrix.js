import path from "node:path";
import { sanitizeVerificationLog } from "../../../../tools/server-scripts/localize-verify-failure.ts";

export const MATERIALIZATION_TEST_PATH =
  "tests/vitest/server/upload-custody-workspace-materialization.test.ts";
export const MATERIALIZATION_TEST_COUNT = 81;
export const MATERIALIZATION_PROJECT = "serial";
export const MATERIALIZATION_SUITE_PREFIX =
  "opaque upload custody to governed workspace materialization > ";

export type AcceptanceFailureCode =
  | "materialization_acceptance_linux_required"
  | "materialization_acceptance_cancelled"
  | "materialization_acceptance_spawn_failed"
  | "materialization_acceptance_output_limit"
  | "materialization_acceptance_collection_failed"
  | "materialization_acceptance_collection_invalid"
  | "materialization_acceptance_report_invalid"
  | "materialization_acceptance_run_failed";

export class MaterializationAcceptanceError extends Error {
  readonly code: AcceptanceFailureCode;
  readonly exitCode: number;
  readonly sanitizedDiagnostic: string;

  constructor(code: AcceptanceFailureCode, exitCode = 1, sanitizedDiagnostic = "") {
    super(code);
    this.name = "MaterializationAcceptanceError";
    this.code = code;
    this.exitCode = exitCode;
    this.sanitizedDiagnostic = sanitizedDiagnostic;
  }
}

export interface CollectedMaterializationCase {
  file?: unknown;
  projectName?: unknown;
  name?: unknown;
}

export interface MaterializationRunReport {
  success?: unknown;
  numTotalTests?: unknown;
  numPassedTests?: unknown;
  numFailedTests?: unknown;
  numPendingTests?: unknown;
  numTodoTests?: unknown;
  numFailedTestSuites?: unknown;
  numPendingTestSuites?: unknown;
  testResults?: unknown;
}

export interface MaterializationProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function sanitizeMaterializationDiagnostic(
  cwd: string,
  sections: readonly string[]
): string {
  return sanitizeVerificationLog(sections.filter(Boolean).join("\n"), cwd);
}

export function validateMaterializationCollection(
  value: unknown,
  cwd: string
): readonly string[] {
  if (!Array.isArray(value) || value.length !== MATERIALIZATION_TEST_COUNT) {
    throw new MaterializationAcceptanceError("materialization_acceptance_collection_invalid");
  }

  const expectedFile = path.resolve(cwd, MATERIALIZATION_TEST_PATH);
  const names: string[] = [];
  const fullNames = new Set<string>();
  for (const entry of value as CollectedMaterializationCase[]) {
    if (
      !entry ||
      path.resolve(cwd, typeof entry.file === "string" ? entry.file : "") !== expectedFile ||
      entry.projectName !== MATERIALIZATION_PROJECT ||
      typeof entry.name !== "string" ||
      !entry.name.startsWith(MATERIALIZATION_SUITE_PREFIX) ||
      entry.name.length <= MATERIALIZATION_SUITE_PREFIX.length
    ) {
      throw new MaterializationAcceptanceError("materialization_acceptance_collection_invalid");
    }

    const fullName = entry.name.split(" > ").join(" ");
    if (fullNames.has(fullName)) {
      throw new MaterializationAcceptanceError("materialization_acceptance_collection_invalid");
    }
    names.push(fullName);
    fullNames.add(fullName);
  }

  return Object.freeze(names);
}

export function validateMaterializationRunReport(
  report: MaterializationRunReport,
  processResult: MaterializationProcessResult,
  expectedNames: readonly string[],
  cwd: string
): void {
  if (processResult.exitCode !== 0 || processResult.signal !== null) {
    throw new MaterializationAcceptanceError("materialization_acceptance_run_failed");
  }

  if (
    expectedNames.length !== MATERIALIZATION_TEST_COUNT ||
    new Set(expectedNames).size !== MATERIALIZATION_TEST_COUNT ||
    report.success !== true ||
    report.numTotalTests !== MATERIALIZATION_TEST_COUNT ||
    report.numPassedTests !== MATERIALIZATION_TEST_COUNT ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    report.numFailedTestSuites !== 0 ||
    report.numPendingTestSuites !== 0 ||
    !Array.isArray(report.testResults) ||
    report.testResults.length !== 1
  ) {
    throw new MaterializationAcceptanceError("materialization_acceptance_report_invalid");
  }

  const result = report.testResults[0] as {
    name?: unknown;
    status?: unknown;
    assertionResults?: unknown;
  } | null;
  if (
    !result ||
    typeof result.name !== "string" ||
    path.resolve(cwd, result.name) !== path.resolve(cwd, MATERIALIZATION_TEST_PATH) ||
    result.status !== "passed" ||
    !Array.isArray(result.assertionResults) ||
    result.assertionResults.length !== MATERIALIZATION_TEST_COUNT
  ) {
    throw new MaterializationAcceptanceError("materialization_acceptance_report_invalid");
  }

  const actualNames = new Set<string>();
  for (const assertion of result.assertionResults) {
    if (
      !assertion ||
      typeof assertion !== "object" ||
      !("fullName" in assertion) ||
      typeof assertion.fullName !== "string" ||
      assertion.status !== "passed" ||
      actualNames.has(assertion.fullName)
    ) {
      throw new MaterializationAcceptanceError("materialization_acceptance_report_invalid");
    }
    actualNames.add(assertion.fullName);
  }

  if (
    actualNames.size !== MATERIALIZATION_TEST_COUNT ||
    expectedNames.some((name) => !actualNames.has(name))
  ) {
    throw new MaterializationAcceptanceError("materialization_acceptance_report_invalid");
  }
}
