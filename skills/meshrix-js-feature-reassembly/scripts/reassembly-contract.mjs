import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_CONTRACT_BYTES = 1_000_000;
const MAX_GIT_OUTPUT_BYTES = 8_000_000;
const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEVKIT_ROOT = path.resolve(SKILL_ROOT, "../..");
const DEFAULT_WORKFLOW_CATALOG = path.join(DEVKIT_ROOT, "workflows", "catalog.json");

export const REASSEMBLY_SURFACE_PROMPTS = Object.freeze([
  "canonical-contract",
  "composition",
  "consumers",
  "configuration",
  "registries-generated",
  "tests",
  "documentation",
  "external-adapters"
]);

const SURFACE_RULES = Object.freeze([
  Object.freeze({
    id: "authority",
    patterns: [
      /(?:^|\/)manifest\.module\.json$/u,
      /(?:^|\/)module\.json$/u,
      /(?:^|\/)tools\/registry\//u,
      /(?:^|\/)packages\/contracts\//u,
      /(?:^|\/)schemas?\//u,
      /(?:^|\/)state-machine\/definitions\//u,
      /(?:^|\/)(?:operation|feature|capability|public-api|dependency-rules).*registry/u
    ]
  }),
  Object.freeze({
    id: "composition",
    patterns: [
      /(?:^|\/)composition(?:\/|[-_.])/u,
      /^apps\/server\//u,
      /(?:^|\/)(?:bootstrap|register|provider|assembly|mount)(?:[-_.\/])/u,
      /(?:^|\/)composition-root\.[^/]+$/u
    ]
  }),
  Object.freeze({
    id: "protocol",
    patterns: [
      /(?:^|\/)packages\/protocols\//u,
      /(?:^|\/)docs\/protocols\//u,
      /(?:^|\/)(?:adapter|controller|transport|wire|rpc|mcp|http)(?:[-_.\/])/u,
      /(?:^|\/)protocols?\.[^/]+$/u
    ]
  }),
  Object.freeze({
    id: "consumers",
    patterns: [
      /^apps\/console\//u,
      /^packages\/ui-console\//u,
      /(?:^|\/)(?:views?|components?|clients?|commands?|executors?)(?:\/|[-_.])/u,
      /(?:^|\/)router\//u
    ]
  }),
  Object.freeze({
    id: "configuration",
    patterns: [
      /(?:^|\/)(?:config|settings)(?:\/|[-_.])/u,
      /(?:^|\/)(?:package(?:-lock)?\.json|Cargo\.toml|pubspec\.yaml|Dockerfile)$/u,
      /^\.github\/workflows\//u,
      /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/u
    ]
  }),
  Object.freeze({
    id: "tests",
    patterns: [
      /(?:^|\/)tests?\//u,
      /(?:^|\/)(?:test|spec)\.[^/]+$/u,
      /(?:^|\/)(?:verify|verifier|stress)[-/_.]/u
    ]
  }),
  Object.freeze({
    id: "documentation",
    patterns: [
      /^docs\//u,
      /(?:^|\/)(?:README|AGENTS)(?:\.[^/]+)?\.md$/u,
      /(?:^|\/)CHANGELOG\.md$/u
    ]
  }),
  Object.freeze({
    id: "generated",
    patterns: [
      /(?:^|\/)generated(?:\/|[-_.])/u,
      /\.generated\.[^/]+$/u,
      /(?:^|\/)operations\.(?:registry|routes|openapi)\.generated\.json$/u,
      /(?:^|\/)capabilities\.registry\.json$/u
    ]
  }),
  Object.freeze({
    id: "source",
    patterns: [
      /^(?:apps|packages|crates|plugins|lib|bin)\//u,
      /(?:^|\/)src\//u
    ]
  })
]);

const CONTRACT_TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "stage",
  "repository",
  "feature",
  "scenario",
  "authority",
  "surfaces",
  "migration",
  "verification"
]);
const SURFACE_FIELDS = new Set(["id", "owner", "status", "paths", "reason"]);
const SURFACE_STATUSES = new Set(["pending", "verified", "not-applicable"]);

