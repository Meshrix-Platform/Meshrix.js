/**
 * package-script-registry.mjs — Package Script Registry API
 *
 * Canonical public API for classifying every npm script in package.json.
 * Explicit entries and category metadata live in
 * package-script-registry-catalog.mjs; this module owns pattern projection,
 * classification queries, and snapshots.
 *
 * When adding an explicit script, register it in the catalog first.
 *
 * Verifiers check that:
 * - Every script in package.json is classified here or in UNCLASSIFIED_ALLOWLIST
 * - Explicit registry commands remain canonical npm aliases backed by real package.json commands
 * - Scripts with sideEffects=docker/network-service are excluded from default profiles
 * - Scripts requiring fresh containers are excluded from fast/local profiles
 *
 * Run verification: node tests/verify-script-registry.mjs
 */

import { PATTERN_CLASSIFIED_SCRIPT_NAMES } from "./package-script-pattern-names.mjs";

export { PATTERN_CLASSIFIED_SCRIPT_NAMES } from "./package-script-pattern-names.mjs";

import {
  SCRIPT_CATEGORIES,
  SCRIPT_REGISTRY,
  UNCLASSIFIED_ALLOWLIST
} from "./package-script-registry-catalog.mjs";

export {
  SCRIPT_CATEGORIES,
  SCRIPT_REGISTRY,
  UNCLASSIFIED_ALLOWLIST
} from "./package-script-registry-catalog.mjs";

const PATTERN_CLASSIFIED_SCRIPT_NAME_SET = new Set(PATTERN_CLASSIFIED_SCRIPT_NAMES);

/**
 * Pattern-based classification for scripts not yet in the detailed registry.
 * Each entry has a prefix pattern → { category, subsystem, owner, tier, sideEffects }.
 * Scripts matching these patterns are considered classified without a full entry.
 */
