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
const REPLACE_REFUSAL: any = "refusing to replace checkpoints or receipts";

const BASELINE_REQUIREMENTS: readonly any[] = Object.freeze([
  "REQ-REL-BASELINE",
  "REQ-BASELINE-UPSTREAM-GATEWAY",
  "REQ-BASELINE-DOWNSTREAM-MCP",
  "REQ-BASELINE-STRATEGY-MANAGEMENT",
  "REQ-BASELINE-ENTERPRISE-GOVERNANCE",
  "REQ-BASELINE-CONSOLE-ADMINISTRATION",
  "REQ-BASELINE-CONTAINER-DEPLOYMENT",
  "REQ-BASELINE-STORAGE",
  "REQ-BASELINE-JOBS",
  "REQ-BASELINE-EXTERNAL-PLUGIN-PACKAGING-LOADING",
  "REQ-BASELINE-AGENT-GATEWAY-MODEL-ROUTING",
  "REQ-BASELINE-CORE-WORKSPACE-ASSETS-GOVERNANCE",
]);

function requireCondition(condition?: any, message?: any) : any {
  if (!condition) throw new Error(message);
}

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stableId(label?: any) : any {
  const digest: any = sha256(`meshrix-agent-service-efficiency:${label}`);
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

function criterion(text?: any) : any {
  return { checked: false, text };
}

function designContract({ ownedPaths, acceptancePaths, decisions = {} }: Record<string, any>) : any {
  return {
    artifact: `docs/plans/${ROOT}/Plan.md`,
    owned_paths: ownedPaths,
    scaffold_paths: ownedPaths,
    acceptance_paths: acceptancePaths,
    symbols: [],
    interfaces: [],
    dependencies: [],
    decisions: {
      composition: decisions.composition || "one bounded capability closure per implementation node",
      algorithms: decisions.algorithms || "indexed incremental work over changed identities and bounded deltas",
      data_structures: decisions.dataStructures || "stable identities, monotonic revisions, bounded maps, queues, and operation logs",
      state: decisions.state || "one Core authority per mutable state boundary",
      isolation: decisions.isolation || "focused verification before one final functional acceptance",
      concurrency: decisions.concurrency || "parallel preparation with short authority-local commit ordering",
    },
    test_seams: ["declared focused regression and exact final receipt boundary"],
  };
}

function node({
  key,
  role,
  code,
  title,
  goal,
  description,
  requirements,
  acceptance,
  prerequisites = [],
  next = [],
  target,
  commands,
  paths,
  difficulty = "complex",
  decisions = {},
  verificationProfile = "code",
}: Record<string, any>) : any {
  const ownedPath: any = path.extname(target) ? target : `${target}/${key}.ts`;
  return {
    id: stableId(key),
    status: "pending",
    role,
    prerequisites: prerequisites.map(stableId),
    platform: "any",
    difficulty: role === "final_validation" ? "critical" : difficulty,
    verification_profile: verificationProfile,
    goal,
    description,
    code,
    title,
    tags: [],
    conditions: [],
    requirements,
    design: designContract({
      ownedPaths: [ownedPath],
      acceptancePaths: [`tests/acceptance/${key}.test.ts`],
      decisions,
    }),
    acceptance_criteria: [criterion(acceptance)],
    commit: {
      repository: ".git",
      message: `plan(agent-service-efficiency): ${title}.`,
      target,
    },
    regression: {
      scope: role === "final_validation" ? "full" : "focused",
      commands,
      criteria: [0],
      paths,
    },
    next: next.map(stableId),
  };
}

function planNodes() : any[] {
  const design: any = "efficiency-design";
  const baseline: any = "interaction-cost-baseline";
  const contract: any = "service-collaboration-contract";
  const connector: any = "connector-working-view";
  const core: any = "core-change-set-authority";
  const effects: any = "explicit-effect-commands";
  const workspace: any = "workspace-reference-migration";
  const efficiency: any = "efficiency-profile";
  const plugin: any = "plugin-console-isolation";
  const operations: any = "enterprise-operations-closure";
  const offline: any = "offline-delivery-closure";
  const final: any = "functional-final";
  const commonPaths: any[] = ["docs/plans", "tools/plan", "tools/server-scripts", "tests/vitest/server"];

  return [
    node({
      key: design,
      role: "group_design",
      code: "EFF-0",
      title: "Freeze Agent Service efficiency architecture",
      goal: "Freeze one efficiency-led product and receipt authority.",
      description: "Define the shared-document editing analogy, Core and external-effect boundary, cost model, retained release closures, and the smallest safe execution frontier. Historical Plan completion and capacity claims are not imported.",
      requirements: ["REQ-REL-BASELINE", "REQ-EFF-MODEL", "REQ-EFF-CLAIMS"],
      acceptance: "Plan.md fixes one current Plan, the interaction model, exact efficiency measurements, remaining closures, and non-claims.",
      next: [baseline],
      target: `docs/plans/${ROOT}/Plan.md`,
      commands: ["npm run verify:better-plan"],
      paths: commonPaths,
    }),
    node({
      key: baseline,
      role: "implementation",
      code: "EFF-1",
      title: "Freeze interaction cost baseline",
      goal: "Measure equivalent legacy and collaborative Agent-to-Service scenarios.",
      description: "Scope: Closure: capability - interaction cost baseline; define cold-open, warm-read, dirty-turn, reconnect, conflict, revocation, and explicit-effect workloads with privacy-safe deterministic counters. Target: a frozen comparison that cannot certify capacity by itself.",
      requirements: ["REQ-EFF-METRICS", "REQ-EFF-CLAIMS"],
      acceptance: "Equivalent scenarios report model-visible calls, schema and context bytes, wire bytes, repeated reads, round trips, server work, latency, memory, and queue peaks without content leakage.",
      prerequisites: [design],
      next: [contract],
      target: "tools/server-scripts",
      commands: ["node tools/server-scripts/agent-service-interaction-cost-baseline.ts"],
      paths: ["tools/registry", "tools/server-scripts", "tools/verifiers", "tests"],
    }),
    node({
      key: contract,
      role: "implementation",
      code: "EFF-2",
      title: "Define the Service collaboration contract",
      goal: "Define one standards-compatible incremental collaboration profile.",
      description: "Scope: Closure: capability - Service collaboration contract; specify Open, Observe, Edit, Commit, Acknowledge, Subscribe, Rebase or Resync with stable identities, causal baselines, bounded Change Sets, Resources, cache hints, Cursors, Snapshots, conflicts, and current authorization.",
      requirements: ["REQ-EFF-MODEL", "REQ-EFF-MCP", "REQ-EFF-AUTHORIZATION", "REQ-BASELINE-UPSTREAM-GATEWAY", "REQ-BASELINE-DOWNSTREAM-MCP"],
      acceptance: "Neutral peers agree on versioned schemas, limits, cache scope, delta ordering, conflict codes, and protocol fallback without a second Core state generation.",
      prerequisites: [baseline],
      next: [connector, core, effects, plugin, operations, offline],
      target: "packages/contracts/src",
      commands: ["node tools/server-scripts/verify-agent-service-collaboration-contract.ts"],
      paths: ["packages/contracts", "packages/protocols/mcp", "tools/server-scripts", "tests"],
      decisions: { algorithms: "stable entity indexes, monotonic Heads, Cursor-indexed deltas, and typed relevant-operation transforms" },
    }),
    node({
      key: connector,
      role: "implementation",
      code: "EFF-3",
      title: "Build the Connector Working View",
      goal: "Eliminate repeated discovery, schema injection, and unchanged remote reads.",
      description: "Scope: Closure: module - Connector Working View; maintain confirmed and optimistic authorization-partitioned Resource state, bounded Inbox and Outbox, private weighted caches, invalidation, acknowledgement, and explicit resynchronization.",
      requirements: ["REQ-EFF-CONNECTOR", "REQ-EFF-MCP", "REQ-EFF-PRIVACY", "REQ-BASELINE-DOWNSTREAM-MCP"],
      acceptance: "Valid warm cache hits perform no remote read, unchanged schemas add zero model-context bytes, revocation purges the partition, and backpressure never drops unacknowledged changes.",
      prerequisites: [contract],
      next: [workspace],
      target: "packages/protocols/mcp/adapter/gateway-installer",
      commands: ["node tools/server-scripts/verify-connector-working-view.ts"],
      paths: ["packages/protocols/mcp/adapter/gateway-installer", "tools/server-scripts", "tests"],
    }),
    node({
      key: core,
      role: "implementation",
      code: "EFF-4",
      title: "Build the Core Change Set authority",
      goal: "Coalesce one dirty turn into one bounded atomic Core change.",
      description: "Scope: Closure: capability - Core Change Set authority; implement stable identities, monotonic Heads, idempotent ChangeIds, bounded typed operations, relevant-operation rebase, atomic visibility, history, Snapshot and Cursor recovery, and current sink authorization.",
      requirements: ["REQ-EFF-CHANGE-SET", "REQ-EFF-AUTHORIZATION", "REQ-EFF-COMPLEXITY", "REQ-BASELINE-CORE-WORKSPACE-ASSETS-GOVERNANCE", "REQ-BASELINE-STORAGE", "REQ-BASELINE-JOBS"],
      acceptance: "A clean turn sends no apply call, a dirty turn sends at most one Change Set, duplicate delivery has one result, and work is independent of total Service state and history.",
      prerequisites: [contract],
      next: [workspace],
      target: "packages/agents/src",
      commands: ["node tools/server-scripts/verify-core-change-set-authority.ts"],
      paths: ["packages/agents", "packages/foundation", "packages/server-runtime", "tools/server-scripts", "tests"],
    }),
    node({
      key: effects,
      role: "implementation",
      code: "EFF-5",
      title: "Separate explicit external Effect Commands",
      goal: "Keep irreversible Service effects governable and visible.",
      description: "Scope: Closure: capability - explicit external Effect Commands; bind each effect to current authorization, EffectId, idempotency or explicit non-idempotency, cancellation, uncertainty, terminal result, audit, and optional compensation without CRDT or silent retry semantics.",
      requirements: ["REQ-EFF-EFFECTS", "REQ-EFF-AUTHORIZATION", "REQ-BASELINE-ENTERPRISE-GOVERNANCE", "REQ-BASELINE-STRATEGY-MANAGEMENT"],
      acceptance: "No external effect is hidden inside a merge, uncertain results are not retried automatically, and compensation never claims to reverse an unowned external effect.",
      prerequisites: [contract],
      next: [workspace],
      target: "packages/server-runtime/src",
      commands: ["node tools/server-scripts/verify-explicit-effect-commands.ts"],
      paths: ["packages/server-runtime", "packages/foundation/src/security", "tools/server-scripts", "tests"],
    }),
    node({
      key: workspace,
      role: "implementation",
      code: "EFF-6",
      title: "Migrate Workspace collaboration to the shared model",
      goal: "Use Workspace editing as the complete reference implementation.",
      description: "Scope: Closure: scenario - Workspace reference migration; cut over file collaboration to stable Assets, Resources, one Change Set per turn, delta subscriptions, Suggestions, checkpoints, and restore-as-new-change, then remove per-file model loops and former online writers.",
      requirements: ["REQ-EFF-WORKSPACE", "REQ-EFF-REMOVAL", "REQ-BASELINE-CORE-WORKSPACE-ASSETS-GOVERNANCE"],
      acceptance: "Workspace peers converge through bounded deltas and one turn apply, while old per-file collaboration tools, path identity, scan sync, dual reads, and dual writes are absent.",
      prerequisites: [connector, core, effects],
      next: [efficiency],
      target: "packages/agents/src/agent-workspace",
      commands: ["node tools/server-scripts/verify-workspace-collaboration-migration.ts"],
      paths: ["packages/agents", "packages/protocols/mcp", "apps/console", "tools/server-scripts", "tests", "docs"],
    }),
    node({
      key: efficiency,
      role: "implementation",
      code: "EFF-7",
      title: "Validate the named efficiency profile",
      goal: "Prove material interaction reduction without overclaiming capacity.",
      description: "Scope: Closure: scenario - named efficiency profile; compare equivalent legacy and collaborative workloads and certify only the exact profile when completeness, privacy, safety, recovery, call reduction, and byte reduction thresholds all pass.",
      requirements: ["REQ-EFF-METRICS", "REQ-EFF-TARGETS", "REQ-EFF-COMPLEXITY", "REQ-EFF-CLAIMS"],
      acceptance: "The warm profile has zero unchanged schema bytes, zero valid-cache reads, zero clean-turn apply calls, at most one dirty-turn Change Set call, at least 60 percent fewer model-visible calls, and at least 70 percent fewer model-context and wire bytes, or capacityCertified is false with a finite reason.",
      prerequisites: [workspace],
      next: [final],
      target: "tools/server-scripts",
      commands: ["node tools/server-scripts/verify-agent-service-efficiency-profile.ts"],
      paths: ["tools/registry", "tools/server-scripts", "tools/verifiers", "tests", "docs"],
    }),
    node({
      key: plugin,
      role: "implementation",
      code: "EFF-8",
      title: "Close Plugin Console isolation",
      goal: "Remove privileged same-origin third-party Console loading.",
      description: "Scope: Closure: capability - Plugin Console isolation; register plugin verification, use an opaque-origin iframe and bounded revocable MessageChannel bridge, and delete same-origin dynamic import compatibility.",
      requirements: ["REQ-BASELINE-EXTERNAL-PLUGIN-PACKAGING-LOADING", "REQ-REL-BASELINE"],
      acceptance: "Unified plugin evidence and browser escape tests pass with no privileged Console import path.",
      prerequisites: [contract],
      next: [final],
      target: "apps/console",
      commands: ["node tools/server-scripts/plugin-console-isolation-closure.ts"],
      paths: ["apps/console", "packages/foundation/src/module-system", "tools/server-scripts", "tests"],
      verificationProfile: "hybrid",
    }),
    node({
      key: operations,
      role: "implementation",
      code: "EFF-9",
      title: "Close enterprise single-node operations",
      goal: "Retain the remaining governed delivery and recovery closures.",
      description: "Scope: Closure: scenario - enterprise operations closure; prove the governed MCP journey, denial and uncertainty behavior, diagnostics, emergency administration, key lifecycle, clean-root restore, N-1 upgrade and failed rollback on one candidate.",
      requirements: ["REQ-EFF-RELEASE", "REQ-BASELINE-CONSOLE-ADMINISTRATION", "REQ-BASELINE-CONTAINER-DEPLOYMENT", "REQ-BASELINE-AGENT-GATEWAY-MODEL-ROUTING"],
      acceptance: "One candidate completes governed operation, administration, recovery, upgrade, rollback, and diagnostics without optional infrastructure or environment-support claims.",
      prerequisites: [contract],
      next: [final],
      target: "tools/server-scripts",
      commands: ["node tools/server-scripts/enterprise-operations-closure.ts"],
      paths: ["apps", "packages", "tools/server-scripts", "tests", "docs"],
    }),
    node({
      key: offline,
      role: "implementation",
      code: "EFF-10",
      title: "Close disconnected dual-architecture delivery",
      goal: "Prove exact offline candidate transfer without rebuilding.",
      description: "Scope: Closure: scenario - disconnected delivery closure; build candidate-bound Linux amd64 and arm64 OCI layouts with inventory, SBOM, provenance, signatures and instructions, then verify the exact bytes in a disconnected clean target.",
      requirements: ["REQ-EFF-RELEASE", "REQ-BASELINE-CONTAINER-DEPLOYMENT"],
      acceptance: "The exact dual-architecture bundle imports, starts, executes its first governed call, stops, and cleans up without network access or rebuilding.",
      prerequisites: [contract],
      next: [final],
      target: "tools/server-scripts",
      commands: ["node tools/server-scripts/offline-delivery-closure.ts"],
      paths: ["docker", "tools/containers", "tools/server-scripts", "tests", "docs"],
    }),
    node({
      key: final,
      role: "final_validation",
      code: "EFF-FINAL",
      title: "Run functional acceptance once",
      goal: "Issue the only current functional candidate decision.",
      description: "Scope: Closure: scenario - final functional acceptance; consume exact current efficiency, Plugin isolation, enterprise operations, and offline evidence once, rejecting missing, stale, replayed, substituted, rebuilt, or cross-candidate inputs.",
      requirements: ["REQ-EFF-FINAL", "REQ-EFF-CLAIMS", "REQ-REL-BASELINE"],
      acceptance: "One privacy-safe functional receipt covers the exact current evidence set and creates no publication, production-readiness, or environment-support claim.",
      prerequisites: [efficiency, plugin, operations, offline],
      target: "build/reports",
      commands: ["npm run verify:acceptance"],
      paths: [".github/workflows", "apps", "packages", "tools", "tests", "docs"],
    }),
  ];
}

function planMarkdown() : any {
  return `# Agent–Service Collaboration Efficiency Plan

## Current Outcome

The only current Meshrix.js plan is one enterprise single-node functional candidate led by Agent-to-MCP Service interaction efficiency. It is pre-release work, not a publication, production-readiness statement, achieved capacity result, or environment-support claim.

Implemented runtime capacity and concurrency improvements are substrate. They are not a separate current Plan. The current Plan measures their behavior only where the new interaction profile needs fresh evidence or an objectively failing final regression requires repair.

## The Shared-Document Model

A person does not reopen a shared document, download every page, resend the editor schema, and save every keystroke as a separate remote command. The person opens it once, keeps a current local view, edits locally, submits a compact transaction, receives an acknowledgement, and consumes later deltas.

An Agent should interact with an MCP Service the same way when the Service supports the collaboration profile:

1. **Open once.** Resolve current authorization and open a Service Working Set with opaque Handles, stable entity identities, a confirmed Head, Resource links, cache policy, and Cursor.
2. **Observe locally.** The Connector keeps a private authorization-partitioned Working View of confirmed Resources, catalogs, schemas, acknowledgements, and bounded history. Valid cache hits require no model-visible remote read.
3. **Edit locally.** Agent reasoning and provisional edits update an optimistic view without repeating unchanged schema or state in the model context.
4. **Commit once.** A dirty work turn emits at most one bounded typed Change Set for Core-managed state. A clean or read-only turn emits none.
5. **Acknowledge minimally.** Core returns the assigned revision, changed identities, compact result facts, conflicts, and invalidations rather than the entire Service state.
6. **Subscribe to deltas.** MCP Resources, private cache hints, \`subscriptions/listen\`, and \`notifications/resources/updated\` deliver only relevant change signals. The Connector fetches only invalidated Resources or missing delta pages.
7. **Rebase or resynchronize explicitly.** Eligible typed operations rebase only over relevant indexed operations. Other conflicts return stable facts. A valid Cursor returns bounded missing changes; an expired Cursor returns an authorized Snapshot plus bounded tail.

Workspace file collaboration is the reference implementation, not the limit of the model. A Service may expose documents, structured records, jobs, configurations, catalogs, or other Core-governed Resources through the same Working View and Change Set contract.

## State Changes And External Effects

Core-managed state uses stable identities, monotonic Heads, immutable attributed Change Sets, idempotent ChangeIds, causal baselines, bounded typed operations, atomic visibility, indexed history, Snapshots, and Cursors.

Arbitrary external or irreversible MCP effects are not document edits. They remain explicit governed **Effect Commands**. Every effect binds its current principal, grant, target, policy, approval, audience, request, EffectId, idempotency or explicit non-idempotency, cancellation state, terminal or uncertain result, audit, and optional compensation. Meshrix.js never merges arbitrary effects through CRDT rules, retries an uncertain effect silently, or claims that a local rollback reverses an external effect.

The design learns from proven collaboration invariants without transferring Core authority: Yjs state vectors exchange missing updates; Automerge SyncState records peer knowledge and emits nothing when synchronized; CodeMirror and ProseMirror retain a confirmed authority version plus unconfirmed local steps and rebase them over remote changes.

## Efficiency Contract

The verifier freezes equivalent legacy and collaborative scenarios for cold open, warm read, dirty turn, concurrent change, reconnect, conflict, revocation, and explicit side effect. It records only privacy-safe numeric counters:

- model-visible tool calls and remote reads;
- discovery, catalog, schema, model-context, request, and response bytes;
- network round trips and repeated reads;
- indexed statements, scanned entities, relevant operations, wakeups, timers, and cache weight;
- acknowledgement and subscriber-visibility latency;
- memory, queue, subscription, retry, and snapshot peaks.

For the named warm profile, future acceptance requires:

- zero unchanged catalog or schema bytes entering the model context;
- zero remote reads for valid Connector cache hits;
- zero apply calls for a clean turn;
- at most one Change Set apply call for a dirty turn, excluding explicit non-batchable Effect Commands;
- at least 60 percent fewer model-visible calls than the equivalent frozen legacy scenario; and
- at least 70 percent fewer combined model-context and wire bytes.

Hot-path work must depend on changed identities, changed bytes, relevant intervening operations, matching subscribers, and explicit effects, never total Service state, total history, total catalog size, or total connected clients. Until one complete named run passes every workload, privacy, safety, recovery, and threshold check, \`capacityCertified\` remains false with a finite reason such as \`owner_profile_not_authorized\`.

## Governance, Privacy, And Bounds

Every open, read, subscribe, apply, approval, checkpoint, restore, import, export, notification delivery, and Effect Command re-resolves current identity, grant, resource, policy, approval, audience, request, and generation. Handles, Cursors, cached bytes, connection state, earlier discovery, and prior approval are lookup or history facts, never authority.

Caches, Inbox, Outbox, Change Sets, operation logs, delta pages, subscribers, retries, snapshots, reports, and evidence have count and byte budgets, cancellation, backpressure, and explicit overload or resync outcomes. Content, prompts, credentials, machine paths, Service locations, authorization material, backend rows, and runtime logs do not enter notifications, telemetry, reports, or receipts.

MCP \`2026-07-28\` stateless requests, Resources, \`ttlMs\`, \`cacheScope\`, \`subscriptions/listen\`, notifications, protocol negotiation, and direct tool calls remain standards-compatible. A non-optimized client or Service may use the ordinary protocol path, but Meshrix.js retains only one Core state generation and one current Plan.

## Delivery Order

| Node | Closure |
| --- | --- |
| **EFF-0** | Freeze this single authority, interaction model, measurements, and claim boundary. |
| **EFF-1** | Freeze equivalent legacy and collaborative interaction-cost workloads. |
| **EFF-2** | Define the versioned Service collaboration contract. |
| **EFF-3** | Build the Connector Working View and incremental MCP projection. |
| **EFF-4** | Build the Core Change Set authority. |
| **EFF-5** | Separate explicit external Effect Commands. |
| **EFF-6** | Migrate Workspace collaboration and remove per-file model loops and former online writers. |
| **EFF-7** | Validate the named efficiency profile and thresholds. |
| **EFF-8** | Close Plugin Console opaque-origin isolation and remove privileged imports. |
| **EFF-9** | Close governed operation, administration and key recovery, clean-root restore, and upgrade rollback. |
| **EFF-10** | Close exact disconnected Linux amd64 and arm64 delivery. |
| **EFF-FINAL** | Consume exact current evidence and run functional acceptance once. |

EFF-3, EFF-4, EFF-5, EFF-8, EFF-9, and EFF-10 may proceed after the contract on their real dependency boundaries. Workspace migration joins the Connector, Core state, and effect semantics. Functional acceptance joins efficiency, Plugin isolation, enterprise operations, and offline delivery.

## Complete Migration

The old enterprise child Plans, standalone runtime-capacity Plan, standalone shared Workspace Plan, their receipts, aliases, dependency edges, and old planning documents are removed in the same closure that establishes this Plan. There is no dual Plan, redirect, compatibility graph, or old-name gate. A one-time residue search proves removal and is then discarded.

## Deferred Support Decisions

Native host qualification, client-platform qualification, public-cloud qualification, independent recovery-host support, multi-node availability, federation, and hosted operation begin only after this functional candidate is accepted. The offline Linux artifacts required by EFF-10 do not themselves establish native Linux support.
`;
}

function capabilities() : any[] {
  return [
    {
      key: "meshrix",
      parent: null,
      title: "Meshrix.js",
      kind: "repository",
      basis: "observed",
      disclosure: "examined",
      touch: "in_scope",
      source_files: ["docs/STATUS.md", "docs/WHATS-NEXT.md"],
      description: "Pre-release private-deployment governance platform with one efficiency-led current Plan.",
    },
    {
      key: "meshrix/agent-service-collaboration-efficiency",
      parent: "meshrix",
      title: "Agent Service Collaboration Efficiency",
      kind: "capability",
      basis: "designed",
      disclosure: "examined",
      touch: "in_scope",
      source_files: [`docs/plans/${ROOT}/Plan.md`],
      description: "One current functional candidate using shared-document interaction mechanics to reduce Agent-to-MCP Service cost.",
    },
  ];
}

function manifest() : any[] {
  return [{
    id: stableId(`manifest:${ROOT}`),
    status: "pending",
    title: "Agent Service Collaboration Efficiency",
    directory: ROOT,
    source_files: [`docs/plans/${ROOT}/Plan.md`, `docs/plans/${ROOT}/DependencyMap.json`],
    purpose: "Own the only current efficiency-led functional candidate and its exact final receipt.",
    goal: "Accept one immutable enterprise single-node functional candidate with materially lower Agent-to-MCP Service interaction cost.",
    description: "Single current Plan containing efficiency, remaining delivery closures, and functional acceptance.",
    checkpoints: `${ROOT}/Checkpoints.json`,
    kind: "group",
    capability_key: "meshrix/agent-service-collaboration-efficiency",
    tree_mode: "show",
    node_status: "show",
    decision_issues: [],
  }];
}

function dependencyMap(revision?: any) : any {
  return {
    schema_version: 3,
    generated_from_revision: revision,
    profiles: [PROFILE],
    plans: [{
      directory: ROOT,
      parent: null,
      parent_contract_node_id: null,
      parent_integrations: [],
      final_validations: [{ node_id: stableId("functional-final"), profiles: [PROFILE] }],
      prerequisite_receipts: [],
      children: [],
      accepted_final_receipts: {},
    }],
  };
}

async function writeFile(root?: any, relativePath?: any, content?: any) : Promise<any> {
  const target: any = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

export async function buildCurrentPlanWorkspace({ repoRoot = defaultRepoRoot, outputRoot }: Record<string, any> = {}) : Promise<any> {
  const resolvedRepoRoot: any = path.resolve(repoRoot);
  const plansRoot: any = path.resolve(outputRoot ?? path.join(resolvedRepoRoot, "docs", "plans"));
  requireCondition(
    !(await fs.stat(plansRoot).then(() : any => true, () : any => false)),
    `Current release Plan already exists; ${REPLACE_REFUSAL}`,
  );
  const revision: any = currentRevision(resolvedRepoRoot);
  const stagingRoot: any = `${plansRoot}.initializing-${process.pid}`;
  await fs.rm(stagingRoot, { recursive: true, force: true });
  await fs.mkdir(stagingRoot, { recursive: true });
  try {
    const nodes: any[] = planNodes();
    await writeFile(stagingRoot, "Capabilities.json", jsonText(capabilities()));
    await writeFile(stagingRoot, "Manifest.json", jsonText(manifest()));
    await writeFile(stagingRoot, "FutureGoals.md", `# Future Goals\n\nThese workflows begin only after the current functional candidate is accepted and do not contribute receipts to it.\n\n- Native Linux environment qualification for named amd64 and arm64 hosts.\n- Client platform qualification for macOS, Windows, and supported browser shells.\n- Public-cloud and independent clean-host recovery qualification.\n- Multi-node availability, forwarding, federation, hosted operation, and external identity-provider profiles.\n`);
    await writeFile(stagingRoot, `${ROOT}/Plan.md`, planMarkdown());
    await writeFile(stagingRoot, `${ROOT}/Checkpoints.json`, jsonText(nodes));
    await writeFile(stagingRoot, `${ROOT}/DependencyMap.json`, jsonText(dependencyMap(revision)));
    await fs.mkdir(path.dirname(plansRoot), { recursive: true });
    await fs.rename(stagingRoot, plansRoot);
    return { ok: true, profile: PROFILE, plans: 1, nodes: nodes.length };
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

function parseArguments(argv: any[] = []) : any {
  let repoRoot: any = defaultRepoRoot;
  let outputRoot: any;
  let index: any = 0;
  if (argv[0] && !String(argv[0]).startsWith("--")) {
    repoRoot = path.resolve(argv[0]);
    index = 1;
  }
  while (index < argv.length) {
    if (argv[index] !== "--output-root" || outputRoot || !argv[index + 1]) {
      throw new Error(REPLACE_REFUSAL);
    }
    outputRoot = path.resolve(argv[index + 1]);
    index += 2;
  }
  return { repoRoot, outputRoot };
}

async function main(argv: any = process.argv.slice(2)) : Promise<any> {
  const result: any = await buildCurrentPlanWorkspace(parseArguments(argv));
  process.stdout.write(jsonText(result));
}

const isDirectRun: any = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  main().catch((error?: any) : any => {
    process.stderr.write(`[plan-baseline] ${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