export async function planReassembly({ target = process.cwd(), changedFrom = "" } = {}) {
  if (changedFrom) validateGitReference(changedFrom);
  const repositoryRoot = await resolveRepositoryRoot(target);
  const entries = await collectChangedEntries(repositoryRoot, changedFrom);
  const surfaces = SURFACE_RULES.map((surface) => {
    const paths = entries
      .filter((entry) => surface.patterns.some((pattern) => pattern.test(entry.path)))
      .map((entry) => entry.path);
    return Object.freeze({ id: surface.id, changedFileCount: paths.length, paths: Object.freeze(paths) });
  });
  const surfaceCounts = Object.fromEntries(surfaces.map((surface) => [surface.id, surface.changedFileCount]));
  const statusCounts = countStatuses(entries);
  const signals = [];
  addSignal(signals, "migration-closure", statusCounts.deleted + statusCounts.renamed);
  addSignal(signals, "package-or-layer-boundary", entries.filter((entry) => isBoundaryPath(entry.path)).length);
  addSignal(signals, "canonical-authority-projection", surfaceCounts.authority + surfaceCounts.generated);
  addSignal(signals, "runtime-composition-binding", surfaceCounts.composition);
  addSignal(signals, "protocol-compatibility", surfaceCounts.protocol);
  addSignal(signals, "user-surface-adaptation", surfaceCounts.consumers);
  addSignal(signals, "factual-documentation-update", surfaceCounts.documentation);
  const suggestedDepth = suggestDepth(signals);

  const digestPayload = entries.map((entry) => [entry.status, entry.path, ...(entry.previousPaths ?? [])]);
  return Object.freeze({
    ok: true,
    schemaVersion: "v0.0.1:meshrix-js:reassembly-plan-2",
    mode: changedFrom ? "reference-and-working-tree" : "working-tree",
    changeDigest: `sha256:${sha256(JSON.stringify(digestPayload))}`,
    changedFileCount: entries.length,
    statusCounts: Object.freeze(statusCounts),
    entries: Object.freeze(entries),
    surfaces: Object.freeze(surfaces),
    signals: Object.freeze(signals),
    framework: Object.freeze({
      mode: "heuristic",
      skill: "meshrix-js-feature-reassembly",
      contractTemplate: "skills/meshrix-js-feature-reassembly/assets/reassembly-contract.template.json",
      suggestedDepth,
      recommendedProfiles: Object.freeze(["changed"]),
      optionalProfiles: Object.freeze([
        Object.freeze({
          id: "reassembly",
          owner: "meshrix-js",
          when: "Core package, composition, registry, or product-surface convergence materially changed."
        })
      ])
    })
  });
}

