#!/usr/bin/env node
/**
 * verify-test-suite-scripts.ts
 *
 * Validates test suite registry consistency by importing the suite-registry
 * module directly (no regex parsing of source code).
 *
 * Checks:
 * 1. No duplicate suite IDs
 * 2. Every npm script referenced by a suite exists in package.json#scripts
 * 3. Every profile references only known suite IDs
 * 4. The canonical "core-public" profile exists (required by npm test)
 *
 * Part of the npm test core-public profile and test:audit.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot: any = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const testRegistry: any = JSON.parse(
  await fs.readFile(path.join(repoRoot, "tools/registry/tests.registry.json"), "utf8")
);
const SUITES: any = testRegistry.suites || [];
const PROFILES: any = Object.fromEntries(
  (Object.entries(testRegistry.profiles || {}) as [string, any][]).map(([name, def]: any[]) : any => [name, def.suites || []])
);
const suiteById: any = new Map<any, any>(SUITES.map((suite?: any) : any => [suite.id, suite]));

function generateRegistrySnapshot() : any {
  return testRegistry;
}

const packageJson: any = JSON.parse(
  await fs.readFile(path.join(repoRoot, "package.json"), "utf8")
);

const scripts: any = packageJson.scripts || {};

let issues: any = 0;

// ── Check 1: No duplicate suite IDs ──────────────────────────────────────────
console.log("1. Checking for duplicate suite IDs...");
const seenIds: any = new Set<any>();
const duplicates: any[] = [];
for (const suite of SUITES) {
  if (seenIds.has(suite.id)) {
    duplicates.push(suite.id);
  }
  seenIds.add(suite.id);
}
if (duplicates.length > 0) {
  console.error(`  DUPLICATE suite IDs: ${duplicates.join(", ")}`);
  issues += duplicates.length;
} else {
  console.log("   OK: All suite IDs are unique");
}

// ── Check 2: Every npm script referenced exists ──────────────────────────────
console.log("2. Checking npm script references...");
const missingScripts: any = new Set<any>();
for (const suite of SUITES) {
  if (!suite.command || !Array.isArray(suite.args)) {
    missingScripts.add(`${suite.id}:<missing-command>`);
    continue;
  }
  if (suite.command.endsWith("npm") || suite.command.endsWith("npm.cmd")) {
    const runIdx: any = suite.args.indexOf("run");
    if (runIdx >= 0 && runIdx + 1 < suite.args.length) {
      const scriptName: any = suite.args[runIdx + 1];
      if (scriptName && !scripts[scriptName]) {
        missingScripts.add(scriptName);
      }
    }
  }
}
if (missingScripts.size > 0) {
  console.error(`  MISSING npm scripts: ${[...missingScripts].join(", ")}`);
  issues += missingScripts.size;
} else {
  console.log("   OK: All npm script references resolve");
}

// ── Check 3: Every profile references only known suite IDs ───────────────────
console.log("3. Checking profile references...");
const allSuiteIds: any = new Set<any>(SUITES.map((s?: any) : any => s.id));
const unknownProfileRefs: any[] = [];
for (const [profileName, ids] of (Object.entries(PROFILES) as [string, any][])) {
  for (const id of ids) {
    if (!allSuiteIds.has(id)) {
      unknownProfileRefs.push({ profile: profileName, id });
    }
  }
}
if (unknownProfileRefs.length > 0) {
  console.error(`  UNKNOWN profile references:`);
  for (const ref of unknownProfileRefs) {
    console.error(`    profile "${ref.profile}" references unknown suite: ${ref.id}`);
  }
  issues += unknownProfileRefs.length;
} else {
  console.log("   OK: All profile references are valid");
}

// ── Check 4: Canonical core-public profile exists ────────────────────────────
console.log("4. Checking core-public profile exists...");
if (!PROFILES["core-public"]) {
  console.error("  MISSING core-public profile — required by npm test");
  issues++;
} else {
  console.log(`   OK: core-public profile has ${PROFILES["core-public"].length} direct suites`);
}

// ── Generate registry snapshot for CI artifacts ──────────────────────────────
const reportDir: any = path.join(repoRoot, "build", "reports");
await fs.mkdir(reportDir, { recursive: true });
const snapshot: any = generateRegistrySnapshot();
await fs.writeFile(
  path.join(reportDir, "test-suite-registry.json"),
  JSON.stringify(snapshot, null, 2),
  "utf8"
);
console.log(`   Generated build/reports/test-suite-registry.json`);

// ── Summary ──────────────────────────────────────────────────────────────────
console.log("");
if (issues === 0) {
  console.log(`Test suite scripts verified: ${SUITES.length} suites, ${Object.keys(PROFILES).length} profiles`);
} else {
  console.error(`Test suite registry verification: FAILED (${issues} issue(s))`);
  process.exitCode = 1;
}
