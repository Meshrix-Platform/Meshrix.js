#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertNoLeak } from "../tools/server-scripts/lib/report-evidence-safety.ts";
import {
  createRegressionHtmlReport,
  shouldRefreshTrackedRegressionReport,
  TRACKED_REGRESSION_REPORT_PATH
} from "./lib/regression-html-report.ts";
import {
  isCachedTestResultReusable,
  mergeInheritedProfileExecution,
  parseTestShard,
  notRunSuiteResult,
  planTestExecutionPhases,
  profileInherits,
  resolveRequiredServiceApplicability,
  runTestPhaseLanes,
  runSuiteProcess,
  sourceNodeEnvironment,
  summarizeTestResults
} from "../tools/scripts/lib/unified-test-runner-execution.ts";
import {
  discoverLocalExecutionEnvironment,
  type LocalExecutionEnvironment
} from "../tools/server-scripts/lib/local-execution-environment.ts";
import {
  discoverOciConformanceImageAvailability
} from "../tools/server-scripts/verify-execution-sandbox-oci-conformance.ts";
import { resolveCommandCandidate } from "../packages/foundation/src/environment-compatibility/host-runtime.ts";
import { npmCliArgs, resolveNpmCliInvocation } from "../tools/server-scripts/lib/npm-cli-invocation.ts";
import { loadPreparedReleaseSet } from "../tools/server-scripts/publish-release-set.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultReportDir: any = path.join(repoRoot, "build", "test-reports");

// ── Registry loading ─────────────────────────────────────────────────────

const REGISTRY_PATH: any = path.join(repoRoot, "tools/registry/tests.registry.json");

let _registry: any = null;

/** Load test registry from JSON. The JSON registry is mandatory. */
async function loadRegistry() : Promise<any> {
  if (_registry) return _registry;

  if (!existsSync(REGISTRY_PATH)) {
    throw new Error(
      `Registry not found at ${REGISTRY_PATH}. ` +
      "Create tools/registry/tests.registry.json before running test profiles."
    );
  }

  const raw: any = readFileSync(REGISTRY_PATH, "utf-8");
  const reg: any = JSON.parse(raw);

  if (!Array.isArray(reg.suites) || !reg.profiles) {
    throw new Error("Registry missing suites or profiles");
  }

  const suites: any = reg.suites;
  const missingCommands: any = suites.filter((s?: any) : any => !s.command || !Array.isArray(s.args));
  if (missingCommands.length > 0) {
    throw new Error(
      `Registry suites without executable command: ${missingCommands.map((s?: any) : any => s.id).join(", ")}`
    );
  }
  // Resolve profile extends and build profile→suiteId map
  const rawProfiles: any = resolveProfiles(reg.profiles);
  const suiteById: any = new Map<any, any>(suites.map((s?: any) : any => [s.id, s]));
  const profileMap: Record<string, any> = {};
  const profileConfigs: Record<string, any> = {};
  for (const name of Object.keys(rawProfiles)) {
    profileConfigs[name] = Object.freeze(resolveInheritedProfileConfig(name, rawProfiles));
    // Skip dynamic profiles (e.g. "changed"); the runner handles them natively
    if (rawProfiles[name].dynamic) continue;
    const resolved: any = resolveProfileExtends(name, rawProfiles);
    if (resolved.suites.length === 0) {
      throw new Error(`Profile "${name}" resolves to zero suites.`);
    }
    profileMap[name] = Object.freeze(resolved.suites);
  }

  _registry = { suites, profileSuites: profileMap, profileConfigs, suiteById };
  return _registry;
}

function resolveInheritedProfileConfig(name: string, profiles: Record<string, any>, visited = new Set<string>()): any {
  if (visited.has(name)) throw new Error(`Circular profile extends: ${name}`);
  const profile = profiles[name];
  if (!profile) return {};
  visited.add(name);
  const parent = profile.extends ? resolveInheritedProfileConfig(profile.extends, profiles, visited) : {};
  visited.delete(name);
  const execution = Array.isArray(profile.execution?.phases)
    ? mergeInheritedProfileExecution(parent.execution, profile.execution)
    : profile.execution;
  return {
    ...profile,
    execution,
    trackedArtifacts: [...new Set([...(parent.trackedArtifacts || []), ...(profile.trackedArtifacts || [])])]
  };
}