const SCRIPT_CLASSIFICATION_PATTERNS = Object.freeze([
  { prefix: "server:verify:",        category: "verifier",      subsystem: "server",    owner: "platform",  tier: "hygiene",      sideEffects: "none" },
  { prefix: "server:test:",          category: "test",          subsystem: "server",    owner: "platform",  tier: "unit",         sideEffects: "none" },
  { prefix: "server:dev:",           category: "startup",       subsystem: "server",    owner: "platform",  tier: "integration",  sideEffects: "runtime-data" },
  { prefix: "server:start:",         category: "startup",       subsystem: "server",    owner: "platform",  tier: "integration",  sideEffects: "runtime-data" },
  { prefix: "server:build:",         category: "packaging",     subsystem: "server",    owner: "platform",  tier: "release",      sideEffects: "build-output" },
  { prefix: "server:pack:",          category: "packaging",     subsystem: "server",    owner: "platform",  tier: "release",      sideEffects: "build-output" },
  { prefix: "server:composition:",   category: "packaging",     subsystem: "server",    owner: "platform",  tier: "hygiene",      sideEffects: "none" },
  { prefix: "server:mcp:",           category: "mcp-installer", subsystem: "gateway",   owner: "platform",  tier: "integration",  sideEffects: "none" },
  { prefix: "server:doctor:",        category: "maintenance",   subsystem: "server",    owner: "platform",  tier: "hygiene",      sideEffects: "none" },
  { prefix: "server:module:",        category: "maintenance",   subsystem: "optional",  owner: "platform",  tier: "integration",  sideEffects: "runtime-data" },
  { prefix: "server:auth",           category: "maintenance",   subsystem: "core",      owner: "platform",  tier: "integration",  sideEffects: "runtime-data" },
  { prefix: "server:deployment",     category: "maintenance",   subsystem: "deployment", owner: "platform", tier: "hygiene",      sideEffects: "none" },
  { prefix: "server:gate:",          category: "verifier",      subsystem: "optional",  owner: "platform",  tier: "hygiene",      sideEffects: "none" },
  { prefix: "server:skills:",        category: "verifier",      subsystem: "optional",  owner: "platform",  tier: "hygiene",      sideEffects: "none" },
  { prefix: "server:console:",       category: "startup",       subsystem: "server",    owner: "platform",  tier: "integration",  sideEffects: "runtime-data" },
  { prefix: "server:background:",    category: "startup",       subsystem: "server",    owner: "platform",  tier: "integration",  sideEffects: "runtime-data" },
  { prefix: "server:setup-",         category: "startup",       subsystem: "server",    owner: "platform",  tier: "integration",  sideEffects: "runtime-data" },
  { prefix: "server:gateway:",       category: "startup",       subsystem: "gateway",   owner: "platform",  tier: "integration",  sideEffects: "network" },
  { prefix: "server:renderer:",      category: "packaging",     subsystem: "console", owner: "frontend", tier: "unit",       sideEffects: "build-output" },
  { prefix: "server:browser:",       category: "packaging",     subsystem: "console", owner: "frontend", tier: "integration",  sideEffects: "network" },
  { prefix: "test:",                 category: "test",          subsystem: "tests",     owner: "platform",  tier: "integration",  sideEffects: "runtime-data" },
  { prefix: "contract:",             category: "test",          subsystem: "module-system", owner: "platform", tier: "integration", sideEffects: "none" },
  { prefix: "repo:",                 category: "hygiene",       subsystem: "scripts",   owner: "platform",  tier: "hygiene",      sideEffects: "none" },
  { prefix: "security:",             category: "hygiene",       subsystem: "core",      owner: "platform",  tier: "hygiene",      sideEffects: "none" },
  { prefix: "metadata:",             category: "version-control", subsystem: "core",    owner: "platform",  tier: "hygiene",      sideEffects: "runtime-data" },
  { prefix: "version:",              category: "version-control", subsystem: "core",    owner: "platform",  tier: "hygiene",      sideEffects: "none" },
  { prefix: "server:benchmark:",     category: "test",          subsystem: "server",    owner: "platform",  tier: "integration",  sideEffects: "runtime-data" },
  { prefix: "verify:",               category: "verifier",      subsystem: "tools",     owner: "platform",  tier: "hygiene",      sideEffects: "none" },
  { prefix: "console:",              category: "verifier",      subsystem: "console",   owner: "frontend",  tier: "hygiene",      sideEffects: "none" },
  { prefix: "mcp:",                  category: "mcp-installer", subsystem: "gateway",   owner: "platform",  tier: "integration",  sideEffects: "none" },
  { prefix: "release:",              category: "packaging",     subsystem: "tools",     owner: "platform",  tier: "release",      sideEffects: "none" },
  { prefix: "docs:",                 category: "maintenance",   subsystem: "docs",      owner: "platform",  tier: "hygiene",      sideEffects: "none" },
  { prefix: "vitest",                category: "test",          subsystem: "tests",     owner: "platform",  tier: "unit",         sideEffects: "none" },
  { prefix: "setup",                 category: "maintenance",   subsystem: "runtime",   owner: "platform",  tier: "integration",  sideEffects: "runtime-data" },
  { prefix: "dev",                   category: "startup",       subsystem: "tools",     owner: "platform",  tier: "integration",  sideEffects: "runtime-data" },
  { prefix: "build",                 category: "packaging",     subsystem: "tools",     owner: "platform",  tier: "release",      sideEffects: "build-output" },
]);

/**
 * Returns a partial ScriptEntry for scripts matched by pattern classification.
 * Returns null if no pattern matches.
 */
function _classifyByPattern(scriptName) {
  if (!PATTERN_CLASSIFIED_SCRIPT_NAME_SET.has(scriptName)) {
    return null;
  }
  for (const pattern of SCRIPT_CLASSIFICATION_PATTERNS) {
    if (scriptName.startsWith(pattern.prefix)) {
      return {
        scriptName,
        command: `npm run ${scriptName}`,
        category: pattern.category,
        subsystem: pattern.subsystem,
        owner: pattern.owner,
        tier: pattern.tier,
        sideEffects: pattern.sideEffects,
        requiresFreshContainer: pattern.sideEffects === "docker",
        ciProfile: pattern.tier === "external" ? "external" : pattern.tier === "hygiene" ? "hygiene" : "core",
        expectedDurationClass: "standard",
        inputs: [],
        outputs: [],
      };
    }
  }
  return null;
}

// All known script names (registry + allowlist)
const _knownScripts = new Set([
  ...Object.keys(SCRIPT_REGISTRY),
  ...UNCLASSIFIED_ALLOWLIST,
  ...PATTERN_CLASSIFIED_SCRIPT_NAMES,
]);

export function isClassified(scriptName) {
  return _knownScripts.has(scriptName);
}

export function getCategory(scriptName) {
  const entry = SCRIPT_REGISTRY[scriptName];
  if (entry) return entry.category;
  const patternEntry = _classifyByPattern(scriptName);
  return patternEntry?.category || null;
}

