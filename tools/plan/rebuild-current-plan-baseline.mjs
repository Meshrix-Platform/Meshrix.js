#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ENTERPRISE_SINGLE_NODE_PROFILE } from "./plan-dependency-map.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(modulePath), "../..");
const PROFILE = ENTERPRISE_SINGLE_NODE_PROFILE;
const ROOT = "end-to-end-release";
const DELIVERY = `${ROOT}/enterprise-single-node`;
const ACCEPTANCE = `${ROOT}/release-acceptance`;
const RECORDED_AT = new Date().toISOString();

const BASELINE_CAPABILITIES = Object.freeze([
  "UPSTREAM-GATEWAY",
  "DOWNSTREAM-MCP",
  "STRATEGY-MANAGEMENT",
  "ENTERPRISE-GOVERNANCE",
  "CONSOLE-ADMINISTRATION",
  "CONTAINER-DEPLOYMENT",
  "STORAGE",
  "JOBS",
  "EXTERNAL-PLUGIN-PACKAGING-LOADING",
  "AGENT-GATEWAY-MODEL-ROUTING",
  "CORE-WORKSPACE-ASSETS-GOVERNANCE",
]);

const CORE_STAGES = Object.freeze([
  {
    code: "E0",
    slug: "release-truth",
    title: "Release Truth And Candidate Convergence",
    requirement: "REQ-ENT-E0",
    prerequisites: [],
    goal: "Converge release facts, support boundaries, report status, and one auditable candidate.",
    acceptance: "The support matrix exposes only enterprise-single-node, report ownership is classified, and the candidate inventory is auditable.",
    target: "tools/plan/rebuild-current-plan-baseline.mjs",
    commands: ["npm run verify:better-plan"],
    paths: ["docs/plans", "docs/reports", "tools/plan", "tools/server-scripts"],
  },
  {
    code: "E1",
    slug: "offline-dual-architecture",
    title: "Offline Dual-Architecture Compose Artifact",
    requirement: "REQ-ENT-E1",
    prerequisites: ["E0"],
    goal: "Deliver a fully offline Docker Compose artifact for Linux x64 and ARM64.",
    acceptance: "Pinned OCI images, installation dependencies, SBOM, signatures, and inventory verification work without public-network access.",
    target: "docker-compose.yml",
    commands: ["npm run verify:composition-source-package"],
    paths: ["docker-compose.yml", "tools/server-scripts", "packages"],
  },
  {
    code: "E2",
    slug: "production-security-baseline",
    title: "Production Security Baseline",
    requirement: "REQ-ENT-E2",
    prerequisites: ["E1"],
    goal: "Close production TLS, secret protection, startup preflight, and privacy-safe diagnostics.",
    acceptance: "Administrator-mounted TLS materials and protected secrets fail closed, while diagnostics disclose no private runtime data.",
    target: "packages/foundation/src/security",
    commands: ["npm run test:security"],
    paths: ["apps/server/runtime", "packages/foundation/src/security", "packages/server-runtime/src/composition", "tests/vitest/server"],
  },
  {
    code: "E3",
    slug: "emergency-administrator-recovery",
    title: "Emergency Administrator Recovery",
    requirement: "REQ-ENT-E3",
    prerequisites: ["E2"],
    goal: "Provide an audited emergency administrator recovery path and a versioned external-identity port that remain available without an external identity provider.",
    acceptance: "Emergency recovery, disablement, role enforcement, external-identity port failure isolation, and complete audit coverage are proven without requiring an external identity provider.",
    target: "packages/foundation/src/security/auth",
    commands: ["node tools/server-scripts/verify-emergency-administrator-recovery.mjs"],
    paths: ["packages/foundation/src/security/auth", "packages/protocols/http/controllers", "packages/server-runtime/src/composition/console-domain", "tests/vitest/server"],
  },
  {
    code: "E4",
    slug: "backup-and-clean-host-restore",
    title: "Independent Backup And Clean-Host Restore",
    requirement: "REQ-ENT-E4",
    prerequisites: ["E2"],
    goal: "Back up to explicitly configured independent mounted storage and restore on a clean host.",
    acceptance: "Empty backup configuration is non-executable; integrity verification, restore preview, and clean-host recovery are proven.",
    target: "packages/foundation/src/storage",
    commands: ["node tools/server-scripts/verify-storage-production-restore-drill.mjs"],
    paths: ["packages/foundation/src/storage", "packages/server-runtime/src/composition", "tools/server-scripts", "tests/vitest/server"],
  },
  {
    code: "E5",
    slug: "n-minus-one-upgrade-rollback",
    title: "N-1 Upgrade And Failure Rollback",
    requirement: "REQ-ENT-E5",
    prerequisites: ["E4"],
    goal: "Provide preflighted N-1 upgrades with pre-upgrade backup, atomic migration, health validation, and rollback.",
    acceptance: "A failed N-1 upgrade returns the node to the last healthy version without losing governed state.",
    target: "tools/server-scripts/upgrade",
    commands: ["node tools/server-scripts/verify-upgrade-rollback.mjs"],
    paths: ["tools/server-scripts", "packages/foundation/src/storage", "tests/vitest/server"],
  },
  {
    code: "E6",
    slug: "core-operations-observability",
    title: "Core Operations Observability",
    requirement: "REQ-ENT-E6",
    prerequisites: ["E2"],
    goal: "Deliver local health diagnostics, Prometheus metrics, versioned telemetry and notification ports, and integration-state visibility without an external telemetry service.",
    acceptance: "Local diagnostics, Prometheus metrics, optional exporter and notification port isolation, and integration-state visibility work with every external integration disabled or unavailable.",
    target: "packages/foundation/src/observability",
    commands: [
      "node tools/server-scripts/verify-observability-runtime-acceptance.mjs",
      "npm run verify:enterprise-observability-coverage",
      "npm run verify:security-alert-lifecycle",
    ],
    paths: ["packages/foundation/src/observability", "packages/server-runtime/src/composition", "tools/server-scripts", "tests/vitest/server"],
  },
]);