function resolveProfiles(profiles?: any) : any {
  const resolved: Record<string, any> = {};
  for (const [name, def] of (Object.entries(profiles) as [string, any][])) {
    resolved[name] = {
      suites: def.suites ? [...def.suites] : [],
      extends: def.extends || null,
      dynamic: def.dynamic || false,
      trackedArtifacts: def.trackedArtifacts ? [...def.trackedArtifacts] : [],
      execution: def.execution || {},
    };
  }
  return resolved;
}

function resolveProfileExtends(name?: any, profiles?: any, visited: any = new Set<any>()) : any {
  if (visited.has(name)) {
    throw new Error(`Circular profile extends: ${name}`);
  }
  visited.add(name);

  const def: any = profiles[name];
  if (!def) {
    return { suites: [] };
  }

  let result: any[] = [...def.suites];
  if (def.extends) {
    const base: any = resolveProfileExtends(def.extends, profiles, visited);
    result = [...base.suites, ...result.filter((id?: any) : any => !base.suites.includes(id))];
  }

  return { suites: result };
}

// ── Module-level registry state (initialized in main()) ─────────────────

let suites: any[] = [];
let profileSuites: Record<string, any> = {};
let profileConfigs: Record<string, any> = {};
let suiteById: any = new Map<any, any>();

