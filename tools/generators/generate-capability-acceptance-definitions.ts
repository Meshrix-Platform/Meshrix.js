#!/usr/bin/env node
/**
 * Generate capability acceptance state-machine definitions and their registry
 * from the tracked capability checkpoint authorities.
 *
 * Usage:
 *   node tools/generators/generate-capability-acceptance-definitions.ts
 *   node tools/generators/generate-capability-acceptance-definitions.ts --check
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname: any = path.dirname(fileURLToPath(import.meta.url));
const ROOT: any = path.resolve(__dirname, "../..");
const CHECKPOINT_ROOT: any = path.resolve(ROOT, "tools/registry/capability-acceptance-checkpoints");
const OUTPUT_DIR: any = path.resolve(
  ROOT,
  "packages/foundation/src/workflow/state-machine/definitions/acceptance"
);
const REGISTRY_PATH: any = path.resolve(ROOT, "tools/registry/capability-acceptance.registry.json");
const GENERATED_COMMENT: any =
  "GENERATED - DO NOT EDIT MANUALLY. Source: tools/generators/generate-capability-acceptance-definitions.ts and tools/registry/capability-acceptance-checkpoints/*.json";
const REGISTRY_VERSION: any = "v0.0.1:registry:capability-acceptance-4";
const GENERATED_AT: any = "1970-01-01T00:00:00.000Z";
const CAPABILITY_SLUG_PATTERN: any =
  /^(?![a-z0-9-]*(?:legacy|compat|v[0-9]+))[a-z](?:[a-z0-9-]*[a-z0-9])?$/u;

const PLUGIN_RUNTIME_CAPABILITY_BINDINGS: Readonly<Record<string, any>> = Object.freeze({
  "model-gateway-service": Object.freeze({ pluginIds: Object.freeze(["model-gateway"]) }),
  "plugin-runtime-and-module-system": Object.freeze({
    aggregate: true,
    pluginIds: Object.freeze(["external-gateway", "shared-space", "skill-hub"])
  })
});

const DETACHABLE_CORE_CAPABILITIES: Readonly<Record<string, any>> = Object.freeze({
  "model-gateway-service": "model-gateway",
  "strategy-management": "strategy-management"
});

const DETACHABLE_GOVERNANCE_EVIDENCE_COMMANDS: Readonly<Record<string, any>> = Object.freeze({
  "model-gateway-service": Object.freeze([
    "model-gateway-service",
    "model-gateway-routing",
    "model-gateway-admission",
    "model-gateway-usage-accounting"
  ]),
  "strategy-management": Object.freeze([
    "strategy-management",
    "operation-permission-protocol-consistency"
  ])
});

const EXTERNAL_PLUGIN_CAPABILITIES: any = new Set<any>();

const STATES: readonly any[] = Object.freeze([
  { id: "planned", label: "Planned" },
  { id: "implemented", label: "Implemented" },
  { id: "verified", label: "Verified For Platform Reduction", terminal: true },
  { id: "blocked", label: "Blocked" },
  { id: "failed", label: "Failed" }
]);

const EVENTS: readonly any[] = Object.freeze([
  { id: "code_and_docs_complete", label: "Code And Docs Complete", riskLevel: "medium" },
  { id: "capability_verifiers_pass", label: "Capability Verifiers Pass", riskLevel: "high" },
  { id: "required_authority_missing", label: "Required Authority Missing", riskLevel: "low" },
  { id: "invariant_or_security_failure", label: "Invariant Or Boundary Failure", riskLevel: "medium" },
  { id: "evidence_rejected", label: "Evidence Rejected", riskLevel: "medium" },
  { id: "external_evidence_missing", label: "External Evidence Missing", riskLevel: "low" },
  { id: "plan_reopened", label: "Plan Reopened", riskLevel: "low" },
  { id: "fix_required", label: "Fix Required", riskLevel: "low" }
]);

const LEGAL_TRANSITIONS: Readonly<Record<string, any>> = Object.freeze({
  "planned::code_and_docs_complete": "implemented",
  "planned::required_authority_missing": "blocked",
  "planned::external_evidence_missing": "blocked",
  "implemented::capability_verifiers_pass": "verified",
  "implemented::invariant_or_security_failure": "failed",
  "implemented::evidence_rejected": "failed",
  "implemented::external_evidence_missing": "blocked",
  "blocked::plan_reopened": "planned",
  "failed::fix_required": "planned"
});

const IDEMPOTENT_TRANSITIONS: any = new Set<any>([
  "implemented::code_and_docs_complete",
  "verified::capability_verifiers_pass"
]);

function toPosixRelative(filePath?: any) : any {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function titleFromSlug(slug?: any) : any {
  return slug
    .split("-")
    .map((part?: any) : any => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function checkpointFiles() : any {
  return fs.readdirSync(CHECKPOINT_ROOT)
    .filter((name?: any) : any => name.endsWith(".json"))
    .map((name?: any) : any => path.join(CHECKPOINT_ROOT, name))
    .filter((entry?: any) : any => fs.statSync(entry).isFile())
    .sort((left?: any, right?: any) : any => path.basename(left).localeCompare(path.basename(right)));
}

function transitionCell(from?: any, event?: any) : any {
  const key: any = `${from}::${event}`;
  const to: any = LEGAL_TRANSITIONS[key];
  if (to) {
    const cell: Record<string, any> = {
      from,
      event,
      result: "legal_transition",
      to
    };
    if (key === "implemented::capability_verifiers_pass") {
      cell.result = "requires_external_receipt";
      cell.sideEffects = ["verification_report_receipt"];
    }
    if (from === "blocked" && event === "plan_reopened") {
      cell.allowedReopenTransition = true;
    }
    if (from === "failed" && event === "fix_required") {
      cell.allowedReopenTransition = true;
    }
    return cell;
  }
  if (IDEMPOTENT_TRANSITIONS.has(key)) {
    return { from, event, result: "ignored_idempotent_event" };
  }
  return {
    from,
    event,
    result: "illegal_transition",
    errorCode: "CAPABILITY_ACCEPTANCE_INVALID_TRANSITION"
  };
}

function totalMatrix() : any {
  const cells: any[] = [];
  for (const state of STATES) {
    for (const event of EVENTS) {
      cells.push(transitionCell(state.id, event.id));
    }
  }
  return cells;
}

function buildDefinition(slug?: any) : any {
  if (!CAPABILITY_SLUG_PATTERN.test(slug)) {
    throw new Error(`Capability acceptance slug must be lowercase kebab-case: ${slug}`);
  }
  const registryPath: any = "tools/registry/capability-acceptance.registry.json";
  const checkpointPath: any = `tools/registry/capability-acceptance-checkpoints/${slug}.json`;
  const reportPath: any = `build/reports/capability-acceptance-machines.json`;
  const machineId: any = `acceptance.${slug}`;
  const title: any = titleFromSlug(slug);
  return {
    "$comment": GENERATED_COMMENT,
    machineId,
    entityType: "capability_acceptance",
    version: `v0.0.1:state-machine:capability-acceptance-${slug}-3`,
    description: `Local verification lifecycle for the ${title} capability. Verified is evidence for, not a declaration by, the platform release reducer.`,
    initialState: "planned",
    states: STATES,
    events: EVENTS,
    totalMatrix: totalMatrix(),
    invariants: [
      "SM-ACCEPTANCE-SINGLE-MACHINE-PER-CAPABILITY",
      "SM-ACCEPTANCE-IMPLEMENTATION-BEFORE-FINAL-VALIDATION",
      "SM-ACCEPTANCE-RELEASE-REDUCER-OWNS-FINAL-READINESS",
      "SM-GOV-PRIVACY-SAFE-EVIDENCE"
    ],
    proofObligations: [
      "PO-ACCEPTANCE-REGISTRY-LINK",
      "PO-ACCEPTANCE-CHECKPOINT-IMPLEMENTATION",
      "PO-ACCEPTANCE-FINAL-VALIDATION",
      "PO-ACCEPTANCE-PLATFORM-REDUCER-BOUNDARY",
      "PO-ACCEPTANCE-PRIVACY-SAFE-EVIDENCE"
    ],
    proofMappings: [
      {
        obligationId: "PO-ACCEPTANCE-REGISTRY-LINK",
        method: "registry_entry_matches_machine",
        params: { registryPath, capabilityId: slug, machineId }
      },
      {
        obligationId: "PO-ACCEPTANCE-CHECKPOINT-IMPLEMENTATION",
        method: "checkpoint_role_exists",
        params: { checkpointPath, role: "implementation" }
      },
      {
        obligationId: "PO-ACCEPTANCE-FINAL-VALIDATION",
        method: "checkpoint_role_exists",
        params: { checkpointPath, role: "final_validation" }
      },
      {
        obligationId: "PO-ACCEPTANCE-PLATFORM-REDUCER-BOUNDARY",
        method: "external_platform_reducer_reference",
        params: { platformReducerCommand: "npm run verify:acceptance", capabilityReportPath: reportPath }
      },
      {
        obligationId: "PO-ACCEPTANCE-PRIVACY-SAFE-EVIDENCE",
        method: "report_leak_scan",
        params: { reportPath }
      }
    ],
    acceptance: {
      capabilityId: slug,
      registryPath,
      checkpointPath,
      platformReducerCommand: "npm run verify:acceptance",
      verifier: "tools/server-scripts/verify-capability-acceptance-machines.ts",
      reportPath
    }
  };
}

function buildRegistryEntry(slug?: any) : any {
  const pluginRuntime: any = PLUGIN_RUNTIME_CAPABILITY_BINDINGS[slug];
  const detachableFeatureId: any = DETACHABLE_CORE_CAPABILITIES[slug];
  const capabilityClass: any = EXTERNAL_PLUGIN_CAPABILITIES.has(slug)
    ? "external-plugin"
    : detachableFeatureId
      ? "detachable-core"
      : "core";
  return {
    capabilityId: slug,
    capabilityClass,
    releaseScope: capabilityClass === "core"
      ? "core-release"
      : "optional-support-matrix",
    ...(detachableFeatureId ? { activationFeatureId: detachableFeatureId } : {}),
    ...(DETACHABLE_GOVERNANCE_EVIDENCE_COMMANDS[slug]
      ? { governedEvidenceCommandIds: DETACHABLE_GOVERNANCE_EVIDENCE_COMMANDS[slug] }
      : {}),
    checkpointPath: `tools/registry/capability-acceptance-checkpoints/${slug}.json`,
    acceptanceMachineId: `acceptance.${slug}`,
    definitionPath: `packages/foundation/src/workflow/state-machine/definitions/acceptance/${slug}.json`,
    verifier: "tools/server-scripts/verify-capability-acceptance-machines.ts",
    reportPath: "build/reports/capability-acceptance-machines.json",
    platformReducerCommand: "npm run verify:acceptance",
    ...(pluginRuntime ? { pluginRuntime } : {})
  };
}

function buildRegistry(slugs?: any) : any {
  const entries: any = slugs.map(buildRegistryEntry);
  return {
    "$schema": "./schema/capability-acceptance.schema.json",
    "$comment": GENERATED_COMMENT,
    version: REGISTRY_VERSION,
    generatedAt: GENERATED_AT,
    entryCount: entries.length,
    entries
  };
}

function stableStringify(value?: any) : any {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() : any {
  const checkMode: any = process.argv.includes("--check");
  const expectedFiles: any = new Map<any, any>(
    checkpointFiles().map((checkpointPath?: any) : any => {
      const slug: any = path.basename(checkpointPath, ".json");
      return [
        path.join(OUTPUT_DIR, `${slug}.json`),
        stableStringify(buildDefinition(slug))
      ];
    })
  );
  const slugs: any = [...expectedFiles.keys()]
    .map((filePath?: any) : any => path.basename(filePath, ".json"))
    .sort();
  const expectedRegistry: any = stableStringify(buildRegistry(slugs));

  if (checkMode) {
    let stale: any = false;
    const expectedBaseNames: any = new Set<any>([...expectedFiles.keys()].map((filePath?: any) : any => path.basename(filePath)));
    if (fs.existsSync(OUTPUT_DIR)) {
      for (const file of fs.readdirSync(OUTPUT_DIR)) {
        if (file.endsWith(".json") && !expectedBaseNames.has(file)) {
          console.error(`ORPHAN: ${toPosixRelative(path.join(OUTPUT_DIR, file))}`);
          stale = true;
        }
      }
    }
    for (const [filePath, expected] of expectedFiles) {
      if (!fs.existsSync(filePath)) {
        console.error(`MISSING: ${toPosixRelative(filePath)}`);
        stale = true;
        continue;
      }
      const actual: any = fs.readFileSync(filePath, "utf8");
      if (actual !== expected) {
        console.error(`STALE: ${toPosixRelative(filePath)}`);
        stale = true;
      }
    }
    if (!fs.existsSync(REGISTRY_PATH)) {
      console.error(`MISSING: ${toPosixRelative(REGISTRY_PATH)}`);
      stale = true;
    } else if (fs.readFileSync(REGISTRY_PATH, "utf8") !== expectedRegistry) {
      console.error(`STALE: ${toPosixRelative(REGISTRY_PATH)}`);
      stale = true;
    }
    if (stale) {
      console.error("Run: node tools/generators/generate-capability-acceptance-definitions.ts");
      process.exit(1);
    }
    console.log(`OK: ${expectedFiles.size} capability acceptance definitions and registry`);
    return;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const expectedBaseNames: any = new Set<any>([...expectedFiles.keys()].map((filePath?: any) : any => path.basename(filePath)));
  if (fs.existsSync(OUTPUT_DIR)) {
    for (const file of fs.readdirSync(OUTPUT_DIR)) {
      if (file.endsWith(".json") && !expectedBaseNames.has(file)) {
        fs.rmSync(path.join(OUTPUT_DIR, file));
      }
    }
  }
  for (const [filePath, content] of expectedFiles) {
    fs.writeFileSync(filePath, content, "utf8");
  }
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, expectedRegistry, "utf8");
  console.log(`Generated: ${expectedFiles.size} capability acceptance definitions and registry`);
}

main();
