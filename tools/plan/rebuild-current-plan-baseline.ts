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
const PLUGIN_ISOLATION: any = `${ROOT}/plugin-console-isolation`;
const OFFLINE_TRANSFER: any = `${ROOT}/cross-system-offline-transfer`;
const ACCEPTANCE: any = `${ROOT}/functional-release-acceptance`;
const REPLACE_REFUSAL: any = "refusing to replace checkpoints or receipts";

const BASELINE_REQUIREMENTS: readonly any[] = Object.freeze([
  "REQ-BASELINE-UPSTREAM-GATEWAY",
  "REQ-BASELINE-DOWNSTREAM-MCP",
  "REQ-BASELINE-STRATEGY-MANAGEMENT",
  "REQ-BASELINE-ENTERPRISE-GOVERNANCE",
  "REQ-BASELINE-CONSOLE-ADMINISTRATION",
  "REQ-BASELINE-CONTAINER-DEPLOYMENT",
  "REQ-BASELINE-STORAGE",
  "REQ-BASELINE-JOBS",
  "REQ-BASELINE-AGENT-GATEWAY-MODEL-ROUTING",
  "REQ-BASELINE-CORE-WORKSPACE-ASSETS-GOVERNANCE",
]);

const PLAN_DEFINITIONS: readonly any[] = Object.freeze([
  Object.freeze({
    directory: ROOT,
    capabilityKey: "meshrix/release-orchestration",
    title: "Reliable Enterprise Single-Node Candidate",
    purpose: "Own the only current candidate and reduce its mandatory child receipts into one functional result.",
    goal: "Accept one immutable enterprise single-node functional candidate.",
    description: "Root release group for the sole current deployment profile.",
  }),
  Object.freeze({
    directory: DELIVERY,
    capabilityKey: "meshrix/enterprise-single-node",
    title: "Enterprise Single-Node Delivery",
    purpose: "Own candidate identity, governed operation, administration, recovery, upgrade, diagnostics, and capacity closure.",
    goal: "Deliver the complete platform behavior required by the functional candidate.",
    description: "Mandatory single-node product delivery group without environment support claims.",
  }),
  Object.freeze({
    directory: PLUGIN_ISOLATION,
    capabilityKey: "meshrix/plugin-console-isolation",
    title: "Plugin Console Isolation",
    purpose: "Own the third-party browser-code boundary and unified plugin verification closure.",
    goal: "Replace privileged same-origin plugin Console loading with an opaque-origin least-authority boundary.",
    description: "Mandatory plugin verification and browser-isolation group.",
  }),
  Object.freeze({
    directory: OFFLINE_TRANSFER,
    capabilityKey: "meshrix/cross-system-offline-transfer",
    title: "Cross-System Offline Transfer",
    purpose: "Own the exact candidate bytes transferred from a connected build environment to a disconnected target.",
    goal: "Prove a complete dual-architecture offline delivery artifact without rebuilding.",
    description: "Mandatory disconnected-delivery group; it does not establish native environment support.",
  }),
  Object.freeze({
    directory: ACCEPTANCE,
    capabilityKey: "meshrix/functional-release-acceptance",
    title: "Functional Release Acceptance",
    purpose: "Consume the three mandatory same-candidate child receipts and issue the functional verdict exactly once.",
    goal: "Reduce the mandatory delivery receipts into one functional candidate decision.",
    description: "Final functional gate independent of optional real-machine workflows.",
  }),
]);

function requireCondition(condition?: any, message?: any) : any {
  if (!condition) throw new Error(message);
}

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stableId(label?: any) : any {
  const digest: any = sha256(`meshrix-current-candidate:${label}`);
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

function commit(message?: any, target?: any) : any {
  return { repository: ".git", message, target };
}

function designContract({ directory, ownedPaths, acceptancePaths, interfaces = [], decisions = {} }: Record<string, any>) : any {
  return {
    artifact: `docs/plans/${directory}/Architecture.md`,
    owned_paths: ownedPaths,
    scaffold_paths: ownedPaths,
    acceptance_paths: acceptancePaths,
    symbols: [],
    interfaces,
    dependencies: [],
    decisions: {
      composition: decisions.composition || "one independently acceptable closure per implementation node",
      algorithms: decisions.algorithms || "single-pass validation and deterministic keyed reduction",
      data_structures: decisions.dataStructures || "immutable records, bounded maps, and explicit receipt keys",
      state: decisions.state || "one owner per mutable state boundary",
      isolation: decisions.isolation || "focused verification before one final group regression",
      concurrency: decisions.concurrency || "preserve independent ready nodes and serialize only true handoffs",
    },
    test_seams: ["declared focused regression and exact final receipt boundary"],
  };
}

function node({
  key,
  directory,
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
  verificationProfile = "code",
  designOwnedPaths,
  designAcceptancePaths,
  interfaces = [],
  designDecisions = {},
}: Record<string, any>) : any {
  const resolvedOwnedPaths: any[] = designOwnedPaths ?? [
    target === "build/reports"
      ? `tools/plan/${key}.ts`
      : path.extname(target)
        ? target
        : `${target}/${key}.ts`,
  ];
  const resolvedAcceptancePaths: any[] = designAcceptancePaths ?? [
    `tests/acceptance/${key}.test.ts`,
  ];
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
      directory,
      ownedPaths: resolvedOwnedPaths,
      acceptancePaths: resolvedAcceptancePaths,
      interfaces,
      decisions: designDecisions,
    }),
    acceptance_criteria: [criterion(acceptance)],
    commit: commit(`plan(${PROFILE}): ${goal}`, target),
    regression: {
      scope: role === "final_validation" ? "full" : "focused",
      commands,
      criteria: [0],
      paths,
    },
    next: next.map(stableId),
  };
}

