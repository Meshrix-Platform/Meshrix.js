#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertNoLeak } from "../tools/server-scripts/lib/report-evidence-safety.mjs";
import {
  resolveExecutionTimeout,
  runSuiteProcess,
  timeoutMsForSuite
} from "./lib/unified-test-runner-execution.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultReportDir = path.join(repoRoot, "build", "test-reports");

// ── Registry loading ─────────────────────────────────────────────────────

const REGISTRY_PATH = path.join(repoRoot, "tools/registry/tests.registry.json");

let _registry = null;

/** Load test registry from JSON. The JSON registry is mandatory. */
async function loadRegistry() {
  if (_registry) return _registry;

  if (!existsSync(REGISTRY_PATH)) {
    throw new Error(
      `Registry not found at ${REGISTRY_PATH}. ` +
      "Create tools/registry/tests.registry.json before running test profiles."
    );
  }

  const raw = readFileSync(REGISTRY_PATH, "utf-8");
  const reg = JSON.parse(raw);

  if (!Array.isArray(reg.suites) || !reg.profiles) {
    throw new Error("Registry missing suites or profiles");
  }

  const suites = reg.suites;
  const missingCommands = suites.filter((s) => !s.command || !Array.isArray(s.args));
  if (missingCommands.length > 0) {
    throw new Error(
      `Registry suites without executable command: ${missingCommands.map((s) => s.id).join(", ")}`
    );
  }
  for (const suite of suites) {
    timeoutMsForSuite(suite);
  }

  // Resolve profile extends and build profile→suiteId map
  const rawProfiles = resolveProfiles(reg.profiles);
  const suiteById = new Map(suites.map((s) => [s.id, s]));
  const profileMap = {};
  const profileConfigs = {};
  for (const name of Object.keys(rawProfiles)) {
    profileConfigs[name] = Object.freeze({ ...rawProfiles[name] });
    // Skip dynamic profiles (e.g. "changed"); the runner handles them natively
    if (rawProfiles[name].dynamic) continue;
    const resolved = resolveProfileExtends(name, rawProfiles);
    if (resolved.suites.length === 0) {
      throw new Error(`Profile "${name}" resolves to zero suites.`);
    }
    profileMap[name] = Object.freeze(resolved.suites);
  }

  _registry = { suites, profileSuites: profileMap, profileConfigs, suiteById };
  return _registry;
}

function resolveProfiles(profiles) {
  const resolved = {};
  for (const [name, def] of Object.entries(profiles)) {
    resolved[name] = {
      suites: def.suites ? [...def.suites] : [],
      extends: def.extends || null,
      dynamic: def.dynamic || false,
      timeoutMs: def.timeoutMs,
    };
  }
  return resolved;
}

function resolveProfileExtends(name, profiles, visited = new Set()) {
  if (visited.has(name)) {
    throw new Error(`Circular profile extends: ${name}`);
  }
  visited.add(name);

  const def = profiles[name];
  if (!def) {
    return { suites: [] };
  }

  let result = [...def.suites];
  if (def.extends) {
    const base = resolveProfileExtends(def.extends, profiles, visited);
    result = [...base.suites, ...result.filter((id) => !base.suites.includes(id))];
  }

  return { suites: result };
}

// ── Module-level registry state (initialized in main()) ─────────────────

let suites = [];
let profileSuites = {};
let profileConfigs = {};
let suiteById = new Map();

