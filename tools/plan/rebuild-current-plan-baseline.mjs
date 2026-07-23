#!/usr/bin/env node

import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { PLAN_PROFILES } from "./plan-dependency-map.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(modulePath), "../..");
const HIGH_PROFILES = Object.freeze(["ha", "regional-dr", "scale"]);
const REBUILD_RECORDED_AT = new Date().toISOString();

const BASELINE_CAPABILITIES = Object.freeze([
  ["upstream-gateway", "tests/vitest/server/upstream-gateway-ssrf.test.mjs"],
  ["downstream-mcp", "tests/vitest/server/upstream-mcp-gateway.test.mjs"],
  ["strategy-management", "tests/vitest/server/strategy-management-provider.test.mjs"],
  ["enterprise-governance", "tests/vitest/server/operation-permission.test.mjs"],
  ["console-administration", "tests/vitest/server/console-domain-services-ports.test.mjs"],
  ["container-deployment", "tests/vitest/server/deployment-lifecycle-state-machine.test.mjs"],
  ["storage", "tests/vitest/server/storage-provider.test.mjs"],
  ["jobs", "tests/vitest/server/queued-job-workflow-provider.test.mjs"],
  ["external-plugin-packaging-loading", "tests/vitest/server/plugin-runtime.test.mjs"],
  ["agent-gateway-model-routing", "tests/vitest/server/model-provider-runtime.test.mjs"],
  ["core-workspace-assets-governance", "tests/vitest/server/workspace-governance.test.mjs"],
]);

const SCALE_STAGES = Object.freeze([
  {
    slug: "m0-profile-contract",
    title: "M0 Deployment Profile Contract",
    label: "REQ-SCALE-M0",
    goal: "Implement fail-closed local, HA, scale, and regional-DR deployment profile contracts.",
    dependencies: [],
  },
  {
    slug: "algorithmic-resource-discipline",
    title: "Algorithmic Resource Discipline",
    label: "REQ-SCALE-ARD",
    goal: "Prove bounded algorithms, scheduling, caching, lock ownership, and memory budgets.",
    dependencies: ["m0-profile-contract"],
  },
  {
    slug: "m1-state-authority",
    title: "M1 Shared State Authority And Migration",
    label: "REQ-SCALE-M1",
    goal: "Migrate shared correctness state to one transactional multi-replica authority.",
    dependencies: ["algorithmic-resource-discipline"],
  },
  {
    slug: "m2-object-storage",
    title: "M2 Object Storage",
    label: "REQ-SCALE-M2",
    goal: "Move shared object bytes behind governed object storage without changing ownership authority.",
    dependencies: ["algorithmic-resource-discipline"],
  },
  {
    slug: "m3-event-delivery",
    title: "M3 Durable Event Delivery",
    label: "REQ-SCALE-M3",
    goal: "Implement transactional outbox and bounded durable delivery for asynchronous work.",
    dependencies: ["m1-state-authority", "m2-object-storage"],
  },
  {
    slug: "m4-gateway-valkey",
    title: "M4 Gateway And Valkey",
    label: "REQ-SCALE-M4",
    goal: "Implement edge traffic governance and non-authoritative distributed caching.",
    dependencies: ["algorithmic-resource-discipline", "m1-state-authority", "m2-object-storage"],
  },
  {
    slug: "m5-roles-elasticity",
    title: "M5 Runtime Roles And Elasticity",
    label: "REQ-SCALE-M5",
    goal: "Separate control, data, and worker roles with fenced, bounded elasticity.",
    dependencies: ["m3-event-delivery", "m4-gateway-valkey"],
  },
  {
    slug: "m6-observability",
    title: "M6 Observability Pipeline",
    label: "REQ-SCALE-M6",
    goal: "Implement bounded telemetry export, storage, alerts, and privacy-safe operational evidence.",
    dependencies: ["m5-roles-elasticity"],
  },
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
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
  return {
    checked,
    text,
    ...(evidenceRefs ? { evidence_refs: evidenceRefs } : {}),
  };
}

function designContract(artifact, ownedPath, acceptancePath = "tools/plan/rebuild-current-plan-baseline.mjs") {
  return {
    artifact,
    owned_paths: [ownedPath],
    scaffold_paths: [ownedPath],
    acceptance_paths: [acceptancePath],
    symbols: [],
    interfaces: [],
    dependencies: [],
    decisions: {
      composition: "one closure with one current authority",
      algorithms: "bounded validation and deterministic reduction",
      data_structures: "immutable profile sets and keyed final receipts",
      state: "one DependencyMap and one checkpoint owner",
      isolation: "profile-scoped receipts and disjoint acceptance evidence",
      concurrency: "focused closures before the single declared full regression",
    },
    test_seams: ["declared regression command and exact receipt boundary"],
  };
}

function node({
  id = randomUUID(),
  status = "pending",
  role = "implementation",
  prerequisites = [],
  next = [],
  goal,
  description,
  requirements,
  acceptance,
  commitValue,
  regression,
  designPath,
  designArtifact = designPath,
}) {
  const resolvedDesignPath = designPath ?? `build/plan-design/${id}.json`;
  const resolvedDesignArtifact = designArtifact ?? resolvedDesignPath;
  return {
    id,
    status,
    role,
    prerequisites,
    platform: "any",
    difficulty: role === "final_validation" ? "deep" : "high",
    goal,
    description,
    requirements,
    acceptance_criteria: acceptance,
    commit: commitValue,
    ...(status !== "completed" && (role === "implementation" || role === "final_validation")
      ? { design: designContract(resolvedDesignArtifact, resolvedDesignPath) }
      : {}),
    ...(regression ? { regression } : {}),
    next,
  };
}

function focusedRegression(command, paths, criteria = [0]) {
  return { scope: "focused", commands: [command], paths, criteria };
}

function fullRegression() {
  return { scope: "full", commands: ["npm test"], paths: ["apps", "packages", "tools", "tests"], criteria: [0] };
}

function planMarkdown({ title, labels, purpose, profiles = PLAN_PROFILES, sequence = [] }) {
  return `# ${title}

## Authority

This Plan is part of the rebuilt Current Baseline authority. Historical lifecycle state and receipts are not executable inputs.

## Profiles

${profiles.map((profile) => `- \`${profile}\``).join("\n")}

