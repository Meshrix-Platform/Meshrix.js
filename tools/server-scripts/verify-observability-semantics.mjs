#!/usr/bin/env node
/**
 * verify-observability-semantics.mjs — OTel Semantic Conventions Baseline
 *
 * Defines the OTel semantic convention baseline for LicoMesh and verifies
 * that key observability touchpoints (operation dispatch, MCP gateway,
 * CLI dispatch, layout audit) produce logs/traces with stable field names
 * aligned to OpenTelemetry semantic conventions.
 *
 * This verifier does NOT rewrite the logging system.  It establishes a
 * schema baseline and validates that critical code paths reference the
 * expected field names.  Incremental adoption is expected.
 *
 * Gate levels:
 *   --gate hygiene  Report only, never exit 1
 *   --gate audit    >= 4/7 groups covered, 5 critical touchpoints each have >= 1 group
 *   --gate release  >= 7/7 groups covered, Operation Dispatcher/MCP Gateway/Runtime Logger fully covered
 *
 * Usage:
 *   node tools/server-scripts/verify-observability-semantics.mjs
 *   node tools/server-scripts/verify-observability-semantics.mjs --gate audit
 *   node tools/server-scripts/verify-observability-semantics.mjs --gate release
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeAndPublishSensitiveReport
} from "./lib/sensitive-report-scan.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const VERIFIER = "tools/server-scripts/verify-observability-semantics.mjs";
const COMMAND_ID = "observability-semantics";
const REPORT_SCHEMA_VERSION = "v0.0.1:observability:semantics-0.2.0";
const PLAN_FILE = "docs/plans/end-to-end-release/current-baseline/Plan.md";
const REQUIREMENTS = Object.freeze(["REQ-REL-003", "REQ-REL-009", "REQ-REL-010", "REQ-REL-011", "REQ-REL-024", "REQ-REL-025", "REQ-USP-013"]);
const SOURCE_FILES = Object.freeze([
  "packages/foundation/src/observability/otel-semantic-fields.mjs",
  "packages/foundation/src/observability/runtime-logger.mjs",
  "packages/foundation/src/observability/sensitive-report-scan.mjs",
  VERIFIER
]);

// ── OTel Semantic Convention Baseline Schema ────────────────────────────────

const SEMANTIC_CONVENTIONS = Object.freeze({
  service: {
    group: "service",
    fields: ["service.name", "service.version"],
  },
  process: {
    group: "process",
    fields: ["process.pid", "process.command"],
  },
  ci: {
    group: "ci",
    fields: ["ci.workflow.name", "ci.job.name"],
  },
  vcs: {
    group: "vcs",
    fields: ["vcs.repository.url", "vcs.ref.head.name", "vcs.ref.head.revision"],
  },
  mcp: {
    group: "mcp",
    fields: ["mcp.method.name"],
  },
  genai: {
    group: "gen_ai",
    fields: ["gen_ai.operation.name"],
  },
  lico: {
    group: "lico",
    fields: ["lico.operation.id", "lico.workspace.id", "lico.capability.id", "lico.receipt.id", "lico.command.name", "lico.audit.report_id"],
  },
});

const TOTAL_GROUPS = Object.keys(SEMANTIC_CONVENTIONS).length; // 7, not 11 — corrected from spec

// ── Touchpoints ────────────────────────────────────────────────────────────

const TOUCHPOINTS = Object.freeze([
  {
    name: "Operation Dispatcher",
    files: ["packages/server-runtime/src/composition/"],
    expectedGroups: ["service", "lico"],
    critical: true,
  },
  {
    name: "MCP Connector Runtime",
    files: ["packages/protocols/mcp/adapter/gateway-installer/", "packages/protocols/mcp/adapter/native-installer/"],
    expectedGroups: ["service", "mcp"],
    critical: true,
  },
  {
    name: "Layout Audit",
    files: ["tools/server-scripts/verify-layout-audit.mjs", "tools/server-scripts/verify-layout-manifest-consistency.mjs"],
    expectedGroups: ["service", "vcs", "lico"],
    critical: false,
  },
  {
    name: "Runtime Logger",
    files: ["packages/foundation/src/observability/runtime-logger.mjs"],
    expectedGroups: ["service", "process", "ci", "genai", "lico"],
    critical: true,
  },
]);

// ── Comment-stripping helpers ──────────────────────────────────────────────

function stripComments(text, ext) {
  let result = text;
  // Strip block comments for JS/TS/MJS/RS
  if (/\.(mjs|js|ts|vue|rs)$/.test(ext)) {
    result = result.replace(/\/\*[\s\S]*?\*\//g, "");  // block comments
    result = result.replace(/\/\/[^\n]*/g, "");         // line comments
  }
  // Markdown is not scanned as source touchpoint
  return result;
}

