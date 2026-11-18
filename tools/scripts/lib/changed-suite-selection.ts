/**
 * Change-driven suite selection.
 *
 * `changed` answers one question: which suites does this change actually touch? It is
 * deliberately narrow, because its purpose is a fast developer loop. Suites that
 * declare `triggerPaths: ["."]` genuinely read the whole repository; running them on
 * every local change would cost minutes and defeat the purpose, so they are excluded
 * and reported as work that belongs to the full `engineering` scope.
 *
 * The mechanism is soft by design. An undeclared suite is not an error: it is reported
 * as invisible to change detection, so declaring `triggerPaths` only ever narrows what
 * a change selects. One case is fatal, because the result would otherwise be a
 * verification claim with nothing behind it: verification-sensitive files changed and
 * no declared suite covered any of them.
 */

export interface TriggerSuiteEntry {
  id: string;
  triggerPaths?: readonly string[];
}

export interface ChangedSuiteSelection {
  /** Suites to run, each with the changed paths that selected it. */
  selected: { id: string; matchedPaths: string[] }[];
  /** Suites that read the whole repository, so `changed` leaves them to `engineering`. */
  wholeRepository: string[];
  /** Suites with no declaration, invisible to change detection. */
  unscoped: string[];
  /** Changed verification-sensitive files that no declared suite covers. */
  uncoveredSensitiveFiles: string[];
  /** Changed verification-sensitive files, covered or not. */
  sensitiveFiles: string[];
}

/**
 * Paths whose change can alter behaviour and therefore needs verification. Documentation
 * and other non-executable content is excluded so a documentation-only change does not
 * demand a test run.
 */
const VERIFICATION_SENSITIVE_PREFIXES: readonly string[] = Object.freeze([
  "apps/",
  "config/",
  "docker/",
  "packages/",
  "plugins/",
  "services/",
  "tests/",
  "tools/",
  "workflows/"
]);

const VERIFICATION_SENSITIVE_FILES: readonly string[] = Object.freeze([
  ".github/",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.ts"
]);

export function isVerificationSensitivePath(changedFile: string): boolean {
  const normalized: string = normalizePath(changedFile);
  if (!normalized) return false;
  return VERIFICATION_SENSITIVE_PREFIXES.some((prefix: string) : any => normalized.startsWith(prefix))
    || VERIFICATION_SENSITIVE_FILES.some((entry: string) : any =>
      entry.endsWith("/") ? normalized.startsWith(entry) : normalized === entry)
    || /^tsconfig\.[^/]+\.json$/u.test(normalized);
}

/** A trigger path matches a change when it is that path or a parent directory of it. */
export function triggerPathMatches(triggerPath: string, changedFile: string): boolean {
  const trigger: string = normalizePath(triggerPath);
  const changed: string = normalizePath(changedFile);
  if (!trigger || !changed) return false;
  if (trigger === ".") return true;
  return changed === trigger || changed.startsWith(`${trigger}/`);
}

export function selectChangedSuites(
  { changedFiles, suites }: { changedFiles: readonly string[]; suites: readonly TriggerSuiteEntry[] }
): ChangedSuiteSelection {
  const changed: string[] = [...new Set(changedFiles.map(normalizePath).filter(Boolean))].sort();
  const sensitiveFiles: string[] = changed.filter(isVerificationSensitivePath);

  const selected: { id: string; matchedPaths: string[] }[] = [];
  const wholeRepository: string[] = [];
  const unscoped: string[] = [];
  const coveredSensitive: Set<string> = new Set<string>();

  for (const suite of suites) {
    const declared: readonly string[] | undefined = suite.triggerPaths;
    if (!declared || declared.length === 0) {
      unscoped.push(suite.id);
      continue;
    }
    if (declared.some((trigger: string) : any => normalizePath(trigger) === ".")) {
      wholeRepository.push(suite.id);
      continue;
    }
    const matchedPaths: string[] = changed.filter((file: string) : any =>
      declared.some((trigger: string) : any => triggerPathMatches(trigger, file)));
    if (matchedPaths.length === 0) continue;
    for (const file of matchedPaths) coveredSensitive.add(file);
    selected.push({ id: suite.id, matchedPaths });
  }

  selected.sort((left: any, right: any) : any => left.id.localeCompare(right.id));
  wholeRepository.sort();
  unscoped.sort();
  return {
    selected,
    wholeRepository,
    unscoped,
    sensitiveFiles,
    uncoveredSensitiveFiles: sensitiveFiles.filter((file: string) : any => !coveredSensitive.has(file))
  };
}

/** True when the selection would report success without having verified anything. */
export function selectionIsUnverifiable(selection: ChangedSuiteSelection): boolean {
  return selection.selected.length === 0 && selection.uncoveredSensitiveFiles.length > 0;
}

/** The prominent, structured account of what a change-driven run did and did not cover. */
export function describeChangedSelection(selection: ChangedSuiteSelection): string {
  const lines: string[] = [];
  lines.push(`Changed-file selection: ${selection.selected.length} suite(s) targeted by this change.`);
  for (const entry of selection.selected) {
    lines.push(`  RUNS ${entry.id} <- ${entry.matchedPaths.slice(0, 3).join(", ")}`
      + (entry.matchedPaths.length > 3 ? ` (+${entry.matchedPaths.length - 3} more)` : ""));
  }
  if (selection.sensitiveFiles.length === 0) {
    lines.push("  No verification-sensitive file changed; documentation-only changes need no suite run.");
  }
  if (selection.wholeRepository.length > 0) {
    lines.push(`  NOT RUN ${selection.wholeRepository.length} whole-repository suite(s) that read the entire`
      + ` repository: ${selection.wholeRepository.join(", ")}`);
    lines.push("    Run `npm run ci:local` (engineering scope) for those.");
  }
  if (selection.unscoped.length > 0) {
    lines.push(`  NOT VISIBLE ${selection.unscoped.length} suite(s) declare no triggerPaths, so change`
      + " detection cannot select them.");
  }
  if (selection.uncoveredSensitiveFiles.length > 0) {
    lines.push(`  UNCOVERED ${selection.uncoveredSensitiveFiles.length} changed verification-sensitive file(s)`
      + " selected no declared suite:");
    for (const file of selection.uncoveredSensitiveFiles.slice(0, 10)) lines.push(`    ${file}`);
    if (selection.uncoveredSensitiveFiles.length > 10) {
      lines.push(`    (+${selection.uncoveredSensitiveFiles.length - 10} more)`);
    }
  }
  return lines.join("\n");
}

function normalizePath(value: unknown): string {
  return String(value || "")
    .split("\\").join("/")
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "")
    .trim();
}