function rootNodes() : any[] {
  const requirements: any[] = [
    "REQ-REL-BASELINE",
    "REQ-REL-CANDIDATE",
    "REQ-REL-RECEIPTS",
    "REQ-REL-PRIVACY",
    "REQ-REL-FUNCTIONAL",
  ];
  const design: any = "root-design";
  const contract: any = "root-candidate-contract";
  const integrations: any[] = [
    ["root-integrate-delivery", "REL-2", "Integrate enterprise delivery", "Consume the exact enterprise delivery receipt."],
    ["root-integrate-plugin", "REL-3", "Integrate plugin isolation", "Consume the exact plugin Console isolation receipt."],
    ["root-integrate-offline", "REL-4", "Integrate offline transfer", "Consume the exact cross-system offline-transfer receipt."],
    ["root-integrate-acceptance", "REL-5", "Integrate functional acceptance", "Consume the exact functional-acceptance receipt."],
  ];
  const final: any = "root-final";
  return [
    node({
      key: design,
      directory: ROOT,
      role: "group_design",
      code: "REL-0",
      title: "Freeze candidate receipt architecture",
      goal: "Freeze the five-group candidate and receipt architecture.",
      description: "Scope: define the sole functional-candidate authority, child ownership, receipt handoffs, support non-claims, and the smallest safe execution frontier. Context: the prior workspace mixed completed history, optional environments, and current release authority. Target: one decision-complete design for the current candidate only. Design Considerations: use explicit receipt keys and no ancestry-as-dependency assumptions. Design Value: a small graph prevents stale state from promoting release claims. Constraints & Risks: no historical completion or environment support may be imported.",
      requirements,
      acceptance: "Architecture.md fixes five groups, exact child receipt ownership, and optional environment non-dependencies.",
      target: `docs/plans/${ROOT}/Architecture.md`,
      commands: ["npm run verify:better-plan"],
      paths: ["docs/plans", "tools/plan", "tools/server-scripts"],
      difficulty: "critical",
      next: [contract, ...integrations.map(([key]: any[]) : any => key)],
    }),
    node({
      key: contract,
      directory: ROOT,
      role: "implementation",
      code: "REL-1",
      title: "Freeze immutable candidate contract",
      goal: "Freeze one immutable candidate identity and current Plan authority.",
      description: "Scope: Closure: capability - immutable candidate contract; release identity, Manifest, DependencyMap, receipt reducers, and privacy-safe evidence inventory. Context: a passing command or prior receipt cannot define the current candidate. Target: one candidate identity binds source revision, tree, lockfile, release definition, package inventory, image digests, profile, and report owners. Design Considerations: use deterministic hashing and keyed receipts with constant-time lookup. Design Value: exact binding prevents cross-candidate evidence composition. Constraints & Risks: no user identity, local path, secret, or backend runtime row enters evidence.",
      requirements: ["REQ-REL-BASELINE", "REQ-REL-CANDIDATE", "REQ-REL-PRIVACY"],
      acceptance: "One privacy-safe candidate identity binds every mandatory artifact and rejects substituted or cross-candidate evidence.",
      prerequisites: [design],
      next: [...integrations.map(([key]: any[]) : any => key), final],
      target: "tools/plan",
      commands: ["npm run verify:better-plan"],
      paths: ["docs/plans", "tools/plan", "tests/vitest/server"],
    }),
    ...integrations.map(([key, code, title, acceptance]: any[]) : any => node({
      key,
      directory: ROOT,
      role: "implementation",
      code,
      title,
      goal: `${title} receipt into the root candidate.`,
      description: `Scope: Closure: scenario - ${title.toLowerCase()} receipt integration; DependencyMap and final-receipt reducer. Context: child completion has no release effect until its exact current receipt is consumed. Target: accept one same-candidate child receipt and reject missing, stale, or mismatched evidence. Design Considerations: keyed lookup by child final node and candidate identity. Design Value: explicit integration keeps child ownership separate from release promotion. Constraints & Risks: this node does not rerun or reinterpret child verification.`,
      requirements: ["REQ-REL-RECEIPTS", "REQ-REL-PRIVACY"],
      acceptance,
      prerequisites: [design, contract],
      next: [final],
      target: `docs/plans/${ROOT}/DependencyMap.json`,
      commands: ["npm run verify:better-plan"],
      paths: ["docs/plans", "tools/plan", "tools/server-scripts"],
      designOwnedPaths: [`tools/plan/${key}-receipt.ts`],
    })),
    node({
      key: final,
      directory: ROOT,
      role: "final_validation",
      code: "REL-FINAL",
      title: "Reduce the functional candidate",
      goal: "Issue the only current enterprise single-node functional candidate result.",
      description: "Scope: Closure: scenario - root functional-candidate reduction; verify the current graph, exact receipts, privacy boundary, and support non-claims. Context: publication and environment support are separate downstream decisions. Target: one current result for enterprise-single-node only. Design Considerations: fail closed on every missing or stale receipt. Design Value: a single reducer prevents conflicting release authorities. Constraints & Risks: no native host, cloud, connector, or recovery-environment support claim is emitted.",
      requirements,
      acceptance: "The root reducer accepts only the exact functional receipt set and emits no environment support or publication claim.",
      prerequisites: [contract, ...integrations.map(([key]: any[]) : any => key)],
      target: "build/reports",
      commands: ["npm run verify:better-plan"],
      paths: ["docs/plans", "tools/plan", "tools/server-scripts"],
    }),
  ];
}

