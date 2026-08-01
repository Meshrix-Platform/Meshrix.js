import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname: any = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT: any = resolve(__dirname, "..", "..");
const DEFAULT_REGISTRY_PATH: any = "tools/registry/release-authority-baseline.registry.json";
const PACKAGE_SCRIPT_FRAGMENT: any = /^package\.json#scripts\.(.+)$/u;

function normalizeRepoPath(value: any = "") : any {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/gu, "")
    .replace(/^\.\//u, "")
    .split(/[\\/]+/u)
    .join("/");
}

function stripFragment(value: any = "") : any {
  return normalizeRepoPath(String(value || "").split("#")[0] || "");
}

function isSafeRepoRelativePath(value?: any) : any {
  const text: any = normalizeRepoPath(value);
  return Boolean(text) &&
    !text.startsWith("/") &&
    !/^[a-z]+:\/\//iu.test(text) &&
    !/^[A-Za-z]:\\/u.test(text) &&
    !text.split("/").includes("..");
}

async function pathExists(rootDir?: any, relativePath?: any) : Promise<any> {
  try {
    await access(resolve(rootDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(rootDir?: any, relativePath?: any) : Promise<any> {
  try {
    return (await stat(resolve(rootDir, relativePath))).isDirectory();
  } catch {
    return false;
  }
}

function add(findings?: any, source?: any, kind?: any, detail?: any) : any {
  findings.push({ source, kind, detail });
}

function sortedUnique(values?: any) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))].sort();
}

async function importRepoModule(rootDir?: any, relativePath?: any) : Promise<any> {
  const absolute: any = resolve(rootDir, relativePath);
  return import(pathToFileURL(absolute).href);
}

async function discoverCheckpointFiles(rootDir?: any, checkpointDir?: any) : Promise<any> {
  const absolute: any = resolve(rootDir, checkpointDir);
  const names: any = await readdir(absolute);
  return sortedUnique(
    names
      .filter((name?: any) : any => name.endsWith(".json"))
      .map((name?: any) : any => `${normalizeRepoPath(checkpointDir)}/${name}`)
  );
}

function consumerPathExists(rootDir?: any, consumer?: any, packageScripts?: any) : any {
  const packageMatch: any = String(consumer || "").match(PACKAGE_SCRIPT_FRAGMENT);
  if (packageMatch) {
    return packageScripts.has(packageMatch[1]);
  }
  const pathOnly: any = stripFragment(consumer);
  return isSafeRepoRelativePath(pathOnly) ? pathExists(rootDir, pathOnly) : Promise.resolve(false);
}

export async function discoverReleaseAuthorityCoverage(rootDir: any = DEFAULT_ROOT) : Promise<any> {
  const commandModule: any = await importRepoModule(
    rootDir,
    "tools/server-scripts/lib/platform-acceptance-command-catalog.ts"
  );
  const reportModule: any = await importRepoModule(
    rootDir,
    "tools/server-scripts/lib/platform-acceptance-report-catalog.ts"
  );
  const requiredReportModule: any = await importRepoModule(
    rootDir,
    "tools/server-scripts/lib/required-report-validator.ts"
  );
  const capabilityRegistry: any = JSON.parse(
    await readFile(resolve(rootDir, "tools/registry/capability-acceptance.registry.json"), "utf8")
  );
  const factSourceRegistry: any = JSON.parse(
    await readFile(resolve(rootDir, "tools/registry/fact-source-authority.registry.json"), "utf8")
  );
  const checkpointPaths: any = await discoverCheckpointFiles(
    rootDir,
    "tools/registry/capability-acceptance-checkpoints"
  );

  const commands: any = Array.isArray(commandModule.PLATFORM_ACCEPTANCE_COMMANDS)
    ? commandModule.PLATFORM_ACCEPTANCE_COMMANDS
    : [];
  const childReports: any = sortedUnique(commands.flatMap((command?: any) : any => command.ownedReports || []));
  const requiredReportSpecs: any = requiredReportModule.REQUIRED_REPORT_SPECS &&
    typeof requiredReportModule.REQUIRED_REPORT_SPECS === "object"
    ? (Object.values(requiredReportModule.REQUIRED_REPORT_SPECS) as any[])
    : [];
  const capabilityEntries: any = Array.isArray(capabilityRegistry.entries) ? capabilityRegistry.entries : [];
  const authorities: any = Array.isArray(factSourceRegistry.authorities) ? factSourceRegistry.authorities : [];

  return {
    commands: sortedUnique(commands.map((command?: any) : any => command.id)),
    reports: sortedUnique([
      ...childReports,
      ...requiredReportSpecs.map((spec?: any) : any => spec.path),
      reportModule.PLATFORM_ACCEPTANCE_REPORT_PATH
    ].filter(Boolean)),
    capabilities: sortedUnique(capabilityEntries.map((entry?: any) : any => entry.capabilityId)),
    checkpoints: checkpointPaths,
    reducerInputs: sortedUnique([
      "tools/server-scripts/lib/platform-acceptance-command-catalog.ts",
      "tools/server-scripts/lib/platform-acceptance-report-catalog.ts",
      "tools/server-scripts/lib/required-report-validator.ts",
      "tools/server-scripts/lib/platform-acceptance-reducer.ts"
    ]),
    requiredReportSpecs: sortedUnique(requiredReportSpecs.map((spec?: any) : any => spec.path)),
    sourceAuthorities: sortedUnique(authorities.map((authority?: any) : any => authority.id)),
    sourceAuthorityFactKeys: sortedUnique(authorities.map((authority?: any) : any => authority.factKey)),
    generatedProjections: []
  };
}