/**
 * Returns the ScriptEntry for a given script name.
 * For explicit entries, returns the SCRIPT_REGISTRY entry with the real
 * package.json command filled in (replacing "npm run <name>" placeholders).
 * For pattern-classified entries, fills in the real package.json command.
 *
 * @param {string} scriptName
 * @param {Record<string, string>} [packageScripts] - package.json#scripts for filling real commands
 * @returns {ScriptEntry|null}
 */
export function getEntry(scriptName, packageScripts) {
  const entry = SCRIPT_REGISTRY[scriptName];
  if (entry) {
    // Fill real command if the registry uses the "npm run <scriptName>" placeholder
    if (packageScripts && packageScripts[scriptName] && entry.command === `npm run ${scriptName}`) {
      return { ...entry, command: packageScripts[scriptName] };
    }
    return entry;
  }
  const patternEntry = _classifyByPattern(scriptName);
  if (patternEntry && packageScripts && packageScripts[scriptName]) {
    // Fill real package.json command instead of the generic placeholder
    patternEntry.command = packageScripts[scriptName];
  }
  return patternEntry;
}

/**
 * Returns the source-declared registry entry without projecting package.json's
 * executable command into it. Verification uses this view so a malformed raw
 * command alias cannot be hidden by getEntry().
 */
export function getDeclaredEntry(scriptName) {
  return SCRIPT_REGISTRY[scriptName] || _classifyByPattern(scriptName);
}

/**
 * Returns scripts filtered by tier.
 * @param {string} tier
 * @returns {ScriptEntry[]}
 */
export function scriptsByTier(tier) {
  return Object.values(SCRIPT_REGISTRY).filter((s) => s.tier === tier);
}

/**
 * Returns scripts filtered by sideEffects kind.
 * @param {string[]} excludeKinds
 * @returns {ScriptEntry[]}
 */
export function scriptsExcludingSideEffects(excludeKinds) {
  const excludeSet = new Set(excludeKinds);
  return Object.values(SCRIPT_REGISTRY).filter((s) => !excludeSet.has(s.sideEffects));
}

/**
 * Returns scripts that require a fresh container.
 * @returns {ScriptEntry[]}
 */
export function scriptsRequiringFreshContainer() {
  const registryEntries = Object.values(SCRIPT_REGISTRY).filter((s) => s.requiresFreshContainer);
  // Also include pattern-classified entries
  for (const pattern of SCRIPT_CLASSIFICATION_PATTERNS) {
    if (pattern.sideEffects === "docker") {
      registryEntries.push({
        scriptName: `${pattern.prefix}*`,
        command: `npm run ${pattern.prefix}*`,
        category: pattern.category,
        subsystem: pattern.subsystem,
        owner: pattern.owner,
        tier: pattern.tier,
        sideEffects: pattern.sideEffects,
        requiresFreshContainer: true,
        ciProfile: "external",
        expectedDurationClass: "extended",
        inputs: [],
        outputs: [],
      });
    }
  }
  return registryEntries;
}

/**
 * Generates a JSON snapshot suitable for CI artifacts.
 * Fills real commands from package.json where available.
 * @param {Record<string, string>} [packageScripts] - package.json#scripts for filling real commands
 * @returns {object}
 */
export function generateScriptRegistrySnapshot(packageScripts) {
  const pkgScripts = packageScripts || {};

  return {
    schemaVersion: "v0.0.1:registry:script-catalog-0.2.0",
    generatedAt: new Date().toISOString(),
    scriptCount: Object.keys(SCRIPT_REGISTRY).length,
    categoryCount: Object.keys(SCRIPT_CATEGORIES).length,
    entries: Object.values(SCRIPT_REGISTRY).map((s) => ({
      scriptName: s.scriptName,
      category: s.category,
      subsystem: s.subsystem,
      owner: s.owner,
      tier: s.tier,
      sideEffects: s.sideEffects,
      requiresFreshContainer: s.requiresFreshContainer,
      ciProfile: s.ciProfile,
      expectedDurationClass: s.expectedDurationClass,
      command: pkgScripts[s.scriptName] || s.command,
      registryCommand: s.command,
      commandMatch: pkgScripts[s.scriptName] ? (pkgScripts[s.scriptName] === s.command ? "ok" : "mismatch") : "no-package-entry",
    })),
  };
}