function deliveryNodes() : any[] {
  const design: any = "delivery-design";
  const candidate: any = "delivery-candidate-authority";
  const implementationKeys: any[] = [
    candidate,
    "delivery-governed-journey",
    "delivery-admin-key-lifecycle",
    "delivery-backup-restore",
    "delivery-upgrade-rollback",
    "delivery-capacity-envelope",
  ];
  const final: any = "delivery-final";
  const allRequirements: any[] = [
    ...BASELINE_REQUIREMENTS,
    "REQ-ENT-CANDIDATE",
    "REQ-ENT-GOVERNED-JOURNEY",
    "REQ-ENT-ADMIN-RECOVERY",
    "REQ-ENT-BACKUP-RESTORE",
    "REQ-ENT-UPGRADE-ROLLBACK",
    "REQ-ENT-CAPACITY",
  ];
  const common: any = {
    directory: DELIVERY,
    prerequisites: [design, candidate],
    next: [final],
  };
  return [
    node({
      key: design,
      directory: DELIVERY,
      role: "group_design",
      code: "ENT-0",
      title: "Freeze single-node delivery design",
      goal: "Freeze the mandatory single-node behavior and evidence boundaries.",
      description: "Scope: design candidate, governed journey, diagnostics, administrator recovery, key lifecycle, backup, upgrade, and capacity closures. Context: implemented surfaces need one same-candidate product journey. Target: disjoint implementation ownership with explicit artifact handoffs. Design Considerations: reuse current operation, storage, security, and resource authorities. Design Value: cohesive closures reduce duplicate evidence and full regressions. Constraints & Risks: plugin browser isolation and offline transfer remain separate sibling plans.",
      requirements: allRequirements,
      acceptance: "Architecture.md fixes the six delivery closures, their interfaces, and one final Ubuntu-container validation.",
      target: `docs/plans/${DELIVERY}/Architecture.md`,
      commands: ["npm run verify:acceptance:plan"],
      paths: ["docs/plans", "tools/server-scripts", "tests/vitest/server"],
      difficulty: "critical",
      next: implementationKeys,
    }),
    node({
      key: candidate,
      directory: DELIVERY,
      role: "implementation",
      code: "ENT-1",
      title: "Bind delivery to one candidate",
      goal: "Bind all single-node evidence to the root candidate identity.",
      description: "Scope: Closure: capability - delivery candidate binding; candidate identity, execution admission, report ownership, and Ubuntu-container authority. Context: delivery evidence is ineligible without an exact immutable source and artifact identity. Target: every mandatory delivery command consumes the same candidate and cannot reset Plan evidence. Design Considerations: deterministic digest projection and one initialization path. Design Value: removes cross-run evidence ambiguity. Constraints & Risks: optional environment workflows remain outside the functional gate.",
      requirements: ["REQ-ENT-CANDIDATE", ...BASELINE_REQUIREMENTS],
      acceptance: "All baseline platform capabilities and the complete delivery regression bind one exact candidate without rebuilding Plan state.",
      prerequisites: [design],
      next: [...implementationKeys.filter((key?: any) : any => key !== candidate), final],
      target: "tools/plan",
      commands: ["npm run verify:core-platform-surface-convergence", "npm run verify:acceptance:plan"],
      paths: ["docs/plans", "tools/plan", "tools/server-scripts"],
    }),
    node({
      key: "delivery-governed-journey",
      ...common,
      role: "implementation",
      code: "ENT-2",
      title: "Close the governed operation journey",
      goal: "Prove the first governed MCP-to-upstream operation and bounded diagnostics.",
      description: "Scope: Closure: scenario - first governed MCP-to-upstream call; authorization, gateway, diagnostics, audit, denial, revocation, replay, conflict, cancellation, and uncertainty. Context: individual surfaces are implemented but not accepted as one candidate journey. Target: exactly one authorized effect and zero unauthorized additional effects across negative cases. Design Considerations: sink-near revalidation, single-use permits, bounded privacy-safe reason codes. Design Value: one end-to-end invariant is stronger than disconnected checks. Constraints & Risks: raw credentials, identities, paths, requests, responses, and backend rows never enter reports.",
      requirements: ["REQ-ENT-GOVERNED-JOURNEY"],
      acceptance: "The positive journey succeeds once and every negative case produces no unauthorized additional effect with diagnosable bounded output.",
      target: "tools/server-scripts",
      commands: ["npm run verify:release-journey"],
      paths: ["packages", "tools/server-scripts", "tests/vitest/server"],
      difficulty: "critical",
    }),
    node({
      key: "delivery-admin-key-lifecycle",
      ...common,
      role: "implementation",
      code: "ENT-3",
      title: "Close administrator and key recovery",
      goal: "Close emergency administration and protected-key lifecycle without optional infrastructure.",
      description: "Scope: Closure: capability - emergency administrator and protected-key lifecycle; bootstrap, recovery, disablement, rotation, wrong-key denial, and historical proof verification. Context: candidate operation must remain recoverable when external identity is absent or broken. Target: one audited operator lifecycle with stable privacy-safe outcomes. Design Considerations: versioned ports, revision checks, and bounded historical keys. Design Value: preserves administrative availability without making an external provider authoritative. Constraints & Risks: actual external identity integrations remain future work.",
      requirements: ["REQ-ENT-ADMIN-RECOVERY"],
      acceptance: "Emergency recovery and key rotation work with optional identity disabled, while wrong, revoked, or stale authority fails closed.",
      target: "packages/foundation/src/security",
      commands: ["node tools/server-scripts/verify-emergency-administrator-recovery.ts", "npm run test:security"],
      paths: ["packages/foundation/src/security", "packages/server-runtime/src/composition", "tests/vitest/server"],
      difficulty: "critical",
    }),
    node({
      key: "delivery-backup-restore",
      ...common,
      role: "implementation",
      code: "ENT-4",
      title: "Close clean-root restore",
      goal: "Restore one independent backup into a clean replacement root.",
      description: "Scope: Closure: scenario - independent backup and clean-root restore; integrity, preview, key separation, schema admission, restart, and governed-call recovery. Context: filesystem copies or same-root reopen do not prove recovery. Target: one exact-candidate functional restore without reusing the source data root. Design Considerations: streaming integrity checks and bounded restore state. Design Value: proves recoverability of governed state, not only archive readability. Constraints & Risks: this is a functional simulation, not a cross-host environment support claim.",
      requirements: ["REQ-ENT-BACKUP-RESTORE"],
      acceptance: "An independently retained backup restores into a clean root and the governed call succeeds again without source-root reuse.",
      target: "packages/foundation/src/storage",
      commands: ["node tools/server-scripts/verify-storage-production-restore-drill.ts"],
      paths: ["packages/foundation/src/storage", "packages/server-runtime/src/composition", "tests/vitest/server"],
      difficulty: "critical",
    }),
    node({
      key: "delivery-upgrade-rollback",
      ...common,
      role: "implementation",
      code: "ENT-5",
      title: "Close N-1 upgrade rollback",
      goal: "Prove a real schema transition, failed upgrade rollback, and healthy retry.",
      description: "Scope: Closure: scenario - N-1 upgrade and rollback; preflight, backup, atomic migration, health admission, failure rollback, reopen, and retry. Context: a single-image restart does not prove upgrade safety. Target: two immutable generations preserve governed state across success and injected failure. Design Considerations: transactional migration and one active-generation pointer. Design Value: prevents half-migrated state from becoming current. Constraints & Risks: no environment support claim follows from the functional workflow.",
      requirements: ["REQ-ENT-UPGRADE-ROLLBACK"],
      acceptance: "A failed N-1 upgrade returns to the last healthy generation without state loss, and a corrected retry becomes healthy.",
      target: "tools/server-scripts",
      commands: ["node tools/server-scripts/verify-upgrade-rollback.ts"],
      paths: ["packages/foundation/src/storage", "tools/server-scripts", "tests/vitest/server"],
      difficulty: "critical",
    }),
    node({
      key: "delivery-capacity-envelope",
      ...common,
      role: "implementation",
      code: "ENT-6",
      title: "Publish bounded candidate capacity",
      goal: "Measure and publish named resource and Console capacity envelopes.",
      description: "Scope: Closure: capability - candidate capacity envelope; gateway, queue, upload, event, plugin, storage, and Console workloads. Context: optimization and support claims require measured saturation evidence. Target: named hardware-neutral test profiles record configuration, workload, throughput, tail latency, memory, event-loop delay, storage contention, and recovery. Design Considerations: bounded queues, shared caches, batching, and single-pass aggregation are adopted only after profiling evidence. Design Value: prevents speculative complexity and repeated computation. Constraints & Risks: results apply only to the named configuration and are not production guarantees.",
      requirements: ["REQ-ENT-CAPACITY"],
      acceptance: "Each published envelope names configuration, workload, saturation, resource ceiling, and recovery behavior without generalizing beyond the evidence.",
      target: "tools/server-scripts",
      commands: ["npm run server:verify:resource-discipline"],
      paths: ["apps/console", "packages", "tools/server-scripts", "tests/vitest/server"],
    }),
    node({
      key: final,
      directory: DELIVERY,
      role: "final_validation",
      code: "ENT-FINAL",
      title: "Validate enterprise delivery",
      goal: "Validate the exact single-node candidate in one fresh Ubuntu container.",
      description: "Scope: Closure: scenario - enterprise delivery final; reconstruct the candidate in a digest-pinned Ubuntu container and execute the complete delivery regression once. Context: focused closures must converge on one immutable candidate. Target: one current delivery receipt covering baseline, governed journey, recovery, upgrade, diagnostics, and capacity evidence. Design Considerations: receipt reduction is deterministic and privacy-safe. Design Value: a single final run limits regression cost and prevents evidence mixing. Constraints & Risks: plugin isolation and offline transfer are separate sibling receipts.",
      requirements: allRequirements,
      acceptance: "All delivery nodes are current and one fresh container produces a same-candidate privacy-safe final receipt after one complete regression.",
      prerequisites: implementationKeys,
      target: "tools/server-scripts/verify-enterprise-single-node-ubuntu-container.ts",
      commands: ["npm run verify:enterprise-single-node:ubuntu-container"],
      paths: [".github/workflows", "docker-compose.yml", "docs/plans", "packages", "tools"],
    }),
  ];
}