## Requirements

${labels.map((label) => `- **${label}** — ${purpose}`).join("\n")}

## Execution

${sequence.length > 0 ? sequence.map((step, index) => `${index + 1}. ${step}`).join("\n") : "Execute the pending implementation node, its focused regression, and its final validation in order."}

## Acceptance Boundary

Only current source, current evidence, exact profile-scoped prerequisite receipts, and the canonical reducer may advance this Plan. No profile consumes or promotes another profile's final receipt.
`;
}

function rootDocuments() {
  const labels = [
    "REQ-REL-BASELINE",
    "REQ-REL-PROFILE-ISOLATION",
    "REQ-REL-RECEIPT-CURRENT",
    "REQ-REL-PRIVACY",
    ...PLAN_PROFILES.map((profile) => `REQ-REL-ACCEPT-${profile.toUpperCase().replace("-", "-")}`),
    ...SCALE_STAGES.map((stage) => stage.label),
    "REQ-SCALE-M7-HA",
    "REQ-SCALE-M7-SCALE",
    "REQ-SCALE-M7-REGIONAL-DR",
  ];
  return {
    "Requirements.md": `# Current Release Requirements

${labels.map((label) => `- **${label}** — Current source and profile-scoped proof are the only release authority.`).join("\n")}

The four profiles are \`local\`, \`ha\`, \`scale\`, and \`regional-dr\`. Each profile has an independent final-validation node and receipt. The local profile consumes only Current Baseline and local acceptance evidence. HA, scale, and regional-DR consume the shared high-concurrency receipt plus only their matching M7 capacity/fault receipt.
`,
    "Architecture.md": `# Current Release Architecture

The dependency graph is the executable architecture authority. Current Baseline feeds all profiles. M0 through M6 and Algorithmic Resource Discipline feed the shared high-concurrency final. Each M7 Plan consumes that shared final and produces one profile-specific capacity/fault claim. Release Acceptance and the root each reduce four disjoint profile branches.
`,
    "Evidence.md": `# Current Release Evidence

Historical receipts are intentionally excluded. Evidence must be generated from a clean worktree at the revision recorded by a v4 Plan receipt. Capacity, memory, and fault evidence run in independent processes and write independent reports.
`,
    "Validation.md": `# Current Release Validation

Run the canonical Better Plan source and label checks, the project dependency validator, current receipt proof verification, and privacy hygiene before node selection. Run focused regression per implementation closure and one complete Core regression at the shared high-concurrency regression node.
`,
    labels,
  };
}

function highConcurrencyDocument() {
  return `# 高并发执行权威

## 当前定位

本文档是 M0–M7 与 Algorithmic Resource Discipline 的当前可执行规划权威，不引用旧 Jobs、Observability 或历史计划状态作为当前事实源。所有节点均已接入 Manifest、Checkpoints 和 DependencyMap。

## 固定顺序

1. M0 档位契约；
2. Algorithmic Resource Discipline；
3. M1 状态权威与迁移、M2 对象存储；
4. M3 事件投递、M4 Gateway 与 Valkey；
5. M5 运行角色与弹性；
6. M6 可观测性；
7. 一次完整 Core 回归；
8. HA、scale、regional-DR 各自独立的 M7 capacity/fault 验收。

Gateway 的资源调度证据必须消费 Algorithmic Resource Discipline 的当前回执。M7 仅形成最终容量与故障声明，不承担普通 focused closure。容量、内存和故障验证必须在独立新进程中运行，并写入互不复用的独立报告。

## 需求标签

${["REQ-SCALE-M0", "REQ-SCALE-ARD", "REQ-SCALE-M1", "REQ-SCALE-M2", "REQ-SCALE-M3",
  "REQ-SCALE-M4", "REQ-SCALE-M5", "REQ-SCALE-M6", "REQ-SCALE-M7-HA", "REQ-SCALE-M7-SCALE",
  "REQ-SCALE-M7-REGIONAL-DR"].map((label) => `- **${label}**`).join("\n")}
`;
}