export async function checkReassemblyContract({
  contractPath,
  target = process.cwd(),
  workflowCatalogPath = DEFAULT_WORKFLOW_CATALOG
} = {}) {
  if (!contractPath) throw codedError("contract-required");
  const repositoryRoot = await resolveRepositoryRoot(target);
  const raw = await readRegularUtf8(contractPath, MAX_CONTRACT_BYTES, "contract-read-failed");
  const contractDigest = `sha256:${sha256(raw)}`;
  let contract;
  try {
    contract = JSON.parse(raw);
  } catch {
    return invalidDiagnostic(contractDigest, [issue("contract-json", "contract", "Contract must be valid JSON.")]);
  }

  const errors = [];
  const advisories = [];
  if (!isPlainObject(contract)) {
    return invalidDiagnostic(contractDigest, [issue("contract-shape", "contract", "Contract must be a JSON object.")]);
  }
  for (const key of Object.keys(contract)) {
    if (!CONTRACT_TOP_LEVEL_FIELDS.has(key)) {
      advisories.push(advisory("unknown-contract-field", "contract", "The diagnostic contains an unknown top-level field.", "low"));
    }
  }

  const stage = contract.stage === "closure" ? "closure" : contract.stage === "plan" ? "plan" : "invalid";
  if (contract.schemaVersion !== 2) errors.push(issue("contract-version", "schemaVersion", "schemaVersion must be 2."));
  if (stage === "invalid") errors.push(issue("contract-stage", "stage", "stage must be plan or closure."));
  validateIdentifier(contract.repository, "repository", advisories);
  validateIdentifier(contract.feature, "feature", advisories);
  if (typeof contract.scenario !== "string" || !contract.scenario.trim() || contract.scenario.length > 500) {
    advisories.push(advisory("contract-scenario", "scenario", "Describe one bounded outcome or decision.", "medium"));
  }

  const authority = isPlainObject(contract.authority) ? contract.authority : null;
  if (!authority) {
    advisories.push(advisory("authority-shape", "authority", "Consider recording the current and superseded fact sources.", "medium"));
  } else {
    validateExactFields(authority, new Set(["canonicalSources", "supersededSources"]), "authority", advisories);
  }
  const canonicalSources = authority
    ? validatePathArray(authority.canonicalSources, "authority.canonicalSources", errors, advisories, { nonEmpty: true })
    : [];
  const supersededSources = authority
    ? validatePathArray(authority.supersededSources, "authority.supersededSources", errors, advisories)
    : [];

  const surfaceCounts = { pending: 0, verified: 0, notApplicable: 0 };
  const surfaceIds = new Set();
  if (!Array.isArray(contract.surfaces)) {
    errors.push(issue("surfaces-shape", "surfaces", "surfaces must be an array when provided."));
  } else {
    for (let index = 0; index < contract.surfaces.length; index += 1) {
      const surface = contract.surfaces[index];
      const item = `surfaces[${index}]`;
      if (!isPlainObject(surface)) {
        errors.push(issue("surface-shape", item, "Each surface must be an object."));
        continue;
      }
      validateExactFields(surface, SURFACE_FIELDS, item, advisories);
      const surfaceId = String(surface.id || "");
      if (!REASSEMBLY_SURFACE_PROMPTS.includes(surfaceId)) {
        advisories.push(advisory("surface-id", item, "This surface is not one of the known diagnostic prompts.", "low"));
      } else if (surfaceIds.has(surfaceId)) {
        advisories.push(advisory("duplicate-surface", item, "Duplicate surface prompts usually add noise.", "low"));
      }
      else surfaceIds.add(surfaceId);
      validateIdentifier(surface.owner, `${item}.owner`, advisories);
      if (!SURFACE_STATUSES.has(surface.status)) {
        advisories.push(advisory("surface-status", item, "Use pending, verified, or not-applicable when a status is useful.", "medium"));
      }
      else if (surface.status === "pending") surfaceCounts.pending += 1;
      else if (surface.status === "verified") surfaceCounts.verified += 1;
      else surfaceCounts.notApplicable += 1;
      const surfacePaths = validatePathArray(surface.paths, `${item}.paths`, errors, advisories);
      if (typeof surface.reason !== "string" || surface.reason.length > 500) {
        advisories.push(advisory("surface-reason", item, "Use a bounded reason when it changes a decision.", "low"));
      }

      if (stage === "closure") {
        if (surface.status === "pending") {
          advisories.push(advisory("pending-surface", item, "Decide whether this open question matters to the closure claim.", "medium"));
        }
        if (surface.status === "verified" && surfacePaths.length === 0) {
          advisories.push(advisory("verified-surface-paths", item, "A current path would make this conclusion easier to audit.", "medium"));
        }
        if (surface.status === "not-applicable" && !String(surface.reason || "").trim()) {
          advisories.push(advisory("not-applicable-reason", item, "A short exclusion reason would reduce future ambiguity.", "low"));
        }
        if (surface.status === "not-applicable" && surfacePaths.length > 0) {
          advisories.push(advisory("not-applicable-paths", item, "Paths and a not-applicable conclusion appear to conflict.", "medium"));
        }
      }
    }
  }
  const unexaminedSurfaceCount = REASSEMBLY_SURFACE_PROMPTS.filter((surfaceId) => !surfaceIds.has(surfaceId)).length;
  if (unexaminedSurfaceCount > 0) {
    advisories.push(advisory(
      "unexamined-surfaces",
      "surfaces",
      "Some standard surface prompts were omitted; review them only if they could change the outcome.",
      "low"
    ));
  }

  const migration = isPlainObject(contract.migration) ? contract.migration : null;
  if (!migration) advisories.push(advisory("migration-shape", "migration", "Add a migration inventory only when old behavior is being replaced.", "low"));
  else validateExactFields(migration, new Set(["residueSelectors", "compatibilityRetained"]), "migration", advisories);
  if (migration) validateBoundedStringArray(migration.residueSelectors, "migration.residueSelectors", errors, advisories);
  const compatibilityRetained = migration
    ? validateBoundedStringArray(migration.compatibilityRetained, "migration.compatibilityRetained", errors, advisories)
    : [];
  if (stage === "closure" && compatibilityRetained.length > 0) {
    advisories.push(advisory(
      "retained-compatibility",
      "migration.compatibilityRetained",
      "Confirm that retained compatibility is an intentional current contract before claiming migration completion.",
      "high"
    ));
  }

  const verification = isPlainObject(contract.verification) ? contract.verification : null;
  if (!verification) advisories.push(advisory("verification-shape", "verification", "Record verification only when it helps select proportionate evidence.", "low"));
  else validateExactFields(verification, new Set(["profiles", "taskIds", "blockers"]), "verification", advisories);
  const profiles = verification
    ? validateIdentifierArray(verification.profiles, "verification.profiles", errors, advisories)
    : [];
  const taskIds = verification
    ? validateIdentifierArray(verification.taskIds, "verification.taskIds", errors, advisories, { allowDots: true })
    : [];
  const blockers = verification
    ? validateBoundedStringArray(verification.blockers, "verification.blockers", errors, advisories)
    : [];

  const workflowCatalog = await readWorkflowCatalog(workflowCatalogPath);
  const knownProfiles = new Set(Object.keys(workflowCatalog.profiles || {}));
  const knownTaskIds = new Set((workflowCatalog.tasks || []).map((task) => task.id));
  for (let index = 0; index < profiles.length; index += 1) {
    if (!knownProfiles.has(profiles[index])) {
      advisories.push(advisory("unknown-workflow-profile", `verification.profiles[${index}]`, "This workflow profile is not cataloged.", "medium"));
    }
  }
  for (let index = 0; index < taskIds.length; index += 1) {
    if (!knownTaskIds.has(taskIds[index])) {
      advisories.push(advisory("unknown-workflow-task", `verification.taskIds[${index}]`, "This workflow task is not cataloged.", "medium"));
    }
  }
  if (profiles.includes("reassembly") && contract.repository !== "meshrix") {
    advisories.push(advisory(
      "core-profile-owner-mismatch",
      "verification.profiles",
      "The reassembly profile is Core-owned; select repository-owned checks unless Core is the target.",
      "medium"
    ));
  }
  if (stage === "closure" && !profiles.includes("changed")) {
    advisories.push(advisory("consider-changed-profile", "verification.profiles", "Consider the changed profile or an equivalent owner-specific focused check.", "low"));
  }
  if (stage === "closure" && contract.repository === "meshrix" && shouldConsiderCoreReassembly(contract.surfaces) && !profiles.includes("reassembly")) {
    advisories.push(advisory(
      "consider-core-reassembly-profile",
      "verification.profiles",
      "A Core boundary surface changed; consider the optional Core reassembly profile if it adds useful evidence.",
      "low"
    ));
  }
  if (blockers.length > 0) {
    advisories.push(advisory(
      "declared-blockers",
      "verification.blockers",
      "Confirm that each blocker is objective and external; ordinary uncertainty should not halt closure.",
      "high"
    ));
  }
  if (stage === "closure") {
    await validateClosurePaths(repositoryRoot, canonicalSources, supersededSources, contract.surfaces || [], advisories);
  }

  const highRiskAdvisories = advisories.filter((entry) => entry.severity === "high").length;
  const mediumAdvisories = advisories.filter((entry) => entry.severity === "medium").length;
  const recommendation = errors.length > 0
    ? "repair-diagnostic"
    : highRiskAdvisories > 0
      ? "review-high-risk"
      : mediumAdvisories > 0
        ? "proceed-with-review"
        : advisories.length > 0
          ? "proceed-with-awareness"
          : "proceed";
  return Object.freeze({
    ok: errors.length === 0,
    schemaVersion: "v0.0.1:meshrix-js:reassembly-contract-check-2",
    mode: "heuristic",
    stage,
    contractDigest,
    recommendation,
    counts: Object.freeze({
      surfaces: Array.isArray(contract.surfaces) ? contract.surfaces.length : 0,
      unexaminedSurfaces: unexaminedSurfaceCount,
      pendingSurfaces: surfaceCounts.pending,
      verifiedSurfaces: surfaceCounts.verified,
      notApplicableSurfaces: surfaceCounts.notApplicable,
      canonicalSources: canonicalSources.length,
      supersededSources: supersededSources.length,
      retainedCompatibility: compatibilityRetained.length,
      blockers: blockers.length,
      errors: errors.length,
      advisories: advisories.length,
      highRiskAdvisories
    }),
    errors: Object.freeze(errors),
    advisories: Object.freeze(advisories)
  });
}