function pluginIsolationNodes() : any[] {
  const design: any = "plugin-design";
  const verifier: any = "plugin-verifier-registry";
  const contract: any = "plugin-console-contract";
  const frame: any = "plugin-opaque-frame";
  const bridge: any = "plugin-capability-bridge";
  const migration: any = "plugin-host-migration";
  const final: any = "plugin-final";
  const implementationKeys: any[] = [verifier, contract, frame, bridge, migration];
  const requirements: any[] = [
    "REQ-BASELINE-EXTERNAL-PLUGIN-PACKAGING-LOADING",
    "REQ-PLUGIN-VERIFIER",
    "REQ-PLUGIN-CONTRIBUTION",
    "REQ-PLUGIN-OPAQUE-FRAME",
    "REQ-PLUGIN-BRIDGE",
    "REQ-PLUGIN-LEGACY-REMOVAL",
    "REQ-PLUGIN-BOUNDS",
  ];
  const common: any = { directory: PLUGIN_ISOLATION, next: [final] };
  return [
    node({
      key: design,
      directory: PLUGIN_ISOLATION,
      role: "group_design",
      code: "PLUGIN-0",
      title: "Freeze plugin Console isolation design",
      goal: "Freeze the third-party browser sandbox and least-authority bridge contract.",
      description: "Scope: define plugin contribution migration, opaque iframe document, MessageChannel bridge, Operation Permission handoff, lifecycle revocation, resource bounds, and browser escape verification. Context: current Console code executes by same-origin dynamic import. Target: a complete migration with no privileged fallback. Design Considerations: one self-contained artifact, opaque origin, explicit capability list, bounded messages, and generation binding. Design Value: browser isolation becomes enforceable rather than a provenance claim. Constraints & Risks: server plugin modules remain separately classified trusted in-process deployment code.",
      requirements,
      acceptance: "Architecture.md fixes the closed contribution, iframe, bridge, lifecycle, bounds, and legacy-removal contracts.",
      target: `docs/plans/${PLUGIN_ISOLATION}/Architecture.md`,
      commands: ["npm run verify:plugin-runtime"],
      paths: ["apps/console", "apps/server", "packages/server-runtime", "tests/vitest"],
      difficulty: "critical",
      next: implementationKeys,
    }),
    node({
      key: verifier,
      ...common,
      role: "implementation",
      code: "PLUGIN-1",
      title: "Register plugin runtime verification",
      goal: "Make the existing plugin runtime verifier part of unified capability verification.",
      description: "Scope: Closure: module - plugin runtime verifier registration; test registry, capability matrix, acceptance command mapping, and platform audit reduction. Context: the verifier exists but the unified audit still reports partial structural coverage. Target: one registered authority with no duplicate command or report owner. Design Considerations: reuse registry indexes and avoid repeated filesystem scans. Design Value: current evidence becomes discoverable by the same platform reducer. Constraints & Risks: this node does not implement browser isolation.",
      requirements: ["REQ-BASELINE-EXTERNAL-PLUGIN-PACKAGING-LOADING", "REQ-PLUGIN-VERIFIER"],
      acceptance: "The unified platform audit resolves the current plugin runtime report through one registered verifier authority.",
      prerequisites: [design],
      target: "tools/registry",
      commands: ["npm run verify:plugin-runtime", "npm run verify:platform-audit"],
      paths: ["tools/registry", "tools/scripts", "tools/server-scripts"],
    }),
    node({
      key: contract,
      ...common,
      role: "implementation",
      code: "PLUGIN-2",
      title: "Migrate the Console contribution contract",
      goal: "Replace executable module projection with a closed sandbox and tool-capability projection.",
      description: "Scope: Closure: interface - PluginConsoleEntry and contribution admission; sandboxUrl, bridge version, plugin-owned allowed tool ids, artifact identity, route or slot identity, and scope list. Context: assetUrl and assetExport currently expose a privileged browser loading path. Target: public state contains only the isolated endpoint and closed capabilities. Design Considerations: immutable snapshots and constant-time maps validate tool ownership and generation. Design Value: the Host can enforce least authority before code runs. Constraints & Risks: old Console entries are rejected; no compatibility projection remains.",
      requirements: ["REQ-PLUGIN-CONTRIBUTION", "REQ-PLUGIN-LEGACY-REMOVAL"],
      acceptance: "Console contributions admit only closed sandbox metadata and plugin-owned Operation Permission tool ids; legacy fields are absent from public projection.",
      prerequisites: [design],
      next: [frame, bridge, final],
      target: "packages/server-runtime/src/composition/plugin-contribution-registry.ts",
      commands: ["npm run vitest -- tests/vitest/server/plugin-contribution-registry.test.ts"],
      paths: ["packages/server-runtime", "tests/vitest/server"],
      difficulty: "critical",
      interfaces: [{
        name: "PluginConsoleEntry",
        producer: "packages/server-runtime/src/composition/plugin-contribution-registry.ts",
        consumers: ["apps/console/router/plugin-console-routes.ts"],
        inputs: "verified plugin console declaration and artifact identity",
        outputs: "sandbox URL, bridge version, plugin-owned tool ids, scopes, and route metadata",
        errors: ["reject legacy or cross-plugin capability declarations"],
      }],
    }),
    node({
      key: frame,
      ...common,
      role: "implementation",
      code: "PLUGIN-3",
      title: "Serve the opaque sandbox document",
      goal: "Serve verified plugin UI inside a network-denied opaque-origin iframe.",
      description: "Scope: Closure: module - plugin Console sandbox HTTP document; authenticated artifact lookup, nonce bootstrap, opaque iframe response policy, and current generation checks. Context: a verified same-origin script is still privileged browser code. Target: sandbox=allow-scripts only, no same-origin, forms, popups, downloads, top navigation, or direct network. Design Considerations: embed one verified self-contained module with a nonce and deny connect, form, object, media, and external resource sources. Design Value: the browser enforces the isolation boundary even for hostile UI code. Constraints & Risks: retain the 4 MiB asset limit and never weaken the Host page CSP.",
      requirements: ["REQ-PLUGIN-OPAQUE-FRAME", "REQ-PLUGIN-BOUNDS"],
      acceptance: "The iframe document is generation-bound, opaque-origin, no-store, frameable only by the Host, and unable to access Host DOM, storage, credentials, or network.",
      prerequisites: [design, contract],
      next: [migration, final],
      target: "apps/server/runtime/http-server-plugin-console-assets.ts",
      commands: ["npm run vitest -- tests/vitest/server/http-server-plugin-console-assets.test.ts"],
      paths: ["apps/server/runtime", "tests/vitest/server"],
      difficulty: "critical",
    }),
    node({
      key: bridge,
      ...common,
      role: "implementation",
      code: "PLUGIN-4",
      title: "Implement the least-authority bridge",
      goal: "Expose only bounded context and governed plugin-owned tool calls through one MessageChannel.",
      description: "Scope: Closure: interface - versioned plugin Console MessageChannel bridge; theme, locale, privacy-safe route context, tool call, cancellation, bounded response, and lifecycle close. Context: an opaque frame needs explicit capabilities without direct HTTP access. Target: every call rechecks session, scopes, active route, plugin generation, declared tool ownership, and Operation Permission. Design Considerations: one-use channel binding, request-id map, four in-flight calls, 1 MiB request, 8 MiB response, and 30 second timeout. Design Value: explicit mediation preserves revocation and audit semantics. Constraints & Risks: query secrets and arbitrary Host state are not projected.",
      requirements: ["REQ-PLUGIN-BRIDGE", "REQ-PLUGIN-BOUNDS"],
      acceptance: "Only declared plugin-owned tools execute through Operation Permission; oversized, stale, revoked, timed-out, or cancelled calls fail closed and release resources.",
      prerequisites: [design, contract],
      next: [migration, final],
      target: "apps/console/router/plugin-console-routes.ts",
      commands: ["npm run vitest -- tests/vitest/server/plugin-console-routes.test.ts"],
      paths: ["apps/console", "packages/ui-console", "tests/vitest/server"],
      difficulty: "critical",
      interfaces: [{
        name: "plugin-console-bridge-v1",
        producer: "apps/console/router/plugin-console-routes.ts",
        consumers: ["sandboxed plugin Console document"],
        inputs: "bounded versioned JSON tool-call and cancellation envelopes",
        outputs: "theme, locale, privacy-safe route context, and bounded governed results",
        errors: ["stale generation", "unauthorized tool", "resource limit", "timeout", "cancellation"],
      }],
    }),
    node({
      key: migration,
      ...common,
      role: "implementation",
      code: "PLUGIN-5",
      title: "Remove privileged Console loading",
      goal: "Switch routes and slots to the sandbox Host and delete direct dynamic import compatibility.",
      description: "Scope: Closure: scenario - plugin Console Host migration; router, workspace slots, unmount, logout, disablement, generation drift, browser escape matrix, and deletion of direct module import. Context: retaining the old importer would preserve the vulnerability. Target: every plugin Console surface uses the isolated Host and destroys the channel on authority change. Design Considerations: one lifecycle controller owns iframe, MessagePort, AbortControllers, and object URLs. Design Value: complete migration prevents split security semantics and resource leaks. Constraints & Risks: tests must exercise DOM, storage, network, navigation, message spoofing, revocation, and resource-bound attacks in a real browser.",
      requirements: ["REQ-PLUGIN-LEGACY-REMOVAL", "REQ-PLUGIN-BOUNDS"],
      acceptance: "No same-origin plugin import path remains, all routes and slots use the sandbox Host, and the browser escape matrix passes.",
      prerequisites: [design, frame, bridge],
      target: "apps/console/router/plugin-console-routes.ts",
      commands: ["npm run vitest -- tests/vitest/server/plugin-console-routes.test.ts tests/vitest/server/http-server-plugin-console-assets.test.ts", "npm run verify:console-admin-browser-visual"],
      paths: ["apps/console", "apps/server", "tests/vitest"],
      difficulty: "critical",
      verificationProfile: "hybrid",
    }),
    node({
      key: final,
      directory: PLUGIN_ISOLATION,
      role: "final_validation",
      code: "PLUGIN-FINAL",
      title: "Validate plugin Console isolation",
      goal: "Validate unified plugin evidence and the complete browser isolation boundary.",
      description: "Scope: Closure: scenario - plugin isolation final; verify contribution admission, opaque document policy, bridge authorization, lifecycle revocation, resource cleanup, and absence of legacy loading. Context: provenance and focused unit tests alone do not prove browser isolation. Target: one hybrid final receipt with real-browser evidence and current plugin runtime reduction. Design Considerations: code and rendered security evidence reduce together. Design Value: the candidate receives one explicit third-party UI trust verdict. Constraints & Risks: server plugin modules remain trusted in-process code and are not relabeled sandboxed.",
      requirements,
      acceptance: "Unified plugin runtime evidence is current, every browser escape case fails closed, and no privileged Console fallback remains.",
      prerequisites: implementationKeys,
      target: "build/reports",
      commands: ["npm run verify:plugin-runtime", "npm run verify:console-admin-browser-visual"],
      paths: ["apps/console", "apps/server", "packages", "tools", "tests"],
      verificationProfile: "hybrid",
    }),
  ];
}

