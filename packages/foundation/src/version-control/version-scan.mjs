import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const defaultRepoRoot = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

export const VERSION_SCAN_ROOTS = Object.freeze([
  "apps",
  "packages",
  "plugins",
  "crates",
  "content",
  "fixtures",
  "tools",
  "tests",
  "docs"
]);

export const IGNORED_VERSION_SCAN_PATH_PARTS = Object.freeze([
  ".git",
  "build",
  "node_modules"
]);

export const IGNORED_VERSION_SCAN_FILES = Object.freeze([
  "package-lock.json"
]);

export const IGNORED_VERSION_SCAN_PREFIXES = Object.freeze([
  "docs/plans/",
  "docs/reports/"
]);

const GOVERNED_NAME_SOURCE =
  "(?![a-z0-9-]*(?:legacy|compat|v[0-9]+))[a-z](?:[a-z0-9-]*[a-z0-9])?";
const GOVERNED_VERSIONED_NAME_SOURCE = `${GOVERNED_NAME_SOURCE}-[0-9]+(?:\\.[0-9]+)*`;

export const GOVERNED_VERSION_PATTERN = new RegExp(
  `^v[0-9]+\\.[0-9]+\\.[0-9]+:${GOVERNED_NAME_SOURCE}:${GOVERNED_VERSIONED_NAME_SOURCE}$`
);

export const GOVERNED_VERSION_TOKEN_PATTERN = new RegExp(
  `\\bv[0-9]+\\.[0-9]+\\.[0-9]+:${GOVERNED_NAME_SOURCE}:${GOVERNED_VERSIONED_NAME_SOURCE}(?![A-Za-z0-9_.:-])`,
  "g"
);

export const GOVERNED_VERSION_CANDIDATE_PATTERN =
  /\bv[0-9]+\.[0-9]+\.[0-9]+:[A-Za-z][A-Za-z0-9_.-]*(?::[A-Za-z][A-Za-z0-9_.-]*)*/g;

const GOVERNED_DYNAMIC_IDENTIFIER_SOURCE = "[A-Za-z_$][A-Za-z0-9_$]*";
const GOVERNED_DYNAMIC_VERSION_TEMPLATE_PATTERN = new RegExp(
  `^\\\`(?<platform>v[0-9]+\\.[0-9]+\\.[0-9]+):(?<domain>${GOVERNED_NAME_SOURCE}):(?<prefix>${GOVERNED_NAME_SOURCE})-\\$\\{(?<identifier>${GOVERNED_DYNAMIC_IDENTIFIER_SOURCE})\\}-(?<revision>[0-9]+(?:\\.[0-9]+)*)\\\``
);

const GOVERNED_DYNAMIC_VERSION_TEMPLATE_AUTHORITIES = Object.freeze({
  "tools/generators/generate-capability-acceptance-definitions.mjs": Object.freeze({
    domain: "state-machine",
    prefix: "capability-acceptance",
    identifier: "slug",
    validatorSnippets: Object.freeze([
      "const CAPABILITY_SLUG_PATTERN",
      "if (!CAPABILITY_SLUG_PATTERN.test(slug))"
    ])
  })
});

export function isValidatedGovernedDynamicVersionTemplateAt(text, candidateIndex, {
  relativePath = ""
} = {}) {
  if (candidateIndex <= 0 || text[candidateIndex - 1] !== "`") return false;
  const match = text.slice(candidateIndex - 1).match(GOVERNED_DYNAMIC_VERSION_TEMPLATE_PATTERN);
  if (!match?.groups) return false;
  const authority = GOVERNED_DYNAMIC_VERSION_TEMPLATE_AUTHORITIES[relativePath];
  if (!authority ||
    authority.domain !== match.groups.domain ||
    authority.prefix !== match.groups.prefix ||
    authority.identifier !== match.groups.identifier ||
    !authority.validatorSnippets.every((snippet) => text.includes(snippet))) {
    return false;
  }
  const completedVersion = `${match.groups.platform}:${match.groups.domain}:${match.groups.prefix}-dynamic-${match.groups.revision}`;
  return GOVERNED_VERSION_PATTERN.test(completedVersion);
}

export function shouldSkipVersionScanPath(relativePath, {
  excludedRelativePaths = []
} = {}) {
  if (excludedRelativePaths.includes(relativePath)) return true;
  if (IGNORED_VERSION_SCAN_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) return true;
  if (IGNORED_VERSION_SCAN_FILES.includes(path.basename(relativePath))) return true;
  return relativePath.split("/").some((part) => IGNORED_VERSION_SCAN_PATH_PARTS.includes(part));
}

export function isVersionScanTextFile(filePath) {
  return /\.(?:mjs|js|cjs|ts|tsx|json|md|html|yaml|yml|txt)$/.test(filePath);
}

export function lineAndColumn(text, index) {
  const prefix = text.slice(0, index);
  const lines = prefix.split("\n");
  return {
    line: lines.length,
    column: lines.at(-1).length + 1
  };
}

export function collectVersionScanFiles({
  repoRoot = defaultRepoRoot,
  scanRoots = VERSION_SCAN_ROOTS,
  excludedRelativePaths = []
} = {}) {
  const files = [];

  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      const relativePath = path.relative(repoRoot, filePath).split(path.sep).join("/");
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
} = {}) {
  const occurrences = new Map();
  for (const filePath of collectVersionScanFiles({ repoRoot, scanRoots, excludedRelativePaths })) {
    const relativePath = path.relative(repoRoot, filePath).split(path.sep).join("/");
    const text = fs.readFileSync(filePath, "utf8");
    for (const match of text.matchAll(GOVERNED_VERSION_CANDIDATE_PATTERN)) {
      const value = match[0];
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