async function collectChangedEntries(repositoryRoot, changedFrom) {
  const groups = [];
  if (changedFrom) groups.push(await gitNameStatus(repositoryRoot, ["diff", "--name-status", "-z", "--find-renames", `${changedFrom}...HEAD`, "--"]));
  groups.push(
    await gitNameStatus(repositoryRoot, ["diff", "--name-status", "-z", "--find-renames", "--"]),
    await gitNameStatus(repositoryRoot, ["diff", "--cached", "--name-status", "-z", "--find-renames", "--"])
  );
  const untracked = await gitText(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--"]);
  groups.push(untracked.split("\0").filter(Boolean).map((file) => ({ status: "?", path: normalizeGitPath(file), previousPaths: [] })));

  const merged = new Map();
  for (const entry of groups.flat()) {
    const current = merged.get(entry.path) || { path: entry.path, statuses: new Set(), previousPaths: new Set() };
    current.statuses.add(entry.status);
    for (const previousPath of entry.previousPaths || []) current.previousPaths.add(previousPath);
    merged.set(entry.path, current);
  }
  return [...merged.values()]
    .map((entry) => Object.freeze({
      status: normalizedStatus(entry.statuses),
      path: entry.path,
      ...(entry.previousPaths.size > 0 ? { previousPaths: Object.freeze([...entry.previousPaths].sort()) } : {})
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function gitNameStatus(repositoryRoot, args) {
  const tokens = (await gitText(repositoryRoot, args)).split("\0").filter(Boolean);
  const entries = [];
  for (let index = 0; index < tokens.length;) {
    const rawStatus = tokens[index++];
    const status = String(rawStatus || "").charAt(0);
    if (!/[ACDMRTUXB?]/u.test(status)) throw codedError("git-output-invalid");
    if (status === "R" || status === "C") {
      if (index + 1 >= tokens.length) throw codedError("git-output-invalid");
      const previousPath = normalizeGitPath(tokens[index++]);
      const currentPath = normalizeGitPath(tokens[index++]);
      entries.push({ status, path: currentPath, previousPaths: [previousPath] });
    } else {
      if (index >= tokens.length) throw codedError("git-output-invalid");
      entries.push({ status, path: normalizeGitPath(tokens[index++]), previousPaths: [] });
    }
  }
  return entries;
}

async function gitText(repositoryRoot, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: 30_000,
      windowsHide: true
    });
    return new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    throw codedError("git-inspection-failed");
  }
}

async function resolveRepositoryRoot(target) {
  const candidate = path.resolve(target || process.cwd());
  const root = (await gitText(candidate, ["rev-parse", "--show-toplevel"])).trim();
  if (!root) throw codedError("repository-required");
  return path.resolve(root);
}

function normalizeGitPath(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  if (!isSafeRepositoryPath(normalized)) throw codedError("git-output-invalid");
  return normalized;
}

function normalizedStatus(statuses) {
  for (const status of ["R", "D", "A", "M", "C", "T", "U", "X", "B", "?"]) {
    if (statuses.has(status)) return status;
  }
  return "?";
}

function countStatuses(entries) {
  const counts = { added: 0, modified: 0, deleted: 0, renamed: 0, untracked: 0, other: 0 };
  for (const entry of entries) {
    if (entry.status === "A") counts.added += 1;
    else if (entry.status === "M") counts.modified += 1;
    else if (entry.status === "D") counts.deleted += 1;
    else if (entry.status === "R" || entry.status === "C") counts.renamed += 1;
    else if (entry.status === "?") counts.untracked += 1;
    else counts.other += 1;
  }
  return counts;
}

function isBoundaryPath(file) {
  return /(?:^|\/)(?:manifest\.module\.json|module\.json|package(?:-lock)?\.json|Cargo\.toml|pubspec\.yaml)$/u.test(file) ||
    /(?:^|\/)(?:public-api|dependency-rules|modules|server-layers|repo-layout).*registry\.json$/u.test(file) ||
    /(?:^|\/)composition(?:\/|[-_.])/u.test(file);
}

function addSignal(signals, id, fileCount) {
  if (fileCount > 0) signals.push(Object.freeze({ id, changedFileCount: fileCount }));
}

function suggestDepth(signals) {
  const ids = new Set(signals.map((signal) => signal.id));
  if (ids.has("migration-closure") || ids.has("protocol-compatibility")) return "deep";
  if (
    ids.has("package-or-layer-boundary") ||
    ids.has("canonical-authority-projection") ||
    ids.has("runtime-composition-binding") ||
    ids.has("user-surface-adaptation")
  ) return "standard";
  return "light";
}

function shouldConsiderCoreReassembly(surfaces) {
  if (!Array.isArray(surfaces)) return false;
  const materialIds = new Set(["canonical-contract", "composition", "registries-generated", "consumers"]);
  return surfaces.some((surface) => isPlainObject(surface) && surface.status === "verified" && materialIds.has(surface.id));
}

async function validateClosurePaths(repositoryRoot, canonicalSources, supersededSources, surfaces, advisories) {
  for (let index = 0; index < canonicalSources.length; index += 1) {
    if (!(await sourcePathExists(repositoryRoot, canonicalSources[index]))) {
      advisories.push(advisory(
        "canonical-source-missing",
        `authority.canonicalSources[${index}]`,
        "The declared canonical source does not exist; reconcile the claim or the path.",
        "high"
      ));
    }
  }
  for (let index = 0; index < supersededSources.length; index += 1) {
    if (await sourcePathExists(repositoryRoot, supersededSources[index])) {
      advisories.push(advisory(
        "superseded-source-present",
        `authority.supersededSources[${index}]`,
        "A declared superseded source still exists; confirm coexistence is intentional before claiming migration completion.",
        "high"
      ));
    }
  }
  for (let surfaceIndex = 0; surfaceIndex < surfaces.length; surfaceIndex += 1) {
    const surface = surfaces[surfaceIndex];
    if (!isPlainObject(surface) || surface.status !== "verified" || !Array.isArray(surface.paths)) continue;
    for (let pathIndex = 0; pathIndex < surface.paths.length; pathIndex += 1) {
      if (isSafeRepositoryPath(surface.paths[pathIndex]) && !(await sourcePathExists(repositoryRoot, surface.paths[pathIndex]))) {
        advisories.push(advisory(
          "verified-surface-path-missing",
          `surfaces[${surfaceIndex}].paths[${pathIndex}]`,
          "A path supporting this verified conclusion does not exist in the target repository.",
          "medium"
        ));
      }
    }
  }
}

async function sourcePathExists(repositoryRoot, relativePath) {
  const absolute = path.resolve(repositoryRoot, relativePath);
  const relative = path.relative(repositoryRoot, absolute);
  if (!relative || relative === "." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  const status = await lstat(absolute).catch(() => null);
  return Boolean(status && !status.isSymbolicLink());
}

function validateExactFields(value, allowed, item, issues) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(advisory("unknown-field", item, "The diagnostic contains an unknown field.", "low"));
  }
}

function validateIdentifier(value, item, issues, { allowDots = false } = {}) {
  const expression = allowDots ? /^[a-z0-9][a-z0-9._-]{0,127}$/u : /^[a-z0-9][a-z0-9_-]{0,127}$/u;
  if (typeof value !== "string" || !expression.test(value)) {
    issues.push(advisory("identifier", item, "Use a stable lowercase identifier when this label matters.", "medium"));
  }
}

function validateIdentifierArray(value, item, errors, advisories, options = {}) {
  if (!Array.isArray(value)) {
    errors.push(issue("identifier-array", item, "Value must be an array of identifiers."));
    return [];
  }
  const result = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const before = advisories.length;
    validateIdentifier(value[index], `${item}[${index}]`, advisories, options);
    if (advisories.length !== before) continue;
    if (seen.has(value[index])) {
      advisories.push(advisory("duplicate-identifier", `${item}[${index}]`, "Duplicate identifiers add no diagnostic evidence.", "low"));
    }
    else {
      seen.add(value[index]);
      result.push(value[index]);
    }
  }
  return result;
}