function offlineNodes() : any[] {
  const design: any = "offline-design";
  const bundle: any = "offline-dual-arch-bundle";
  const journey: any = "offline-disconnected-journey";
  const final: any = "offline-final";
  const requirements: any[] = ["REQ-OFFLINE-DUAL-ARCH", "REQ-OFFLINE-TRANSFER", "REQ-OFFLINE-NONCLAIM"];
  return [
    node({
      key: design,
      directory: OFFLINE_TRANSFER,
      role: "group_design",
      code: "OFFLINE-0",
      title: "Freeze disconnected delivery design",
      goal: "Freeze the exact connected-to-disconnected artifact and receipt flow.",
      description: "Scope: define candidate-bound amd64 and arm64 OCI layouts, dependency inventory, SBOM, provenance, signatures, extraction, verification, startup, first call, shutdown, and cleanup. Context: a source tree or image cache is not an offline delivery artifact. Target: exact exported bytes cross one custody boundary without rebuild. Design Considerations: content-addressed inventory and streaming verification. Design Value: deterministic bytes and receipts make disconnected installation auditable. Constraints & Risks: native environment support remains a separate future workflow.",
      requirements,
      acceptance: "Architecture.md fixes the dual-architecture package, custody handoff, disconnected lifecycle, and support non-claim.",
      target: `docs/plans/${OFFLINE_TRANSFER}/Architecture.md`,
      commands: ["npm run verify:cross-system-offline-transfer"],
      paths: ["docker-compose.yml", "tools/server-scripts", "tests/vitest/server"],
      difficulty: "critical",
      next: [bundle, journey],
    }),
    node({
      key: bundle,
      directory: OFFLINE_TRANSFER,
      role: "implementation",
      code: "OFFLINE-1",
      title: "Build the dual-architecture bundle",
      goal: "Produce one complete candidate-bound offline bundle for Linux amd64 and arm64.",
      description: "Scope: Closure: module - offline bundle assembly; OCI layouts, dependency inventory, SBOM, provenance, signatures, digests, extraction, and verification commands. Context: all claimed runtime dependencies must be present before network isolation. Target: deterministic exported bytes for both target architectures. Design Considerations: sorted inventories, streaming digests, and no duplicate artifact reads. Design Value: one immutable inventory prevents missing-dependency and substitution ambiguity. Constraints & Risks: the bundle establishes functional artifact coverage, not native host support.",
      requirements: ["REQ-OFFLINE-DUAL-ARCH", "REQ-OFFLINE-NONCLAIM"],
      acceptance: "The exact candidate exports verified amd64 and arm64 OCI layouts with complete inventory, SBOM, provenance, signatures, and cleanup instructions.",
      prerequisites: [design],
      next: [journey, final],
      target: "tools/server-scripts",
      commands: ["npm run verify:composition-source-package"],
      paths: ["docker-compose.yml", "packages", "tools/server-scripts"],
      difficulty: "critical",
    }),
    node({
      key: journey,
      directory: OFFLINE_TRANSFER,
      role: "implementation",
      code: "OFFLINE-2",
      title: "Prove the disconnected lifecycle",
      goal: "Transfer and run the exact bundle on a network-disabled clean target.",
      description: "Scope: Closure: scenario - disconnected installation journey; custody transfer, digest and signature verification, import, startup, health, first governed call, shutdown, and cleanup. Context: package assembly alone does not prove offline operation. Target: the target performs no rebuild and contacts no public network. Design Considerations: explicit phase receipts and deterministic cleanup. Design Value: a complete lifecycle catches missing dependencies and hidden network use. Constraints & Risks: this is a controlled functional environment, not a support claim for its host.",
      requirements: ["REQ-OFFLINE-TRANSFER", "REQ-OFFLINE-NONCLAIM"],
      acceptance: "A clean network-disabled target verifies and runs the exact exported bytes through the first governed call, then stops and cleans up without rebuilding.",
      prerequisites: [design, bundle],
      next: [final],
      target: "tools/server-scripts/verify-cross-system-offline-transfer-evidence.ts",
      commands: ["npm run verify:cross-system-offline-transfer"],
      paths: [".github/workflows", "tools/server-scripts", "tests/vitest/server"],
      difficulty: "critical",
    }),
    node({
      key: final,
      directory: OFFLINE_TRANSFER,
      role: "final_validation",
      code: "OFFLINE-FINAL",
      title: "Validate cross-system offline transfer",
      goal: "Reduce the exact offline artifact and disconnected lifecycle receipt.",
      description: "Scope: Closure: scenario - offline transfer final; verify candidate binding, complete inventory, disconnected behavior, first governed call, and support non-claim. Context: the functional candidate consumes this receipt as mandatory evidence. Target: one same-candidate privacy-safe offline receipt. Design Considerations: reducer reads each phase once and rejects missing or stale evidence. Design Value: keeps artifact verification separate from environment support. Constraints & Risks: no native Linux support statement is emitted.",
      requirements,
      acceptance: "The reducer accepts only the exact candidate bundle and complete disconnected lifecycle, with no native environment support claim.",
      prerequisites: [bundle, journey],
      target: "build/reports",
      commands: ["npm run verify:cross-system-offline-transfer"],
      paths: [".github/workflows", "docs/plans", "tools/server-scripts", "tests/vitest/server"],
    }),
  ];
}

