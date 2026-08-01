#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ENTERPRISE_SINGLE_NODE_PROFILE } from "./plan-dependency-map.ts";

const modulePath: any = fileURLToPath(import.meta.url);
const defaultRepoRoot: any = path.resolve(path.dirname(modulePath), "../..");
const PROFILE: any = ENTERPRISE_SINGLE_NODE_PROFILE;
const ROOT: any = "end-to-end-release";
const DELIVERY: any = `${ROOT}/enterprise-single-node`;
const OFFLINE_TRANSFER: any = `${ROOT}/cross-system-offline-transfer`;
const NATIVE_X64: any = `${ROOT}/native-linux-x64`;
const NATIVE_ARM64: any = `${ROOT}/native-linux-arm64`;
const NATIVE_MACOS_ARM64: any = `${ROOT}/native-macos-arm64`;
const NATIVE_WINDOWS_X64: any = `${ROOT}/native-windows-x64`;
const PUBLIC_CLOUD: any = `${ROOT}/public-cloud-single-node`;
const CLEAN_HOST_RECOVERY: any = `${ROOT}/clean-host-recovery`;
const ACCEPTANCE: any = `${ROOT}/functional-release-acceptance`;
const RECORDED_AT: any = new Date().toISOString();
const REPLACE_REFUSAL: any = "refusing to replace checkpoints or receipts";