function parseArgs(argv?: any) : any {
  const options: Record<string, any> = {
    profile: "core-public",
    suites: [],
    tags: [],
    list: false,
    dryRun: false,
    continueOnFailure: false,
    strictPlatform: false,
    report: null,
    changedBase: null,
    shard: null
  };

  for (let index: any = 0; index < argv.length; index += 1) {
    const arg: any = argv[index];
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
    if (arg === "--shard") {
      options.shard = takeValue(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--shard=")) {
      options.shard = arg.slice("--shard=".length);
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

function takeValue(argv?: any, index?: any, flag?: any) : any {
  const value: any = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function splitCsv(value?: any) : any {
  return value.split(",").map((entry?: any) : any => entry.trim()).filter(Boolean);
}

function printHelp() : any {
  console.log(`Meshrix.js unified test runner

Usage:
  node tests/run.ts [--profile ${[...Object.keys(profileSuites), "changed"].filter((value?: any, index?: any, values?: any) : any => values.indexOf(value) === index).join("|")}]
  node tests/run.ts --suite repo.public-boundary --suite registry.consistency
  node tests/run.ts --tag security --continue-on-failure

Options:
  --list                  Print suites and profiles.
  --dry-run               Print selected suites without executing them.
  --continue-on-failure   Run remaining suites after a failure.
  --strict-platform       Treat platform-incompatible suites as failures.
  --report <path>         Write report JSON to an explicit path.
  --shard <index/count>   Shard merged Vitest processes (for example 1/4).
  --changed-base <ref>    Base ref for the changed profile. Defaults to HEAD.
`);
}

function listSuites() : any {
  console.log("Profiles:");
  for (const [profile, ids] of (Object.entries(profileSuites) as [string, any][])) {
    console.log(`- ${profile}: ${ids.join(", ")}`);
  }
  console.log("");
  console.log("Suites:");
  for (const entry of suites) {
    const label: any = entry.label || entry.id;
    const tags: any = entry.tags ? entry.tags.join(", ") : (entry.level || "unknown");
    const platforms: any = entry.platforms ? ` platforms=${entry.platforms.join(",")}` : "";
    const cmdStatus: any = entry.command ? "" : " [NO-COMMAND]";
    console.log(`- ${entry.id}: ${label} [${tags}]${platforms}${cmdStatus}`);
  }
}

function printFeatureConsistencyGate() : any {
  console.log(
    [
      "Feature consistency gate: before treating this test run as final after a feature change, confirm the feature is the single current execution path.",
      "- Runtime behavior is the ordinary execution path for the current contract.",
      "- Docs, registries, fixtures, configs, generated artifacts, and tests describe the current path unless another path remains a current requirement.",
      "- Repository boundary gate: source, docs, and registries must resolve through current canonical roots and module boundaries.",
      "- Documentation gate: keep docs tied to current runtime behavior and update the owning document instead of creating parallel notes.",
      "- No version-named boundaries: name features, modules, and docs by functional boundary or change summary, not v2/version/release numbers.",
      "- Repo local-info hygiene: npm run repo:local-info-hygiene scans source, docs, fixtures, tests, and tools; high-risk privacy, identity, production, and deployment metadata fails the process.",
      "- Core repository gate: run the owning narrow checks for documentation, registry, or boundary changes, and the selected integration profile for the accepted task outcome (see CONTRIBUTING.md).",
      "- Commit-ready: before commit, confirm upstream/downstream adaptation passed the smallest relevant verifier or document an objective blocker with follow-up command.",
      "- Guide: docs/RUNBOOK.md."
    ].join("\n")
  );
}

function resolveSuiteIds(options?: any) : any {
  const explicitIds: any = new Set<any>(options.suites);
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

  const ids: any = profileSuites[options.profile];
  if (!ids) {
    throw new Error(`Unknown profile: ${options.profile}`);
  }
  return uniqueKnownSuites(ids);
}

function uniqueKnownSuites(ids?: any) : any {
  const selected: any[] = [];
  const seen: any = new Set<any>();
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

function changedSuiteIds(baseRef?: any) : any {
  const changedFiles: any = new Set<any>();
  for (const file of gitLines(["diff", "--name-only", "--diff-filter=ACMRTUXB", baseRef])) {
    changedFiles.add(file);
  }
  for (const file of gitLines(["ls-files", "--others", "--exclude-standard"])) {
    changedFiles.add(file);
  }

  const selected: any = new Set<any>([
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

function gitLines(args?: any) : any {
  const result: any = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout.split(/\r?\n/u).map((line?: any) : any => line.trim()).filter(Boolean);
}

function commandLine(entry?: any) : any {
  return [entry.command, ...entry.args].join(" ");
}

function cleanSourceRevision() : string | null {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
  if (status.status !== 0 || status.stdout.trim() !== "") return null;
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return revision.status === 0 ? revision.stdout.trim() || null : null;
}

function passedResultCache(profile: string, sourceRevision: string | null): Map<string, any> {
  if (!sourceRevision) return new Map();
  const reportPath = path.join(defaultReportDir, "latest.json");
  if (!existsSync(reportPath)) return new Map();
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (
      !profileInherits(profileConfigs, profile, report.profile) ||
      report.sourceRevision !== sourceRevision
    ) return new Map();
    return new Map((Array.isArray(report.suites) ? report.suites : [])
      .filter((result: any) => result?.status === "passed" && typeof result.command === "string")
      .map((result: any) => [result.command, result]));
  } catch {
    return new Map();
  }
}

function displayReportPath(filePath?: any) : any {
  const relativePath: any = path.relative(repoRoot, filePath).split(path.sep).join("/");
  return relativePath && !relativePath.startsWith("../") && relativePath !== ".."
    ? relativePath
    : "<report-output>";
}

function isPlatformCompatible(entry?: any) : any {
  return !entry.platforms || entry.platforms.includes(process.platform);
}

async function discoverRequiredServiceCapabilities(requiredServices: readonly string[]): Promise<{
  environment?: LocalExecutionEnvironment;
  capabilities: Record<string, { status: "available" | "unavailable" | "failed"; reasonCode?: string }>;
}> {
  const capabilities: Record<string, { status: "available" | "unavailable" | "failed"; reasonCode?: string }> = {};
  const required = new Set(requiredServices);
  let environment: LocalExecutionEnvironment | undefined;

  if (required.has("docker") || required.has("oci-conformance-native-image")) {
    try {
      environment = await discoverLocalExecutionEnvironment();
      capabilities.docker = environment.docker.status === "available"
        ? { status: "available" }
        : { status: "unavailable", reasonCode: environment.docker.reasonCode };
    } catch {
      capabilities.docker = { status: "failed", reasonCode: "service_probe_failed" };
    }
  }

  for (const service of required) {
    if (service === "oci-conformance-native-image") {
      if (!environment) {
        capabilities[service] = { status: "failed", reasonCode: "service_probe_failed" };
        continue;
      }
      try {
        const availability = await discoverOciConformanceImageAvailability({ environment });
        capabilities[service] = availability.status === "available"
          ? { status: "available" }
          : { status: availability.status, reasonCode: availability.reasonCode };
      } catch {
        capabilities[service] = { status: "failed", reasonCode: "oci_image_inspect_failed" };
      }
      continue;
    }
    if (service === "podman") {
      let available = false;
      try {
        available = Boolean(resolveCommandCandidate("podman", { includeDefaultLocalBin: false }).path);
      } catch { /* A missing executable is an unavailable optional service. */ }
      capabilities[service] = available
        ? { status: "available" }
        : { status: "unavailable", reasonCode: "podman_cli_missing" };
      continue;
    }
    if (service === "external-https-endpoint") {
      capabilities[service] = process.env.MESHRIX_UPSTREAM_EXTERNAL_COMPAT === "1"
        ? { status: "available" }
        : { status: "unavailable", reasonCode: "external_endpoint_not_opted_in" };
      continue;
    }
    if (service !== "docker") {
      capabilities[service] = { status: "failed", reasonCode: "service_capability_unknown" };
    }
  }

  return { environment, capabilities };
}

async function writeJsonAtomic(filePath?: any, data?: any) : Promise<any> {
  await writeTextAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath: any = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, text, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function main() : Promise<any> {
  // Initialize registry from JSON (async because of fallback import)
  const reg: any = await loadRegistry();
  suites = reg.suites;
  profileSuites = reg.profileSuites;
  profileConfigs = reg.profileConfigs;
  suiteById = reg.suiteById;

  const options: any = parseArgs(process.argv.slice(2));
  if (options.list) {
    listSuites();
    return;
  }

  const selectedIds: any = resolveSuiteIds(options);
  const productManifest: any = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const productVersion: string = String(productManifest.version || "");
  const profileExecution: any = profileConfigs[options.profile]?.execution || {};
  const shardEnvironment: string = String(profileExecution.shardEnvironment || "").trim();
  const shard = parseTestShard(options.shard || (shardEnvironment ? process.env[shardEnvironment] : null));
  const selectedEntries: any[] = selectedIds.map((id: string) => suiteById.get(id));
  const requiredServices = [...new Set(selectedEntries
    .filter((entry: any) => isPlatformCompatible(entry))
    .flatMap((entry: any) => entry.requiredServices || []))];
  const selectedByProfile: any = options.suites.length === 0 && options.tags.length === 0;
  const refreshTrackedReport = shouldRefreshTrackedRegressionReport({
    profile: options.profile,
    selectedByProfile
  });
  const trackedArtifacts: string[] = profileConfigs[options.profile]?.trackedArtifacts || [];
  if (refreshTrackedReport && !trackedArtifacts.includes(TRACKED_REGRESSION_REPORT_PATH)) {
    throw new Error(
      `Profile "${options.profile}" must declare ${TRACKED_REGRESSION_REPORT_PATH} as a tracked artifact.`
    );
  }
  const phaseDefinitions: any = selectedByProfile ? profileExecution.phases : null;
  const executionPhases: any[] = planTestExecutionPhases(selectedEntries, phaseDefinitions, {
    mergeVitestProcesses: profileExecution.mergeVitestProcesses === true,
    shard
  });
  const executionEntries: any[] = executionPhases.flatMap((phase: any) =>
    phase.lanes.flatMap((lane: any) => lane.entries)
  );
  const startedAt: any = new Date();
  const results: any[] = [];
  const sourceRevision = profileExecution.cachePassedResults === true ? cleanSourceRevision() : null;
  const resultCache = passedResultCache(options.profile, sourceRevision);
  const executionLaneCount = executionPhases.reduce(
    (count: number, phase: any) => count + phase.lanes.length,
    0
  );

  console.log(
    `Meshrix.js test runner: profile=${options.profile} suites=${selectedIds.length} `
    + `phases=${executionPhases.length} lanes=${executionLaneCount} processes=${executionEntries.length}`
  );
  console.log(`Report directory: ${displayReportPath(defaultReportDir)}`);
  printFeatureConsistencyGate();

  if (selectedIds.length === 0) {
    throw new Error(`Profile "${options.profile}" selected zero suites.`);
  }

  const cancellation = new AbortController();
  let receivedSignal: string | null = null;
  const requestCancellation = (signal: string): void => {
    if (cancellation.signal.aborted) return;
    receivedSignal = signal;
    cancellation.abort(signal);
  };
  const onSigint = (): void => requestCancellation("SIGINT");
  const onSigterm = (): void => requestCancellation("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  let serviceDiscovery: Awaited<ReturnType<typeof discoverRequiredServiceCapabilities>> = {
    environment: undefined,
    capabilities: {}
  };

  const markNotRun = (entry: any, reason: string, blockedBy: string[] = []): any => {
    const result: any = { ...notRunSuiteResult(entry, { reason, blockedBy }), reasonCode: reason };
    console.log(`NOT_RUN ${entry.id} (${reason})`);
    return result;
  };

  const executeEntry = async (
    entry: any,
    context: { blockedBy: readonly string[] } = { blockedBy: [] }
  ): Promise<any> => {
    if (cancellation.signal.aborted) {
      return markNotRun(entry, "runner_interrupted_before_start", [...context.blockedBy]);
    }
    if (context.blockedBy.length > 0) {
      return markNotRun(entry, "prerequisite_lane_incomplete", [...context.blockedBy]);
    }

    const compatible: any = isPlatformCompatible(entry);
    if (!compatible) {
      const status: any = options.strictPlatform ? "not_run" : "skipped";
      const result: Record<string, any> = {
        id: entry.id,
        label: entry.label || entry.id,
        command: commandLine(entry),
        childSuiteIds: entry.childSuiteIds || [entry.id],
        status,
        reasonCode: "platform_unavailable",
        reason: `Suite supports ${entry.platforms.join(", ")} but current platform is ${process.platform}`,
        ...(options.strictPlatform ? { notRunReason: "platform_incompatible_strict" } : {})
      };
      console.log(`${status.toUpperCase()} ${entry.id} (${result.reason})`);
      return result;
    }

    if (options.dryRun) {
      const result: Record<string, any> = {
        id: entry.id,
        label: entry.label || entry.id,
        command: commandLine(entry),
        childSuiteIds: entry.childSuiteIds || [entry.id],
        status: "dry-run"
      };
      console.log(`DRY-RUN ${entry.id}: ${result.command}`);
      return result;
    }

    const applicability = resolveRequiredServiceApplicability(entry.requiredServices || [], serviceDiscovery.capabilities);
    if (applicability.status !== "available") {
      const result: Record<string, any> = {
        ...notRunSuiteResult(entry, { reason: applicability.status === "failed" ? "required_service_probe_failed" : "required_service_unavailable" }),
        status: applicability.status,
        reasonCode: applicability.reasonCode,
        requiredService: applicability.requiredService,
        ...(applicability.status === "not_run" ? { notRunReason: applicability.reasonCode } : {})
      };
      console.log(`${applicability.status.toUpperCase()} ${entry.id} (${applicability.requiredService}: ${applicability.reasonCode})`);
      return result;
    }

    console.log(`\nRUN ${entry.id}: ${entry.label || entry.id}`);
    console.log(commandLine(entry));
    const cached = resultCache.get(commandLine(entry));
    if (await isCachedTestResultReusable(entry, cached, {
      rootDir: repoRoot,
      validatePreparedReleaseSet: loadPreparedReleaseSet
    })) {
      const result: any = {
        ...cached,
        id: entry.id,
        label: entry.label || entry.id,
        childSuiteIds: entry.childSuiteIds || [entry.id],
        cached: true
      };
      console.log(`PASSED ${entry.id} (cached)`);
      return result;
    }

    const childEnv = sourceNodeEnvironment();
    let result: any;
    try {
      const npmInvocation = entry.command === "npm" ? resolveNpmCliInvocation({ env: childEnv }) : null;
      result = await runSuiteProcess(entry, {
        cwd: repoRoot,
        env: childEnv,
        signal: cancellation.signal,
        ...(npmInvocation ? {
          executionCommand: npmInvocation.command,
          executionArgs: npmCliArgs(npmInvocation, entry.args)
        } : {})
      });
    } catch {
      result = {
        id: entry.id,
        label: entry.label || entry.id,
        command: commandLine(entry),
        childSuiteIds: entry.childSuiteIds || [entry.id],
        status: "failed",
        reasonCode: "command_invocation_failed",
        exitCode: null
      };
    }
    result.cached = false;
    if (result.status === "not_run") {
      console.log(`NOT_RUN ${entry.id} (${result.reason})`);
    } else {
      console.log(`${result.status.toUpperCase()} ${entry.id} (${result.durationMs}ms)`);
    }
    return result;
  };

  try {
    if (!options.dryRun) serviceDiscovery = await discoverRequiredServiceCapabilities(requiredServices);
    let stopReason: { reason: string; blockedBy: string[] } | null = null;
    for (const phase of executionPhases) {
      console.log("");
      console.log(`PHASE ${phase.id}: ${phase.label || phase.id}`);
      console.log(`LANES ${phase.lanes.map((lane: any) => lane.id).join(", ")}`);
      let phaseResults: any[];
      if (stopReason) {
        phaseResults = phase.lanes.flatMap((lane: any) => lane.entries.map((entry: any) => ({
          ...markNotRun(entry, stopReason!.reason, stopReason!.blockedBy),
          phaseId: phase.id,
          laneId: lane.id
        })));
      } else {
        const laneOutcomes: any[] = await runTestPhaseLanes(phase, executeEntry);
        phaseResults = laneOutcomes.flatMap((lane: any) =>
          lane.results.map((result: any) => ({
            ...result,
            phaseId: phase.id,
            laneId: lane.id
          }))
        );
      }
      results.push(...phaseResults);

      if (receivedSignal) {
        stopReason = { reason: "runner_interrupted_before_start", blockedBy: [] };
      } else if (!stopReason && phaseResults.some((result: any) => ["failed", "cancelled", "not_run"].includes(result.status)) && !options.continueOnFailure) {
        const hasFailedCommand = phaseResults.some((result: any) => result.status === "failed");
        const failedSuites = phaseResults.filter((result: any) => ["failed", "cancelled", "not_run"].includes(result.status))
          .flatMap((result: any) => result.childSuiteIds || [result.id]);
        console.log(`STOP after phase ${phase.id}: later phases were not started.`);
        stopReason = {
          reason: hasFailedCommand ? "previous_phase_failed" : "previous_phase_incomplete",
          blockedBy: failedSuites
        };
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }

  const finishedAt: any = new Date();
  const summary: any = summarizeTestResults(results, executionEntries.length);
  summary.reportLeakScan = true;

  console.log("");
  console.log(`Summary: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped, ${summary.cancelled} cancelled, ${summary.notRun} not run, ${summary.dryRun} dry-run`);
  if (options.dryRun) {
    console.log("Report: not written (dry-run)");
    if (summary.failed > 0 || summary.notRun > 0 || summary.cancelled > 0) {
      process.exitCode = receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : 1;
    }
    return;
  }

  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:schema:definition-1",
    verifier: "tests/run.ts",
    runner: "meshrix-unified-test-runner",
    productVersion,
    profile: options.profile,
    selectedSuites: selectedIds,
    executionPhases: executionPhases.map((phase: any) => ({
      id: phase.id,
      label: phase.label,
      lanes: phase.lanes.map((lane: any) => ({
        id: lane.id,
        label: lane.label,
        dependsOn: lane.dependsOn || [],
        processes: lane.entries.map((entry: any) => ({
          id: entry.id,
          childSuiteIds: entry.childSuiteIds || [entry.id],
          command: commandLine(entry)
        }))
      }))
    })),
    executionProcesses: executionEntries.map((entry: any) => ({
      id: entry.id,
      childSuiteIds: entry.childSuiteIds || [entry.id],
      command: commandLine(entry)
    })),
    sourceRevision,
    options: {
      tags: options.tags,
      explicitSuites: options.suites,
      dryRun: options.dryRun,
      continueOnFailure: options.continueOnFailure,
      strictPlatform: options.strictPlatform,
      changedBase: options.changedBase,
      shard,
      mergeVitestProcesses: profileExecution.mergeVitestProcesses === true,
      cachePassedResults: profileExecution.cachePassedResults === true,
      phasedExecution: Array.isArray(phaseDefinitions),
      phaseCount: executionPhases.length,
      laneCount: executionLaneCount
    },
    ...(receivedSignal ? { interruption: { receivedSignal } } : {}),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      ...(serviceDiscovery.environment ? { localExecution: serviceDiscovery.environment } : {}),
      serviceCapabilities: Object.fromEntries(Object.entries(serviceDiscovery.capabilities).map(([name, capability]) => [
        name,
        { status: capability.status, ...(capability.reasonCode ? { reasonCode: capability.reasonCode } : {}) }
      ]))
    },
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    summary,
    suites: results
  };
  assertNoLeak(report, "unified test runner report");

  const timestamp: any = startedAt.toISOString().replace(/[:.]/gu, "-");
  const reportPath: any = options.report
    ? path.resolve(repoRoot, options.report)
    : path.join(defaultReportDir, `meshrix-test-report-${timestamp}.json`);
  await writeJsonAtomic(reportPath, report);
  await writeJsonAtomic(path.join(defaultReportDir, "latest.json"), report);

  if (refreshTrackedReport) {
    const htmlReport: string = createRegressionHtmlReport(report, { productVersion });
    assertNoLeak(htmlReport, "tracked regression HTML report");
    await writeTextAtomic(path.join(repoRoot, TRACKED_REGRESSION_REPORT_PATH), htmlReport);
    console.log(`Interactive report: ${TRACKED_REGRESSION_REPORT_PATH}`);
  }

  console.log(`Report: ${displayReportPath(reportPath)}`);

  if (summary.failed > 0 || summary.notRun > 0 || summary.cancelled > 0) {
    process.exitCode = receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : 1;
  }
}

main().catch((error?: any) : any => {
  console.error(error);
  process.exitCode = 1;
});