async function legacySummary(planRoot, revision) {
  let manifest = [];
  let dependencyMap = { plans: [] };
  const stateFiles = [];
  try {
    manifest = JSON.parse(await fs.readFile(path.join(planRoot, "Manifest.json"), "utf8"));
    dependencyMap = JSON.parse(await fs.readFile(
      path.join(planRoot, "end-to-end-release", "DependencyMap.json"),
      "utf8",
    ));
    const pending = [planRoot];
    while (pending.length > 0) {
      const directory = pending.pop();
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(absolutePath);
        else if (entry.name === "Manifest.json" || entry.name === "Checkpoints.json" ||
          entry.name === "DependencyMap.json") stateFiles.push(absolutePath);
      }
    }
  } catch {
    // A missing or malformed legacy tree is summarized as an empty, non-authoritative input.
  }
  let checkpointCount = 0;
  for (const manifestPlan of manifest) {
    try {
      const nodes = JSON.parse(await fs.readFile(
        path.join(planRoot, manifestPlan.checkpoints),
        "utf8",
      ));
      checkpointCount += Array.isArray(nodes) ? nodes.length : 0;
    } catch {
      // Count only readable historical nodes.
    }
  }
  const receipts = (dependencyMap.plans ?? []).flatMap((plan) => [
    ...(plan.accepted_final_receipt ? [plan.accepted_final_receipt] : []),
    ...Object.values(plan.accepted_final_receipts ?? {}),
  ]).filter(Boolean);
  const staleCommitBindings = receipts.filter((receipt) =>
    receipt.repository_revision !== revision || receipt.source_revision !== revision).length;
  const aggregateDigest = sha256((await Promise.all(stateFiles.sort().map(async (filePath) =>
    sha256(await fs.readFile(filePath))))).join(""));
  return {
    schema_version: "licomesh.plan-baseline-migration-summary.v1",
    historical_authority_retained: false,
    legacy_state_file_count: stateFiles.length,
    legacy_plan_count: manifest.length,
    legacy_checkpoint_count: checkpointCount,
    legacy_receipt_count: receipts.length,
    stale_commit_binding_count: staleCommitBindings,
    legacy_state_aggregate_sha256: aggregateDigest,
  };
}

function ownerPlan(stage, highContractId, stageFinals, highIntegrations) {
  const directory = `end-to-end-release/high-concurrency/${stage.slug}`;
  const implementationId = randomUUID();
  const finalId = randomUUID();
  const planText = planMarkdown({
    title: stage.title,
    labels: [stage.label],
    purpose: stage.goal,
    profiles: HIGH_PROFILES,
  });
  const checkpoints = [
    node({
      id: implementationId,
      goal: stage.goal,
      description: `Scope: Closure: capability - ${stage.title}; implement only this scale-stage closure and remove superseded paths in the same migration.`,
      requirements: [stage.label],
      acceptance: [criterion(`${stage.title} focused regression and current evidence pass.`)],
      commitValue: commit(`feat(scale): implement ${stage.slug}`, "apps, packages, tools, tests, docs", null),
      designPath: `docs/plans/${directory}/Plan.md`,
      regression: focusedRegression(
        "npx vitest run tests/vitest/server/plan-execution-eligibility.test.mjs",
        ["apps", "packages", "tools", "tests"],
      ),
      next: [finalId],
    }),
    node({
      id: finalId,
      role: "final_validation",
      prerequisites: [implementationId],
      goal: `Validate ${stage.title}.`,
      description: `Scope: Closure: scenario - ${stage.title} final validation; reduce current focused evidence without making a capacity claim.`,
      requirements: [stage.label],
      acceptance: [criterion(`${stage.title} final evidence is current, privacy-safe, and profile-scoped.`)],
      commitValue: commit(`test(scale): validate ${stage.slug}`, "build/reports", null),
      designPath: `docs/plans/${directory}/Plan.md`,
      regression: {
        scope: "full",
        commands: ["npm run verify:better-plan"],
        paths: ["tools/plan", "docs/plans"],
        criteria: [0],
      },
    }),
  ];
  const prerequisiteReceipts = stage.dependencies.map((dependency) => ({
    plan: `end-to-end-release/high-concurrency/${dependency}`,
    node_id: stageFinals.get(dependency),
    kind: "final_validation",
    profiles: [...HIGH_PROFILES],
  }));
  stageFinals.set(stage.slug, finalId);
  return {
    directory,
    title: stage.title,
    planText,
    checkpoints,
    mapPlan: {
      directory,
      parent: "end-to-end-release/high-concurrency",
      parent_contract_node_id: highContractId,
      parent_integrations: [{
        child_final_node_id: finalId,
        parent_node_id: highIntegrations.get(stage.slug),
        profiles: [...HIGH_PROFILES],
      }],
      final_validations: [{ node_id: finalId, profiles: [...HIGH_PROFILES] }],
      prerequisite_receipts: prerequisiteReceipts,
      children: [],
      accepted_final_receipts: {},
    },
    sourceFiles: [`docs/plans/${directory}/Plan.md`, `docs/plans/${directory}/Checkpoints.json`],
  };
}