const ADAPTER_RUNTIME_STAGE = Object.freeze({
  code: "A0",
  slug: "adapter-runtime-isolation",
  title: "Adapter Runtime Isolation",
  requirement: "REQ-ENT-A0",
  prerequisites: ["E0"],
  goal: "Provide one supervised asynchronous adapter lifecycle that cannot acquire authority over Core server startup or shutdown.",
  acceptance: "Empty configuration creates no adapter; simulated connect, execution, cancellation, and close failures remain capability-scoped, resource-bounded, privacy-safe, and unable to prevent bounded Core startup or shutdown.",
  target: "packages/server-runtime/src/composition/integration-task-supervisor.mjs",
  commands: ["node tools/server-scripts/verify-integration-task-supervisor.mjs"],
  paths: ["apps/server/runtime", "packages/server-runtime/src/composition", "tests/vitest/server"],
});

const DELIVERY_STAGES = Object.freeze([
  ...CORE_STAGES,
  ADAPTER_RUNTIME_STAGE,
]);
const PARALLEL_STAGES = Object.freeze([ADAPTER_RUNTIME_STAGE]);

const EXISTING_NODE_IDS = Object.freeze({
  scaffold: "0ebfb01b-ff04-4e8a-ab61-cbd493e90668",
  deliveryIntegration: "40310ec4-ad93-4d71-a507-80df9a8f155c",
  acceptanceIntegration: "84e9a3d7-f0b6-47cb-a082-8999b7eb1614",
  rootFinal: "e6881d70-2b3c-49b2-abe3-f743bcd5a3af",
  deliveryFinal: "aca5ebca-d8b2-4688-a1bf-70dc1d2ce8d4",
  e7: "6e093952-2e2f-4680-a915-c1808d99b7cf",
  e7Final: "ca963790-4ff2-4188-a12d-3dc383909f2a",
  E0: "3450427a-f3c9-4813-ab1d-d2259ba64e68",
  E1: "ae223d80-0779-44e7-a504-79327cfd601f",
  E2: "df11642c-fb1d-45fc-aae0-a57cb2eac036",
  E3: "70f36363-b443-42dd-a624-3054bd310a5a",
  E4: "312e50b5-bc67-4147-a651-a82f084b7a75",
  E5: "24b75bb2-dbde-4379-a96e-d069f3d63a8c",
  E6: "160438e7-a4fa-48e1-ad4f-4bdb375189e0",
});

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stableId(label) {
  const digest = sha256(`meshrix-enterprise-single-node:${label}`);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function currentRevision(repoRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  requireCondition(result.status === 0 && result.stdout.trim(), "Current repository revision is unavailable");
  return result.stdout.trim();
}

function commit(message, target, revision) {
  return {
    repository: ".git",
    message,
    target,
    ...(revision ? { delivered: revision } : {}),
  };
}

function criterion(text, checked = false, evidenceRefs = undefined) {
  return { checked, text, ...(evidenceRefs ? { evidence_refs: evidenceRefs } : {}) };
}

function designContract(artifact, ownedPaths, acceptancePaths) {
  return {
    artifact,
    owned_paths: ownedPaths,
    scaffold_paths: ownedPaths,
    acceptance_paths: acceptancePaths,
    symbols: [],
    interfaces: [],
    dependencies: [],
    decisions: {
      composition: "one minimal enterprise operations closure",
      algorithms: "bounded validation with deterministic reduction",
      data_structures: "one supported profile and keyed final receipts",
      state: "Manifest plus one DependencyMap and per-plan checkpoints",
      isolation: "focused verification before the final acceptance regression",
      concurrency: "dependency-based Core nodes plus A0 after E0; concrete third-party adapter plans remain independent",
    },
    test_seams: ["declared regression command and exact receipt boundary"],
  };
}

function pendingNode({
  id,
  role = "implementation",
  prerequisites = [],
  next = [],
  goal,
  description,
  requirements,
  acceptance,
  target,
  command,
  commands,
  scope = "focused",
  paths = ["docs/plans", "tools/plan"],
}) {
  const artifact = `build/plan-design/${id}.json`;
  const acceptancePath = target === "tools/plan/rebuild-current-plan-baseline.mjs"
    ? "tools/server-scripts/verify-better-plan.mjs"
    : "tools/plan/rebuild-current-plan-baseline.mjs";
  return {
    id,
    status: "pending",
    role,
    prerequisites,
    platform: "any",
    difficulty: role === "final_validation" ? "deep" : "high",
    goal,
    description,
    requirements,
    acceptance_criteria: [criterion(acceptance)],
    commit: commit(`plan(${PROFILE}): ${goal}`, target),
    design: designContract(artifact, [target], [acceptancePath]),
    regression: { scope, commands: commands ?? [command], paths, criteria: [0] },
    next,
  };
}

function completedScaffold(id, next, revision, requirementsSha) {
  return {
    id,
    status: "completed",
    role: "architecture_scaffold",
    prerequisites: [],
    platform: "any",
    difficulty: "high",
    goal: "Define the reliable enterprise single-node release authority.",
    description: "The current authority exposes one supported deployment profile and imports no historical completion state.",
    requirements: ["REQ-REL-BASELINE", "REQ-ENT-SCOPE"],
    acceptance_criteria: [
      criterion("The release authority defines enterprise-single-node as the only supported profile.", true, [{
        type: "file",
        path: `docs/plans/${ROOT}/Requirements.md`,
        sha256: requirementsSha,
        recorded_at: RECORDED_AT,
      }]),
    ],
    commit: commit("docs(plan): define enterprise single-node authority", `docs/plans/${ROOT}/Requirements.md`, revision),
    next: [next],
  };
}

function planMarkdown(title, purpose, requirements, sequence) {
  return `# ${title}

## Authority

This Plan belongs to the current reliable enterprise single-node release authority. Historical lifecycle state and receipts are not executable inputs.

## Supported Profile

- \`${PROFILE}\`

## Purpose

${purpose}

## Requirements

${requirements.map((item) => `- **${item}**`).join("\n")}

## Execution

${sequence.map((item, index) => `${index + 1}. ${item}`).join("\n")}

## Acceptance Boundary

Only current source, current evidence, exact prerequisite receipts, and the canonical reducer may advance this Plan. Synthetic architecture evidence cannot promote release status.
`;
}

function requirementsMarkdown() {
  return `# Enterprise Single-Node Release Requirements

## Product Goal

Deliver a reliable single-node enterprise edition through Docker Compose, including fully offline installation, Linux x64 and ARM64 artifacts, an audited emergency administrator, independent backup and clean-host restore, N-1 upgrade rollback, local Prometheus observability, and versioned fail-isolated ports for optional identity, telemetry, and alert-delivery adapters.

## Supported Profile

- **REQ-ENT-SCOPE** — The public support matrix contains only \`${PROFILE}\`.
- **REQ-REL-BASELINE** — Manifest and DependencyMap remain the machine-readable current authority.
- **REQ-REL-RECEIPT-CURRENT** — Only receipts generated from the current source and graph may advance the release.
- **REQ-REL-PRIVACY** — Evidence and diagnostics must not expose machine identity, personal paths, secrets, or private runtime data.

## Delivery Stages

${CORE_STAGES.map((stage) => `- **${stage.requirement} (${stage.code})** — ${stage.goal}`).join("\n")}
- **REQ-ENT-INTEGRATION-LIFECYCLE** — A disabled, unconfigured, invalid, slow, or unavailable third-party integration must not prevent bounded Core server startup or shutdown. Adapter work starts only after Core readiness and exposes typed degraded state.
- **${ADAPTER_RUNTIME_STAGE.requirement} (${ADAPTER_RUNTIME_STAGE.code})** — ${ADAPTER_RUNTIME_STAGE.goal}
- **REQ-ENT-E7** — Prove the complete offline enterprise workflow on real Linux x64 and ARM64 environments.

## Explicitly Unsupported

This release does not claim multi-node automatic failover, production-scale capacity, cross-region replication, cross-region failover, or RPO/RTO guarantees. Planned maintenance windows are allowed. Backup may use independent media but is not an automatic cross-region disaster-recovery service.

## Deferred Work

Provider Trust remains staged and cannot enter the current execution graph until the E7 enterprise final receipt is complete.
`;
}

function currentPlanMarkdown() {
  return `# Current Plan: Reliable Enterprise Single Node

## What This Decision Means

The product is being prepared as one dependable server installed with Docker Compose. “Enterprise production ready” means that administrators can install it offline, secure it, recover it, upgrade it safely, and operate it with local standard monitoring. Optional external integrations extend that running Core; they do not decide whether the Core process may start or stop. It does not mean a cluster automatically survives a server failure.

## Supported Delivery

- Docker Compose is the production installation entry point.
- The package contains pinned OCI images and every installation dependency for Linux x64 and ARM64; the target server does not contact public networks.
- Administrators mount their own TLS certificate material.
- The local emergency administrator is a self-contained recovery mechanism and every use is audited.
- Backup storage must be an explicitly configured independent mount. Missing configuration stays non-executable.
- N-1 upgrades include preflight, backup, atomic migration, health verification, and failure rollback.
- Local health diagnostics and Prometheus metrics are part of the self-contained operating boundary.
- Optional OIDC, OTLP, and webhook implementations are independently owned adapter tasks outside the Core release graph. Core supplies only their versioned ports, lifecycle isolation, neutral fixtures, and degraded-state projection.

## Not Supported In This Release

- Multi-node automatic failover.
- Production-scale capacity claims.
- Cross-region replication or failover.
- RPO/RTO commitments.

These are not hidden acceptance requirements. They are future product directions and cannot block or promote this release.

## Core Dependency Graph

${CORE_STAGES.map((stage) => `- **${stage.code} — ${stage.title}:** ${stage.prerequisites.length === 0 ? "entry node" : `starts after ${stage.prerequisites.join(" and ")}`}. ${stage.goal}`).join("\n")}

## Concurrent Adapter Runtime Boundary

- **${ADAPTER_RUNTIME_STAGE.code} — ${ADAPTER_RUNTIME_STAGE.title}:** starts after E0 and may execute concurrently with every otherwise eligible Core node. ${ADAPTER_RUNTIME_STAGE.goal}

OIDC, OTLP, webhook, PostgreSQL, model-provider, gateway-framework, parser, provider, and datastore implementations use independent owner plans and receipts. They do not become Core prerequisites and cannot promote or block a Core receipt. After E2, emergency recovery, backup and restore, and Core observability may execute concurrently; only upgrade and rollback depends on backup and restore. The delivery final validation joins E3, E5, E6, and A0. E7 then starts from the offline package on real Linux x64 and ARM64 hosts and proves installation, TLS, emergency recovery, the first governed call, backup restore, upgrade rollback, local observability, and bounded Core startup and shutdown with optional adapters absent or failing. The complete regression runs once, as part of E7 final validation.

## Blockers And Ownership

### Current Hard Blockers

- The working tree must become one auditable candidate rather than an ambiguous mixture of changes.
- E0 must finish the release facts, support matrix, historical report classification, and migration scan.

### Enterprise Capability Blockers

- E1 owns the offline dual-architecture package.
- E2 owns TLS, secrets, preflight, and safe diagnostics.
- E3 owns self-contained emergency administrator recovery.
- E4 owns independent backup and clean-host restore.
- E5 owns N-1 upgrade rollback.
- E6 owns local diagnostics, Prometheus metrics, and integration-state visibility.
- A0 owns the common bounded adapter task lifecycle and its startup/shutdown isolation contract.
- E7 owns real-host end-to-end evidence and closure of any currently confirmed P0/P1 security or data-integrity issue.

### Explicit Non-Blockers

Cluster failover, production-scale capacity, regional disaster recovery, Provider Trust, and other Future Goals are outside the current release graph. Provider Trust remains deferred until E7 completes.

The Manifest is the machine-state authority. This document explains that state for people.
`;
}

async function readHistoricalSummary(repoRoot) {
  const migrationPath = path.join(repoRoot, "docs/reports/plan-baseline-migration.json");
  try {
    const migration = JSON.parse(await fs.readFile(migrationPath, "utf8"));
    if (
      migration?.schema_version === "v0.0.1:meshrix:plan-baseline-rebuild-2" &&
      migration?.superseded_authority
    ) {
      return migration.superseded_authority;
    }
  } catch {
    // The first migration has no prior report to preserve.
  }
  const manifestPath = path.join(repoRoot, "docs/plans/Manifest.json");
  try {
    const manifestBytes = await fs.readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes);
    const statuses = {};
    let nodeCount = 0;
    for (const entry of manifest) {
      const checkpointsPath = path.join(repoRoot, "docs/plans", entry.checkpoints);
      try {
        const nodes = JSON.parse(await fs.readFile(checkpointsPath, "utf8"));
        nodeCount += nodes.length;
        for (const node of nodes) statuses[node.status] = (statuses[node.status] ?? 0) + 1;
      } catch {
        statuses.unreadable = (statuses.unreadable ?? 0) + 1;
      }
    }
    return { plan_count: manifest.length, node_count: nodeCount, node_statuses: statuses, manifest_sha256: sha256(manifestBytes) };
  } catch {
    return { plan_count: 0, node_count: 0, node_statuses: {}, manifest_sha256: null };
  }
}