function validatePathArray(value, item, errors, advisories, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    errors.push(issue("path-array", item, "Value must be an array of repository-relative paths."));
    return [];
  }
  if (nonEmpty && value.length === 0) {
    advisories.push(advisory("path-array-empty", item, "Consider identifying the current canonical source.", "medium"));
  }
  const result = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    if (!isSafeRepositoryPath(value[index])) {
      errors.push(issue("repository-path", `${item}[${index}]`, "Path must be a safe repository-relative path."));
      continue;
    }
    if (seen.has(value[index])) {
      advisories.push(advisory("duplicate-path", `${item}[${index}]`, "Duplicate paths add no diagnostic evidence.", "low"));
    }
    else {
      seen.add(value[index]);
      result.push(value[index]);
    }
  }
  return result;
}

function validateBoundedStringArray(value, item, errors, advisories) {
  if (!Array.isArray(value)) {
    errors.push(issue("string-array", item, "Value must be an array of bounded strings."));
    return [];
  }
  const result = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== "string" || !entry.trim() || entry.length > 300 || /[\0\r\n]/u.test(entry)) {
      errors.push(issue("bounded-string", `${item}[${index}]`, "Entry must be one non-empty bounded line."));
      continue;
    }
    if (seen.has(entry)) {
      advisories.push(advisory("duplicate-string", `${item}[${index}]`, "Duplicate entries add no diagnostic evidence.", "low"));
    }
    else {
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}