function m7Plan(profile, rootContractId, rootIntegrationId, highFinalId) {
  const slug = profile === "regional-dr" ? "m7-regional-dr" : `m7-${profile}`;
  const label = `REQ-SCALE-M7-${profile.toUpperCase().replace("-", "-")}`;
  const directory = `end-to-end-release/${slug}`;
  const capacityId = randomUUID();
  const finalId = randomUUID();
  const planText = planMarkdown({
    title: `M7 ${profile} Capacity And Fault Acceptance`,
    labels: [label],
    purpose: `Produce only the ${profile} capacity and fault declaration from independent processes and reports.`,
    profiles: [profile],
    sequence: [
      "Start a fresh capacity-test process and write its dedicated report.",
      "Start a fresh memory-bound test process and write its dedicated report.",
      "Start a fresh fault-injection process and write its dedicated report.",
      "Reduce only this profile's evidence into the final receipt.",
    ],
  });
  return {
    directory,
    title: `M7 ${profile} Capacity And Fault Acceptance`,
    planText,
    checkpoints: [
      node({
        id: capacityId,
        goal: `Run independent ${profile} capacity, memory, and fault acceptance.`,
        description: `Scope: Closure: scenario - ${profile} M7 capacity and fault acceptance; own only the terminal capacity/fault claim and three independent reports.`,
        requirements: [label],
        acceptance: [
          criterion("Capacity verification ran in a fresh process and owns a dedicated report."),
          criterion("Memory verification ran in a fresh process and owns a dedicated report."),
          criterion("Fault verification ran in a fresh process and owns a dedicated report."),
        ],
        commitValue: commit(`test(scale): accept ${profile} capacity and faults`, "tools, tests, build/reports", null),
        designPath: `docs/plans/${directory}/Plan.md`,
        regression: focusedRegression(
          "npx vitest run tests/vitest/server/plan-execution-eligibility.test.mjs",
          ["tools", "tests", "build/reports"],
          [0, 1, 2],
        ),
        next: [finalId],
      }),
      node({
        id: finalId,
        role: "final_validation",
        prerequisites: [capacityId],
        goal: `Reduce ${profile} M7 evidence.`,
        description: `Scope: Closure: scenario - ${profile} M7 final declaration; make no claim for another profile.`,
        requirements: [label],
        acceptance: [criterion(`Only ${profile} evidence is reduced and no cross-profile receipt is consumed.`)],
        commitValue: commit(`test(scale): reduce ${profile} M7 receipt`, "build/reports", null),
        designPath: `docs/plans/${directory}/Plan.md`,
        regression: fullRegression(),
      }),
    ],
    mapPlan: {
      directory,
      parent: "end-to-end-release",
      parent_contract_node_id: rootContractId,
      parent_integrations: [{
        child_final_node_id: finalId,
        parent_node_id: rootIntegrationId,
        profiles: [profile],
      }],
      final_validations: [{ node_id: finalId, profiles: [profile] }],
      prerequisite_receipts: [{
        plan: "end-to-end-release/high-concurrency",
        node_id: highFinalId,
        kind: "final_validation",
        profiles: [profile],
      }],
      children: [],
      accepted_final_receipts: {},
    },
    finalId,
    sourceFiles: [`docs/plans/${directory}/Plan.md`, `docs/plans/${directory}/Checkpoints.json`],
  };
}