function acceptanceNodes() : any[] {
  const design: any = "acceptance-design";
  const reduce: any = "acceptance-reduce";
  const final: any = "acceptance-final";
  const requirements: any[] = ["REQ-ACCEPT-SAME-CANDIDATE", "REQ-ACCEPT-NEGATIVE", "REQ-ACCEPT-ONCE"];
  return [
    node({
      key: design,
      directory: ACCEPTANCE,
      role: "group_design",
      code: "ACCEPT-0",
      title: "Freeze functional acceptance design",
      goal: "Freeze the same-candidate receipt reducer and one-run Functional Release Gate.",
      description: "Scope: define receipt providers, currentness checks, negative mutation matrix, single execution authority, and functional-only output. Context: optional environment state must neither promote nor block the candidate. Target: consume enterprise delivery, plugin isolation, and offline transfer receipts only. Design Considerations: keyed receipt validation and atomic final reduction. Design Value: one strict reducer prevents stale or optional evidence from changing the verdict. Constraints & Risks: publication and support remain unclaimed.",
      requirements,
      acceptance: "Architecture.md fixes the three mandatory providers, exact rejection matrix, and one-run final gate.",
      target: `docs/plans/${ACCEPTANCE}/Architecture.md`,
      commands: ["npm run verify:acceptance:plan"],
      paths: ["docs/plans", "tools/plan", "tools/server-scripts"],
      difficulty: "critical",
      next: [reduce],
    }),
    node({
      key: reduce,
      directory: ACCEPTANCE,
      role: "implementation",
      code: "ACCEPT-1",
      title: "Reduce mandatory functional receipts",
      goal: "Consume the three mandatory child receipts and reject every inexact set.",
      description: "Scope: Closure: scenario - functional receipt reduction; enterprise delivery, plugin isolation, offline transfer, missing, stale, rebuilt, substituted, cross-candidate, and replay cases. Context: all three product workstreams are mandatory before the candidate can close. Target: one atomic decision for the exact candidate. Design Considerations: sorted keyed receipt map and constant-time identity comparisons. Design Value: deterministic rejection prevents accidental evidence composition. Constraints & Risks: real-machine, cloud, connector, and cross-host receipts are neither read nor required.",
      requirements: ["REQ-ACCEPT-SAME-CANDIDATE", "REQ-ACCEPT-NEGATIVE", "REQ-ACCEPT-ONCE"],
      acceptance: "The reducer accepts exactly one current same-candidate receipt from each mandatory provider and rejects every negative mutation.",
      prerequisites: [design],
      next: [final],
      target: "tools/server-scripts/verify-platform-acceptance.ts",
      commands: ["npm run verify:acceptance:plan"],
      paths: ["docs/plans", "tools/plan", "tools/server-scripts", "tests/vitest/server"],
      difficulty: "critical",
    }),
    node({
      key: final,
      directory: ACCEPTANCE,
      role: "final_validation",
      code: "ACCEPT-FINAL",
      title: "Run the Functional Release Gate once",
      goal: "Issue one functional candidate receipt from the exact mandatory evidence set.",
      description: "Scope: Closure: scenario - functional acceptance final; execute the gate once, verify current candidate binding, and publish only the functional verdict. Context: reruns or optional environment inputs would create competing acceptance authority. Target: one privacy-safe receipt and no environment or publication claim. Design Considerations: atomic write and replay refusal. Design Value: one final authority makes release state unambiguous. Constraints & Risks: any confirmed security or data-integrity blocker fails closed.",
      requirements,
      acceptance: "The Functional Release Gate runs once, consumes only current mandatory receipts, and emits one functional-only candidate receipt.",
      prerequisites: [reduce],
      target: "build/reports",
      commands: ["npm run verify:acceptance:plan"],
      paths: [".github/workflows", "docs/plans", "tools/plan", "tools/server-scripts"],
    }),
  ];
}

