import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const defaultRepoRoot: any = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

export const VERSION_SCAN_ROOTS: readonly any[] = Object.freeze([
  "apps",
  "packages",
  "plugins",
  "services",
  "crates",
  "content",
  "fixtures",
  "tools",
  "tests",
  "docs"
]);

export const IGNORED_VERSION_SCAN_PATH_PARTS: readonly any[] = Object.freeze([
  ".git",
  "build",
  "dist",
  "node_modules"
]);

export const IGNORED_VERSION_SCAN_FILES: readonly any[] = Object.freeze([
  "package-lock.json"
]);

export const IGNORED_VERSION_SCAN_PREFIXES: readonly any[] = Object.freeze([
  "docs/plans/",
  "docs/reports/"
]);

const GOVERNED_NAME_SOURCE: any =
  "(?![a-z0-9-]*(?:legacy|compat|v[0-9]+))[a-z](?:[a-z0-9-]*[a-z0-9])?";
const GOVERNED_VERSIONED_NAME_SOURCE: any = `${GOVERNED_NAME_SOURCE}-[0-9]+(?:\\.[0-9]+)*`;

export const GOVERNED_VERSION_PATTERN: any = new RegExp(
  `^v[0-9]+\\.[0-9]+\\.[0-9]+:${GOVERNED_NAME_SOURCE}:${GOVERNED_VERSIONED_NAME_SOURCE}$`
);

export const GOVERNED_VERSION_TOKEN_PATTERN: any = new RegExp(
  `\\bv[0-9]+\\.[0-9]+\\.[0-9]+:${GOVERNED_NAME_SOURCE}:${GOVERNED_VERSIONED_NAME_SOURCE}(?![A-Za-z0-9_.:-])`,
  "g"
);

export const GOVERNED_VERSION_CANDIDATE_PATTERN: any =
  /\bv[0-9]+\.[0-9]+\.[0-9]+:[A-Za-z][A-Za-z0-9_.-]*(?::[A-Za-z][A-Za-z0-9_.-]*)*/g;

const GOVERNED_DYNAMIC_IDENTIFIER_SOURCE: any = "[A-Za-z_$][A-Za-z0-9_$]*";
const GOVERNED_DYNAMIC_VERSION_TEMPLATE_PATTERN: any = new RegExp(
  `^\\\`(?<platform>v[0-9]+\\.[0-9]+\\.[0-9]+):(?<domain>${GOVERNED_NAME_SOURCE}):(?<prefix>${GOVERNED_NAME_SOURCE})-\\$\\{(?<identifier>${GOVERNED_DYNAMIC_IDENTIFIER_SOURCE})\\}-(?<revision>[0-9]+(?:\\.[0-9]+)*)\\\``
);

const GOVERNED_DYNAMIC_VERSION_TEMPLATE_AUTHORITIES: Readonly<Record<string, any>> = Object.freeze({
  "tools/generators/generate-capability-acceptance-definitions.ts": Object.freeze({
    domain: "state-machine",
    prefix: "capability-acceptance",
    identifier: "slug",
    validatorSnippets: Object.freeze([
      "const CAPABILITY_SLUG_PATTERN",
      "if (!CAPABILITY_SLUG_PATTERN.test(slug))"
    ])
  })
});

export function isValidatedGovernedDynamicVersionTemplateAt(text?: any, candidateIndex?: any, {
  relativePath = ""
}: Record<string, any> = {}) : any {
  if (candidateIndex <= 0 || text[candidateIndex - 1] !== "`") return false;
  const match: any = text.slice(candidateIndex - 1).match(GOVERNED_DYNAMIC_VERSION_TEMPLATE_PATTERN);
  if (!match?.groups) return false;
  const authority: any = GOVERNED_DYNAMIC_VERSION_TEMPLATE_AUTHORITIES[relativePath];
  if (!authority ||
    authority.domain !== match.groups.domain ||
    authority.prefix !== match.groups.prefix ||
    authority.identifier !== match.groups.identifier ||
    !authority.validatorSnippets.every((snippet?: any) : any => text.includes(snippet))) {
    return false;
  }
  const completedVersion: any = `${match.groups.platform}:${match.groups.domain}:${match.groups.prefix}-dynamic-${match.groups.revision}`;
  return GOVERNED_VERSION_PATTERN.test(completedVersion);
}

export function shouldSkipVersionScanPath(relativePath?: any, {
  excludedRelativePaths = []
}: Record<string, any> = {}) : any {
  if (excludedRelativePaths.includes(relativePath)) return true;
  if (IGNORED_VERSION_SCAN_PREFIXES.some((prefix?: any) : any => relativePath.startsWith(prefix))) return true;
  if (IGNORED_VERSION_SCAN_FILES.includes(path.basename(relativePath))) return true;
  return relativePath.split("/").some((part?: any) : any => IGNORED_VERSION_SCAN_PATH_PARTS.includes(part));
}

export function isVersionScanTextFile(filePath?: any) : any {
  return /\.(?:mjs|js|cjs|ts|tsx|json|md|html|yaml|yml|txt)$/.test(filePath);
}

export function lineAndColumn(text?: any, index?: any) : any {
  const prefix: any = text.slice(0, index);
  const lines: any = prefix.split("\n");
  return {
    line: lines.length,
    column: lines.at(-1).length + 1
  };
}

export function collectVersionScanFiles({
  repoRoot = defaultRepoRoot,
  scanRoots = VERSION_SCAN_ROOTS,
  excludedRelativePaths = []
}: Record<string, any> = {}) : any {
  const files: any[] = [];

  function walk(directory?: any) : any {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath: any = path.join(directory, entry.name);
      const relativePath: any = path.relative(repoRoot, filePath).split(path.sep).join("/");
      if (shouldSkipVersionScanPath(relativePath, { excludedRelativePaths })) continue;
      if (entry.isDirectory()) {
        walk(filePath);
      } else if (entry.isFile() && isVersionScanTextFile(filePath)) {
        files.push(filePath);
      }
    }
  }

  for (const root of scanRoots) {
    walk(path.join(repoRoot, root));
  }
  return files;
}

export function collectGovernedVersionOccurrences({
  repoRoot = defaultRepoRoot,
  scanRoots = VERSION_SCAN_ROOTS,
  excludedRelativePaths = []
}: Record<string, any> = {}) : any {
  const occurrences: any = new Map<any, any>();
  for (const filePath of collectVersionScanFiles({ repoRoot, scanRoots, excludedRelativePaths })) {
    const relativePath: any = path.relative(repoRoot, filePath).split(path.sep).join("/");
    const text: any = fs.readFileSync(filePath, "utf8");
    for (const match of text.matchAll(GOVERNED_VERSION_CANDIDATE_PATTERN)) {
      const value: any = match[0];
      if (isValidatedGovernedDynamicVersionTemplateAt(text, match.index || 0, { relativePath })) continue;
      if (!occurrences.has(value)) {
        occurrences.set(value, []);
      }
      occurrences.get(value).push({
        relativePath,
        value,
        ...lineAndColumn(text, match.index || 0)
      });
    }
  }
  return occurrences;
}
