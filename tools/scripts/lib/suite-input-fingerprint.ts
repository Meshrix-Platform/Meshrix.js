import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";

import type { TestSuiteEntry } from "./unified-test-runner-execution.ts";

/**
 * Passed results are reused by the content identity of a suite's inputs, not by
 * whether the worktree happens to be clean.
 *
 * A clean worktree is neither necessary nor sufficient for a passed result to remain
 * current. It is unnecessary, because a dirty worktree can leave every input of a
 * given suite untouched; and it is insufficient, because an identical revision and
 * command say nothing about the files a command actually reads. Keying reuse on the
 * content of the inputs a suite declares or references keeps results usable while
 * development is in progress, and still refuses to present a stale result as current.
 *
 * Scopes are deliberately conservative. A scope that is too wide only costs time; a
 * scope that is too narrow would report a stale pass as if it were current, so every
 * uncertain case widens the scope instead of narrowing it.
 */

/** Directory or file names that are build output or installed dependencies, never suite inputs. */
const GENERATED_NAMES: ReadonlySet<string> = new Set([
  ".DS_Store",
  ".cache",
  ".git",
  ".meshrix-agent-history",
  ".meshrix-server-data",
  ".next",
  ".playwright-cli",
  ".turbo",
  ".vite",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "meshrix-data",
  "meshrix-js-branch-promotion",
  "node_modules",
  "output",
  "test-results",
  "tmp"
]);

/**
 * Repository files that change how every suite runs, so they belong to every scope.
 * Editing the runner, the registries or the lockfile invalidates every recorded result.
 */
const SHARED_INPUT_PATHS: readonly string[] = Object.freeze([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.workspace.ts",
  "tests/run.ts",
  "tools/registry/modules.registry.json",
  "tools/registry/tests.registry.json",
  "tools/scripts/lib/node-runtime-support.ts",
  "tools/scripts/lib/suite-input-fingerprint.ts",
  "tools/scripts/lib/unified-test-runner-execution.ts",
  "tools/scripts/local-ci.ts"
]);

/** Registry `package` value to the workspace directories that value denotes. */
const PACKAGE_DIRECTORIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  agents: ["packages/agents"],
  capabilities: ["packages/capabilities"],
  console: ["apps/console", "packages/ui-console"],
  contracts: ["packages/contracts"],
  foundation: ["packages/foundation"],
  gateway: ["packages/gateway"],
  protocols: ["packages/protocols"],
  "server-runtime": ["packages/server-runtime"]
});

export interface SuiteInputScope {
  directories: string[];
  files: string[];
}

interface WorkspaceDependencyGraph {
  byName: Map<string, string>;
  byDirectory: Map<string, string[]>;
}

/**
 * Per-run memoization. Scopes overlap heavily but rarely coincide, so the cache holds
 * file content hashes and directory listings rather than only whole-scope hashes.
 */
export interface SuiteInputScopeCache {
  scopeHashes: Map<string, string>;
  fileHashes: Map<string, string>;
  directoryListings: Map<string, string[]>;
  workspaceGraph?: WorkspaceDependencyGraph;
}

export function createSuiteInputScopeCache(): SuiteInputScopeCache {
  return {
    scopeHashes: new Map(),
    fileHashes: new Map(),
    directoryListings: new Map()
  };
}

/**
 * The directories and files whose content decides whether this suite's passed result
 * is still current. Registry `package` values that denote the whole repository
 * (`repo`, `root`, `deployment`) intentionally fall back to the entire tree.
 */
