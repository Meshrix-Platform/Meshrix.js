import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..", "..");
const DEFAULT_REGISTRY_PATH = "tools/registry/release-authority-baseline.registry.json";
const PACKAGE_SCRIPT_FRAGMENT = /^package\.json#scripts\.(.+)$/u;

function normalizeRepoPath(value = "") {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/gu, "")
    .replace(/^\.\//u, "")
    .split(/[\\/]+/u)
    .join("/");
}

function stripFragment(value = "") {
  return normalizeRepoPath(String(value || "").split("#")[0] || "");
}

function isSafeRepoRelativePath(value) {
  const text = normalizeRepoPath(value);
  return Boolean(text) &&
    !text.startsWith("/") &&
    !/^[a-z]+:\/\//iu.test(text) &&
    !/^[A-Za-z]:\\/u.test(text) &&
    !text.split("/").includes("..");
}

async function pathExists(rootDir, relativePath) {
  try {
    await access(resolve(rootDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(rootDir, relativePath) {
  try {
    return (await stat(resolve(rootDir, relativePath))).isDirectory();
  } catch {
    return false;
  }
}

function add(findings, source, kind, detail) {
  findings.push({ source, kind, detail });
}

function sortedUnique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

async function importRepoModule(rootDir, relativePath) {
  const absolute = resolve(rootDir, relativePath);
  return import(pathToFileURL(absolute).href);
}

async function discoverCheckpointFiles(rootDir, checkpointDir) {
  const absolute = resolve(rootDir, checkpointDir);
  const names = await readdir(absolute);
  return sortedUnique(
    names
      .filter((name) => name.endsWith(".json"))
      .map((name) => `${normalizeRepoPath(checkpointDir)}/${name}`)
  );
}

function consumerPathExists(rootDir, consumer, packageScripts) {
  const packageMatch = String(consumer || "").match(PACKAGE_SCRIPT_FRAGMENT);
  if (packageMatch) {
    return packageScripts.has(packageMatch[1]);
  }
  const pathOnly = stripFragment(consumer);
  return isSafeRepoRelativePath(pathOnly) ? pathExists(rootDir, pathOnly) : Promise.resolve(false);
}

export async function discoverReleaseAuthorityCoverage(rootDir = DEFAULT_ROOT) {
  const commandModule = await importRepoModule(
    rootDir,
    "tools/server-scripts/lib/platform-acceptance-command-catalog.mjs"
  );
  const reportModule = await importRepoModule(
    rootDir,
    "tools/server-scripts/lib/platform-acceptance-report-catalog.mjs"
  );
  const requiredReportModule = await importRepoModule(
    rootDir,
    "tools/server-scripts/lib/required-report-validator.mjs"
  );
  const capabilityRegistry = JSON.parse(
    await readFile(resolve(rootDir, "tools/registry/capability-acceptance.registry.json"), "utf8")
  );
  const factSourceRegistry = JSON.parse(
    await readFile(resolve(rootDir, "tools/registry/fact-source-authority.registry.json"), "utf8")
  );
  const checkpointPaths = await discoverCheckpointFiles(
    rootDir,
    "tools/registry/capability-acceptance-checkpoints"
  );

  const commands = Array.isArray(commandModule.PLATFORM_ACCEPTANCE_COMMANDS)
    ? commandModule.PLATFORM_ACCEPTANCE_COMMANDS
    : [];
  const childReports = sortedUnique(commands.flatMap((command) => command.ownedReports || []));
  const requiredReportSpecs = requiredReportModule.REQUIRED_REPORT_SPECS &&
    typeof requiredReportModule.REQUIRED_REPORT_SPECS === "object"
    ? Object.values(requiredReportModule.REQUIRED_REPORT_SPECS)
    : [];
  const capabilityEntries = Array.isArray(capabilityRegistry.entries) ? capabilityRegistry.entries : [];
  const authorities = Array.isArray(factSourceRegistry.authorities) ? factSourceRegistry.authorities : [];

  return {
    commands: sortedUnique(commands.map((command) => command.id)),
    reports: sortedUnique([
      ...childReports,
      ...requiredReportSpecs.map((spec) => spec.path),
      reportModule.PLATFORM_ACCEPTANCE_REPORT_PATH
    ].filter(Boolean)),
    capabilities: sortedUnique(capabilityEntries.map((entry) => entry.capabilityId)),
    checkpoints: checkpointPaths,
    reducerInputs: sortedUnique([
      "tools/server-scripts/lib/platform-acceptance-command-catalog.mjs",
      "tools/server-scripts/lib/platform-acceptance-report-catalog.mjs",
      "tools/server-scripts/lib/required-report-validator.mjs",
      "tools/server-scripts/lib/platform-acceptance-reducer.mjs"
    ]),
    requiredReportSpecs: sortedUnique(requiredReportSpecs.map((spec) => spec.path)),
    sourceAuthorities: sortedUnique(authorities.map((authority) => authority.id)),
    sourceAuthorityFactKeys: sortedUnique(authorities.map((authority) => authority.factKey)),
    generatedProjections: []
  };
}

export async function validateReleaseAuthorityBaselineFindings(data, options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const registryPath = options.registryPath || DEFAULT_REGISTRY_PATH;
  const findings = [];

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

  const catalogAuthorities = data?.catalogAuthorities && typeof data.catalogAuthorities === "object"
    ? data.catalogAuthorities
    : null;
  if (!catalogAuthorities) {
    add(findings, registryPath, "catalog-authorities-missing", "catalogAuthorities must be an object");
    return { findings, coverage: null, inventory: null };
  }

  for (const [key, value] of Object.entries(catalogAuthorities)) {
    const pathOnly = stripFragment(value);
    if (!isSafeRepoRelativePath(pathOnly) || !await pathExists(rootDir, pathOnly)) {
      add(findings, registryPath, "catalog-authority-missing", `${key}:${pathOnly || "(missing)"}`);
    }
  }

  const packageJson = JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf8"));
  const packageScripts = new Set(Object.keys(packageJson.scripts || {}));
  const coverage = await discoverReleaseAuthorityCoverage(rootDir);

  const generatorOwnership = Array.isArray(data.generatorOwnership) ? data.generatorOwnership : [];
  if (generatorOwnership.length === 0) {
    add(findings, registryPath, "generator-ownership-empty", "generatorOwnership must be non-empty");
  }
  const generatorIds = new Set();
  const generatedProjections = [];
  for (const entry of generatorOwnership) {
    const id = String(entry.id || "").trim();
    const generator = normalizeRepoPath(entry.generator);
    const authorityPath = normalizeRepoPath(entry.authorityPath);
    const label = id || generator || "(missing generator)";
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
    const projectionPaths = Array.isArray(entry.projectionPaths) ? entry.projectionPaths : [];
    if (projectionPaths.length === 0) {
      add(findings, registryPath, "generator-projections-missing", label);
    }
    for (const projectionPath of projectionPaths.map(normalizeRepoPath)) {
      generatedProjections.push(projectionPath);
      if (!isSafeRepoRelativePath(projectionPath) || !await pathExists(rootDir, projectionPath)) {
        add(findings, registryPath, "generator-projection-invalid", `${label}:${projectionPath || "(missing)"}`);
      }
      if (projectionPath === authorityPath) {
        add(findings, registryPath, "projection-equals-authority", `${label}:${projectionPath}`);
      }
    }
  }
  coverage.generatedProjections = sortedUnique(generatedProjections);

  const categories = [
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

  const retained = Array.isArray(data?.migrationInventory?.retainedPositiveForwarding)
    ? data.migrationInventory.retainedPositiveForwarding
    : [];
  const removeLater = Array.isArray(data?.migrationInventory?.removeLaterLockdownOrStaticOnly)
    ? data.migrationInventory.removeLaterLockdownOrStaticOnly
    : [];
  if (retained.length === 0) {
    add(findings, registryPath, "retained-inventory-empty", "retainedPositiveForwarding must be non-empty");
  }
  if (removeLater.length === 0) {
    add(findings, registryPath, "remove-later-inventory-empty", "removeLaterLockdownOrStaticOnly must be non-empty");
  }

  const retainedIds = new Set();
  for (const entry of retained) {
    const id = String(entry.id || "").trim();
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
    const assertions = Array.isArray(entry.assertions) ? entry.assertions : [];
    if (assertions.length === 0) {
      add(findings, registryPath, "retained-assertions-missing", id);
    }
    for (const authorityPath of (entry.authorityPaths || []).map(normalizeRepoPath)) {
      if (!isSafeRepoRelativePath(authorityPath) || !await pathExists(rootDir, authorityPath)) {
        add(findings, registryPath, "retained-authority-invalid", `${id}:${authorityPath || "(missing)"}`);
      }
    }
  }

  const removeIds = new Set();
  const inventoriedLockdownCommands = new Set();
  const inventoriedLockdownReports = new Set();
  for (const entry of removeLater) {
    const id = String(entry.id || "").trim();
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
    const replacement = normalizeRepoPath(entry.replacementAuthority);
    if (!isSafeRepoRelativePath(replacement) || !await pathExists(rootDir, replacement)) {
      add(findings, registryPath, "remove-later-replacement-invalid", `${id}:${replacement || "(missing)"}`);
    }
    const consumers = Array.isArray(entry.consumers) ? entry.consumers : [];
    if (consumers.length === 0) {
      add(findings, registryPath, "remove-later-consumers-missing", id);
    }
    for (const consumer of consumers) {
      if (!await consumerPathExists(rootDir, consumer, packageScripts)) {
        add(findings, registryPath, "remove-later-consumer-invalid", `${id}:${consumer || "(missing)"}`);
      }
    }
    for (const commandId of entry.liveCommandIds || []) {
      const text = String(commandId || "").trim();
      if (!text) continue;
      inventoriedLockdownCommands.add(text);
      if (!coverage.commands.includes(text)) {
        add(findings, registryPath, "lockdown-command-orphan-inventory", `${id}:${text}`);
      }
    }
    for (const reportPath of entry.liveReportPaths || []) {
      const text = normalizeRepoPath(reportPath);
      if (!text) continue;
      inventoriedLockdownReports.add(text);
      if (!coverage.reports.includes(text)) {
        add(findings, registryPath, "lockdown-report-orphan-inventory", `${id}:${text}`);
      }
    }
  }

  const liveLockdownCommands = coverage.commands.filter((id) => id.includes("lockdown"));
  for (const commandId of liveLockdownCommands) {
    if (!inventoriedLockdownCommands.has(commandId)) {
      add(findings, registryPath, "lockdown-command-uninventoried", commandId);
    }
  }
  const liveLockdownReports = coverage.reports.filter((path) => path.includes("lockdown"));
  for (const reportPath of liveLockdownReports) {
    if (!inventoriedLockdownReports.has(reportPath)) {
      add(findings, registryPath, "lockdown-report-uninventoried", reportPath);
    }
  }

  const lockdownScriptNames = Object.keys(packageJson.scripts || {})
    .filter((name) => name.includes("lockdown"));
  for (const scriptName of lockdownScriptNames) {
    const consumerHit = removeLater.some((entry) =>
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

export async function validateReleaseAuthorityBaselineRegistry(data, options = {}) {
  const { findings } = await validateReleaseAuthorityBaselineFindings(data, options);
  return findings.map((finding) => `release-authority-baseline: ${finding.kind}: ${finding.detail}`);
}

export async function loadReleaseAuthorityBaselineRegistry(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const registryPath = options.registryPath || DEFAULT_REGISTRY_PATH;
  const data = JSON.parse(await readFile(resolve(rootDir, registryPath), "utf8"));
  return { rootDir, registryPath, data };
}

export {
  DEFAULT_REGISTRY_PATH,
  DEFAULT_ROOT,
  isDirectory,
  normalizeRepoPath
};