function parseArgs(argv) {
  const options = {
    profile: "core-public",
    suites: [],
    tags: [],
    list: false,
    dryRun: false,
    continueOnFailure: false,
    strictPlatform: false,
    report: null,
    changedBase: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile" || arg === "-p") {
      options.profile = takeValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--profile=")) {
      options.profile = arg.slice("--profile=".length);
      continue;
    }
    if (arg === "--suite" || arg === "-s") {
      options.suites.push(...splitCsv(takeValue(argv, ++index, arg)));
      continue;
    }
    if (arg.startsWith("--suite=")) {
      options.suites.push(...splitCsv(arg.slice("--suite=".length)));
      continue;
    }
    if (arg === "--tag" || arg === "-t") {
      options.tags.push(...splitCsv(takeValue(argv, ++index, arg)));
      continue;
    }
    if (arg.startsWith("--tag=")) {
      options.tags.push(...splitCsv(arg.slice("--tag=".length)));
      continue;
    }
    if (arg === "--changed-base") {
      options.changedBase = takeValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--changed-base=")) {
      options.changedBase = arg.slice("--changed-base=".length);
      continue;
    }
    if (arg === "--report") {
      options.report = takeValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--report=")) {
      options.report = arg.slice("--report=".length);
      continue;
    }
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--continue-on-failure") {
      options.continueOnFailure = true;
      continue;
    }
    if (arg === "--strict-platform") {
      options.strictPlatform = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function takeValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function splitCsv(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function printHelp() {
  console.log(`Meshrix unified test runner

Usage:
  node tests/run.mjs [--profile ${[...Object.keys(profileSuites), "changed"].filter((value, index, values) => values.indexOf(value) === index).join("|")}]
  node tests/run.mjs --suite repo.public-boundary --suite registry.consistency
  node tests/run.mjs --tag security --continue-on-failure

Options:
  --list                  Print suites and profiles.
  --dry-run               Print selected suites without executing them.
  --continue-on-failure   Run remaining suites after a failure.
  --strict-platform       Treat platform-incompatible suites as failures.
  --report <path>         Write report JSON to an explicit path.
  --changed-base <ref>    Base ref for the changed profile. Defaults to HEAD.
`);
}

function listSuites() {
  console.log("Profiles:");
  for (const [profile, ids] of Object.entries(profileSuites)) {
    console.log(`- ${profile}: ${ids.join(", ")}`);
  }
  console.log("");
  console.log("Suites:");
  for (const entry of suites) {
    const label = entry.label || entry.id;
    const tags = entry.tags ? entry.tags.join(", ") : (entry.level || "unknown");
    const platforms = entry.platforms ? ` platforms=${entry.platforms.join(",")}` : "";
    const cmdStatus = entry.command ? "" : " [NO-COMMAND]";
    console.log(`- ${entry.id}: ${label} [${tags}]${platforms}${cmdStatus}`);
  }
}

function printFeatureConsistencyGate() {
  console.log(
    [
      "Feature consistency gate: before treating this test run as final after a feature change, confirm the feature is the single current execution path.",
      "- Runtime behavior is the ordinary execution path for the current contract.",
      "- Docs, registries, fixtures, configs, generated artifacts, and tests describe the current path unless another path remains a current requirement.",
      "- Repository boundary gate: source, docs, and registries must resolve through current canonical roots and module boundaries.",
      "- Documentation gate: keep docs tied to current runtime behavior and update the owning document instead of creating parallel notes.",
      "- No version-named boundaries: name features, modules, and docs by functional boundary or change summary, not v2/version/release numbers.",
      "- Repo local-info hygiene: npm run repo:local-info-hygiene scans source, docs, fixtures, tests, and tools; high-risk privacy, identity, production, and deployment metadata fails the process.",
      "- Core repository gate: run npm test for documentation, registry, or boundary changes.",
      "- Commit-ready: before commit, confirm upstream/downstream adaptation passed the smallest relevant verifier or document an objective blocker with follow-up command.",
      "- Guide: docs/RUNBOOK.md."
    ].join("\n")
  );
}

function resolveSuiteIds(options) {
  const explicitIds = new Set(options.suites);
  for (const tag of options.tags) {
    for (const entry of suites) {
      if (entry.tags && entry.tags.includes(tag)) {
        explicitIds.add(entry.id);
      }
    }
  }

  if (explicitIds.size > 0) {
    return uniqueKnownSuites([...explicitIds]);
  }

  if (options.profile === "changed") {
    return changedSuiteIds(options.changedBase || "HEAD");
  }

  const ids = profileSuites[options.profile];
  if (!ids) {
    throw new Error(`Unknown profile: ${options.profile}`);
  }
  return uniqueKnownSuites(ids);
}

function uniqueKnownSuites(ids) {
  const selected = [];
  const seen = new Set();
  for (const id of ids) {
    if (!suiteById.has(id)) {
      throw new Error(`Unknown suite: ${id}`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      selected.push(id);
    }
  }
  return selected;
}

function changedSuiteIds(baseRef) {
  const changedFiles = new Set();
  for (const file of gitLines(["diff", "--name-only", "--diff-filter=ACMRTUXB", baseRef])) {
    changedFiles.add(file);
  }
  for (const file of gitLines(["ls-files", "--others", "--exclude-standard"])) {
    changedFiles.add(file);
  }

  const selected = new Set([
    "repo.public-boundary",
    "security.secret-hygiene",
    "repo.local-info-hygiene",
    "registry.consistency"
  ]);
  for (const file of changedFiles) {
    if (file === "package.json" || file === "package-lock.json" || file.startsWith("tests/")) {
      selected.add("repo.root-hygiene");
      selected.add("repo.organization");
    }
    if (file.startsWith("apps/console/") || file.startsWith("packages/ui-console/") || file === "vite.config.ts") {
      selected.add("repo.public-boundary");
    }
    if (file.startsWith("docs/") || file === "README.md") {
      selected.add("repo.public-boundary");
    }
  }

  selected.add("repo.root-hygiene");
  return uniqueKnownSuites([...selected]);
}

function gitLines(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function commandLine(entry) {
  return [entry.command, ...entry.args].join(" ");
}

function displayReportPath(filePath) {
  const relativePath = path.relative(repoRoot, filePath).split(path.sep).join("/");
  return relativePath && !relativePath.startsWith("../") && relativePath !== ".."
    ? relativePath
    : "<report-output>";
}

function isPlatformCompatible(entry) {
  return !entry.platforms || entry.platforms.includes(process.platform);
}

async function writeJsonAtomic(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function main() {
  // Initialize registry from JSON (async because of fallback import)
  const reg = await loadRegistry();
  suites = reg.suites;
  profileSuites = reg.profileSuites;
  profileConfigs = reg.profileConfigs;
  suiteById = reg.suiteById;

  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    listSuites();
    return;
  }

  const selectedIds = resolveSuiteIds(options);
  const startedAt = new Date();
  const results = [];
  const selectedByProfile = options.suites.length === 0 && options.tags.length === 0;
  const profileTimeoutMs = selectedByProfile
    ? profileConfigs[options.profile]?.timeoutMs
    : null;
  if (selectedByProfile && (!Number.isInteger(profileTimeoutMs) || profileTimeoutMs <= 0)) {
    throw new Error(`Profile "${options.profile}" must declare a positive timeoutMs.`);
  }
  const profileDeadlineMs = profileTimeoutMs
    ? startedAt.getTime() + profileTimeoutMs
    : null;

  console.log(`Meshrix test runner: profile=${options.profile} suites=${selectedIds.length}`);
  console.log(`Report directory: ${displayReportPath(defaultReportDir)}`);
  printFeatureConsistencyGate();

  if (selectedIds.length === 0) {
    throw new Error(`Profile "${options.profile}" selected zero suites.`);
  }

  for (const id of selectedIds) {
    const entry = suiteById.get(id);
    const compatible = isPlatformCompatible(entry);
    if (!compatible) {
      const status = options.strictPlatform ? "failed" : "skipped";
      const result = {
        id: entry.id,
        label: entry.label || entry.id,
        command: commandLine(entry),
        status,
        timedOut: false,
        reason: `Suite supports ${entry.platforms.join(", ")} but current platform is ${process.platform}`,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0
      };
      results.push(result);
      console.log(`${status.toUpperCase()} ${entry.id} - ${result.reason}`);
      if (status === "failed" && !options.continueOnFailure) {
        break;
      }
      continue;
    }

    if (options.dryRun) {
      const result = {
        id: entry.id,
        label: entry.label || entry.id,
        command: commandLine(entry),
        status: "dry-run",
        timedOut: false,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0
      };
      results.push(result);
      console.log(`DRY-RUN ${entry.id}: ${result.command}`);
      continue;
    }

    console.log(`\nRUN ${entry.id}: ${entry.label || entry.id}`);
    console.log(commandLine(entry));
    const declaredSuiteTimeoutMs = timeoutMsForSuite(entry);
    const profileRemainingMs = profileDeadlineMs === null
      ? null
      : profileDeadlineMs - Date.now();
    if (profileRemainingMs !== null && profileRemainingMs <= 0) {
      const now = new Date();
      results.push({
        id: entry.id,
        label: entry.label || entry.id,
        command: commandLine(entry),
        status: "failed",
        reason: "Profile timeout budget was exhausted before this suite could start.",
        timedOut: true,
        timeoutMs: profileTimeoutMs,
        timeoutScope: "profile",
        terminationSignals: [],
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        durationMs: 0
      });
      console.log(`FAILED ${entry.id} (profile timeout)`);
      break;
    }
    const timeout = resolveExecutionTimeout({
      suiteTimeoutMs: declaredSuiteTimeoutMs,
      profileRemainingMs
    });
    const result = await runSuiteProcess(entry, {
      cwd: repoRoot,
      timeoutMs: timeout.timeoutMs,
      timeoutScope: timeout.timeoutScope
    });
    result.timeoutClass = entry.timeoutClass;
    result.declaredSuiteTimeoutMs = declaredSuiteTimeoutMs;
    results.push(result);
    console.log(`${result.status.toUpperCase()} ${entry.id} (${result.durationMs}ms)`);
    if (result.timedOut === true && result.timeoutScope === "profile") {
      break;
    }
    if (result.status === "failed" && !options.continueOnFailure) {
      break;
    }
  }

  const finishedAt = new Date();
  const summary = summarize(results);
  summary.coverageReady = summary.passed > 0 && summary.failed === 0 && summary.dryRun === 0;
  summary.releaseReady = summary.coverageReady;
  summary.reportLeakScan = true;

  console.log("");
  console.log(`Summary: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped, ${summary.dryRun} dry-run, ${summary.timedOut} timed out`);
  if (options.dryRun) {
    console.log("Report: not written (dry-run)");
    if (summary.failed > 0) {
      process.exitCode = 1;
    }
    return;
  }

  const report = {
    schemaVersion: "v0.0.1:schema:definition-1",
    verifier: "tests/run.mjs",
    runner: "meshrix-unified-test-runner",
    profile: options.profile,
    selectedSuites: selectedIds,
    options: {
      tags: options.tags,
      explicitSuites: options.suites,
      dryRun: options.dryRun,
      continueOnFailure: options.continueOnFailure,
      strictPlatform: options.strictPlatform,
      changedBase: options.changedBase,
      profileTimeoutMs
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version
    },
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    summary,
    suites: results
  };
  assertNoLeak(report, "unified test runner report");

  const timestamp = startedAt.toISOString().replace(/[:.]/gu, "-");
  const reportPath = options.report
    ? path.resolve(repoRoot, options.report)
    : path.join(defaultReportDir, `meshrix-test-report-${timestamp}.json`);
  await writeJsonAtomic(reportPath, report);
  await writeJsonAtomic(path.join(defaultReportDir, "latest.json"), report);

  console.log(`Report: ${displayReportPath(reportPath)}`);

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

function summarize(results) {
  const summary = {
    passed: 0,
    failed: 0,
    skipped: 0,
    dryRun: 0,
    timedOut: 0
  };
  for (const result of results) {
    if (result.status === "passed") {
      summary.passed += 1;
    } else if (result.status === "failed") {
      summary.failed += 1;
    } else if (result.status === "skipped") {
      summary.skipped += 1;
    } else if (result.status === "dry-run") {
      summary.dryRun += 1;
    }
    if (result.timedOut === true) {
      summary.timedOut += 1;
    }
  }
  return summary;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