async function buildWorkspace(repoRoot, revision) {
  const rootDirectory = "end-to-end-release";
  const rootContractId = randomUUID();
  const rootFinals = new Map(PLAN_PROFILES.map((profile) => [profile, randomUUID()]));
  const rootIntegrations = new Map([
    ["current-baseline", randomUUID()],
    ["high-concurrency", randomUUID()],
    ["m7-ha", randomUUID()],
    ["m7-scale", randomUUID()],
    ["m7-regional-dr", randomUUID()],
    ["release-local", randomUUID()],
    ["release-ha", randomUUID()],
    ["release-scale", randomUUID()],
    ["release-regional-dr", randomUUID()],
  ]);

  const baselineDirectory = `${rootDirectory}/current-baseline`;
  const baselineScaffoldId = randomUUID();
  const baselineFinalId = randomUUID();
  const baselineLabels = BASELINE_CAPABILITIES.map(([capability]) =>
    `REQ-BASELINE-${capability.toUpperCase().replaceAll("-", "-")}`);
  const baselinePlanText = planMarkdown({
    title: "Current Baseline Plan",
    labels: baselineLabels,
    purpose: "Verify one current capability-matrix row with its existing minimal focused test.",
  });
  const baselineNodes = BASELINE_CAPABILITIES.map(([capability, testPath], index) => {
    const id = randomUUID();
    return node({
      id,
      prerequisites: [baselineScaffoldId],
      next: [baselineFinalId],
      goal: `Verify the current ${capability} capability baseline.`,
      description: `Scope: Closure: capability - ${capability} current baseline; run the existing minimal verifier without implementing new runtime behavior.`,
      requirements: [baselineLabels[index]],
      acceptance: [criterion(`${capability} minimal focused verification passes against current source.`)],
      commitValue: commit(`test(plan): verify ${capability} baseline`, testPath, null),
      regression: focusedRegression(`npx vitest run ${testPath}`, [testPath]),
    });
  });
  const baselineScaffoldTextHash = sha256(baselinePlanText);
  const baselineCheckpoints = [
    node({
      id: baselineScaffoldId,
      status: "completed",
      role: "architecture_scaffold",
      next: baselineNodes.map((entry) => entry.id),
      goal: "Define the Current Baseline capability matrix and verification ownership.",
      description: "Current planning scaffold only; no runtime implementation or historical receipt is imported.",
      requirements: baselineLabels,
      acceptance: [criterion("Current Baseline maps exactly eleven capability checks.", true, [{
        type: "file",
        path: `docs/plans/${baselineDirectory}/Plan.md`,
        sha256: baselineScaffoldTextHash,
        recorded_at: REBUILD_RECORDED_AT,
      }])],
      commitValue: commit("docs(plan): define current baseline", `docs/plans/${baselineDirectory}/Plan.md`, revision),
    }),
    ...baselineNodes,
    node({
      id: baselineFinalId,
      role: "final_validation",
      prerequisites: baselineNodes.map((entry) => entry.id),
      goal: "Reduce the eleven current capability checks and one complete Core regression.",
      description: "Scope: Closure: scenario - Current Baseline final validation; run the complete Core regression once after all focused capability checks.",
      requirements: baselineLabels,
      acceptance: [criterion("All eleven checks and the single complete Core regression pass at the current revision.")],
      commitValue: commit("test(plan): accept current baseline", "build/reports/current-baseline.json", null),
      regression: fullRegression(),
    }),
  ];

  const highDirectory = `${rootDirectory}/high-concurrency`;
  const highContractId = randomUUID();
  const highFinalId = randomUUID();
  const highFullRegressionId = randomUUID();
  const highIntegrations = new Map(SCALE_STAGES.map((stage) => [stage.slug, randomUUID()]));
  const stageFinals = new Map();
  const ownerPlans = SCALE_STAGES.map((stage) =>
    ownerPlan(stage, highContractId, stageFinals, highIntegrations));
  const stageBySlug = new Map(SCALE_STAGES.map((stage) => [stage.slug, stage]));
  const highNodes = [
    node({
      id: highContractId,
      status: "completed",
      role: "architecture_scaffold",
      next: [highIntegrations.get("m0-profile-contract")],
      goal: "Define the executable high-concurrency stage contract.",
      description: "Current planning scaffold for M0–M7 and Algorithmic Resource Discipline.",
      requirements: SCALE_STAGES.map((stage) => stage.label),
      acceptance: [criterion("The stage order and profile boundaries are current.", true, [{
        type: "file",
        path: `docs/plans/${rootDirectory}/HighConcurrencyServicePlan.zh-CN.md`,
        sha256: sha256(highConcurrencyDocument()),
        recorded_at: REBUILD_RECORDED_AT,
      }])],
      commitValue: commit("docs(plan): activate high-concurrency graph",
        `docs/plans/${rootDirectory}/HighConcurrencyServicePlan.zh-CN.md`, revision),
    }),
    ...SCALE_STAGES.map((stage) => {
      const integrationId = highIntegrations.get(stage.slug);
      const dependentIntegrations = SCALE_STAGES
        .filter((candidate) => candidate.dependencies.includes(stage.slug))
        .map((candidate) => highIntegrations.get(candidate.slug));
      const next = stage.slug === "m6-observability" ? [highFullRegressionId] : dependentIntegrations;
      return node({
        id: integrationId,
        role: "implementation",
        prerequisites: stage.slug === "m0-profile-contract"
          ? [highContractId]
          : stage.dependencies.map((dependency) => highIntegrations.get(dependency)),
        next,
        goal: `Integrate the exact ${stage.title} final receipt.`,
        description: `Scope: Closure: module - ${stage.title} parent receipt integration; consume only the exact current child receipt.`,
        requirements: [stage.label],
        acceptance: [criterion(`${stage.title} exact final receipt is current and profile-scoped.`)],
        commitValue: commit(`docs(plan): integrate ${stage.slug} receipt`, "docs/plans", null),
        regression: focusedRegression("npm run verify:better-plan", ["tools/plan", "docs/plans"]),
      });
    }),
    node({
      id: highFullRegressionId,
      role: "evidence",
      prerequisites: [highIntegrations.get("m6-observability")],
      next: [highFinalId],
      goal: "Run the one shared complete Core regression after M0–M6.",
      description: "Scope: Closure: scenario - shared high-concurrency Core regression; this is the only complete Core regression before M7.",
      requirements: SCALE_STAGES.map((stage) => stage.label),
      acceptance: [criterion("The complete Core regression passes once after all shared scale stages.")],
      commitValue: commit("test(scale): run shared Core regression", "build/reports/high-concurrency-core.json", null),
      regression: fullRegression(),
    }),
    node({
      id: highFinalId,
      role: "final_validation",
      prerequisites: [highFullRegressionId],
      goal: "Reduce the shared HA, scale, and regional-DR implementation evidence.",
      description: "Scope: Closure: scenario - shared high-concurrency final validation; capacity and fault claims remain exclusively M7-owned.",
      requirements: SCALE_STAGES.map((stage) => stage.label),
      acceptance: [criterion("The shared receipt contains M0–M6 and Algorithmic Resource Discipline but no M7 capacity claim.")],
      commitValue: commit("test(scale): reduce shared high-concurrency receipt", "build/reports", null),
      regression: fullRegression(),
    }),
  ];
  for (const stage of SCALE_STAGES) {
    requireCondition(stageBySlug.has(stage.slug), "Scale stage generation failed");
  }

  const m7Plans = [
    m7Plan("ha", rootContractId, rootIntegrations.get("m7-ha"), highFinalId),
    m7Plan("scale", rootContractId, rootIntegrations.get("m7-scale"), highFinalId),
    m7Plan("regional-dr", rootContractId, rootIntegrations.get("m7-regional-dr"), highFinalId),
  ];
  const m7ByProfile = new Map(m7Plans.map((plan) => [
    plan.directory.split("/").at(-1).replace("m7-", ""),
    plan,
  ]));
  m7ByProfile.set("regional-dr", m7Plans[2]);

  const releaseDirectory = `${rootDirectory}/release-acceptance`;
  const releaseScaffoldId = randomUUID();
  const releaseFinals = new Map(PLAN_PROFILES.map((profile) => [profile, randomUUID()]));
  const releaseReducers = new Map(PLAN_PROFILES.map((profile) => [profile, randomUUID()]));
  const releaseLabels = PLAN_PROFILES.map((profile) =>
    `REQ-REL-ACCEPT-${profile.toUpperCase().replace("-", "-")}`);
  const releasePlanText = planMarkdown({
    title: "Profile-Scoped Release Acceptance",
    labels: releaseLabels,
    purpose: "Reduce one profile without consuming or promoting another profile's final receipt.",
  });
  const releaseNodes = [
    node({
      id: releaseScaffoldId,
      status: "completed",
      role: "architecture_scaffold",
      next: [...releaseReducers.values()],
      goal: "Define four disjoint release-acceptance branches.",
      description: "Current planning scaffold for independent profile acceptance.",
      requirements: releaseLabels,
      acceptance: [criterion("Four profile-specific final owners are declared.", true, [{
        type: "file",
        path: `docs/plans/${releaseDirectory}/Plan.md`,
        sha256: sha256(releasePlanText),
        recorded_at: REBUILD_RECORDED_AT,
      }])],
      commitValue: commit("docs(plan): define profile acceptance", `docs/plans/${releaseDirectory}/Plan.md`, revision),
    }),
    ...PLAN_PROFILES.map((profile, index) => {
      const reducerId = releaseReducers.get(profile);
      const finalId = releaseFinals.get(profile);
      return node({
        id: reducerId,
        prerequisites: [releaseScaffoldId],
        next: [finalId],
        goal: `Run ${profile} release acceptance.`,
        description: `Scope: Closure: scenario - ${profile} release acceptance; consume only the ${profile} prerequisite receipts.`,
        requirements: [releaseLabels[index]],
        acceptance: [criterion(`${profile} canonical acceptance evidence passes without another profile's final receipt.`)],
        commitValue: commit(`test(release): accept ${profile}`, "build/reports", null),
        regression: focusedRegression("npm run verify:acceptance", ["tools", "tests", "build/reports"]),
      });
    }),
    ...PLAN_PROFILES.map((profile) => {
      const reducerId = releaseReducers.get(profile);
      const finalId = releaseFinals.get(profile);
      return node({
        id: finalId,
        role: "final_validation",
        prerequisites: [reducerId],
        goal: `Reduce the ${profile} release receipt.`,
        description: `Scope: Closure: scenario - ${profile} final readiness; this receipt cannot promote any other profile.`,
        requirements: releaseLabels,
        acceptance: [criterion(`${profile} final receipt is current, exact, and independently proven.`)],
        commitValue: commit(`test(release): reduce ${profile} receipt`, "build/reports", null),
        regression: fullRegression(),
      });
    }),
  ];
  const releasePrerequisites = [{
    plan: baselineDirectory,
    node_id: baselineFinalId,
    kind: "final_validation",
    profiles: ["local"],
  }];
  for (const profile of HIGH_PROFILES) {
    releasePrerequisites.push(
      {
        plan: baselineDirectory,
        node_id: baselineFinalId,
        kind: "final_validation",
        profiles: [profile],
      },
      {
        plan: highDirectory,
        node_id: highFinalId,
        kind: "final_validation",
        profiles: [profile],
      },
      {
        plan: m7ByProfile.get(profile).directory,
        node_id: m7ByProfile.get(profile).finalId,
        kind: "final_validation",
        profiles: [profile],
      },
    );
  }

  const rootDocs = rootDocuments();
  const rootNodes = [
    node({
      id: rootContractId,
      status: "completed",
      role: "architecture_scaffold",
      next: [rootIntegrations.get("current-baseline")],
      goal: "Define the rebuilt current release authority and four profile branches.",
      description: "Current planning scaffold; no historical lifecycle or receipt is imported.",
      requirements: rootDocs.labels,
      acceptance: [criterion("The current release authority declares four disjoint profile finals.", true, [{
        type: "file",
        path: `docs/plans/${rootDirectory}/Requirements.md`,
        sha256: sha256(rootDocs["Requirements.md"]),
        recorded_at: REBUILD_RECORDED_AT,
      }])],
      commitValue: commit("docs(plan): rebuild current release authority",
        `docs/plans/${rootDirectory}/Requirements.md`, revision),
    }),
  ];
  const integrationDefinitions = [
    ["current-baseline", [rootContractId], [
      rootIntegrations.get("high-concurrency"),
      ...PLAN_PROFILES.map((profile) => rootIntegrations.get(`release-${profile}`)),
    ], rootDocs.labels],
    ["high-concurrency", [rootIntegrations.get("current-baseline")], [
      rootIntegrations.get("m7-ha"),
      rootIntegrations.get("m7-scale"),
      rootIntegrations.get("m7-regional-dr"),
    ], ["REQ-REL-PROFILE-ISOLATION"]],
    ["m7-ha", [rootIntegrations.get("high-concurrency")], [rootIntegrations.get("release-ha")], ["REQ-REL-PROFILE-ISOLATION"]],
    ["m7-scale", [rootIntegrations.get("high-concurrency")], [rootIntegrations.get("release-scale")], ["REQ-REL-PROFILE-ISOLATION"]],
    ["m7-regional-dr", [rootIntegrations.get("high-concurrency")], [rootIntegrations.get("release-regional-dr")], ["REQ-REL-PROFILE-ISOLATION"]],
    ["release-local", [rootIntegrations.get("current-baseline")], [rootFinals.get("local")], ["REQ-REL-ACCEPT-LOCAL"]],
    ["release-ha", [rootIntegrations.get("current-baseline"), rootIntegrations.get("m7-ha")],
      [rootFinals.get("ha")], ["REQ-REL-ACCEPT-HA"]],
    ["release-scale", [rootIntegrations.get("current-baseline"), rootIntegrations.get("m7-scale")],
      [rootFinals.get("scale")], ["REQ-REL-ACCEPT-SCALE"]],
    ["release-regional-dr", [rootIntegrations.get("current-baseline"), rootIntegrations.get("m7-regional-dr")],
      [rootFinals.get("regional-dr")], ["REQ-REL-ACCEPT-REGIONAL-DR"]],
  ];
  for (const [name, prerequisites, next, requirements] of integrationDefinitions) {
    rootNodes.push(node({
      id: rootIntegrations.get(name),
      prerequisites,
      next,
      goal: `Integrate the exact ${name} child receipt.`,
      description: `Scope: Closure: module - ${name} receipt integration; preserve exact profile ownership.`,
      requirements,
      acceptance: [criterion(`${name} receipt is current and bound to its declared profiles.`)],
      commitValue: commit(`docs(plan): integrate ${name} receipt`, "docs/plans", null),
      regression: focusedRegression("npm run verify:better-plan", ["tools/plan", "docs/plans"]),
    }));
  }
  for (const [profile, finalId] of rootFinals) {
    rootNodes.push(node({
      id: finalId,
      role: "final_validation",
      prerequisites: [rootIntegrations.get(`release-${profile}`)],
      goal: `Reduce the root ${profile} release decision.`,
      description: `Scope: Closure: scenario - root ${profile} release decision; no other profile receipt is consumed or promoted.`,
      requirements: rootDocs.labels,
      acceptance: [criterion(`The root ${profile} receipt is independently current and verified.`)],
      commitValue: commit(`test(release): reduce root ${profile}`, "build/reports", null),
      regression: fullRegression(),
    }));
  }

  const plans = [
    {
      directory: rootDirectory,
      title: "Current Release Authority",
      files: Object.fromEntries(Object.entries(rootDocs).filter(([, value]) => typeof value === "string")),
      checkpoints: rootNodes,
      sourceFiles: [
        ...["Requirements.md", "Evidence.md", "Architecture.md", "Validation.md", "HighConcurrencyServicePlan.zh-CN.md",
          "DependencyMap.json"].map((name) => `docs/plans/${rootDirectory}/${name}`),
      ],
    },
    {
      directory: baselineDirectory,
      title: "Current Baseline Plan",
      files: { "Plan.md": baselinePlanText },
      checkpoints: baselineCheckpoints,
      sourceFiles: [
        `docs/plans/${baselineDirectory}/Plan.md`,
        `docs/plans/${baselineDirectory}/Checkpoints.json`,
        ...BASELINE_CAPABILITIES.map(([, testPath]) => testPath),
      ],
    },
    {
      directory: highDirectory,
      title: "Shared High-Concurrency Plan",
      files: {
        "Plan.md": planMarkdown({
          title: "Shared High-Concurrency Plan",
          labels: SCALE_STAGES.map((stage) => stage.label),
          purpose: "Integrate M0–M6 and Algorithmic Resource Discipline before one complete Core regression.",
          profiles: HIGH_PROFILES,
          sequence: SCALE_STAGES.map((stage) => stage.title),
        }),
      },
      checkpoints: highNodes,
      sourceFiles: [
        `docs/plans/${highDirectory}/Plan.md`,
        `docs/plans/${highDirectory}/Checkpoints.json`,
        ...ownerPlans.map((plan) => `docs/plans/${plan.directory}/Checkpoints.json`),
      ],
    },
    ...ownerPlans.map((plan) => ({
      directory: plan.directory,
      title: plan.title,
      files: { "Plan.md": plan.planText },
      checkpoints: plan.checkpoints,
      sourceFiles: plan.sourceFiles,
    })),
    ...m7Plans.map((plan) => ({
      directory: plan.directory,
      title: plan.title,
      files: { "Plan.md": plan.planText },
      checkpoints: plan.checkpoints,
      sourceFiles: plan.sourceFiles,
    })),
    {
      directory: releaseDirectory,
      title: "Profile-Scoped Release Acceptance",
      files: { "Plan.md": releasePlanText },
      checkpoints: releaseNodes,
      sourceFiles: [
        `docs/plans/${releaseDirectory}/Plan.md`,
        `docs/plans/${releaseDirectory}/Checkpoints.json`,
      ],
    },
  ];
  plans[0].files["HighConcurrencyServicePlan.zh-CN.md"] = highConcurrencyDocument();
  plans[0].sourceFiles.push(...plans.slice(1).map((plan) => `docs/plans/${plan.directory}/Checkpoints.json`));

  const mapPlans = [
    {
      directory: rootDirectory,
      parent: null,
      parent_contract_node_id: null,
      parent_integrations: [],
      final_validations: PLAN_PROFILES.map((profile) => ({
        node_id: rootFinals.get(profile),
        profiles: [profile],
      })),
      prerequisite_receipts: [],
      children: [
        baselineDirectory,
        highDirectory,
        ...m7Plans.map((plan) => plan.directory),
        releaseDirectory,
      ],
      accepted_final_receipts: {},
    },
    {
      directory: baselineDirectory,
      parent: rootDirectory,
      parent_contract_node_id: rootContractId,
      parent_integrations: [{
        child_final_node_id: baselineFinalId,
        parent_node_id: rootIntegrations.get("current-baseline"),
        profiles: [...PLAN_PROFILES],
      }],
      final_validations: [{ node_id: baselineFinalId, profiles: [...PLAN_PROFILES] }],
      prerequisite_receipts: [],
      children: [],
      accepted_final_receipts: {},
    },
    {
      directory: highDirectory,
      parent: rootDirectory,
      parent_contract_node_id: rootContractId,
      parent_integrations: [{
        child_final_node_id: highFinalId,
        parent_node_id: rootIntegrations.get("high-concurrency"),
        profiles: [...HIGH_PROFILES],
      }],
      final_validations: [{ node_id: highFinalId, profiles: [...HIGH_PROFILES] }],
      prerequisite_receipts: [{
        plan: baselineDirectory,
        node_id: baselineFinalId,
        kind: "final_validation",
        profiles: [...HIGH_PROFILES],
      }],
      children: ownerPlans.map((plan) => plan.directory),
      accepted_final_receipts: {},
    },
    ...ownerPlans.map((plan) => plan.mapPlan),
    ...m7Plans.map((plan) => plan.mapPlan),
    {
      directory: releaseDirectory,
      parent: rootDirectory,
      parent_contract_node_id: rootContractId,
      parent_integrations: PLAN_PROFILES.map((profile) => ({
        child_final_node_id: releaseFinals.get(profile),
        parent_node_id: rootIntegrations.get(`release-${profile}`),
        profiles: [profile],
      })),
      final_validations: PLAN_PROFILES.map((profile) => ({
        node_id: releaseFinals.get(profile),
        profiles: [profile],
      })),
      prerequisite_receipts: releasePrerequisites,
      children: [],
      accepted_final_receipts: {},
    },
  ];
  const dependencyMap = {
    schema_version: 3,
    generated_from_revision: revision,
    profiles: [...PLAN_PROFILES],
    plans: mapPlans,
  };
  plans[0].files["DependencyMap.json"] = jsonText(dependencyMap);
  const manifest = plans.map((plan) => ({
    id: randomUUID(),
    status: plan.checkpoints.some((entry) => entry.status === "completed") ? "in_progress" : "pending",
    title: plan.title,
    directory: plan.directory,
    source_files: [...new Set(plan.sourceFiles)],
    goal: `Execute ${plan.title} from current source and current profile-scoped evidence.`,
    description: "Current Baseline authority; historical lifecycle and receipts are non-authoritative.",
    checkpoints: `${plan.directory}/Checkpoints.json`,
  }));
  return { plans, manifest, dependencyMap };
}