function isSafeRepositoryPath(value) {
  if (typeof value !== "string" || !value || value.length > 500 || /[\0\r\n]/u.test(value)) return false;
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}

async function readWorkflowCatalog(workflowCatalogPath) {
  const raw = await readRegularUtf8(workflowCatalogPath, MAX_CONTRACT_BYTES, "workflow-catalog-read-failed");
  try {
    const value = JSON.parse(raw);
    if (!isPlainObject(value) || !isPlainObject(value.profiles) || !Array.isArray(value.tasks)) throw new Error();
    return value;
  } catch {
    throw codedError("workflow-catalog-invalid");
  }
}

async function readRegularUtf8(file, maxBytes, code) {
  const absolute = path.resolve(file);
  const status = await lstat(absolute).catch(() => null);
  if (!status?.isFile() || status.isSymbolicLink() || status.size > maxBytes) throw codedError(code);
  try {
    const bytes = await readFile(absolute);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw codedError(code);
  }
}

function validateGitReference(reference) {
  if (typeof reference !== "string" || !reference || reference.length > 200 || reference.startsWith("-") || /[\s\0]/u.test(reference)) {
    throw codedError("git-reference-invalid");
  }
}

function invalidDiagnostic(contractDigest, errors) {
  return Object.freeze({
    ok: false,
    schemaVersion: "v0.0.1:meshrix-js:reassembly-contract-check-2",
    mode: "heuristic",
    stage: "invalid",
    contractDigest,
    recommendation: "repair-diagnostic",
    counts: Object.freeze({ errors: errors.length, advisories: 0, highRiskAdvisories: 0 }),
    errors: Object.freeze(errors),
    advisories: Object.freeze([])
  });
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function issue(code, item, message) {
  return Object.freeze({ code, item, message });
}

function advisory(code, item, message, severity) {
  return Object.freeze({ code, item, message, severity });
}

function codedError(code) {
  const error = new Error();
  error.code = code;
  return error;
}
