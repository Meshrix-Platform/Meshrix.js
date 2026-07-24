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

const STAGES = Object.freeze([
  {
    code: "E0",
    slug: "release-truth",
    title: "Release Truth And Candidate Convergence",
    requirement: "REQ-ENT-E0",
    goal: "Converge release facts, support boundaries, report status, and one auditable candidate.",
    acceptance: "The support matrix exposes only enterprise-single-node, report ownership is classified, and the candidate inventory is auditable.",
  },
  {
    code: "E1",
    slug: "offline-dual-architecture",
    title: "Offline Dual-Architecture Compose Artifact",
    requirement: "REQ-ENT-E1",
    goal: "Deliver a fully offline Docker Compose artifact for Linux x64 and ARM64.",
    acceptance: "Pinned OCI images, installation dependencies, SBOM, signatures, and inventory verification work without public-network access.",
  },
  {
    code: "E2",
    slug: "production-security-baseline",
    title: "Production Security Baseline",
    requirement: "REQ-ENT-E2",
    goal: "Close production TLS, secret protection, startup preflight, and privacy-safe diagnostics.",
    acceptance: "Administrator-mounted TLS materials and protected secrets fail closed, while diagnostics disclose no private runtime data.",
  },
  {
    code: "E3",
    slug: "identity-and-emergency-recovery",
    title: "OIDC And Emergency Administrator Recovery",
    requirement: "REQ-ENT-E3",
    goal: "Make OIDC the normal sign-in path and provide an audited emergency administrator recovery path.",
    acceptance: "Real OIDC login, disablement, role mapping, and fully audited emergency recovery are proven.",
  },
  {
    code: "E4",
    slug: "backup-and-clean-host-restore",
    title: "Independent Backup And Clean-Host Restore",
    requirement: "REQ-ENT-E4",
    goal: "Back up to explicitly configured independent mounted storage and restore on a clean host.",
    acceptance: "Empty backup configuration is non-executable; integrity verification, restore preview, and clean-host recovery are proven.",
  },
  {
    code: "E5",
    slug: "n-minus-one-upgrade-rollback",
    title: "N-1 Upgrade And Failure Rollback",
    requirement: "REQ-ENT-E5",
    goal: "Provide preflighted N-1 upgrades with pre-upgrade backup, atomic migration, health validation, and rollback.",
    acceptance: "A failed N-1 upgrade returns the node to the last healthy version without losing governed state.",
  },
  {
    code: "E6",
    slug: "operations-observability",
    title: "Operations Observability And Alert Delivery",
    requirement: "REQ-ENT-E6",
    goal: "Deliver Prometheus metrics, OTLP telemetry, and observable webhook alert delivery.",
    acceptance: "Metrics and telemetry export work, and webhook delivery, bounded retry, and terminal failure visibility are proven.",
  },
]);

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
      concurrency: "sequential E0-E7 delivery",
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
  scope = "focused",
  paths = ["docs/plans", "tools/plan"],
}) {
  const artifact = `build/plan-design/${id}.json`;
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
    design: designContract(artifact, [target], ["tools/plan/rebuild-current-plan-baseline.mjs"]),
    regression: { scope, commands: [command], paths, criteria: [0] },
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

Deliver a reliable single-node enterprise edition through Docker Compose, including fully offline installation, Linux x64 and ARM64 artifacts, OIDC with an audited emergency administrator, independent backup and clean-host restore, N-1 upgrade rollback, Prometheus metrics, OTLP telemetry, and webhook alerting.

## Supported Profile

- **REQ-ENT-SCOPE** — The public support matrix contains only \`${PROFILE}\`.
- **REQ-REL-BASELINE** — Manifest and DependencyMap remain the machine-readable current authority.
- **REQ-REL-RECEIPT-CURRENT** — Only receipts generated from the current source and graph may advance the release.
- **REQ-REL-PRIVACY** — Evidence and diagnostics must not expose machine identity, personal paths, secrets, or private runtime data.

## Delivery Stages

${STAGES.map((stage) => `- **${stage.requirement} (${stage.code})** — ${stage.goal}`).join("\n")}
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

The product is being prepared as one dependable server installed with Docker Compose. “Enterprise production ready” means that administrators can install it offline, secure it, connect their identity provider, recover it, upgrade it safely, and operate it with standard monitoring. It does not mean a cluster automatically survives a server failure.

## Supported Delivery

- Docker Compose is the production installation entry point.
- The package contains pinned OCI images and every installation dependency for Linux x64 and ARM64; the target server does not contact public networks.
- Administrators mount their own TLS certificate material.
- OIDC is the normal user sign-in path; the local emergency administrator is a recovery mechanism and every use is audited.
- Backup storage must be an explicitly configured independent mount. Missing configuration stays non-executable.
- N-1 upgrades include preflight, backup, atomic migration, health verification, and failure rollback.
- Prometheus, OTLP, and webhook alert delivery are part of the operating boundary.

## Not Supported In This Release

- Multi-node automatic failover.
- Production-scale capacity claims.
- Cross-region replication or failover.
- RPO/RTO commitments.

These are not hidden acceptance requirements. They are future product directions and cannot block or promote this release.

## Execution Order

${STAGES.map((stage) => `- **${stage.code} — ${stage.title}:** ${stage.goal}`).join("\n")}
- **E7 — Dual-Architecture Operations Acceptance:** start from the offline package on real Linux x64 and ARM64 hosts and prove installation, TLS, OIDC, emergency recovery, the first governed call, backup restore, upgrade rollback, telemetry, and alert delivery.

Each stage is a minimal independent closure. Its focused verification must pass before the next stage starts. The complete regression runs once, as part of E7 final validation.

## Blockers And Ownership

### Current Hard Blockers

- The working tree must become one auditable candidate rather than an ambiguous mixture of changes.
- E0 must finish the release facts, support matrix, historical report classification, and migration scan.

### Enterprise Capability Blockers

- E1 owns the offline dual-architecture package.
- E2 owns TLS, secrets, preflight, and safe diagnostics.
- E3 owns OIDC and emergency administrator recovery.
- E4 owns independent backup and clean-host restore.
- E5 owns N-1 upgrade rollback.
- E6 owns telemetry and alert delivery.
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
    scaffold: stableId("root-scaffold"),
    deliveryIntegration: stableId("root-delivery-integration"),
    acceptanceIntegration: stableId("root-acceptance-integration"),
    rootFinal: stableId("root-final"),
    deliveryFinal: stableId("delivery-final"),
    e7: stableId("e7-implementation"),
    e7Final: stableId("e7-final"),
  };
  const stageIds = Object.fromEntries(STAGES.map((stage) => [stage.code, stableId(stage.code)]));

  const rootRequirementsList = [
    "REQ-REL-BASELINE",
    "REQ-ENT-SCOPE",
    "REQ-REL-RECEIPT-CURRENT",
    "REQ-REL-PRIVACY",
    ...STAGES.map((stage) => stage.requirement),
    "REQ-ENT-E7",
  ];
  const rootNodes = [
    completedScaffold(ids.scaffold, ids.deliveryIntegration, revision, requirementsSha),
    pendingNode({
      id: ids.deliveryIntegration,
      prerequisites: [ids.scaffold],
      next: [ids.acceptanceIntegration],
      goal: "Integrate the E0-E6 enterprise delivery receipt.",
      description: "Scope: Closure: capability - integrate the exact enterprise delivery final receipt into the root authority; verify current binding.",
      requirements: rootRequirementsList,
      acceptance: "The E0-E6 final receipt is current, exact, privacy-safe, and bound to this integration node.",
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

  const deliveryRequirements = [
    "REQ-REL-BASELINE",
    "REQ-ENT-SCOPE",
    "REQ-REL-RECEIPT-CURRENT",
    "REQ-REL-PRIVACY",
    ...BASELINE_CAPABILITIES.map((name) => `REQ-BASELINE-${name}`),
    ...STAGES.map((stage) => stage.requirement),
  ];
  const deliveryNodes = STAGES.map((stage, index) => {
    const previous = STAGES[index - 1];
    const next = STAGES[index + 1];
    return pendingNode({
      id: stageIds[stage.code],
      prerequisites: previous ? [stageIds[previous.code]] : [],
      next: next ? [stageIds[next.code]] : [ids.deliveryFinal],
      goal: stage.goal,
      description: `Scope: Closure: capability - ${stage.code} ${stage.slug}; verify the stage acceptance boundary.`,
      requirements: deliveryRequirements,
      acceptance: stage.acceptance,
      target: `docs/plans/${DELIVERY}/Checkpoints.json`,
      command: "npm run verify:better-plan",
      paths: ["docs/plans", "docs/reports", "tools/plan", "tools/server-scripts"],
    });
  });
  deliveryNodes.push(pendingNode({
    id: ids.deliveryFinal,
    role: "final_validation",
    prerequisites: [stageIds.E6],
    goal: "Validate the complete E0-E6 enterprise operations delivery.",
    description: "Scope: Closure: module - reduce one exact E0-E6 enterprise delivery receipt; verify sequential completion.",
    requirements: deliveryRequirements,
    acceptance: "E0-E6 are complete, current, sequentially proven, and contain no synthetic dual-architecture promotion.",
    target: "build/reports",
    command: "npm run verify:better-plan",
    scope: "full",
    paths: ["docs/plans", "docs/reports", "tools/plan", "tools/server-scripts"],
  }));

  const acceptanceRequirements = ["REQ-ENT-SCOPE", "REQ-REL-RECEIPT-CURRENT", "REQ-REL-PRIVACY", "REQ-ENT-E7"];
  const acceptanceNodes = [
    pendingNode({
      id: ids.e7,
      prerequisites: [],
      next: [ids.e7Final],
      goal: "Prove enterprise operations on real Linux x64 and ARM64 hosts.",
      description: "Scope: Closure: scenario - execute the offline enterprise journey on both supported CPU architectures; verify real hosts.",
      requirements: acceptanceRequirements,
      acceptance: "Both real architectures prove offline install, TLS, OIDC, emergency recovery, first governed call, restore, rollback, telemetry, and alert delivery.",
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
    ["Architecture.md", "# Architecture\n\nThe current release architecture is one Docker Compose node with explicit external identity, backup, TLS, telemetry, and alert-delivery boundaries. The DependencyMap is the executable graph authority.\n"],
    ["Evidence.md", "# Evidence\n\nOnly current-source evidence may advance this plan. Real Linux x64 and ARM64 evidence is required at E7; emulation cannot promote release status.\n"],
    ["Validation.md", "# Validation\n\nRun focused verification after E0-E6. Run the complete regression once at E7 final validation.\n"],
    ["Checkpoints.json", jsonText(rootNodes)],
    ["DependencyMap.json", jsonText(dependencyMap)],
    ["enterprise-single-node/Plan.md", planMarkdown("Enterprise Single-Node Delivery", "Deliver E0-E6 in strict sequence.", deliveryRequirements, STAGES.map((stage) => `${stage.code}: ${stage.title}`))],
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
      goal: "Deliver E0-E6 as sequential operational closures.",
      description: "Capability delivery plan for the enterprise single-node profile.",
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