async function writeWorkspace(candidateRoot, workspace) {
  for (const plan of workspace.plans) {
    const planPath = path.join(candidateRoot, ...plan.directory.split("/"));
    await fs.mkdir(planPath, { recursive: true });
    for (const [name, text] of Object.entries(plan.files)) {
      await fs.writeFile(path.join(planPath, name), text, { encoding: "utf8", mode: 0o600 });
    }
    await fs.writeFile(path.join(planPath, "Checkpoints.json"), jsonText(plan.checkpoints), {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  await fs.writeFile(path.join(candidateRoot, "Manifest.json"), jsonText(workspace.manifest), {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function atomicReplacePlanRoot(planRoot, candidateRoot) {
  const retiredRoot = `${planRoot}.retired-${randomUUID()}`;
  let retired = false;
  try {
    try {
      await fs.rename(planRoot, retiredRoot);
      retired = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.rename(candidateRoot, planRoot);
    if (retired) await fs.rm(retiredRoot, { recursive: true, force: true });
  } catch (error) {
    if (retired) {
      await fs.rm(planRoot, { recursive: true, force: true });
      await fs.rename(retiredRoot, planRoot);
    }
    throw error;
  }
}

export async function rebuildCurrentPlanBaseline({ repoRoot = defaultRepoRoot } = {}) {
  const revision = currentRevision(repoRoot);
  const docsRoot = path.join(repoRoot, "docs");
  const planRoot = path.join(docsRoot, "plans");
  const migrationReportPath = path.join(docsRoot, "reports", "plan-baseline-migration.json");
  let migration;
  try {
    const previous = JSON.parse(await fs.readFile(migrationReportPath, "utf8"));
    migration = previous?.schema_version === "licomesh.plan-baseline-migration-summary.v1" &&
      previous?.historical_authority_retained === false
      ? Object.fromEntries(Object.entries(previous).filter(([key]) =>
        key.startsWith("legacy_") || key === "schema_version" ||
        key === "historical_authority_retained" || key === "stale_commit_binding_count"))
      : await legacySummary(planRoot, revision);
  } catch {
    migration = await legacySummary(planRoot, revision);
  }
  const candidateRoot = await fs.mkdtemp(path.join(docsRoot, ".plans-current-candidate-"));
  try {
    const workspace = await buildWorkspace(repoRoot, revision);
    await writeWorkspace(candidateRoot, workspace);
    await atomicReplacePlanRoot(planRoot, candidateRoot);
    await fs.mkdir(path.join(docsRoot, "reports"), { recursive: true });
    const reportPath = migrationReportPath;
    const temporaryReport = `${reportPath}.tmp-${randomUUID()}`;
    await fs.writeFile(temporaryReport, jsonText({
      ...migration,
      current_schema_version: 3,
      current_plan_count: workspace.manifest.length,
      current_checkpoint_count: workspace.plans.reduce((count, plan) => count + plan.checkpoints.length, 0),
      current_profile_count: PLAN_PROFILES.length,
      current_revision_sha256: sha256(revision),
      raw_receipts_copied: false,
    }), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryReport, reportPath);
    return {
      schema_version: "licomesh.plan-baseline-rebuild-result.v1",
      accepted: true,
      plan_count: workspace.manifest.length,
      checkpoint_count: workspace.plans.reduce((count, plan) => count + plan.checkpoints.length, 0),
      profile_count: PLAN_PROFILES.length,
      migration_summary_written: true,
    };
  } finally {
    await fs.rm(candidateRoot, { recursive: true, force: true });
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  rebuildCurrentPlanBaseline()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