export async function validateReleaseAuthorityBaselineFindings(data?: any, options: Record<string, any> = {}) : Promise<any> {
  const rootDir: any = options.rootDir || DEFAULT_ROOT;
  const registryPath: any = options.registryPath || DEFAULT_REGISTRY_PATH;
  const findings: any[] = [];

  if (
    data?.policy?.inspectAuthoritiesDirectly !== true ||
    data?.policy?.neverImportGeneratedReportStatus !== true ||
    data?.policy?.placeholderReportsCannotSatisfyReleaseFacts !== true ||
    data?.policy?.doNotDeleteLockdownBeforePositivePath !== true
  ) {
    add(
      findings,
      registryPath,
      "policy-not-strict",
      "baseline policy must require direct authority inspection, reject generated-report authority, reject placeholder release facts, and keep lockdown until the positive path exists"
    );
  }

  const catalogAuthorities: any = data?.catalogAuthorities && typeof data.catalogAuthorities === "object"
    ? data.catalogAuthorities
    : null;
  if (!catalogAuthorities) {
    add(findings, registryPath, "catalog-authorities-missing", "catalogAuthorities must be an object");
    return { findings, coverage: null, inventory: null };
  }

  for (const [key, value] of (Object.entries(catalogAuthorities) as [string, any][])) {
    const pathOnly: any = stripFragment(value);
    if (!isSafeRepoRelativePath(pathOnly) || !await pathExists(rootDir, pathOnly)) {
      add(findings, registryPath, "catalog-authority-missing", `${key}:${pathOnly || "(missing)"}`);
    }
  }

  const packageJson: any = JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf8"));
  const packageScripts: any = new Set<any>(Object.keys(packageJson.scripts || {}));
  const coverage: any = await discoverReleaseAuthorityCoverage(rootDir);

  const generatorOwnership: any = Array.isArray(data.generatorOwnership) ? data.generatorOwnership : [];
  if (generatorOwnership.length === 0) {
    add(findings, registryPath, "generator-ownership-empty", "generatorOwnership must be non-empty");
  }
  const generatorIds: any = new Set<any>();
  const generatedProjections: any[] = [];
  for (const entry of generatorOwnership) {
    const id: any = String(entry.id || "").trim();
    const generator: any = normalizeRepoPath(entry.generator);
    const authorityPath: any = normalizeRepoPath(entry.authorityPath);
    const label: any = id || generator || "(missing generator)";
    if (!id) {
      add(findings, registryPath, "generator-id-missing", generator || "(missing)");
    } else if (generatorIds.has(id)) {
      add(findings, registryPath, "generator-id-duplicate", id);
    }
    generatorIds.add(id);
    if (!isSafeRepoRelativePath(generator) || !await pathExists(rootDir, generator)) {
      add(findings, registryPath, "generator-path-invalid", `${label}:${generator || "(missing)"}`);
    }
    if (!isSafeRepoRelativePath(authorityPath) || !await pathExists(rootDir, authorityPath)) {
      add(findings, registryPath, "generator-authority-invalid", `${label}:${authorityPath || "(missing)"}`);
    }
    const projectionPaths: any = Array.isArray(entry.projectionPaths) ? entry.projectionPaths : [];
    if (projectionPaths.length === 0) {
      add(findings, registryPath, "generator-projections-missing", label);
    }
    for (const projectionPath of projectionPaths.map(normalizeRepoPath)) {
      generatedProjections.push(projectionPath);
      const generatedProjection: any = projectionPath.startsWith("build/");
      if (
        !isSafeRepoRelativePath(projectionPath) ||
        (!generatedProjection && !await pathExists(rootDir, projectionPath))
      ) {
        add(findings, registryPath, "generator-projection-invalid", `${label}:${projectionPath || "(missing)"}`);
      }
      if (projectionPath === authorityPath) {
        add(findings, registryPath, "projection-equals-authority", `${label}:${projectionPath}`);
      }
    }
  }
  coverage.generatedProjections = sortedUnique(generatedProjections);

  const categories: any[] = [
    ["commands", coverage.commands],
    ["reports", coverage.reports],
    ["capabilities", coverage.capabilities],
    ["checkpoints", coverage.checkpoints],
    ["reducerInputs", coverage.reducerInputs],
    ["requiredReportSpecs", coverage.requiredReportSpecs],
    ["generatedProjections", coverage.generatedProjections],
    ["sourceAuthorities", coverage.sourceAuthorities]
  ];
  for (const [name, values] of categories) {
    if (!Array.isArray(values) || values.length === 0) {
      add(findings, registryPath, "coverage-category-empty", name);
    }
  }

  if (coverage.capabilities.length !== coverage.checkpoints.length) {
    add(
      findings,
      registryPath,
      "capability-checkpoint-count-mismatch",
      `capabilities=${coverage.capabilities.length}:checkpoints=${coverage.checkpoints.length}`
    );
  }

  const retained: any = Array.isArray(data?.migrationInventory?.retainedPositiveForwarding)
    ? data.migrationInventory.retainedPositiveForwarding
    : [];
  const removeLater: any = Array.isArray(data?.migrationInventory?.removeLaterLockdownOrStaticOnly)
    ? data.migrationInventory.removeLaterLockdownOrStaticOnly
    : [];
  if (retained.length === 0) {
    add(findings, registryPath, "retained-inventory-empty", "retainedPositiveForwarding must be non-empty");
  }
  if (removeLater.length === 0) {
    add(findings, registryPath, "remove-later-inventory-empty", "removeLaterLockdownOrStaticOnly must be non-empty");
  }

  const retainedIds: any = new Set<any>();
  for (const entry of retained) {
    const id: any = String(entry.id || "").trim();
    if (!id) {
      add(findings, registryPath, "retained-id-missing", "(missing id)");
      continue;
    }
    if (retainedIds.has(id)) {
      add(findings, registryPath, "retained-id-duplicate", id);
    }
    retainedIds.add(id);
    if (entry.classification !== "retained-positive-forwarding") {
      add(findings, registryPath, "retained-classification-invalid", id);
    }
    const assertions: any = Array.isArray(entry.assertions) ? entry.assertions : [];
    if (assertions.length === 0) {
      add(findings, registryPath, "retained-assertions-missing", id);
    }
    for (const authorityPath of (entry.authorityPaths || []).map(normalizeRepoPath)) {
      if (!isSafeRepoRelativePath(authorityPath) || !await pathExists(rootDir, authorityPath)) {
        add(findings, registryPath, "retained-authority-invalid", `${id}:${authorityPath || "(missing)"}`);
      }
    }
  }

  const removeIds: any = new Set<any>();
  const inventoriedLockdownCommands: any = new Set<any>();
  const inventoriedLockdownReports: any = new Set<any>();
  for (const entry of removeLater) {
    const id: any = String(entry.id || "").trim();
    if (!id) {
      add(findings, registryPath, "remove-later-id-missing", "(missing id)");
      continue;
    }
    if (removeIds.has(id)) {
      add(findings, registryPath, "remove-later-id-duplicate", id);
    }
    removeIds.add(id);
    if (retainedIds.has(id)) {
      add(findings, registryPath, "inventory-classification-contradiction", id);
    }
    if (!["lockdown", "static-only"].includes(entry.classification)) {
      add(findings, registryPath, "remove-later-classification-invalid", id);
    }
    if (entry.status !== "present-must-remove-after-positive-path") {
      add(findings, registryPath, "remove-later-status-invalid", id);
    }
    for (const authorityPath of (entry.authorityPaths || []).map(normalizeRepoPath)) {
      if (!isSafeRepoRelativePath(authorityPath) || !await pathExists(rootDir, authorityPath)) {
        add(findings, registryPath, "remove-later-authority-invalid", `${id}:${authorityPath || "(missing)"}`);
      }
    }
    const replacement: any = normalizeRepoPath(entry.replacementAuthority);
    if (!isSafeRepoRelativePath(replacement) || !await pathExists(rootDir, replacement)) {
      add(findings, registryPath, "remove-later-replacement-invalid", `${id}:${replacement || "(missing)"}`);
    }
    const consumers: any = Array.isArray(entry.consumers) ? entry.consumers : [];
    if (consumers.length === 0) {
      add(findings, registryPath, "remove-later-consumers-missing", id);
    }
    for (const consumer of consumers) {
      if (!await consumerPathExists(rootDir, consumer, packageScripts)) {
        add(findings, registryPath, "remove-later-consumer-invalid", `${id}:${consumer || "(missing)"}`);
      }
    }
    for (const commandId of entry.liveCommandIds || []) {
      const text: any = String(commandId || "").trim();
      if (!text) continue;
      inventoriedLockdownCommands.add(text);
      if (!coverage.commands.includes(text)) {
        add(findings, registryPath, "lockdown-command-orphan-inventory", `${id}:${text}`);
      }
    }
    for (const reportPath of entry.liveReportPaths || []) {
      const text: any = normalizeRepoPath(reportPath);
      if (!text) continue;
      inventoriedLockdownReports.add(text);
      if (!coverage.reports.includes(text)) {
        add(findings, registryPath, "lockdown-report-orphan-inventory", `${id}:${text}`);
      }
    }
  }

  const liveLockdownCommands: any = coverage.commands.filter((id?: any) : any => id.includes("lockdown"));
  for (const commandId of liveLockdownCommands) {
    if (!inventoriedLockdownCommands.has(commandId)) {
      add(findings, registryPath, "lockdown-command-uninventoried", commandId);
    }
  }
  const liveLockdownReports: any = coverage.reports.filter((path?: any) : any => path.includes("lockdown"));
  for (const reportPath of liveLockdownReports) {
    if (!inventoriedLockdownReports.has(reportPath)) {
      add(findings, registryPath, "lockdown-report-uninventoried", reportPath);
    }
  }

  const lockdownScriptNames: any = Object.keys(packageJson.scripts || {})
    .filter((name?: any) : any => name.includes("lockdown"));
  for (const scriptName of lockdownScriptNames) {
    const consumerHit: any = removeLater.some((entry?: any) : any =>
      (entry.consumers || []).includes(`package.json#scripts.${scriptName}`)
    );
    if (!consumerHit) {
      add(findings, registryPath, "lockdown-script-uninventoried", scriptName);
    }
  }

  return {
    findings,
    coverage,
    inventory: {
      retainedPositiveForwardingIds: [...retainedIds].sort(),
      removeLaterIds: [...removeIds].sort(),
      lockdownCommandIds: [...inventoriedLockdownCommands].sort(),
      lockdownReportPaths: [...inventoriedLockdownReports].sort()
    }
  };
}

export async function validateReleaseAuthorityBaselineRegistry(data?: any, options: Record<string, any> = {}) : Promise<any> {
  const { findings } = await validateReleaseAuthorityBaselineFindings(data, options);
  return findings.map((finding?: any) : any => `release-authority-baseline: ${finding.kind}: ${finding.detail}`);
}

export async function loadReleaseAuthorityBaselineRegistry(options: Record<string, any> = {}) : Promise<any> {
  const rootDir: any = options.rootDir || DEFAULT_ROOT;
  const registryPath: any = options.registryPath || DEFAULT_REGISTRY_PATH;
  const data: any = JSON.parse(await readFile(resolve(rootDir, registryPath), "utf8"));
  return { rootDir, registryPath, data };
}

export {
  DEFAULT_REGISTRY_PATH,
  DEFAULT_ROOT,
  isDirectory,
  normalizeRepoPath
};