function requirementMarkdown(title?: any, purpose?: any, requirements: readonly string[] = []) : any {
  return `# ${title}\n\n## Authority\n\nThis is current execution authority for the \`${PROFILE}\` functional candidate. Historical lifecycle state and receipts are not inputs.\n\n## Purpose\n\n${purpose}\n\n## Requirements\n\n${requirements.map((label?: any) : any => `- **${label}**`).join("\n")}\n\n## Support Boundary\n\nThe functional candidate does not claim native Linux, macOS, Windows, public-cloud, connector, or independent recovery-environment support.\n`;
}

function architectureMarkdown(title?: any, body?: any) : any {
  return `# ${title} Architecture\n\n${body}\n\n## Design Pattern Assessment\n\nPending group design. The Designer must compare any catalog pattern with the simplest direct solution and record the concrete benefit, costs, smallest application, and acceptance seam.\n`;
}

function validationMarkdown(title?: any, requirements: readonly string[] = []) : any {
  return `# ${title} Validation\n\nEvery implementation runs its declared focused regression. The group Reviewer runs once, followed by one full group regression. The final receipt must cover all non-skipped implementation requirements:\n\n${requirements.map((label?: any) : any => `- **${label}**`).join("\n")}\n`;
}

function capabilities() : any[] {
  return [
    {
      key: "meshrix",
      parent: null,
      title: "Meshrix",
      kind: "repository",
      basis: "observed",
      disclosure: "examined",
      touch: "in_scope",
      source_files: ["docs/STATUS.md", "docs/WHATS-NEXT.md"],
      description: "Meshrix.js is a pre-release private-deployment governance platform whose current closure is one enterprise single-node functional candidate.",
    },
    ...PLAN_DEFINITIONS.map((plan?: any) : any => ({
      key: plan.capabilityKey,
      parent: "meshrix",
      title: plan.title,
      kind: plan.directory === PLUGIN_ISOLATION ? "feature" : "capability",
      basis: plan.directory === PLUGIN_ISOLATION ? "designed" : "observed",
      disclosure: "examined",
      touch: "in_scope",
      source_files: [`docs/plans/${plan.directory}/${plan.directory === ROOT ? "Requirements.md" : "Plan.md"}`],
      description: plan.description,
    })),
  ];
}