const BASELINE_CAPABILITIES: readonly any[] = Object.freeze([
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

const AUTHORITY_STAGE: Readonly<Record<string, any>> = Object.freeze({
  code: "P0",
  slug: "release-plan-execution-authority",
  title: "Release Plan Execution Authority",
  requirement: "REQ-REL-PLAN-LIFECYCLE",
  prerequisites: [],
  goal: "Reassemble release-plan initialization, execution, receipt reduction, and CI consumption into one non-destructive candidate lifecycle.",
  acceptance: "A clean job initializes the ignored local Plan exactly once, executes and records the declared nodes against one candidate, reduces the delivery receipt before the functional-completeness gate consumes it, and cannot reset checkpoints or receipts after evidence exists.",
  target: "tools/server-scripts/verify-enterprise-single-node-ubuntu-container.ts",
  commands: [
    "npm run vitest -- --run tests/vitest/server/plan-execution-eligibility.test.ts tests/vitest/server/platform-acceptance-plan-receipts.test.ts tests/vitest/server/release-workflow-supply-chain.test.ts tests/vitest/server/release-plan-execution-authority.test.ts",
  ],
  paths: [".github/workflows", "package.json", "tools/plan", "tools/server-scripts", "tests/vitest/server"],
  designOwnedPaths: [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "package.json",
    "tools/plan/current-plan-receipt.ts",
    "tools/plan/plan-final-receipt.ts",
    "tools/plan/rebuild-current-plan-baseline.ts",
    "tools/server-scripts/lib/platform-acceptance-plan-receipts.ts",
    "tools/server-scripts/verify-cross-system-offline-transfer-evidence.ts",
    "tools/server-scripts/verify-enterprise-single-node-ubuntu-container.ts",
  ],
  designAcceptancePaths: [
    "tests/vitest/server/plan-execution-eligibility.test.ts",
    "tests/vitest/server/platform-acceptance-plan-receipts.test.ts",
    "tests/vitest/server/release-workflow-supply-chain.test.ts",
    "tests/vitest/server/release-plan-execution-authority.test.ts",
  ],
});

const CORE_STAGES: readonly any[] = Object.freeze([
  {
    code: "E0",
    slug: "release-truth",
    title: "Release Truth And Candidate Convergence",
    requirement: "REQ-ENT-E0",
    prerequisites: ["P0"],
    goal: "Converge release facts, support boundaries, report status, and one immutable auditable candidate.",
    acceptance: "The support matrix exposes only enterprise-single-node, report ownership is classified, one immutable source-candidate identity binds the source revision, repository tree, lockfile, release definition, public package inventory, supported profile, and report-owner inventory, and every derived package or container authority must bind that same candidate identity together with its own immutable artifact digests.",
    target: "tools/server-scripts/verify-release-candidate-identity.ts",
    commands: [
      "node tools/server-scripts/verify-release-candidate-identity.ts",
      "npm run verify:capability-acceptance-machines",
      "npm run verify:core-platform-surface-convergence",
    ],
    paths: ["package-lock.json", "tools/registry/release-definition.registry.json", "tools/server-scripts"],
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
    commands: [
      "npm run test:security",
      "node tools/server-scripts/verify-trusted-forwarding-invariants.ts",
    ],
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
    commands: ["node tools/server-scripts/verify-emergency-administrator-recovery.ts"],
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
    commands: ["node tools/server-scripts/verify-storage-production-restore-drill.ts"],
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
    commands: ["node tools/server-scripts/verify-upgrade-rollback.ts"],
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
      "node tools/server-scripts/verify-observability-runtime-acceptance.ts",
      "npm run verify:enterprise-observability-coverage",
      "npm run verify:security-alert-lifecycle",
    ],
    paths: ["packages/foundation/src/observability", "packages/server-runtime/src/composition", "tools/server-scripts", "tests/vitest/server"],
  },
]);

const ADAPTER_RUNTIME_STAGE: Readonly<Record<string, any>> = Object.freeze({
  code: "A0",
  slug: "adapter-runtime-isolation",
  title: "Adapter Runtime Isolation",
  requirement: "REQ-ENT-A0",
  prerequisites: ["E0"],
  goal: "Provide one supervised asynchronous adapter lifecycle that cannot acquire authority over Core server startup or shutdown.",
  acceptance: "Empty configuration creates no adapter; simulated connect, execution, cancellation, and close failures remain capability-scoped, resource-bounded, privacy-safe, and unable to prevent bounded Core startup or shutdown.",
  target: "packages/server-runtime/src/composition/integration-task-supervisor.ts",
  commands: ["node tools/server-scripts/verify-integration-task-supervisor.ts"],
  paths: ["apps/server/runtime", "packages/server-runtime/src/composition", "tests/vitest/server"],
});

const DELIVERY_STAGES: readonly any[] = Object.freeze([
  AUTHORITY_STAGE,
  ...CORE_STAGES,
  ADAPTER_RUNTIME_STAGE,
]);
const PARALLEL_STAGES: readonly any[] = Object.freeze([ADAPTER_RUNTIME_STAGE]);

const EXISTING_NODE_IDS: Readonly<Record<string, any>> = Object.freeze({
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
  P0: "a8dcd1c8-b89e-4f2f-a556-24a1e30fc6cf",
});

const EXTERNAL_PLANS: readonly any[] = Object.freeze([
  {
    directory: OFFLINE_TRANSFER,
    key: "offlineTransfer",
    title: "Cross-System Offline Transfer",
    requirement: "REQ-ENT-CROSS-SYSTEM-OFFLINE",
    platform: "linux",
    goal: "Transfer the signed candidate from a connected custody environment to a disconnected clean target.",
    acceptance: "A connected build and signing environment exports one signed, inventory-bound OCI bundle; a separate network-disabled clean target verifies its digest, signature, SBOM, provenance, and complete dependency inventory without rebuilding or contacting a public network.",
    command: "npm run verify:cross-system-offline-transfer",
    paths: [".github/workflows/release.yml", "tools/server-scripts", "tests/vitest/server", "docs/plans"],
  },
  {
    directory: NATIVE_X64,
    key: "nativeX64",
    title: "Native Linux x64 Host",
    requirement: "REQ-ENT-NATIVE-X64",
    platform: "linux",
    goal: "Prove the immutable candidate on a native Linux x64 system.",
    acceptance: "A native Linux x64 host imports the signed offline candidate without rebuilding, verifies the exact image digest and delivery receipt, and proves startup, health, cgroup and seccomp behavior, signal handling, persistent-volume semantics, and bounded shutdown with privacy-safe evidence.",
    command: "npm run verify:real-machine -- run --target native-linux-x64",
    paths: [".github/workflows/release.yml", "docker-compose.yml", "tools/server-scripts", "tests/vitest/server"],
  },
  {
    directory: NATIVE_ARM64,
    key: "nativeArm64",
    title: "Native Linux ARM64 Host",
    requirement: "REQ-ENT-NATIVE-ARM64",
    platform: "linux",
    goal: "Prove the immutable candidate on a native Linux ARM64 system.",
    acceptance: "A native Linux ARM64 host imports the signed offline candidate without rebuilding, verifies the exact image digest and delivery receipt, and proves startup, health, cgroup and seccomp behavior, signal handling, persistent-volume semantics, and bounded shutdown with privacy-safe evidence.",
    command: "npm run verify:real-machine -- run --target native-linux-arm64",
    paths: [".github/workflows/release.yml", "docker-compose.yml", "tools/server-scripts", "tests/vitest/server"],
  },
  {
    directory: NATIVE_MACOS_ARM64,
    key: "nativeMacosArm64",
    title: "Native macOS ARM64 Host",
    requirement: "REQ-ENT-NATIVE-MACOS-ARM64",
    platform: "macos",
    goal: "Prove the portable MCP connector artifact on a native macOS ARM64 system.",
    acceptance: "After functional acceptance, a native macOS ARM64 host verifies the exact portable connector artifact, bundled runtime, installer delegation, credential-custody behavior, startup, protocol probe, bounded shutdown, and cleanup without changing the functional release verdict.",
    command: "npm run verify:real-machine -- run --target native-macos-arm64",
    paths: [".github/workflows/real-machine-validation.yml", "packages/protocols/mcp/adapter", "tools/server-scripts", "tests/vitest/server"],
  },
  {
    directory: NATIVE_WINDOWS_X64,
    key: "nativeWindowsX64",
    title: "Native Windows x64 Host",
    requirement: "REQ-ENT-NATIVE-WINDOWS-X64",
    platform: "windows",
    goal: "Prove the MCP connector and installer on a native Windows x64 system.",
    acceptance: "After functional acceptance, a native Windows x64 host verifies the exact connector package, PowerShell installer delegation, DPAPI custody, invalid-input rejection, protocol probe, bounded shutdown, and cleanup without changing the functional release verdict.",
    command: "npm run verify:real-machine -- run --target native-windows-x64",
    paths: [".github/workflows/real-machine-validation.yml", "packages/protocols/mcp/adapter", "tools/server-scripts", "tests/vitest/server"],
  },
  {
    directory: PUBLIC_CLOUD,
    key: "publicCloud",
    title: "Public Cloud Single-Node Environment",
    requirement: "REQ-ENT-NET-PUBLIC-CLOUD",
    platform: "linux",
    goal: "Deploy and operate the immutable candidate on one production-like public cloud server.",
    acceptance: "One declared cloud environment uses real DNS and HTTPS, an explicit trusted-proxy boundary, certificate replacement, remote agent MCP calls, remote upstream HTTP and MCP services, bounded restart and network-fault drills, and target-spec capacity observation; every receipt binds the immutable candidate and contains no server identity or protected runtime data.",
    command: "npm run verify:real-machine -- run --target public-cloud-single-node",
    paths: ["docker-compose.enterprise.yml", "tools/server-scripts", "tests/vitest/server", "docs/plans"],
  },
  {
    directory: CLEAN_HOST_RECOVERY,
    key: "cleanHostRecovery",
    title: "Independent Clean-Host Recovery Environment",
    requirement: "REQ-ENT-CROSS-HOST-RESTORE",
    platform: "linux",
    goal: "Restore a backup from the cloud node onto an independently prepared clean host.",
    acceptance: "A backup created on the declared cloud node is transferred to a separately provisioned clean Linux host and restored with independently retained key material; integrity, schema preflight, governed state, agent service health, and recovery timing are proven without reusing the source host data root or custody files.",
    command: "npm run verify:real-machine -- run --target clean-host-recovery",
    paths: ["packages/foundation/src/storage", "tools/server-scripts", "tests/vitest/server", "docs/plans"],
  },
]);
const SIMULATION_PLANS: any = Object.freeze(
  EXTERNAL_PLANS.filter((plan?: any) : any => plan.directory === OFFLINE_TRANSFER),
);
const REAL_MACHINE_PLANS: any = Object.freeze(
  EXTERNAL_PLANS.filter((plan?: any) : any => plan.directory !== OFFLINE_TRANSFER),
);

function requireCondition(condition?: any, message?: any) : any {
  if (!condition) throw new Error(message);
}

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stableId(label?: any) : any {
  const digest: any = sha256(`meshrix-enterprise-single-node:${label}`);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function jsonText(value?: any) : any {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function currentRevision(repoRoot?: any) : any {
  const result: any = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  requireCondition(result.status === 0 && result.stdout.trim(), "Current repository revision is unavailable");
  return result.stdout.trim();
}

function commit(message?: any, target?: any, revision?: any) : any {
  return {
    repository: ".git",
    message,
    target,
    ...(revision ? { delivered: revision } : {}),
  };
}

function criterion(text?: any, checked: any = false, evidenceRefs: any = undefined) : any {
  return { checked, text, ...(evidenceRefs ? { evidence_refs: evidenceRefs } : {}) };
}

function designContract(artifact?: any, ownedPaths?: any, acceptancePaths?: any) : any {
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
  platform = "any",
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
  designOwnedPaths,
  designAcceptancePaths,
}: Record<string, any>) : any {
  const artifact: any = `build/plan-design/${id}.json`;
  const acceptancePath: any = target === "tools/plan/rebuild-current-plan-baseline.ts"
    ? "tools/server-scripts/verify-better-plan.ts"
    : "tools/plan/rebuild-current-plan-baseline.ts";
  return {
    id,
    status: "pending",
    role,
    prerequisites,
    platform,
    difficulty: role === "final_validation" ? "critical" : "complex",
    verification_profile: "code",
    goal,
    description,
    requirements,
    acceptance_criteria: [criterion(acceptance)],
    commit: commit(`plan(${PROFILE}): ${goal}`, target),
    design: designContract(
      artifact,
      designOwnedPaths ?? [target],
      designAcceptancePaths ?? [acceptancePath],
    ),
    regression: { scope, commands: commands ?? [command], paths, criteria: [0] },
    next,
  };
}

function completedScaffold(id?: any, next?: any, revision?: any, requirementsSha?: any) : any {
  return {
    id,
    status: "completed",
    role: "implementation",
    prerequisites: [],
    platform: "any",
    difficulty: "critical",
    verification_profile: "code",
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
    next: Array.isArray(next) ? [...next] : [next],
  };
}

function planMarkdown(title?: any, purpose?: any, requirements?: any, sequence?: any) : any {
  return `# ${title}

## Authority

This Plan belongs to the current reliable enterprise single-node release authority. Historical lifecycle state and receipts are not executable inputs.

## Supported Profile

- \`${PROFILE}\`

## Purpose

${purpose}

## Requirements

${requirements.map((item?: any) : any => `- **${item}**`).join("\n")}

## Execution

${sequence.map((item?: any, index?: any) : any => `${index + 1}. ${item}`).join("\n")}

## Acceptance Boundary

Only current source, current evidence, exact prerequisite receipts, and the canonical reducer may advance this Plan. Synthetic architecture evidence cannot promote release status.
`;
}

function requirementsMarkdown() : any {
  return `# Enterprise Single-Node Release Requirements

## Product Goal

Deliver a reliable single-node enterprise edition through Docker Compose, including fully offline installation, Linux x64 and ARM64 artifacts, an audited emergency administrator, independent backup and clean-host restore, N-1 upgrade rollback, local Prometheus observability, and versioned fail-isolated ports for optional identity, telemetry, and alert-delivery adapters.

## Supported Profile

- **REQ-ENT-SCOPE** — The public support matrix contains only \`${PROFILE}\`.
- **REQ-REL-BASELINE** — Manifest and DependencyMap remain the machine-readable current authority.
- **REQ-REL-PLAN-LIFECYCLE** — An isolated verification job initializes the ignored local Plan exactly once. Evidence-producing work, checkpoint completion, receipt reduction, and receipt consumption occur without another baseline rebuild; a reset after evidence exists is rejected.
- **REQ-REL-CANDIDATE-BINDING** — One immutable source-candidate identity binds source revision, repository tree, lockfile, release definition, public package inventory, supported profile, and report-owner inventory. Every derived package or container authority must bind that same candidate identity together with its own immutable artifact digests; evidence from another candidate cannot promote the release.
- **REQ-REL-RECEIPT-CURRENT** — Only receipts generated from the current source and graph may advance the release.
- **REQ-REL-PRIVACY** — Evidence and diagnostics must not expose machine identity, personal paths, secrets, or private runtime data.

## Delivery Stages

- **${AUTHORITY_STAGE.requirement} (${AUTHORITY_STAGE.code})** — ${AUTHORITY_STAGE.goal}
${CORE_STAGES.map((stage?: any) : any => `- **${stage.requirement} (${stage.code})** — ${stage.goal}`).join("\n")}
- **REQ-ENT-INTEGRATION-LIFECYCLE** — A disabled, unconfigured, invalid, slow, or unavailable third-party integration must not prevent bounded Core server startup or shutdown. Adapter work starts only after Core readiness and exposes typed degraded state.
- **${ADAPTER_RUNTIME_STAGE.requirement} (${ADAPTER_RUNTIME_STAGE.code})** — ${ADAPTER_RUNTIME_STAGE.goal}
- **REQ-ENT-U0** — In one fresh container created from a digest-pinned Ubuntu 24.04 image, reconstruct the exact E0 candidate, disable public-network access after admitted inputs are present, execute the complete delivery regression exactly once, and bind its sanitized reports to the candidate identity.
- **REQ-ENT-CROSS-SYSTEM-OFFLINE** — Transfer one signed, inventory-bound OCI bundle from a connected build and signing environment to a separate network-disabled clean target, where digest, signature, SBOM, provenance, and dependency completeness are verified without rebuilding.
- **REQ-ENT-FUNCTIONAL-RELEASE** — Reduce the local delivery and every development-environment simulation receipt into the mandatory functional-completeness release decision.

## Optional Real-Machine Verification

- Native Linux x64 verification starts only after functional acceptance and owns only its environment support claim.
- Native Linux ARM64 verification starts only after functional acceptance and owns only its environment support claim.
- Native macOS ARM64 verification starts only after functional acceptance and owns only its MCP connector environment support claim.
- Native Windows x64 verification starts only after functional acceptance and owns only its MCP connector environment support claim.
- Public-cloud verification starts only after functional acceptance and owns only the declared cloud environment support claim.
- Independent clean-host recovery starts only after functional acceptance and owns only its recovery environment support claim.

Missing, queued, ineligible, failed, or stale real-machine evidence cannot block or revoke the functional-completeness release receipt. Each real-machine workflow must consume that receipt before it can issue an environment support claim.

## Explicitly Unsupported

This release does not claim multi-node automatic failover, production-scale capacity, cross-region replication, cross-region failover, or RPO/RTO guarantees. Planned maintenance windows are allowed. Backup may use independent media but is not an automatic cross-region disaster-recovery service.

Authenticated forward-server delegation, external identity providers, remote telemetry exporters, alert webhooks, and other concrete third-party adapters are detachable capabilities. They require independent owner plans and enabled-path receipts; their absence cannot block or promote this Core profile. Core must reject or strip caller credentials at every audience boundary and must never silently treat original credentials as target authority.

## Deferred Work

Provider Trust remains staged and cannot enter the current functional release graph.
`;
}

function currentPlanMarkdown() : any {
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
- Authenticated forward-server delegation and concrete third-party adapter support.

These are not hidden acceptance requirements. They are future product directions and cannot block or promote this release.

## Core Dependency Graph

- **${AUTHORITY_STAGE.code} — ${AUTHORITY_STAGE.title}:** entry node. ${AUTHORITY_STAGE.goal}
${CORE_STAGES.map((stage?: any) : any => `- **${stage.code} — ${stage.title}:** ${stage.prerequisites.length === 0 ? "entry node" : `starts after ${stage.prerequisites.join(" and ")}`}. ${stage.goal}`).join("\n")}

## Concurrent Adapter Runtime Boundary

- **${ADAPTER_RUNTIME_STAGE.code} — ${ADAPTER_RUNTIME_STAGE.title}:** starts after E0 and may execute concurrently with every otherwise eligible Core node. ${ADAPTER_RUNTIME_STAGE.goal}

OIDC, OTLP, webhook, PostgreSQL, model-provider, gateway-framework, parser, provider, and datastore implementations use independent owner plans and receipts. They do not become Core prerequisites and cannot promote or block a Core receipt. P0 first replaces the reset-before-consume workflow with one non-destructive Plan lifecycle. E0 then freezes one candidate identity. After E2, emergency recovery, backup and restore, and Core observability may execute concurrently; only upgrade and rollback depends on backup and restore.

The delivery final validation joins E3, E5, E6, and A0 and executes the complete delivery regression exactly once in a fresh digest-pinned Ubuntu 24.04 container against the E0 candidate. Its receipt and the cross-system offline-transfer simulation feed the mandatory functional-release Plan. Native Linux x64, native Linux ARM64, native macOS ARM64, native Windows x64, public-cloud, and clean-host recovery Plans remain optional real-machine targets outside the mandatory DependencyMap. They must consume the functional receipt through the real-machine workflow and cannot block or revoke it.

## Blockers And Ownership

### Current Hard Blockers

- P0 must remove every reset between Plan initialization and receipt consumption, add the single Ubuntu-container closure command, and make CI and release workflows execute that closure before the functional-completeness gate.
- E0 must freeze one auditable candidate identity; later evidence with a different source tree, package inventory, or image digest is ineligible.

### Enterprise Capability Blockers

- E1 owns the offline dual-architecture package.
- E2 owns TLS, secrets, preflight, and safe diagnostics.
- E3 owns self-contained emergency administrator recovery.
- E4 owns independent backup and clean-host restore.
- E5 owns N-1 upgrade rollback.
- E6 owns local diagnostics, Prometheus metrics, and integration-state visibility.
- A0 owns the common bounded adapter task lifecycle and its startup/shutdown isolation contract.
- U0 delivery final validation owns the one complete regression in a fresh digest-pinned Ubuntu 24.04 container.
- Functional release acceptance owns mandatory receipt aggregation and closure of any currently confirmed P0/P1 security or data-integrity issue.
- The native Linux x64 Plan owns an optional x64 environment support claim.
- The native Linux ARM64 Plan owns an optional ARM64 environment support claim.
- The public-cloud Plan owns an optional claim for one declared Internet-reachable environment.
- The clean-host recovery Plan owns an optional claim for the second server environment and cross-host restore.

### Explicit Non-Blockers

Real-machine environment claims, cluster failover, production-scale capacity guarantees, regional disaster recovery, authenticated forward-server delegation, concrete third-party adapters, Provider Trust, and other Future Goals are outside the mandatory functional release graph. Their disabled, unavailable, queued, failed, or absent state is inert to the functional release receipt.

The Manifest is the machine-state authority. This document explains that state for people.
`;
}

async function writeFile(root?: any, relativePath?: any, content?: any) : Promise<any> {
  const target: any = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function build(repoRoot?: any) : Promise<any> {
  const revision: any = currentRevision(repoRoot);
  const plansRoot: any = path.join(repoRoot, "docs/plans");
  const targetRoot: any = path.join(plansRoot, ROOT);
  const manifestPath: any = path.join(plansRoot, "Manifest.json");
  const tempRoot: any = path.join(plansRoot, `.enterprise-single-node-${process.pid}`);
  requireCondition(
    !(await fs.stat(targetRoot).then(() : any => true, () : any => false)) &&
      !(await fs.stat(manifestPath).then(() : any => true, () : any => false)),
    `Current release Plan already exists; ${REPLACE_REFUSAL}`,
  );
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(tempRoot, { recursive: true });

  const rootRequirements: any = requirementsMarkdown();
  const requirementsSha: any = sha256(rootRequirements);

  const ids: Record<string, any> = {
    scaffold: EXISTING_NODE_IDS.scaffold,
    deliveryIntegration: EXISTING_NODE_IDS.deliveryIntegration,
    acceptanceIntegration: EXISTING_NODE_IDS.acceptanceIntegration,
    rootFinal: EXISTING_NODE_IDS.rootFinal,
    deliveryFinal: EXISTING_NODE_IDS.deliveryFinal,
    e7: EXISTING_NODE_IDS.e7,
    e7Final: EXISTING_NODE_IDS.e7Final,
  };
  const environmentIds: any = Object.fromEntries(EXTERNAL_PLANS.map((plan?: any) : any => [plan.key, {
    implementation: stableId(`${plan.key}-implementation`),
    final: stableId(`${plan.key}-final`),
    integration: stableId(`${plan.key}-integration`),
  }]));
  const stageIds: any = Object.fromEntries(DELIVERY_STAGES.map((stage?: any) : any => [
    stage.code,
    EXISTING_NODE_IDS[stage.code] ?? stableId(stage.code),
  ]));

  const rootRequirementsList: any[] = [...new Set<any>([
    "REQ-REL-BASELINE",
    "REQ-ENT-SCOPE",
    "REQ-REL-PLAN-LIFECYCLE",
    "REQ-REL-CANDIDATE-BINDING",
    "REQ-REL-RECEIPT-CURRENT",
    "REQ-REL-PRIVACY",
    ...DELIVERY_STAGES.map((stage?: any) : any => stage.requirement),
    "REQ-ENT-INTEGRATION-LIFECYCLE",
    "REQ-ENT-U0",
    ...SIMULATION_PLANS.map((plan?: any) : any => plan.requirement),
    "REQ-ENT-FUNCTIONAL-RELEASE",
  ])];
  const rootIntegrationStages: any[] = [
    {
      id: ids.deliveryIntegration,
      platform: "linux",
      goal: "Integrate the local and container delivery receipt.",
      description: "Scope: Closure: capability - integrate the exact self-contained delivery receipt into the root authority.",
      acceptance: "The local and container delivery receipt is current, exact, privacy-safe, and bound to this integration node.",
    },
    ...SIMULATION_PLANS.map((plan?: any) : any => ({
      id: environmentIds[plan.key].integration,
      platform: plan.platform,
      goal: `Integrate the ${plan.title} receipt.`,
      description: `Scope: Closure: environment - integrate the exact ${plan.directory} final receipt into the root authority.`,
      acceptance: `The ${plan.title} receipt is current, exact, privacy-safe, and bound to this integration node.`,
    })),
    {
      id: ids.acceptanceIntegration,
      platform: "linux",
      goal: "Integrate the functional release receipt.",
      description: "Scope: Closure: scenario - integrate the exact functional-completeness receipt into the root authority.",
      acceptance: "The functional release receipt is current, exact, privacy-safe, and bound to this integration node.",
    },
  ];
  const rootIntegrationNodes: any = rootIntegrationStages.map((stage?: any, index?: any) : any => pendingNode({
    id: stage.id,
    role: "evidence",
    platform: stage.platform,
    prerequisites: [index === 0 ? ids.scaffold : rootIntegrationStages[index - 1].id],
    next: [index === rootIntegrationStages.length - 1
      ? ids.rootFinal
      : rootIntegrationStages[index + 1].id],
    goal: stage.goal,
    description: stage.description,
    requirements: rootRequirementsList,
    acceptance: stage.acceptance,
    target: `docs/plans/${ROOT}/DependencyMap.json`,
    command: "npm run verify:better-plan",
  }));
  const rootNodes: any[] = [
    completedScaffold(ids.scaffold, ids.deliveryIntegration, revision, requirementsSha),
    ...rootIntegrationNodes,
    pendingNode({
      id: ids.rootFinal,
      role: "final_validation",
      platform: "linux",
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

  const deliverySharedRequirements: any[] = [
    "REQ-REL-BASELINE",
    "REQ-ENT-SCOPE",
    "REQ-REL-PLAN-LIFECYCLE",
    "REQ-REL-CANDIDATE-BINDING",
    "REQ-REL-RECEIPT-CURRENT",
    "REQ-REL-PRIVACY",
    ...BASELINE_CAPABILITIES.map((name?: any) : any => `REQ-BASELINE-${name}`),
    "REQ-ENT-INTEGRATION-LIFECYCLE",
  ];
  const deliveryRequirements: any[] = [...new Set<any>([
    ...deliverySharedRequirements,
    ...DELIVERY_STAGES.map((stage?: any) : any => stage.requirement),
    "REQ-ENT-U0",
  ])];
  const implementationStages: any[] = [AUTHORITY_STAGE, ...CORE_STAGES, ...PARALLEL_STAGES];
  const deliveryFinalPrerequisiteCodes: any = new Set<any>(["E3", "E5", "E6", "A0"]);
  const coreNodes: any = [AUTHORITY_STAGE, ...CORE_STAGES].map((stage?: any) : any => {
    const dependentStages: any = implementationStages
      .filter((candidate?: any) : any => candidate.prerequisites.includes(stage.code))
      .map((candidate?: any) : any => stageIds[candidate.code]);
    if (deliveryFinalPrerequisiteCodes.has(stage.code)) {
      dependentStages.push(ids.deliveryFinal);
    }
    return pendingNode({
      id: stageIds[stage.code],
      prerequisites: stage.prerequisites.map((code?: any) : any => stageIds[code]),
      next: dependentStages.length > 0 ? dependentStages : [ids.deliveryFinal],
      goal: stage.goal,
      description: `Scope: Closure: capability - ${stage.code} ${stage.slug}; verify the stage acceptance boundary.`,
      requirements: [...new Set<any>([...deliverySharedRequirements, stage.requirement])],
      acceptance: stage.acceptance,
      target: stage.target,
      commands: stage.commands,
      paths: stage.paths,
      designOwnedPaths: stage.designOwnedPaths,
      designAcceptancePaths: stage.designAcceptancePaths,
    });
  });
  const adapterRuntimeNode: any = pendingNode({
    id: stageIds[ADAPTER_RUNTIME_STAGE.code],
    prerequisites: ADAPTER_RUNTIME_STAGE.prerequisites.map((code?: any) : any => stageIds[code]),
    next: [ids.deliveryFinal],
    goal: ADAPTER_RUNTIME_STAGE.goal,
    description: `Scope: Closure: runtime boundary - ${ADAPTER_RUNTIME_STAGE.code} ${ADAPTER_RUNTIME_STAGE.slug}; supervise optional integration tasks after Core readiness and keep process admission and teardown independent.`,
    requirements: [...new Set<any>([...deliverySharedRequirements, ADAPTER_RUNTIME_STAGE.requirement])],
    acceptance: ADAPTER_RUNTIME_STAGE.acceptance,
    target: ADAPTER_RUNTIME_STAGE.target,
    commands: ADAPTER_RUNTIME_STAGE.commands,
    paths: ADAPTER_RUNTIME_STAGE.paths,
  });
  const deliveryNodes: any[] = [...coreNodes, adapterRuntimeNode];
  deliveryNodes.push(pendingNode({
    id: ids.deliveryFinal,
    role: "final_validation",
    platform: "linux",
    prerequisites: [...deliveryFinalPrerequisiteCodes].map((code?: any) : any => stageIds[code]),
    goal: "Validate the exact enterprise candidate in one fresh Ubuntu container and reduce its delivery receipt.",
    description: "Scope: Closure: module - reconstruct the E0 candidate in a digest-pinned Ubuntu 24.04 container, execute the complete delivery regression once, and reduce one exact receipt without resetting Plan state.",
    requirements: [...new Set<any>([...deliveryRequirements, "REQ-ENT-U0"])],
    acceptance: "P0 and E0-E6 and A0 are complete and current; one fresh digest-pinned Ubuntu 24.04 container proves the exact E0 candidate with public-network access disabled after admitted inputs are present; the complete delivery regression runs exactly once; optional integration unavailability cannot block bounded Core startup or shutdown; sanitized evidence binds the source tree, package inventory, image digest, Plan graph, and final receipt.",
    target: "tools/server-scripts/verify-enterprise-single-node-ubuntu-container.ts",
    command: "npm run verify:enterprise-single-node:ubuntu-container",
    scope: "full",
    paths: [".github/workflows", "docker-compose.yml", "package.json", "package-lock.json", "docs/plans", "tools/plan", "tools/server-scripts"],
  }));

  const environmentSharedRequirements: any[] = [
    "REQ-ENT-SCOPE",
    "REQ-REL-PLAN-LIFECYCLE",
    "REQ-REL-CANDIDATE-BINDING",
    "REQ-REL-RECEIPT-CURRENT",
    "REQ-REL-PRIVACY",
    "REQ-ENT-U0",
  ];
  const environmentNodes: any = Object.fromEntries(EXTERNAL_PLANS.map((plan?: any) : any => {
    const planIds: any = environmentIds[plan.key];
    const nodes: any[] = [
      pendingNode({
        id: planIds.implementation,
        prerequisites: [],
        next: [planIds.final],
        platform: plan.platform,
        goal: plan.goal,
        description: `Scope: Closure: environment - execute only the ${plan.title} acceptance contract against the exact U0 candidate.`,
        requirements: [...environmentSharedRequirements, plan.requirement],
        acceptance: plan.acceptance,
        target: plan.paths[0],
        command: plan.command,
        paths: plan.paths,
      }),
      pendingNode({
        id: planIds.final,
        role: "final_validation",
        prerequisites: [planIds.implementation],
        platform: plan.platform,
        goal: `Reduce the ${plan.title} receipt.`,
        description: `Scope: Closure: evidence - reduce existing ${plan.title} evidence without rebuilding the candidate or rerunning another environment.`,
        requirements: [...environmentSharedRequirements, plan.requirement],
        acceptance: `${plan.acceptance} The reducer accepts only evidence from this declared environment and emits one same-candidate final receipt.`,
        target: "build/reports",
        command: plan.command,
        scope: "full",
        paths: plan.paths,
      }),
    ];
    return [plan.key, nodes];
  }));

  const acceptanceRequirements: any[] = [
    ...environmentSharedRequirements,
    ...SIMULATION_PLANS.map((plan?: any) : any => plan.requirement),
    "REQ-ENT-FUNCTIONAL-RELEASE",
  ];
  const acceptanceNodes: any[] = [
    pendingNode({
      id: ids.e7,
      prerequisites: [],
      next: [ids.e7Final],
      platform: "linux",
      goal: "Aggregate the accepted local delivery and development-environment simulation receipts.",
      description: "Scope: Closure: scenario - join functional-completeness receipts for the same immutable candidate without requiring a real machine or network server.",
      requirements: acceptanceRequirements,
      acceptance: "The U0 delivery receipt and every required development-environment simulation receipt bind the same source tree, package inventory, and immutable candidate identity; no real-machine receipt is required.",
      target: "tools/server-scripts/verify-platform-acceptance.ts",
      command: "npm run verify:acceptance:plan",
      paths: ["tools/registry/release-definition.registry.json", "tools/server-scripts", "tests/vitest/server", "docs/plans"],
    }),
    pendingNode({
      id: ids.e7Final,
      role: "final_validation",
      platform: "linux",
      prerequisites: [ids.e7],
      goal: "Reduce the same-candidate functional-completeness release decision.",
      description: "Scope: Closure: scenario - reduce only mandatory functional receipts without running a real machine or network server.",
      requirements: acceptanceRequirements,
      acceptance: "All mandatory functional receipts are current and same-candidate; no confirmed P0/P1 security or data-integrity issue remains open; the canonical reducer emits the functional-completeness release receipt independently of optional real-machine state.",
      target: "build/reports",
      command: "npm run verify:better-plan",
      scope: "full",
      paths: [".github/workflows/release.yml", "build/reports", "docs/plans", "tools/plan", "tools/server-scripts"],
    }),
  ];

  const dependencyMap: Record<string, any> = {
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
        children: [
          DELIVERY,
          OFFLINE_TRANSFER,
          ACCEPTANCE,
        ],
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
      ...SIMULATION_PLANS.map((plan?: any) : any => {
        const planIds: any = environmentIds[plan.key];
        const prerequisiteReceipts: any[] = [{
          plan: DELIVERY,
          node_id: ids.deliveryFinal,
          kind: "final_validation",
          profiles: [PROFILE],
        }];
        return {
          directory: plan.directory,
          parent: ROOT,
          parent_contract_node_id: ids.scaffold,
          parent_integrations: [{
            child_final_node_id: planIds.final,
            parent_node_id: planIds.integration,
            profiles: [PROFILE],
          }],
          final_validations: [{ node_id: planIds.final, profiles: [PROFILE] }],
          prerequisite_receipts: prerequisiteReceipts,
          children: [],
          accepted_final_receipts: {},
        };
      }),
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
        prerequisite_receipts: [
          {
            plan: DELIVERY,
            node_id: ids.deliveryFinal,
            kind: "final_validation",
            profiles: [PROFILE],
          },
          ...SIMULATION_PLANS.map((plan?: any) : any => ({
            plan: plan.directory,
            node_id: environmentIds[plan.key].final,
            kind: "final_validation",
            profiles: [PROFILE],
          })),
        ],
        children: [],
        accepted_final_receipts: {},
      },
    ],
  };

  const files: any = new Map<any, any>([
    ["Requirements.md", rootRequirements],
    ["CurrentPlan.md", currentPlanMarkdown()],
    ["Architecture.md", "# Architecture\n\nThe mandatory release architecture is one self-contained Docker Compose Core with explicit backup and TLS boundaries. Core security, platform-truth, delivery-authority, code-organization, simulation, and failure-injection checks belong to the functional-completeness gate. Cross-system offline transfer is simulated in its mandatory prerequisite Plan and reduced into a receipt consumed by that gate. Native Linux x64, native Linux ARM64, each network server environment, and cross-host recovery have separate optional Plans and environment receipts outside the mandatory DependencyMap. Each optional workflow consumes the immutable functional receipt; no optional result can block or revoke it. The ignored local Plan is initialized once per isolated verification job and is never reset after evidence exists.\n"],
    ["Evidence.md", "# Evidence\n\nOnly evidence bound to the E0 candidate identity may advance functional acceptance. U0 requires one fresh digest-pinned Ubuntu 24.04 container and records the only complete delivery regression. Cross-system offline transfer is a required development-environment simulation. Native Linux x64, native Linux ARM64, public-cloud, and independent clean-host recovery evidence may issue separate environment support claims only after functional acceptance; missing or failed optional evidence cannot affect the functional receipt.\n"],
    ["Validation.md", "# Validation\n\nInitialize the ignored local Plan exactly once. Run focused verification for P0, each Core node, and A0 without rebuilding the baseline. Prove absent, invalid, slow, and unavailable optional adapters cannot block bounded Core startup or shutdown. Run the complete delivery regression exactly once in the U0 Ubuntu container, run the cross-system offline-transfer simulation, and reduce the mandatory functional receipt. Real-machine workflows run separately with prepare, start, verify, stop, cleanup, and reduce phases after consuming that receipt.\n"],
    ["Checkpoints.json", jsonText(rootNodes)],
    ["DependencyMap.json", jsonText(dependencyMap)],
    ["enterprise-single-node/Plan.md", planMarkdown(
      "Enterprise Single-Node Delivery",
      "Reassemble the Plan execution authority, deliver E0-E6 through explicit capability dependencies, keep A0 concurrent, and close the exact candidate in one Ubuntu-container final validation.",
      deliveryRequirements,
      [
        `${AUTHORITY_STAGE.code}: ${AUTHORITY_STAGE.title}`,
        ...CORE_STAGES.map((stage?: any) : any => `${stage.code}: ${stage.title}`),
        `${ADAPTER_RUNTIME_STAGE.code}: ${ADAPTER_RUNTIME_STAGE.title}, eligible after E0 and independent of other Core capability branches`,
        "U0: join E3, E5, E6, and A0; execute the one complete delivery regression in a fresh digest-pinned Ubuntu 24.04 container; reduce the delivery final receipt without resetting Plan state.",
      ],
    )],
    ["enterprise-single-node/Checkpoints.json", jsonText(deliveryNodes)],
    ...EXTERNAL_PLANS.flatMap((plan?: any) : any => {
      const relativeDirectory: any = plan.directory.slice(`${ROOT}/`.length);
      return [
        [`${relativeDirectory}/Plan.md`, planMarkdown(
          plan.title,
          plan.goal,
          [...environmentSharedRequirements, plan.requirement],
          [
            "Consume every declared prerequisite receipt for the exact U0 candidate.",
            plan.acceptance,
            "Reduce one environment-owned receipt without executing another system or server environment.",
          ],
        )],
        [`${relativeDirectory}/Checkpoints.json`, jsonText(environmentNodes[plan.key])],
      ];
    }),
    ["functional-release-acceptance/Plan.md", planMarkdown("Functional Completeness Release Acceptance", "Aggregate every mandatory local, container, and development-environment simulation receipt.", acceptanceRequirements, ["Consume every mandatory same-candidate functional receipt.", "Reject missing, stale, rebuilt, substituted, or cross-candidate functional evidence.", "Reduce one functional-completeness release receipt without requiring any real machine or network server."])],
    ["functional-release-acceptance/Checkpoints.json", jsonText(acceptanceNodes)],
  ]);
  for (const [relativePath, content] of files) await writeFile(tempRoot, relativePath, content);

  const manifestEntries: any[] = [
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
      status: "in_progress",
      title: "Enterprise Single-Node Delivery",
      directory: DELIVERY,
      source_files: [`docs/plans/${DELIVERY}/Plan.md`],
      goal: "Deliver dependency-based Core operations branches and a concurrent fail-isolated adapter lifecycle boundary.",
      description: "Capability delivery plan for the enterprise single-node profile; concrete external integration work belongs to independent owner plans and cannot gate Core process startup, shutdown, or release.",
      checkpoints: `${DELIVERY}/Checkpoints.json`,
    },
    ...EXTERNAL_PLANS.map((plan?: any) : any => ({
      id: stableId(`manifest-${plan.key}`),
      status: "pending",
      title: plan.title,
      directory: plan.directory,
      source_files: [`docs/plans/${plan.directory}/Plan.md`],
      goal: plan.goal,
      description: plan.directory === OFFLINE_TRANSFER
        ? "Mandatory development-environment simulation receipt owner for offline transfer."
        : `Optional real-machine receipt owner for ${plan.title}; it cannot block or revoke functional acceptance.`,
      checkpoints: `${plan.directory}/Checkpoints.json`,
    })),
    {
      id: stableId("manifest-acceptance"),
      status: "pending",
      title: "Functional Completeness Release Acceptance",
      directory: ACCEPTANCE,
      source_files: [`docs/plans/${ACCEPTANCE}/Plan.md`],
      goal: "Aggregate every mandatory same-candidate functional and simulation receipt.",
      description: "Mandatory functional release reduction without real-machine execution.",
      checkpoints: `${ACCEPTANCE}/Checkpoints.json`,
    },
  ];

  requireCondition(
    !(await fs.stat(targetRoot).then(() : any => true, () : any => false)) &&
      !(await fs.stat(manifestPath).then(() : any => true, () : any => false)),
    `Current release Plan appeared during initialization; ${REPLACE_REFUSAL}`,
  );
  await fs.rename(tempRoot, targetRoot);
  await fs.writeFile(manifestPath, jsonText(manifestEntries), { flag: "wx" });

  process.stdout.write(jsonText({
    ok: true,
    profile: PROFILE,
    plans: manifestEntries.length,
    nodes: rootNodes.length + deliveryNodes.length +
      (Object.values(environmentNodes) as any[]).reduce((total?: any, nodes?: any) : any => total + nodes.length, 0) +
      acceptanceNodes.length,
    accepted_receipts: 0,
    next: `${DELIVERY}:${stageIds.P0}`,
  }));
}

const argv: any = process.argv.slice(2);
requireCondition(
  !argv.some((value?: any) : any => value === "--replace" || value.startsWith("--replace=")),
  REPLACE_REFUSAL,
);
requireCondition(
  argv.length <= 1 && (argv.length === 0 || !argv[0].startsWith("-")),
  "Usage: rebuild-current-plan-baseline.ts [repo-root]",
);
const repoRoot: any = path.resolve(argv[0] ?? defaultRepoRoot);
await build(repoRoot);