export function describeSuiteInputScope(
  entry: TestSuiteEntry,
  rootDir: string,
  cache: SuiteInputScopeCache
): SuiteInputScope {
  const directories: Set<string> = new Set<string>();
  const files: Set<string> = new Set<string>();

  for (const shared of SHARED_INPUT_PATHS) {
    if (existsSync(path.join(rootDir, ...shared.split("/")))) files.add(shared);
  }

  const declared: readonly string[] | undefined = PACKAGE_DIRECTORIES[String(entry.package || "")];
  if (!declared) {
    directories.add(".");
  } else {
    for (const directory of workspaceDependencyClosure(rootDir, declared, cache)) {
      directories.add(directory);
    }
  }

  const referenced: string[] = referencedArgumentPaths(entry, rootDir);

  // Paths the suite names in its own argv are inputs even when they live in a generated
  // directory, because the suite reads exactly those paths.
  for (const candidate of referenced) {
    let isDirectory: boolean = false;
    try {
      isDirectory = lstatSync(path.join(rootDir, ...candidate.split("/"))).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) directories.add(candidate);
    else files.add(candidate);
  }

  // Suites that name a Vitest file also depend on the shared test tree, because those
  // files import setup modules and helpers that no single argv path names.
  if (referenced.some((candidate: string) : any => candidate.startsWith("tests/vitest/"))) {
    directories.add("tests/vitest");
  }

  return { directories: [...directories].sort(), files: [...files].sort() };
}

/**
 * A fingerprint of everything that can change what this suite observes: its execution
 * identity, the runtime that would execute it, and the content of its input scope.
 *
 * The runtime belongs here because the same sources can pass on one Node version and
 * fail on another. Without it, a pass recorded under an unsupported runtime would be
 * reused under a supported one, which is exactly the false green this mechanism exists
 * to prevent.
 */
export function computeSuiteInputFingerprint(
  entry: TestSuiteEntry,
  { rootDir, cache }: { rootDir: string; cache: SuiteInputScopeCache }
): string {
  const scope: SuiteInputScope = describeSuiteInputScope(entry, rootDir, cache);
  const scopeKey: string = JSON.stringify(scope);
  let scopeHash: string | undefined = cache.scopeHashes.get(scopeKey);
  if (!scopeHash) {
    scopeHash = hashScopeContent(rootDir, scope, cache);
    cache.scopeHashes.set(scopeKey, scopeHash);
  }
  return createHash("sha256").update(JSON.stringify({
    command: entry.command,
    args: entry.args || [],
    platforms: entry.platforms || [],
    requiredServices: entry.requiredServices || [],
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      modules: process.versions.modules
    },
    scope: scopeHash
  })).digest("hex");
}

function hashScopeContent(rootDir: string, scope: SuiteInputScope, cache: SuiteInputScopeCache): string {
  const collected: Set<string> = new Set<string>(scope.files);
  for (const directory of scope.directories) {
    for (const file of listScopeFiles(rootDir, directory, cache)) collected.add(file);
  }
  const digest: any = createHash("sha256");
  for (const relativePath of [...collected].sort()) {
    digest.update(relativePath);
    digest.update("\u0000");
    digest.update(entryContentHash(rootDir, relativePath, cache));
    digest.update("\u0000");
  }
  return digest.digest("hex");
}

/**
 * Every file below one scope directory, with generated names skipped. Listings and
 * content hashes are memoized for the run, which assumes suites observe their inputs
 * rather than rewriting each other's sources; generated output is excluded precisely
 * so that producing it never perturbs a fingerprint.
 */
function listScopeFiles(
  rootDir: string,
  relativeDirectory: string,
  cache: SuiteInputScopeCache
): string[] {
  const memoized: string[] | undefined = cache.directoryListings.get(relativeDirectory);
  if (memoized) return memoized;

  const listing: string[] = [];
  const absolute: string = path.join(rootDir, ...relativeDirectory.split("/"));
  let stats: any;
  try {
    stats = lstatSync(absolute);
  } catch {
    cache.directoryListings.set(relativeDirectory, listing);
    return listing;
  }
  if (!stats.isDirectory()) {
    listing.push(relativeDirectory);
    cache.directoryListings.set(relativeDirectory, listing);
    return listing;
  }

  let entries: any[];
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    cache.directoryListings.set(relativeDirectory, listing);
    return listing;
  }
  for (const entry of entries) {
    if (GENERATED_NAMES.has(entry.name)) continue;
    const child: string = relativeDirectory === "." ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) listing.push(...listScopeFiles(rootDir, child, cache));
    else listing.push(child);
  }
  cache.directoryListings.set(relativeDirectory, listing);
  return listing;
}