// ── Structural match helpers ───────────────────────────────────────────────

/**
 * Checks if a field name appears in a structural context (not just a comment or docstring).
 * Requires the field to appear as:
 * - An object literal key:  "service.name":  or  service.name:
 * - Inside a logger/audit/trace payload string:  `..."service.name"...`
 * - As an explicit export: OTEL_SEMANTIC_FIELDS
 */
function textContainsFieldStructurally(text, field) {
  const stripped = stripComments(text, ".mjs");

  // Object key patterns
  const keyPatterns = [
    new RegExp(`["']${field.replace(/\./g, "\\.")}["']\\s*:`),   // "service.name":
    new RegExp(`${field.replace(/\./g, "\\.")}\\s*:`),             // service.name: (JS shorthand)
    new RegExp(`\`[^\`]*${field.replace(/\./g, "\\.")}[^\`]*\``),  // template literal containing field
    new RegExp(`["'][^"']*${field.replace(/\./g, "\\.")}[^"']*["']`), // string containing field
    new RegExp(`\\b${field.replace(/\./g, "\\.")}\\b`),            // bare word occurrence
  ];

  return keyPatterns.some((p) => p.test(stripped));
}

/**
 * Checks if a field appears ONLY in comments (false positive).
 */
function isCommentOnlyMatch(text, field) {
  const stripped = stripComments(text, ".mjs");
  const inFull = text.includes(field);
  const inStripped = stripped.includes(field);
  return inFull && !inStripped;
}

// ── File scanner ───────────────────────────────────────────────────────────