async function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function build(repoRoot) {
  const revision = currentRevision(repoRoot);
  const historical = await readHistoricalSummary(repoRoot);
  const plansRoot = path.join(repoRoot, "docs/plans");
  const targetRoot = path.join(plansRoot, ROOT);
  const tempRoot = path.join(plansRoot, `.enterprise-single-node-${process.pid}`);
  const backupRoot = path.join(plansRoot, `.superseded-release-${process.pid}`);
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(tempRoot, { recursive: true });

  const rootRequirements = requirementsMarkdown();
  const requirementsSha = sha256(rootRequirements);

  const ids = {
    scaffold: EXISTING_NODE_IDS.scaffold,
    deliveryIntegration: EXISTING_NODE_IDS.deliveryIntegration,
    acceptanceIntegration: EXISTING_NODE_IDS.acceptanceIntegration,
    rootFinal: EXISTING_NODE_IDS.rootFinal,
    deliveryFinal: EXISTING_NODE_IDS.deliveryFinal,
    e7: EXISTING_NODE_IDS.e7,
    e7Final: EXISTING_NODE_IDS.e7Final,
  };
  const stageIds = Object.fromEntries(DELIVERY_STAGES.map((stage) => [
    stage.code,
    EXISTING_NODE_IDS[stage.code] ?? stableId(stage.code),
  ]));

  const rootRequirementsList = [
    "REQ-REL-BASELINE",
    "REQ-ENT-SCOPE",
    "REQ-REL-RECEIPT-CURRENT",
    "REQ-REL-PRIVACY",
    ...DELIVERY_STAGES.map((stage) => stage.requirement),
    "REQ-ENT-INTEGRATION-LIFECYCLE",
    "REQ-ENT-E7",
  ];
  const rootNodes = [
    completedScaffold(ids.scaffold, ids.deliveryIntegration, revision, requirementsSha),
    pendingNode({
      id: ids.deliveryIntegration,
      prerequisites: [ids.scaffold],
      next: [ids.acceptanceIntegration],
      goal: "Integrate the Core delivery and fail-isolated integration receipts.",
      description: "Scope: Closure: capability - integrate the exact Core delivery graph and adapter-isolation final receipt into the root authority; verify current binding.",
      requirements: rootRequirementsList,
      acceptance: "The Core delivery and adapter-isolation final receipt is current, exact, privacy-safe, and bound to this integration node.",
      target: `docs/plans/${ROOT}/DependencyMap.json`,
      command: "npm run verify:better-plan",
    }),
    pendingNode({
      id: ids.acceptanceIntegration,
      prerequisites: [ids.deliveryIntegration],
      next: [ids.rootFinal],
      goal: "Integrate the E7 enterprise acceptance receipt.",
      description: "Scope: Closure: scenario - integrate the exact dual-architecture E7 final receipt into the root authority; verify real-host evidence.",
      requirements: rootRequirementsList,
      acceptance: "The real-host E7 final receipt is current, exact, privacy-safe, and bound to this integration node.",
      target: `docs/plans/${ROOT}/DependencyMap.json`,
      command: "npm run verify:acceptance:plan",
    }),
    pendingNode({
      id: ids.rootFinal,
      role: "final_validation",
      prerequisites: [ids.acceptanceIntegration],
      goal: "Reduce the enterprise single-node release decision.",
      description: "Scope: Closure: scenario - issue the only current enterprise single-node root release receipt; verify support boundaries.",
      requirements: rootRequirementsList,
      acceptance: "The root receipt proves only the declared enterprise single-node support boundary.",
      target: "build/reports",
      command: "npm run verify:better-plan",
      scope: "full",
      paths: ["docs/plans", "tools/plan", "tools/server-scripts"],
    }),
  ];

  const deliverySharedRequirements = [
    "REQ-REL-BASELINE",
    "REQ-ENT-SCOPE",
    "REQ-REL-RECEIPT-CURRENT",
    "REQ-REL-PRIVACY",
    ...BASELINE_CAPABILITIES.map((name) => `REQ-BASELINE-${name}`),
    "REQ-ENT-INTEGRATION-LIFECYCLE",
  ];
  const deliveryRequirements = [
    ...deliverySharedRequirements,
    ...DELIVERY_STAGES.map((stage) => stage.requirement),
  ];
  const implementationStages = [...CORE_STAGES, ...PARALLEL_STAGES];
  const coreNodes = CORE_STAGES.map((stage) => {
    const dependentStages = implementationStages
      .filter((candidate) => candidate.prerequisites.includes(stage.code))
      .map((candidate) => stageIds[candidate.code]);
    return pendingNode({
      id: stageIds[stage.code],
      prerequisites: stage.prerequisites.map((code) => stageIds[code]),
      next: dependentStages.length > 0 ? dependentStages : [ids.deliveryFinal],
      goal: stage.goal,
      description: `Scope: Closure: capability - ${stage.code} ${stage.slug}; verify the stage acceptance boundary.`,
      requirements: [...deliverySharedRequirements, stage.requirement],
      acceptance: stage.acceptance,
      target: stage.target,
      commands: stage.commands,
      paths: stage.paths,
    });
  });
  const adapterRuntimeNode = pendingNode({
    id: stageIds[ADAPTER_RUNTIME_STAGE.code],
    prerequisites: ADAPTER_RUNTIME_STAGE.prerequisites.map((code) => stageIds[code]),
    next: [ids.deliveryFinal],
    goal: ADAPTER_RUNTIME_STAGE.goal,
    description: `Scope: Closure: runtime boundary - ${ADAPTER_RUNTIME_STAGE.code} ${ADAPTER_RUNTIME_STAGE.slug}; supervise optional integration tasks after Core readiness and keep process admission and teardown independent.`,
    requirements: [...deliverySharedRequirements, ADAPTER_RUNTIME_STAGE.requirement],
    acceptance: ADAPTER_RUNTIME_STAGE.acceptance,
    target: ADAPTER_RUNTIME_STAGE.target,
    commands: ADAPTER_RUNTIME_STAGE.commands,
    paths: ADAPTER_RUNTIME_STAGE.paths,
  });
  const deliveryNodes = [...coreNodes, adapterRuntimeNode];
  deliveryNodes.push(pendingNode({
    id: ids.deliveryFinal,
    role: "final_validation",
    prerequisites: [stageIds.E3, stageIds.E5, stageIds.E6, stageIds.A0],
    goal: "Validate the Core delivery graph and adapter lifecycle isolation.",
    description: "Scope: Closure: module - reduce one exact enterprise delivery receipt; verify dependency-based Core completion and optional-adapter lifecycle isolation.",
    requirements: deliveryRequirements,
    acceptance: "E0-E6 and A0 are complete and current; optional integration unavailability cannot block bounded Core startup or shutdown; no external-product or synthetic dual-architecture evidence promotes the receipt.",
    target: "build/reports",
    command: "npm run verify:better-plan",
    scope: "full",
    paths: ["docs/plans", "docs/reports", "tools/plan", "tools/server-scripts"],
  }));

  const acceptanceRequirements = [
    "REQ-ENT-SCOPE",
    "REQ-REL-RECEIPT-CURRENT",
    "REQ-REL-PRIVACY",
    "REQ-ENT-INTEGRATION-LIFECYCLE",
    ADAPTER_RUNTIME_STAGE.requirement,
    "REQ-ENT-E7",
  ];
  const acceptanceNodes = [
    pendingNode({
      id: ids.e7,
      prerequisites: [],
      next: [ids.e7Final],
      goal: "Prove enterprise operations on real Linux x64 and ARM64 hosts.",
      description: "Scope: Closure: scenario - execute the offline enterprise journey on both supported CPU architectures; verify real hosts.",
      requirements: acceptanceRequirements,
      acceptance: "Both real architectures prove offline install, TLS, emergency recovery, first governed call, restore, rollback, local observability, and bounded startup and shutdown with optional adapters absent, invalid, slow, or unavailable.",
      target: `docs/plans/${ACCEPTANCE}/Checkpoints.json`,
      command: "npm run verify:acceptance:plan",
      paths: ["tools/server-scripts", "tests/vitest/server", "docs/plans"],
    }),
    pendingNode({
      id: ids.e7Final,
      role: "final_validation",
      prerequisites: [ids.e7],
      goal: "Run the single complete regression and reduce the E7 receipt.",
      description: "Scope: Closure: scenario - validate the complete enterprise single-node candidate exactly once; verify release closure.",
      requirements: acceptanceRequirements,
      acceptance: "The complete regression passes and no confirmed P0/P1 security or data-integrity issue remains open.",
      target: "build/reports",
      command: "npm run verify:acceptance",
      scope: "full",
      paths: ["apps", "packages", "tools", "tests", "docs"],
    }),
  ];

  const dependencyMap = {
    schema_version: 3,
    generated_from_revision: revision,
    profiles: [PROFILE],
    plans: [
      {
        directory: ROOT,
        parent: null,
        parent_contract_node_id: null,
        parent_integrations: [],
        final_validations: [{ node_id: ids.rootFinal, profiles: [PROFILE] }],
        prerequisite_receipts: [],
        children: [DELIVERY, ACCEPTANCE],
        accepted_final_receipts: {},
      },
      {
        directory: DELIVERY,
        parent: ROOT,
        parent_contract_node_id: ids.scaffold,
        parent_integrations: [{
          child_final_node_id: ids.deliveryFinal,
          parent_node_id: ids.deliveryIntegration,
          profiles: [PROFILE],
        }],
        final_validations: [{ node_id: ids.deliveryFinal, profiles: [PROFILE] }],
        prerequisite_receipts: [],
        children: [],
        accepted_final_receipts: {},
      },
      {
        directory: ACCEPTANCE,
        parent: ROOT,
        parent_contract_node_id: ids.scaffold,
        parent_integrations: [{
          child_final_node_id: ids.e7Final,
          parent_node_id: ids.acceptanceIntegration,
          profiles: [PROFILE],
        }],
        final_validations: [{ node_id: ids.e7Final, profiles: [PROFILE] }],
        prerequisite_receipts: [{
          plan: DELIVERY,
          node_id: ids.deliveryFinal,
          kind: "final_validation",
          profiles: [PROFILE],
        }],
        children: [],
        accepted_final_receipts: {},
      },
    ],
  };

  const files = new Map([
    ["Requirements.md", rootRequirements],
    ["CurrentPlan.md", currentPlanMarkdown()],
    ["Architecture.md", "# Architecture\n\nThe current release architecture is one self-contained Docker Compose Core with explicit backup and TLS boundaries. Core exposes versioned optional-adapter ports and supervises their asynchronous lifecycle after Core readiness. Concrete third-party implementations remain outside the Core release graph, and their receipts cannot promote or block a Core receipt. The DependencyMap is the executable graph authority.\n"],
    ["Evidence.md", "# Evidence\n\nOnly current-source evidence may advance this plan. Real Linux x64 and ARM64 evidence is required at E7; emulation cannot promote release status.\n"],
    ["Validation.md", "# Validation\n\nRun focused verification for each Core node and A0. Prove absent, invalid, slow, and unavailable optional adapters cannot block bounded Core startup or shutdown. Run the complete regression once at E7 final validation.\n"],
    ["Checkpoints.json", jsonText(rootNodes)],
    ["DependencyMap.json", jsonText(dependencyMap)],
    ["enterprise-single-node/Plan.md", planMarkdown(
      "Enterprise Single-Node Delivery",
      "Deliver E0-E6 through explicit capability dependencies and A0 as a concurrent adapter-lifecycle isolation closure.",
      deliveryRequirements,
      [
        ...CORE_STAGES.map((stage) => `${stage.code}: ${stage.title}`),
        `${ADAPTER_RUNTIME_STAGE.code}: ${ADAPTER_RUNTIME_STAGE.title}, eligible after E0 and independent of other Core capability branches`,
        "Join E3, E5, E6, and A0 in one delivery final validation.",
      ],
    )],
    ["enterprise-single-node/Checkpoints.json", jsonText(deliveryNodes)],
    ["release-acceptance/Plan.md", planMarkdown("Enterprise Single-Node Release Acceptance", "Prove E7 on real Linux x64 and ARM64 environments.", acceptanceRequirements, ["Execute the real-host E7 scenario.", "Run the one complete regression and reduce the final receipt."])],
    ["release-acceptance/Checkpoints.json", jsonText(acceptanceNodes)],
  ]);
  for (const [relativePath, content] of files) await writeFile(tempRoot, relativePath, content);

  const manifestEntries = [
    {
      id: stableId("manifest-root"),
      status: "in_progress",
      title: "Reliable Enterprise Single-Node Release",
      directory: ROOT,
      source_files: [
        `docs/plans/${ROOT}/Requirements.md`,
        `docs/plans/${ROOT}/CurrentPlan.md`,
        `docs/plans/${ROOT}/Architecture.md`,
        `docs/plans/${ROOT}/Evidence.md`,
        `docs/plans/${ROOT}/Validation.md`,
        `docs/plans/${ROOT}/DependencyMap.json`,
      ],
      goal: "Deliver one reliable enterprise single-node release.",
      description: "Current machine authority for the only supported deployment profile.",
      checkpoints: `${ROOT}/Checkpoints.json`,
    },
    {
      id: stableId("manifest-delivery"),
      status: "pending",
      title: "Enterprise Single-Node Delivery",
      directory: DELIVERY,
      source_files: [`docs/plans/${DELIVERY}/Plan.md`],
      goal: "Deliver dependency-based Core operations branches and a concurrent fail-isolated adapter lifecycle boundary.",
      description: "Capability delivery plan for the enterprise single-node profile; concrete external integration work belongs to independent owner plans and cannot gate Core process startup, shutdown, or release.",
      checkpoints: `${DELIVERY}/Checkpoints.json`,
    },
    {
      id: stableId("manifest-acceptance"),
      status: "pending",
      title: "Enterprise Single-Node Release Acceptance",
      directory: ACCEPTANCE,
      source_files: [`docs/plans/${ACCEPTANCE}/Plan.md`],
      goal: "Prove E7 on real Linux x64 and ARM64 environments.",
      description: "Final real-host acceptance and the single complete regression.",
      checkpoints: `${ACCEPTANCE}/Checkpoints.json`,
    },
  ];

  if (await fs.stat(targetRoot).then(() => true, () => false)) await fs.rename(targetRoot, backupRoot);
  try {
    await fs.rename(tempRoot, targetRoot);
    await fs.writeFile(path.join(plansRoot, "Manifest.json"), jsonText(manifestEntries));
    await writeFile(repoRoot, "docs/reports/plan-baseline-migration.json", jsonText({
      schema_version: "v0.0.1:meshrix:plan-baseline-rebuild-2",
      status: "current",
      recorded_at: RECORDED_AT,
      source_revision: revision,
      superseded_authority: historical,
      current_authority: {
        plan_count: manifestEntries.length,
        node_count: rootNodes.length + deliveryNodes.length + acceptanceNodes.length,
        profiles: [PROFILE],
        accepted_receipt_count: 0,
      },
      historical_authority_retained: false,
      irreversible_summary: "The previous executable graph and its receipts were removed; only aggregate counts, status totals, and a manifest digest remain for audit.",
    }));
    await fs.rm(backupRoot, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(targetRoot, { recursive: true, force: true });
    if (await fs.stat(backupRoot).then(() => true, () => false)) await fs.rename(backupRoot, targetRoot);
    throw error;
  }

  process.stdout.write(jsonText({
    ok: true,
    profile: PROFILE,
    plans: manifestEntries.length,
    nodes: rootNodes.length + deliveryNodes.length + acceptanceNodes.length,
    accepted_receipts: 0,
    next: `${DELIVERY}:${stageIds.E0}`,
  }));
}

const repoRoot = path.resolve(process.argv[2] ?? defaultRepoRoot);
await build(repoRoot);