/** Symbolic links are hashed by target, so a workspace link never pulls in its target tree. */
function entryContentHash(rootDir: string, relativePath: string, cache: SuiteInputScopeCache): string {
  const memoized: string | undefined = cache.fileHashes.get(relativePath);
  if (memoized) return memoized;

  let hash: string;
  const absolute: string = path.join(rootDir, ...relativePath.split("/"));
  try {
    const stats: any = lstatSync(absolute);
    if (stats.isSymbolicLink()) hash = `link:${readlinkSync(absolute)}`;
    else if (!stats.isFile()) hash = "not-a-file";
    else hash = createHash("sha256").update(readFileSync(absolute)).digest("hex");
  } catch {
    hash = "unreadable";
  }
  cache.fileHashes.set(relativePath, hash);
  return hash;
}

/**
 * The transitive closure of a package over its declared workspace dependencies. A
 * change in a dependency changes every consumer, so consumers must include it.
 */
function workspaceDependencyClosure(
  rootDir: string,
  declared: readonly string[],
  cache: SuiteInputScopeCache
): string[] {
  if (!cache.workspaceGraph) cache.workspaceGraph = readWorkspaceDependencyGraph(rootDir);
  const graph: WorkspaceDependencyGraph = cache.workspaceGraph;
  const visited: Set<string> = new Set<string>();
  const queue: string[] = [...declared];
  while (queue.length > 0) {
    const directory: string = queue.shift() as string;
    if (visited.has(directory)) continue;
    visited.add(directory);
    for (const dependency of graph.byDirectory.get(directory) || []) {
      const dependencyDirectory: string | undefined = graph.byName.get(dependency);
      if (dependencyDirectory && !visited.has(dependencyDirectory)) queue.push(dependencyDirectory);
    }
  }
  return [...visited].sort();
}

function readWorkspaceDependencyGraph(rootDir: string): WorkspaceDependencyGraph {
  const byName: Map<string, string> = new Map<string, string>();
  const byDirectory: Map<string, string[]> = new Map<string, string[]>();
  for (const parent of ["packages", "apps"]) {
    let entries: any[];
    try {
      entries = readdirSync(path.join(rootDir, parent), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory: string = `${parent}/${entry.name}`;
      const manifestPath: string = path.join(rootDir, parent, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest: any = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (typeof manifest.name === "string" && manifest.name) byName.set(manifest.name, directory);
        byDirectory.set(directory, Object.keys({
          ...(manifest.dependencies || {}),
          ...(manifest.peerDependencies || {})
        }).filter((name: string) : any => name.startsWith("@meshrix/")));
      } catch {
        byDirectory.set(directory, []);
      }
    }
  }
  return { byName, byDirectory };
}

/** Paths a suite names in its own argv. npm script names are not paths. */
function referencedArgumentPaths(entry: TestSuiteEntry, rootDir: string): string[] {
  const referenced: Set<string> = new Set<string>();
  for (const argument of entry.args || []) {
    if (typeof argument !== "string" || argument.length === 0 || argument.startsWith("-")) continue;
    if (argument.includes(":")) continue;
    const candidate: string = argument.split("\\").join("/").replace(/^\.\//u, "").replace(/\/+$/u, "");
    if (!candidate || candidate === "." || path.isAbsolute(candidate)) continue;
    const absolute: string = path.join(rootDir, ...candidate.split("/"));
    if (!absolute.startsWith(rootDir + path.sep)) continue;
    if (!existsSync(absolute)) continue;
    referenced.add(candidate);
  }
  return [...referenced].sort();
}