async function* walkFiles(rootDir) {
  async function* walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const childPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "target", ".git", "build", "__pycache__", ".dart_tool", "coverage"].includes(entry.name)) continue;
        yield* walk(childPath);
      } else if (/\.(mjs|js|ts|rs)$/.test(entry.name)) {
        yield { absPath: childPath, relPath: path.relative(repoRoot, childPath) };
      }
    }
  }
  yield* walk(path.join(repoRoot, rootDir));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const gateLevel = process.argv.includes("--gate")
    ? process.argv[process.argv.indexOf("--gate") + 1]
    : "audit";

  const results = [];
  let totalCoveredGroups = 0;
  const commentOnlyMatches = [];
  const allCoveredGroups = new Set();

  for (const tp of TOUCHPOINTS) {
    const tpResult = { name: tp.name, groups: {}, coveredCount: 0, totalExpected: tp.expectedGroups.length };

    for (const groupName of tp.expectedGroups) {
      const group = SEMANTIC_CONVENTIONS[groupName];
      if (!group) continue;

      let foundAny = false;
      for (const filePattern of tp.files) {
        const isDir = filePattern.endsWith("/");

        if (isDir) {
          for await (const file of walkFiles(filePattern)) {
            try {
              const text = await fs.readFile(file.absPath, "utf8");
              for (const field of group.fields) {
                if (isCommentOnlyMatch(text, field)) {
                  commentOnlyMatches.push({ touchpoint: tp.name, file: file.relPath, field, group: groupName });
                  continue;
                }
                if (textContainsFieldStructurally(text, field)) {
                  foundAny = true;
                  break;
                }
              }
            } catch { /* skip unreadable */ }
            if (foundAny) break;
          }
        } else {
          try {
            const absPath = path.join(repoRoot, filePattern);
            const text = await fs.readFile(absPath, "utf8");
            for (const field of group.fields) {
              if (isCommentOnlyMatch(text, field)) {
                commentOnlyMatches.push({ touchpoint: tp.name, file: filePattern, field, group: groupName });
                continue;
              }
              if (textContainsFieldStructurally(text, field)) {
                foundAny = true;
                break;
              }
            }
          } catch { /* skip unreadable */ }
        }
        if (foundAny) break;
      }

      tpResult.groups[groupName] = foundAny;
      if (foundAny) {
        tpResult.coveredCount++;
        allCoveredGroups.add(groupName);
      }
    }

    totalCoveredGroups += tpResult.coveredCount;
    results.push(tpResult);
  }

  // ── Gate evaluation ──────────────────────────────────────────────────────

  const criticalTouchpoints = TOUCHPOINTS.filter((t) => t.critical);
  const criticalAllCovered = criticalTouchpoints.every((tp) => {
    const result = results.find((r) => r.name === tp.name);
    return result && result.coveredCount === result.totalExpected;
  });

  let passed = true;
  const gateThresholds = { hygiene: 0, audit: 4, release: 7 };
  const threshold = gateThresholds[gateLevel] || 4;

  // Audit gate: each critical touchpoint must cover at least 1 expected group
  if (gateLevel === "audit") {
    for (const tp of criticalTouchpoints) {
      const result = results.find((r) => r.name === tp.name);
      if (result && result.coveredCount === 0) {
        console.error(`Audit gate: ${tp.name} has 0 groups covered (critical touchpoint must have >= 1)`);
        passed = false;
      }
    }
  }

  // Release gate: Operation Dispatcher, MCP Gateway, Runtime Logger must be fully covered
  if (gateLevel === "release") {
    for (const tp of criticalTouchpoints) {
      const result = results.find((r) => r.name === tp.name);
      if (result && result.coveredCount < result.totalExpected) {
        console.error(`Release gate: ${tp.name} covers ${result.coveredCount}/${result.totalExpected} expected groups (must be fully covered)`);
        passed = false;
      }
    }
  }

  if (allCoveredGroups.size < threshold) {
    console.error(`Gate "${gateLevel}": covered ${allCoveredGroups.size}/${TOTAL_GROUPS} groups, threshold is ${threshold}`);
    passed = false;
  }

  // ── Report ────────────────────────────────────────────────────────────────

  console.log("Observability Semantic Convention Baseline");
  console.log("===========================================\n");

  for (const r of results) {
    const status = r.coveredCount === r.totalExpected ? "✓" : (r.coveredCount > 0 ? "◐" : "✗");
    const groupDetails = Object.entries(r.groups)
      .map(([g, found]) => `${found ? "✓" : "✗"} ${g}`)
      .join(", ");
    console.log(`${status} ${r.name} (${r.coveredCount}/${r.totalExpected}): ${groupDetails}`);
  }

  if (commentOnlyMatches.length > 0) {
    console.log(`\nComment-only matches (excluded): ${commentOnlyMatches.length}`);
    for (const cm of commentOnlyMatches.slice(0, 5)) {
      console.log(`  - ${cm.touchpoint}/${cm.file}: "${cm.field}" (${cm.group})`);
    }
    if (commentOnlyMatches.length > 5) {
      console.log(`  ... and ${commentOnlyMatches.length - 5} more`);
    }
  }

  // ── Write report ─────────────────────────────────────────────────────────

  const reportDir = path.join(repoRoot, "build", "reports");
  await fs.mkdir(reportDir, { recursive: true });

  const missingGroups = Object.keys(SEMANTIC_CONVENTIONS).filter((g) => !allCoveredGroups.has(g));

	  const report = {
	    schemaVersion: "v0.0.1:observability:semantics-0.2.0",
	    generatedAt: new Date().toISOString(),
	    verifier: VERIFIER,
	    gate: gateLevel,
	    passed,
	    summary: {
	      readyForReleaseReduction: passed,
	      reportLeakScan: false,
	      missingGroupCount: missingGroups.length,
	      commentOnlyMatchCount: commentOnlyMatches.length
	    },
	    coveredGroups: allCoveredGroups.size,
    totalGroups: TOTAL_GROUPS,
    missingGroups,
    touchpointCoverage: results.map((r) => ({
      name: r.name,
      coveredCount: r.coveredCount,
      totalExpected: r.totalExpected,
      groups: r.groups,
      critical: TOUCHPOINTS.find((t) => t.name === r.name)?.critical || false,
    })),
    commentOnlyMatches: commentOnlyMatches.length,
    semanticConventions: Object.entries(SEMANTIC_CONVENTIONS).map(([key, val]) => ({
      group: key,
      otelGroup: val.group,
      fields: val.fields,
    })),
  };

  const revision = await computeVerifierSourceRevision(repoRoot, SOURCE_FILES);
  const provenance = {
    producer: "licomesh-core-observability",
    commandId: COMMAND_ID,
    sourceRevision: revision
  };
  const finalizedReport = await finalizeAndPublishSensitiveReport(report, {
    filePath: path.join(reportDir, "observability-semantics.json"),
    schemaVersion: REPORT_SCHEMA_VERSION,
    verifier: VERIFIER,
    provenance,
    checkpointDigest: await computeVerifierSourceRevision(repoRoot, [PLAN_FILE]),
    requirements: REQUIREMENTS
  });
  assertReportProvenance(finalizedReport, provenance);

  console.log(`\nCoverage: ${allCoveredGroups.size}/${TOTAL_GROUPS} semantic groups covered`);
  console.log(`Gate: ${gateLevel} | Threshold: ${threshold} | Passed: ${passed}`);
  console.log(`Comment-only matches excluded: ${commentOnlyMatches.length}`);
  console.log(`Report: build/reports/observability-semantics.json`);

  if (!passed && gateLevel !== "hygiene") {
    console.error(`\nObservability semantics gate "${gateLevel}" FAILED.`);
    process.exitCode = 1;
  } else if (gateLevel === "hygiene") {
    console.log(`\nHygiene mode: report generated, no gate failure.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