function planRequirements(nodes: any[] = []) : any[] {
  return [...new Set<any>(nodes.flatMap((entry?: any) : any => entry.requirements || []))];
}

function planSources(directory?: any) : any[] {
  if (directory === ROOT) {
    return ["Requirements.md", "CurrentPlan.md", "Architecture.md", "Evidence.md", "Validation.md", "DependencyMap.json"]
      .map((name?: any) : any => `docs/plans/${ROOT}/${name}`);
  }
  return ["Plan.md", "Architecture.md", "Validation.md"]
    .map((name?: any) : any => `docs/plans/${directory}/${name}`);
}

function manifest() : any[] {
  return PLAN_DEFINITIONS.map((plan?: any) : any => ({
    id: stableId(`manifest:${plan.directory}`),
    status: "pending",
    title: plan.title,
    directory: plan.directory,
    source_files: planSources(plan.directory),
    purpose: plan.purpose,
    goal: plan.goal,
    description: plan.description,
    checkpoints: `${plan.directory}/Checkpoints.json`,
    kind: "group",
    capability_key: plan.capabilityKey,
    tree_mode: "show",
    node_status: "show",
    decision_issues: [],
  }));
}

function dependencyMap(revision?: any) : any {
  const rootContract: any = stableId("root-candidate-contract");
  const childBindings: any[] = [
    [DELIVERY, "delivery-final", "root-integrate-delivery"],
    [PLUGIN_ISOLATION, "plugin-final", "root-integrate-plugin"],
    [OFFLINE_TRANSFER, "offline-final", "root-integrate-offline"],
    [ACCEPTANCE, "acceptance-final", "root-integrate-acceptance"],
  ];
  const prerequisiteReceipts: any = [
    [DELIVERY, "delivery-final"],
    [PLUGIN_ISOLATION, "plugin-final"],
    [OFFLINE_TRANSFER, "offline-final"],
  ].map(([plan, final]: any[]) : any => ({
    plan,
    node_id: stableId(final),
    kind: "final_validation",
    profiles: [PROFILE],
  }));
  return {
    schema_version: 3,
    generated_from_revision: revision,
    profiles: [PROFILE],
    plans: [
      {
        directory: ROOT,
        parent: null,
        parent_contract_node_id: null,
        parent_integrations: [],
        final_validations: [{ node_id: stableId("root-final"), profiles: [PROFILE] }],
        prerequisite_receipts: [],
        children: childBindings.map(([directory]: any[]) : any => directory),
        accepted_final_receipts: {},
      },
      ...childBindings.map(([directory, final, integration]: any[]) : any => ({
        directory,
        parent: ROOT,
        parent_contract_node_id: rootContract,
        parent_integrations: [{
          child_final_node_id: stableId(final),
          parent_node_id: stableId(integration),
          profiles: [PROFILE],
        }],
        final_validations: [{ node_id: stableId(final), profiles: [PROFILE] }],
        prerequisite_receipts: directory === ACCEPTANCE ? prerequisiteReceipts : [],
        children: [],
        accepted_final_receipts: {},
      })),
    ],
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
    const planNodesByDirectory: any = new Map<any, any>([
      [ROOT, rootNodes()],
      [DELIVERY, deliveryNodes()],
      [PLUGIN_ISOLATION, pluginIsolationNodes()],
      [OFFLINE_TRANSFER, offlineNodes()],
      [ACCEPTANCE, acceptanceNodes()],
    ]);
    const map: any = dependencyMap(revision);
    await writeFile(stagingRoot, "Capabilities.json", jsonText(capabilities()));
    await writeFile(stagingRoot, "Manifest.json", jsonText(manifest()));
    await writeFile(stagingRoot, "FutureGoals.md", `# Future Goals\n\nThese workflows begin only after the current functional candidate is accepted. They do not contribute receipts to the current five-group authority.\n\n- Native Linux environment qualification for named amd64 and arm64 hosts.\n- Client platform qualification for macOS, Windows, and supported browser shells.\n- Public-cloud deployment qualification with named provider boundaries.\n- Independent recovery-environment qualification on a clean external host.\n- Multi-node, forwarding, and external identity-provider profiles when separately approved.\n`);
    for (const plan of PLAN_DEFINITIONS) {
      const nodes: any[] = planNodesByDirectory.get(plan.directory);
      const requirements: any[] = planRequirements(nodes);
      await writeFile(stagingRoot, `${plan.directory}/Checkpoints.json`, jsonText(nodes));
      await writeFile(stagingRoot, `${plan.directory}/Architecture.md`, architectureMarkdown(
        plan.title,
        `${plan.description} Execution order exists only in Checkpoints.json prerequisites and DependencyMap receipt bindings.`,
      ));
      await writeFile(stagingRoot, `${plan.directory}/Validation.md`, validationMarkdown(plan.title, requirements));
      if (plan.directory === ROOT) {
        await writeFile(stagingRoot, `${ROOT}/Requirements.md`, requirementMarkdown(plan.title, plan.purpose, requirements));
        await writeFile(stagingRoot, `${ROOT}/CurrentPlan.md`, `# Current Plan\n\nThe only active outcome is one enterprise single-node functional candidate. Enterprise delivery, plugin Console isolation, and cross-system offline transfer proceed after the root candidate contract and feed Functional Release Acceptance. Native hosts, client platforms, public cloud, and independent recovery environments remain downstream support workflows.\n`);
        await writeFile(stagingRoot, `${ROOT}/Evidence.md`, "# Evidence\n\nNo historical completion state or accepted receipt is imported. Every new node begins pending and may advance only through current same-candidate evidence.\n");
        await writeFile(stagingRoot, `${ROOT}/DependencyMap.json`, jsonText(map));
      } else {
        await writeFile(stagingRoot, `${plan.directory}/Plan.md`, requirementMarkdown(plan.title, plan.purpose, requirements));
      }
    }
    await fs.mkdir(path.dirname(plansRoot), { recursive: true });
    await fs.rename(stagingRoot, plansRoot);
    const nodeCount: any = [...planNodesByDirectory.values()]
      .reduce((total?: any, nodes?: any[]) : any => total + (nodes?.length ?? 0), 0);
    return { ok: true, profile: PROFILE, plans: PLAN_DEFINITIONS.length, nodes: nodeCount };
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
