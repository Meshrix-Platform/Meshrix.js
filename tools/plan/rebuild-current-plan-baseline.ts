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
const DELIVERY_PROVENANCE_KEY: any = "delivery-provenance-substrate";
const DELIVERY_TYPING_KEY: any = "delivery-typing-substrate";
const DELIVERY_FEEDBACK_KEY: any = "delivery-feedback-substrate";
const DELIVERY_ACCEPTANCE_REMAINDER_KEY: any = "delivery-acceptance-remainder";
const DELIVERY_TYPING_REMAINDER_KEY: any = "delivery-typing-remainder";
const DELIVERY_FEEDBACK_REMAINDER_KEY: any = "delivery-feedback-remainder";

const GATEWAY_CANONICAL_OWNED_PATHS: readonly any[] = Object.freeze([
  "package.json",
  "package-lock.json",
  "vitest.config.ts",
  "packages/agents/package.json",
  "packages/agents/manifest.module.json",
  "packages/agents/src/agent-gateway",
  "packages/agents/src/agent-configs",
  "packages/agents/src/maintenance",
  "packages/server-runtime/src/composition/background-workers/maintenance-worker.ts",
  "packages/server-runtime/src/composition/console-domain",
  "packages/server-runtime/src/composition/maintenance-work-queue-provider.ts",
  "packages/server-runtime/src/composition/server-runtime-providers.ts",
  "packages/server-runtime/src/composition/composition-root.ts",
  "packages/server-runtime/src/composition/interface-manifest.ts",
  "packages/server-runtime/src/composition/product-api.ts",
  "packages/server-runtime/src/composition/features",
  "packages/server-runtime/src/composition/agent-mcp-gateway-pipeline.ts",
  "packages/server-runtime/src/composition/gateway-channel-router.ts",
  "packages/server-runtime/src/composition/http-application-assembly.ts",
  "packages/server-runtime/src/composition/plugin-contribution-controller.ts",
  "packages/server-runtime/src/composition/plugin-contribution-registry.ts",
  "packages/server-runtime/src/composition/external-gateway-management-provider.ts",
  "packages/server-runtime/src/composition/external-gateway-endpoint-probe.ts",
  "packages/server-runtime/src/composition/plugin-agent-self-maintenance-port.ts",
  "packages/server-runtime/src/composition/plugin-artifact-core-contract.ts",
  "packages/server-runtime/src/composition/plugin-call-context.ts",
  "packages/server-runtime/package.json",
  "packages/contracts/src/operations",
  "packages/contracts/src/generated",
  "packages/protocols/package.json",
  "packages/protocols/http",
  "packages/protocols/mcp/adapter/http-mcp-adapter-transport.ts",
  "packages/agents/src/upstream-gateway",
  "packages/foundation/src/module-system/plugin-registry.ts",
  "packages/foundation/src/module-system/plugin-runtime.ts",
  "packages/foundation/src/module-system/internal-agent-maintenance-channel.ts",
  "packages/foundation/src/module-system/isolated-plugin-process-host.ts",
  "packages/foundation/src/module-system/plugin-console-isolation.ts",
  "packages/foundation/src/observability",
  "packages/foundation/config/frontend-feature-registry.yaml",
  "packages/foundation/src/security/authorization/generated-capabilities.ts",
  "packages/foundation/src/workflow/state-machine/definitions/acceptance",
  "apps/console",
  "plugins/model-gateway",
  "plugins/registry/plugins.json",
  "plugins/schemas/plugin.schema.json",
  "docs/examples/model-gateway.upstream.json",
  "tools/registry/architecture-layout-facade.ts",
  "tools/registry/architecture-layout-manifest.ts",
  "tools/registry/capabilities",
  "tools/registry/capability-acceptance-checkpoints",
  "tools/registry/capability-acceptance.registry.json",
  "tools/registry/dependency-rules.registry.json",
  "tools/registry/docs.registry.json",
  "tools/registry/fact-source-authority.registry.json",
  "tools/registry/internal-platform-capability-matrix.json",
  "tools/registry/mcp-connector.registry.json",
  "tools/registry/modules.registry.json",
  "tools/registry/operations",
  "tools/registry/public-api.registry.json",
  "tools/registry/release-acceptance-standards.registry.json",
  "tools/registry/release-authority-baseline.registry.json",
  "tools/registry/release-definition.registry.json",
  "tools/registry/repo-layout.registry.json",
  "tools/registry/runtime-capacity-profile.registry.json",
  "tools/registry/runtime-payloads.registry.json",
  "tools/registry/schema/capability-acceptance.schema.json",
  "tools/registry/schema/capability.schema.json",
  "tools/registry/schema/dependency-rule.schema.json",
  "tools/registry/schema/docs.schema.json",
  "tools/registry/schema/domain-module.schema.json",
  "tools/registry/schema/fact-source-authority.schema.json",
  "tools/registry/schema/internal-platform-capability-matrix.schema.json",
  "tools/registry/schema/mcp-connector.schema.json",
  "tools/registry/schema/module.schema.json",
  "tools/registry/schema/operation.schema.json",
  "tools/registry/schema/public-api.schema.json",
  "tools/registry/schema/release-acceptance-standards.schema.json",
  "tools/registry/schema/release-authority-baseline.schema.json",
  "tools/registry/schema/release-definition.schema.json",
  "tools/registry/schema/repo-layout.schema.json",
  "tools/registry/schema/runtime-capacity-profile.schema.json",
  "tools/registry/schema/runtime-payload.schema.json",
  "tools/registry/schema/server-layer.schema.json",
  "tools/registry/schema/sqlite-owner-migration.schema.json",
  "tools/registry/schema/state-machine-integrity.schema.json",
  "tools/registry/server-layers.registry.json",
  "tools/registry/source-layout-manifest.ts",
  "tools/registry/sqlite-owner-migration.registry.json",
  "tools/registry/state-machines",
  "tools/server-scripts/external-gateway.ts",
  "tools/server-scripts/verify-external-gateway.ts",
  "docs/functionality",
  "docs/architecture",
  "docs/protocols/PROTOCOLS.md",
]);

const TYPING_SUBSTRATE_OWNED_PATHS: readonly any[] = Object.freeze([
  ".oxlintrc.json",
  "tools/server-scripts/verify-no-explicit-any.ts",
  "packages/contracts/src/service-collaboration-contract.ts",
  "packages/contracts/src/service-collaboration-contract.d.ts",
  "packages/contracts/src/mcp-catalog-delivery.ts",
  "packages/contracts/src/mcp-catalog-delivery.d.ts",
  "packages/contracts/src/upstream-service-publishing.ts",
  "packages/contracts/src/upstream-service-publishing.d.ts",
  "packages/contracts/src/serialization",
  "packages/contracts/src/modules",
  "packages/contracts/src/fixtures",
  "packages/contracts/src/plugins/plugin-bundle-manifest.ts",
  "packages/contracts/src/plugins/plugin-package-receipt.ts",
  "packages/contracts/src/plugins/plugin-package-source.ts",
  "packages/contracts/src/plugins/plugin-package-state.ts",
  "packages/contracts/src/plugins/verified-plugin-package.ts",
  "packages/foundation/src/security/auth",
  "packages/foundation/src/security/secrets",
  "packages/foundation/src/security/risk-control",
  "packages/foundation/src/security/redaction",
  "packages/foundation/src/security/process-identity",
  "packages/foundation/src/security/artifact-signer-port.ts",
  "packages/foundation/src/security/client-strings.ts",
  "packages/foundation/src/security/closed-json-schema.ts",
  "packages/foundation/src/security/final-protected-sink-permit.ts",
  "packages/foundation/src/security/gateway-valkey-discipline.ts",
  "packages/foundation/src/security/gateway-valkey-provider.ts",
  "packages/foundation/src/security/governed-execution-permit-authority.ts",
  "packages/foundation/src/security/local-path-boundary.ts",
  "packages/foundation/src/security/operation-audit-common.ts",
  "packages/foundation/src/security/operation-audit-worker-store.ts",
  "packages/foundation/src/security/operation-audit-worker.ts",
  "packages/foundation/src/security/operation-audit.ts",
  "packages/foundation/src/security/outbound-egress-policy.ts",
  "packages/foundation/src/security/production-ingress-contract.ts",
  "packages/foundation/src/security/register.ts",
  "packages/foundation/src/security/security-alerts.ts",
  "packages/foundation/src/security/security-permissions-provider.ts",
  "packages/foundation/src/security/trusted-client-ip.ts",
  "packages/foundation/src/security/authorization/api-key-issuer-authority.ts",
  "packages/foundation/src/security/authorization/api-key-verifier-key-provider.ts",
  "packages/foundation/src/security/authorization/authorization-capabilities.ts",
  "packages/foundation/src/security/authorization/authorization-engine-common.ts",
  "packages/foundation/src/security/authorization/authorization-engine-support.ts",
  "packages/foundation/src/security/authorization/authorization-engine.ts",
  "packages/foundation/src/security/authorization/authorization-governance-store-support.ts",
  "packages/foundation/src/security/authorization/authorization-governance-store.ts",
  "packages/foundation/src/security/authorization/authorization-resource-context.ts",
  "packages/foundation/src/security/authorization/authorization-store-worker-owner.ts",
  "packages/foundation/src/security/authorization/authorization-store-worker.ts",
  "packages/foundation/src/security/authorization/authorization-store.ts",
  "packages/foundation/src/security/authorization/capability-binding-guard-backends.ts",
  "packages/foundation/src/security/authorization/capability-binding-guard-core.ts",
  "packages/foundation/src/security/authorization/capability-binding-guard.ts",
  "packages/foundation/src/security/authorization/capability-kernel-status.ts",
  "packages/foundation/src/security/authorization/capability-security-helper-client.ts",
  "packages/foundation/src/security/authorization/opaque-capability-key-backends.ts",
  "packages/foundation/src/security/authorization/opaque-capability-key-core.ts",
  "packages/foundation/src/security/authorization/opaque-capability-key-provider.ts",
  "packages/foundation/src/security/authorization/opaque-capability-key-store.ts",
  "packages/foundation/src/security/authorization/opaque-capability-key.ts",
  "packages/foundation/src/security/authorization/organization-model.ts",
  "packages/foundation/src/security/authorization/pdp",
  "packages/foundation/src/security/authorization/tag-store-provider-registry.ts",
  "packages/foundation/src/security/authorization/tag-store.port.ts",
  "packages/foundation/src/security/authorization/tag-tree.ts",
  "packages/foundation/src/security/authorization/universal-tag-policy.ts",
]);

const TYPING_REMAINDER_OWNED_PATHS: readonly any[] = Object.freeze([
  "packages/foundation/src/checkpoint",
  "packages/foundation/src/composition-management",
  "packages/foundation/src/concurrency",
  "packages/foundation/src/config",
  "packages/foundation/src/environment-compatibility",
  "packages/foundation/src/execution-sandbox",
  "packages/foundation/src/http",
  "packages/foundation/src/proof",
  "packages/foundation/src/runtime",
  "packages/foundation/src/scale",
  "packages/foundation/src/serialization",
  "packages/foundation/src/storage",
  "packages/foundation/src/unified-registration-core",
  "packages/foundation/src/version-control",
  "packages/foundation/src/work-queue",
  "packages/foundation/src/workflow/durable-workflow-substrate.ts",
  "packages/foundation/src/workflow/durable-event-delivery.ts",
  "packages/foundation/src/workflow/state-machine/README.md",
  "packages/foundation/src/workflow/state-machine/definition.ts",
  "packages/foundation/src/workflow/state-machine/export-docs.ts",
  "packages/foundation/src/workflow/state-machine/index.ts",
  "packages/foundation/src/workflow/state-machine/invariants.ts",
  "packages/foundation/src/workflow/state-machine/replay.ts",
  "packages/foundation/src/workflow/state-machine/transition.ts",
  "packages/foundation/src/workflow/state-machine/definitions/README.md",
  "packages/foundation/src/workflow/state-machine/definitions/alert.lifecycle.json",
  "packages/foundation/src/workflow/state-machine/definitions/deployment.lifecycle.json",
  "packages/foundation/src/workflow/state-machine/definitions/operation.narrow.json",
  "packages/foundation/src/workflow/state-machine/definitions/production.readiness.lifecycle.json",
  "packages/foundation/src/workflow/state-machine/definitions/storage.backup.lifecycle.json",
  "packages/foundation/src/workflow/state-machine/definitions/version.artifact.lifecycle.json",
  "packages/foundation/src/workflow/state-machine/definitions/version.transition.lifecycle.json",
  "packages/foundation/src/workflow/state-machine/engine",
  "packages/foundation/src/workflow/state-machine/guards",
  "packages/foundation/src/workflow/state-machine/verification",
  "packages/foundation/src/workflow/state-machine/work-queue",
  "packages/agents/src/agent-memory",
  "packages/agents/src/agent-runtime-provider.ts",
  "packages/agents/src/agent-workspace",
  "packages/agents/src/core-change-set-authority.ts",
  "packages/agents/src/workspace-asset-registry",
  "packages/agents/src/workspace-contribution",
  "packages/agents/src/workspace-governance",
  "packages/server-runtime/src/events",
  "packages/server-runtime/src/execution-sandbox",
  "packages/server-runtime/src/explicit-effect-commands.ts",
  "packages/server-runtime/src/jobs",
  "packages/server-runtime/src/module-runtime",
  "packages/server-runtime/src/routing",
  "packages/server-runtime/src/state",
  "packages/protocols/agent-sync",
  "packages/protocols/pubsub",
  "packages/protocols/downstream-client-aspect",
  "tools/plan",
]);

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

function oxlintOwnedBatch(ownedPaths?: any) : any {
  const lintPaths: any[] = ownedPaths.filter((entry?: any) : any =>
    entry !== ".oxlintrc.json" &&
    !String(entry).endsWith(".json") &&
    !String(entry).endsWith(".md") &&
    !String(entry).endsWith(".d.ts"));
  return `npx --yes oxlint@1.78.0 -c .oxlintrc.json ${lintPaths.join(" ")}`;
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
  ownedPaths = [],
  acceptancePaths = [],
  difficulty = "complex",
  decisions = {},
  verificationProfile = "code",
}: Record<string, any>) : any {
  const ownedPath: any = path.extname(target) ? target : `${target}/${key}.ts`;
  const resolvedOwnedPaths: any[] = ownedPaths.length > 0 ? ownedPaths : [ownedPath];
  const resolvedAcceptancePaths: any[] = acceptancePaths.length > 0
    ? acceptancePaths
    : [`tests/acceptance/${key}.test.ts`];
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
      ownedPaths: resolvedOwnedPaths,
      acceptancePaths: resolvedAcceptancePaths,
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

export function planNodes() : any[] {
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
  const gatewayContract: any = "gateway-split-contract";
  const modelGateway: any = "model-gateway-package";
  const agentMaintenance: any = "agent-self-maintenance-runtime";
  const externalGateway: any = "external-gateway-package";
  const gatewayCanonical: any = "gateway-split-canonical-cutover";
  const gatewayBoundaryFinal: any = "gateway-boundary-final";
  const commonPaths: any[] = ["docs/plans", "tools/plan", "tools/server-scripts", "tests/vitest/server"];

  return [
    node({
      key: design,
      role: "group_design",
      code: "EFF-0",
      title: "Freeze Agent Service efficiency architecture",
      goal: "Freeze one efficiency-led product and receipt authority.",
      description: "Define the shared-document editing analogy, Core and external-effect boundary, cost model, retained release closures, and the smallest safe execution frontier.",
      requirements: ["REQ-REL-BASELINE", "REQ-EFF-MODEL", "REQ-EFF-CLAIMS"],
      acceptance: "Plan.md fixes one current Plan, the interaction model, exact efficiency measurements, and remaining closures.",
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
      title: "Close offline Linux VM dual-architecture delivery",
      goal: "Prove exact offline candidate transfer without rebuilding.",
      description: "Scope: Closure: scenario - offline Linux VM delivery closure; build candidate-bound Linux amd64 and arm64 OCI layouts with inventory, SBOM, provenance, signatures and instructions, then verify the exact bytes on a Linux virtual machine. Ubuntu is preferred; Debian is accepted.",
      requirements: ["REQ-EFF-RELEASE", "REQ-BASELINE-CONTAINER-DEPLOYMENT"],
      acceptance: "The exact dual-architecture bundle imports, starts, executes its first governed call, stops, and cleans up on a Linux virtual machine without network access or rebuilding. Ubuntu is preferred; Debian is accepted.",
      prerequisites: [contract],
      next: [final],
      target: "tools/server-scripts",
      commands: ["node tools/server-scripts/offline-delivery-closure.ts"],
      paths: ["docker", "tools/containers", "tools/server-scripts", "tests", "docs"],
    }),
    node({
      key: final,
      role: "implementation",
      code: "EFF-FINAL",
      title: "Run functional acceptance once",
      goal: "Issue the only current functional candidate decision.",
      description: "Scope: Closure: scenario - final functional acceptance; consume exact current efficiency, Plugin isolation, enterprise operations, and offline Linux VM evidence once from a macOS operator host whose reachable Linux virtual machine already closed offline delivery. Ubuntu is preferred; Debian is accepted. Reject missing, stale, replayed, substituted, rebuilt, or cross-candidate inputs.",
      requirements: ["REQ-EFF-FINAL", "REQ-EFF-CLAIMS", "REQ-REL-BASELINE"],
      acceptance: "One privacy-safe plan receipt covers the exact current evidence set on a reachable Linux VM, preferring Ubuntu and accepting Debian.",
      prerequisites: [efficiency, plugin, operations, offline],
      next: [DELIVERY_PROVENANCE_KEY, DELIVERY_TYPING_KEY, DELIVERY_FEEDBACK_KEY],
      target: "tools/server-scripts",
      commands: ["node tools/server-scripts/functional-final.ts"],
      paths: ["tools/server-scripts", "tests", "docs"],
    }),
    node({
      key: DELIVERY_PROVENANCE_KEY,
      role: "implementation",
      code: "DQ-PROVENANCE",
      title: "Publish acceptance-gate provenance substrate",
      goal: "Make acceptance and public-gate reports reproducible before GATE-CONTRACT.",
      description: "Scope: Closure: capability - reproducible acceptance-gate provenance; publish one command and report registry, require schemaVersion, producer, commandId, timestamp, and payloadDigest on producers, fail closed on stale reports, and simulate a clean-checkout PR against an isolated output root without replacing an existing docs/plans workspace.",
      requirements: ["REQ-REL-BASELINE", "REQ-DELIVERY-PROVENANCE"],
      acceptance: "One registry names acceptance and public-gate commands and reports; producers emit schemaVersion, producer, commandId, timestamp, and payloadDigest; stale reports fail closed; the simulator writes a fresh plan to an isolated output root and leaves any existing docs/plans workspace unreplaced.",
      prerequisites: [final],
      next: [gatewayContract],
      target: "tools/server-scripts",
      commands: [
        "node tools/server-scripts/simulate-clean-checkout-pr.ts",
        "npx vitest run tests/vitest/server/acceptance-gate-provenance.test.ts",
      ],
      paths: [
        "tools/registry/index.ts",
        "tools/registry/scripts.registry.json",
        "tools/registry/schema/script.schema.json",
        "tools/server-scripts/verify-platform-acceptance.ts",
        "tools/server-scripts/lib/platform-acceptance-contract.ts",
        "tools/server-scripts/lib/platform-acceptance-reducer.ts",
        "tools/server-scripts/lib/platform-acceptance-command-catalog.ts",
        "tools/server-scripts/lib/platform-acceptance-report-catalog.ts",
        "tools/server-scripts/lib/platform-acceptance-generation-store.ts",
        "tools/server-scripts/lib/platform-acceptance-ledger-anchor.ts",
        "tools/server-scripts/lib/release-report-provenance.ts",
        "tools/server-scripts/simulate-clean-checkout-pr.ts",
        "tests/vitest/server/acceptance-gate-provenance.test.ts",
      ],
      ownedPaths: [
        "tools/registry/index.ts",
        "tools/registry/scripts.registry.json",
        "tools/registry/schema/script.schema.json",
        "tools/server-scripts/verify-platform-acceptance.ts",
        "tools/server-scripts/lib/platform-acceptance-contract.ts",
        "tools/server-scripts/lib/platform-acceptance-reducer.ts",
        "tools/server-scripts/lib/platform-acceptance-command-catalog.ts",
        "tools/server-scripts/lib/platform-acceptance-report-catalog.ts",
        "tools/server-scripts/lib/platform-acceptance-generation-store.ts",
        "tools/server-scripts/lib/platform-acceptance-ledger-anchor.ts",
        "tools/server-scripts/lib/release-report-provenance.ts",
        "tools/server-scripts/simulate-clean-checkout-pr.ts",
      ],
      acceptancePaths: ["tests/vitest/server/acceptance-gate-provenance.test.ts"],
    }),
    node({
      key: DELIVERY_TYPING_KEY,
      role: "implementation",
      code: "DQ-TYPING",
      title: "Close security-critical typing substrate",
      goal: "Deny explicit any on new TypeScript and the contracts plus security batch before GATE-CONTRACT.",
      description: "Scope: Closure: capability - security-critical typing; deny typescript/no-explicit-any with oxlint on new TypeScript and on the contracts plus foundation security batch, leaving GATE-CONTRACT and generated operations outside this write set.",
      requirements: ["REQ-REL-BASELINE", "REQ-DELIVERY-TYPING"],
      acceptance: "oxlint denies typescript/no-explicit-any on new TypeScript and on that batch; GATE-CONTRACT and generated operations stay outside this write set.",
      prerequisites: [final],
      next: [gatewayContract],
      target: ".oxlintrc.json",
      commands: [
        oxlintOwnedBatch(TYPING_SUBSTRATE_OWNED_PATHS),
        "npx vitest run tests/vitest/server/delivery-typing-substrate.test.ts",
      ],
      paths: [...TYPING_SUBSTRATE_OWNED_PATHS, "tests/vitest/server/delivery-typing-substrate.test.ts"],
      ownedPaths: [...TYPING_SUBSTRATE_OWNED_PATHS],
      acceptancePaths: ["tests/vitest/server/delivery-typing-substrate.test.ts"],
    }),
    node({
      key: DELIVERY_FEEDBACK_KEY,
      role: "implementation",
      code: "DQ-FEEDBACK",
      title: "Split PR verification from public-gate",
      goal: "Give pull requests a faster distinct path with localized failures before GATE-CONTRACT.",
      description: "Scope: Closure: capability - faster verification; run pull requests on a distinct path from public-gate, name assertion, file, and command on failures, keep public-gate on npm run verify, and leave suite merging, cache, sharding, and verify:acceptance out of this node.",
      requirements: ["REQ-REL-BASELINE", "REQ-DELIVERY-FEEDBACK"],
      acceptance: "Pull requests run a distinct path from public-gate; failures name assertion, file, and command; public-gate still runs npm run verify; suite merging, cache, sharding, and verify:acceptance stay out of this node.",
      prerequisites: [final],
      next: [gatewayContract],
      target: ".github/workflows/ci.yml",
      commands: [
        "node tools/server-scripts/localize-verify-failure.ts",
        "npx vitest run tests/vitest/server/verify-failure-localization.test.ts",
      ],
      paths: [
        ".github/workflows/ci.yml",
        "tools/server-scripts/localize-verify-failure.ts",
        "tests/vitest/server/verify-failure-localization.test.ts",
      ],
      ownedPaths: [
        ".github/workflows/ci.yml",
        "tools/server-scripts/localize-verify-failure.ts",
      ],
      acceptancePaths: ["tests/vitest/server/verify-failure-localization.test.ts"],
    }),
    node({
      key: gatewayContract,
      role: "implementation",
      code: "GATE-CONTRACT",
      title: "Freeze standalone Model Gateway, the mandatory dual-Gateway pipeline, the optional application stage, and local maintenance contracts",
      goal: "Freeze one Agent MCP pipeline with mandatory downstream and upstream Gateway stages, an optional Workspace application stage between them, Console-controlled per-direction channel selection, the standalone Model Gateway contract, and the configuration-only one-way local maintenance boundary.",
      description: "Scope: Closure: module - standalone Model Gateway, mandatory downstream and upstream Gateway stages, optional Workspace application processing, and one-way local maintenance-plugin contracts; publish one versioned language-neutral Model Gateway HTTP and JSON contract for health, readiness, native OpenAI and Anthropic standard API compatibility, direct authenticated model calls, model and provider management, routing, pricing revisions, idempotency, cancellation, stable errors, and call-ledger states released, settled, and in_doubt with fixed-point amounts. Publish the Meshrix-side ModelGatewayClientPort, operation identities for model_gateway.call and models.*, default-disabled adapter configuration, and general plugin-confinement ports in packages/contracts. Freeze one required immutable operation-descriptor field named trafficModel with exactly workspace_application or gateway_transit. The field selects only the optional middle application stage; it never selects whether either Gateway stage runs. The caller cannot supply or override it, and Meshrix never infers it from URL, tool name, payload shape, workspaceId presence, or runtime health. Missing, unknown, or conflicting classification fails before channel admission, Workspace resolution, credential access, or network egress. Every admitted downstream MCP request first becomes one immutable DownstreamGatewayEnvelope and traverses exactly one selected downstream built-in or plugin channel. After that stage succeeds, workspace_application produces a WorkspaceApplicationEnvelope, requires authorized Workspace context, and alone may use Working Set, Working View, Change Set, Resource delta, checkpoint, collaboration cache, and Workspace materialization. gateway_transit bypasses the application stage with zero Workspace resolution or state effect. Both modes then produce one immutable UpstreamGatewayEnvelope and traverse exactly one selected upstream built-in or plugin channel before the upstream Service. The return path mirrors the same pinned upstream Gateway, optional application-response stage, and downstream Gateway generations. DownstreamGatewayEnvelope and UpstreamGatewayEnvelope carry the common operation identity, authenticated subject reference, target and resource references, bounded input references, policy and approval binding, idempotency identity, deadline and cancellation, streaming mode, and bounded trace and evidence references that every built-in and plugin channel must preserve. Each Gateway stage may provide connection management, bounded load distribution, rate and concurrency admission, health and circuit handling, overload shedding, timeout, cancellation, streaming, and stable transport degradation without changing Meshrix operation meaning or silently bypassing the application stage. Freeze one built-in channel for each stage plus a gatewayChannels Runtime Plugin contribution that may register corresponding External Gateway choices for both traffic models. Caddy and Nginx choices attach only to existing operator-provided independent instances; neither Meshrix nor the plugin owns their install, configuration, process, upgrade, or lifecycle. A direct choice is explicit and never a bypass or fallback. Plugin loading or activation only changes availability and never changes traffic. An administrator switches one selected direction and gateway only through the Meshrix Console; Core validates the choice, commits that direction's selection generation, and pins admitted calls until completion. External Gateway receives neither a Workspace port nor WorkspaceApplicationEnvelope and cannot select a channel, mutate either Gateway envelope, reinterpret results, skip or insert the application stage, or change Meshrix semantics. Freeze plugins/agents/meshrix-self-maintenance/contracts over one closed, atomically replaced local configuration file; explicit enabled revision, targets, strategies, schedules, runbooks, budgets, operation and resource allowlists, workspace selectors, and credential references; independent non-privileged OS identity, storage, credentials, process and lifecycle; direct outbound Model Gateway HTTP and ordinary governed Meshrix operation clients; and no inbound control surface. The configuration file is the only control input. Meshrix cannot call, schedule, cancel, observe, configure, start, stop, or restart Agent self-maintenance.",
      requirements: ["REQ-MODEL-GATEWAY-BOUNDARY", "REQ-MODEL-GATEWAY-ADMISSION", "REQ-MODEL-GATEWAY-BILLING", "REQ-AGENT-MCP-FIXED-GATEWAY-PIPELINE", "REQ-OPTIONAL-WORKSPACE-APPLICATION-STAGE", "REQ-DIRECT-TRANSIT-WORKSPACE-BYPASS", "REQ-GATEWAY-STAGE-PRODUCTION-CONTROLS", "REQ-GATEWAY-SEMANTIC-PRESERVATION", "REQ-EXTERNAL-GATEWAY-BIDIRECTIONAL", "REQ-CONSOLE-GATEWAY-CHANNEL-SELECTION", "REQ-LOCAL-AGENT-MAINTENANCE-PLUGIN", "REQ-MAINTENANCE-NO-INBOUND-CONTROL", "REQ-ONE-WAY-MAINTENANCE-AUTHORITY", "REQ-BASELINE-EXTERNAL-PLUGIN-PACKAGING-LOADING", "REQ-EXTERNAL-GATEWAY-BOUNDARY", "REQ-GATEWAY-SPLIT-DECOUPLING"],
      acceptance: "Wire-schema and contract tests prove that the Model Gateway Service API is language-neutral, versioned, natively compatible with the standard OpenAI and Anthropic APIs, directly usable without Meshrix, and closed over authentication, admission, ledger, pricing, cancellation, idempotency, and stable error semantics. Agent MCP pipeline contract tests prove every published downstream operation has exactly one immutable trafficModel, callers cannot override it, unknown classification fails before either Gateway stage, both workspace_application and gateway_transit traverse downstream Gateway then upstream Gateway in that order, workspace_application alone admits Workspace collaboration state between the stages, and gateway_transit has zero Workspace dependency or side effect. Gateway-channel contract tests prove built-in and plugin channels accept the same immutable DownstreamGatewayEnvelope or UpstreamGatewayEnvelope for both traffic models, preserve normalized semantic outcomes, and expose bounded load distribution, rate and concurrency limits, health and circuit handling, overload degradation, cancellation, timeout, backpressure, and streaming behavior. Plugin activation changes only available choices, only a Console-originated governed administrator selection can change one direction's active channel, External Caddy and Nginx channels attach only to existing independently operated instances with zero proxy lifecycle ownership, and External Gateway code has no selection, Workspace, application-stage, or semantic authority. Maintenance-plugin contract tests prove the configuration file is the only non-credential behavior-control input and there is no inbound interface. The dependency graph permits the standalone Model Gateway Service, Meshrix adapter, local maintenance plugin, and External Gateway plugin to compile independently and contains no Meshrix-to-maintenance-plugin edge; final acceptance remains bounded to the retained Linux VM closure.",
      prerequisites: [DELIVERY_PROVENANCE_KEY, DELIVERY_TYPING_KEY, DELIVERY_FEEDBACK_KEY],
      next: [modelGateway, agentMaintenance, externalGateway],
      target: "packages/contracts/src/agent-mcp-traffic",
      commands: ["npm run typecheck --workspace @meshrix/contracts", "npx vitest run tests/vitest/contracts/model-gateway-port.test.ts tests/vitest/contracts/agent-mcp-gateway-pipeline-contract.test.ts tests/vitest/contracts/gateway-stage-contract.test.ts tests/vitest/contracts/gateway-channel-contract.test.ts tests/vitest/contracts/agent-self-maintenance-local-config.test.ts tests/vitest/contracts/plugin-confinement-port.test.ts"],
      paths: ["services/model-gateway/contracts", "packages/contracts", "tests/vitest/contracts"],
      ownedPaths: [
        "services/model-gateway/contracts",
        "packages/contracts/src/model-gateway",
        "packages/contracts/src/agent-mcp-traffic",
        "packages/contracts/src/gateway-transit",
        "packages/contracts/src/plugins/gateway-channel-contract.ts",
        "plugins/agents/meshrix-self-maintenance/contracts",
        "packages/contracts/src/plugins/index.ts",
        "packages/contracts/src/plugins/plugin-confinement-contract.ts",
        "packages/contracts/package.json",
      ],
      acceptancePaths: [
        "tests/vitest/contracts/model-gateway-port.test.ts",
        "tests/vitest/contracts/agent-mcp-gateway-pipeline-contract.test.ts",
        "tests/vitest/contracts/gateway-stage-contract.test.ts",
        "tests/vitest/contracts/gateway-channel-contract.test.ts",
        "tests/vitest/contracts/agent-self-maintenance-local-config.test.ts",
        "tests/vitest/contracts/plugin-confinement-port.test.ts",
      ],
      decisions: {
        composition: "the Service exposes one language-neutral HTTP and JSON contract with native OpenAI and Anthropic standard API compatibility; Meshrix consumes it through one default-disabled stateless adapter; every Agent MCP call traverses the selected downstream Gateway channel, an optional descriptor-selected Workspace application stage, and the selected upstream Gateway channel in that order; External Caddy and Nginx channels attach only to existing independently operated instances whose configuration and lifecycle remain outside Meshrix and the plugin; the local maintenance plugin calls the Service directly and Meshrix only as an ordinary external governed client",
        dataStructures: "one closed trafficModel enum that selects only the middle stage, one immutable DownstreamGatewayEnvelope, one WorkspaceApplicationEnvelope, one immutable UpstreamGatewayEnvelope, and normalized stage results; neither Gateway envelope contains a Workspace handle or mutable Workspace state",
        state: "contracts own no mutable runtime state; Workspace application state remains in Workspace authorities, Meshrix Core owns independent downstream and upstream channel generations, Runtime Plugin activation owns only channel availability, the Service owns model facts, and the maintenance plugin owns its local configuration-selected run lifecycle and private recovery state",
        isolation: "the maintenance plugin runs under a separate non-privileged OS identity and shares no configuration, state, credential store, PID, socket, listener, lifecycle handle, or control channel with Meshrix",
        concurrency: "one contract freeze is the only prerequisite before three disjoint package branches become eligible together: Model Gateway Service, local Agent self-maintenance, and the bidirectional External Gateway plugin",
      },
    }),
    node({
      key: modelGateway,
      role: "implementation",
      code: "GATE-MODEL",
      title: "Build the independently deployable Model Gateway HTTP Service",
      goal: "Implement a model-only Service that builds, starts, persists, and serves direct clients without Meshrix.js.",
      description: "Scope: Closure: module - services/model-gateway; implement a standalone process with its own package entrypoint, versioned HTTP and JSON API, health and readiness, graceful shutdown, client authentication and scopes, empty initial configuration, model and provider management, provider credential custody, allowlisted egress, bounded routing and retry, request and token buckets, concurrency and cost admission, immutable pricing revisions, per-attempt usage, idempotent settlement, independent persistence, crash recovery, minimum privacy-safe logs, and a separately built OCI artifact. Provider adapters remain internal Service transports. The Service can be configured and called by a direct non-Meshrix client, imports no Meshrix runtime or old Agent Gateway, accesses no Meshrix path or secret, performs no callback or discovery, and is not included in the Meshrix runtime-ui image or offline bundle. It has no dependency on the External Gateway Runtime Plugin.",
      requirements: ["REQ-MODEL-GATEWAY-BOUNDARY", "REQ-MODEL-GATEWAY-ADMISSION", "REQ-MODEL-GATEWAY-BILLING", "REQ-GATEWAY-SPLIT-DECOUPLING"],
      acceptance: "The Service directory installs, tests, builds, starts with an independent data root, reports health and readiness, accepts an authenticated direct non-Meshrix client, enforces request, token, concurrency and cost limits, resolves no provider credential and performs no egress on denial, settles bounded per-attempt usage exactly once against an immutable price revision, restarts with preserved configuration and ledger state, and shuts down cleanly while no Meshrix process is present. Its package graph, image, runtime paths and verifier contain no Meshrix Server, Agents, old Agent Gateway, External Gateway Runtime Plugin, Operation Permission, Console, Plugin Runtime or Meshrix data path.",
      prerequisites: [gatewayContract],
      next: [gatewayCanonical],
      target: "services/model-gateway",
      commands: ["npm --prefix services/model-gateway test", "npm --prefix services/model-gateway run build", "node tools/server-scripts/verify-model-gateway-service.ts"],
      paths: ["services/model-gateway", "tools/server-scripts/verify-model-gateway-service.ts"],
      ownedPaths: ["services/model-gateway/package.json", "services/model-gateway/Dockerfile", "services/model-gateway/README.md", "services/model-gateway/src", "services/model-gateway/internal", "tools/server-scripts/verify-model-gateway-service.ts"],
      acceptancePaths: ["services/model-gateway/test"],
      decisions: {
        composition: "one independently startable HTTP Service and one separately built OCI artifact serve direct clients without any Meshrix process, package, data path, address, lifecycle dependency, or External Gateway Runtime Plugin dependency",
        algorithms: "constant-time descriptor-keyed transactional admission by authenticated Service tenant, subject, workload, model, provider, and policy revision with bounded token buckets, concurrency counters, and cost reservations",
        dataStructures: "bounded keyed admission records plus one idempotent call ledger containing fixed-point integer reservations and bounded per-attempt provider usage keyed by call identity and immutable pricing revision",
        state: "the standalone Service solely owns client identities, model configuration, provider routing, price revisions, usage settlement, credential custody, provider egress, persistence, and lifecycle; Meshrix owns or mirrors none of that state",
        isolation: "the Service performs no Meshrix discovery, callback, process control, shared-volume access, shared-secret access, lifecycle action, or External Gateway Runtime Plugin discovery",
      },
    }),
    node({
      key: agentMaintenance,
      role: "implementation",
      code: "GATE-MAINTENANCE",
      title: "Build the one-way local Agent self-maintenance plugin",
      goal: "Deliver an independently started local plugin controlled only by its local configuration and able to control Meshrix only through ordinary governed operations.",
      description: "Scope: Closure: module - plugins/agents/meshrix-self-maintenance; implement a separately startable local artifact with one fixed configuration path and closed full-snapshot schema, atomic revision reload, explicit targets, plans, strategies, schedules, runbooks, budgets, operation and resource allowlists, single-concurrency bounded execution, local queue, cancellation, recovery journal and minimum private evidence. The plugin directly calls the standalone Model Gateway Service with its own authenticated client and treats model output as an untrusted proposal. It calls Meshrix only as an independent external service principal through existing ordinary governed operations; every protected effect remains subject to current Operation Permission and final-sink reauthorization. Missing configuration is inert, invalid or unreadable configuration stops new admission, and only an atomic configuration replacement can enable, disable, schedule, request, cancel, retarget, or change a run. The process listens on no port and reads no behavior-control CLI argument, environment override or stdin. It registers no operation, route, RPC, MCP, CLI command, Console entry, Host capability, state machine, runtime contribution, or backend handle, and imports no Meshrix Server Runtime, Operation Permission implementation, Meshrix Model Gateway adapter, Model Gateway Service implementation, old Maintenance Service, or old Agent Gateway.",
      requirements: ["REQ-LOCAL-AGENT-MAINTENANCE-PLUGIN", "REQ-MAINTENANCE-NO-INBOUND-CONTROL", "REQ-ONE-WAY-MAINTENANCE-AUTHORITY", "REQ-MODEL-GATEWAY-BOUNDARY", "REQ-GATEWAY-SPLIT-DECOUPLING"],
      acceptance: "Focused artifact tests prove that HTTP, RPC, MCP, CLI, argv, environment, stdin, Console, Core backend, Host and runtime-loader attempts cannot create, pause, cancel, observe or configure a run. Only an atomic valid configuration revision changes enabled state, target, plan, strategy, schedule, desired runs, cancellation, allowlist or budget; missing configuration remains inert and invalid configuration fails closed for new admission. With the Meshrix Model Gateway adapter disabled, the plugin still calls the standalone Model Gateway directly. A Gateway failure, forged proposal or out-of-policy proposal causes zero Meshrix effect call. Allowed Meshrix requests enter the ordinary dispatcher as the plugin's independent service principal, and grant refusal, revocation or sink-authority change produces zero protected effect without controlling or stopping the plugin. Under separate non-privileged OS identities, the plugin remains alive after Meshrix stops, Meshrix cannot alter its configuration or cancel its in-flight model call, and stopping the plugin has no Meshrix effect.",
      prerequisites: [gatewayContract],
      next: [gatewayCanonical],
      target: "plugins/agents/meshrix-self-maintenance/src",
      commands: ["npm --prefix plugins/agents/meshrix-self-maintenance test", "node tools/server-scripts/verify-agent-self-maintenance-runtime.ts"],
      paths: ["plugins/agents/meshrix-self-maintenance", "tools/server-scripts/verify-agent-self-maintenance-runtime.ts"],
      ownedPaths: ["plugins/agents/meshrix-self-maintenance/package.json", "plugins/agents/meshrix-self-maintenance/plugin.json", "plugins/agents/meshrix-self-maintenance/README.md", "plugins/agents/meshrix-self-maintenance/src", "plugins/agents/meshrix-self-maintenance/internal", "tools/server-scripts/verify-agent-self-maintenance-runtime.ts"],
      acceptancePaths: ["plugins/agents/meshrix-self-maintenance/test"],
      decisions: {
        composition: "one separately started local client-peer plugin calls Model Gateway directly and Meshrix only through ordinary governed operations; Meshrix has no import, injected port, callback, loader contribution, or lifecycle reference to it",
        algorithms: "single-concurrency bounded admission and scheduling over explicit configuration revisions, target, plan, strategy, operation allowlist and budget indexes",
        dataStructures: "one closed atomic configuration snapshot plus bounded private queue, cancellation, recovery journal and evidence records without prompts, credentials, reusable permits, or hidden control fields",
        state: "the plugin alone owns its scheduler, queue, cancellation, recovery and run journal; Model Gateway owns model routing and accounting; Meshrix owns only authorization and effects within Meshrix",
      },
    }),
    node({
      key: externalGateway,
      role: "implementation",
      code: "GATE-EDGE",
      title: "Build the bidirectional External Gateway Runtime Plugin",
      goal: "Provide optional downstream and upstream Gateway channels for both application and direct-transit traffic without changing Meshrix semantics, selecting the active path, or owning the optional application stage.",
      description: "Scope: Closure: module - plugins/external-gateway; implement a default-disabled native Meshrix Runtime Plugin whose gatewayChannels contribution registers one downstream and one upstream External Gateway choice usable by both workspace_application and gateway_transit. The downstream choice consumes the frozen immutable DownstreamGatewayEnvelope; the upstream choice consumes the frozen immutable UpstreamGatewayEnvelope. Each returns the same normalized result, stable error, cancellation, backpressure, timeout, and streaming contract as its built-in counterpart. Caddy, Nginx, and direct adapters may perform transport connection management, backend selection, bounded load balancing, traffic distribution, rate and concurrency admission, health and circuit handling, overload shedding, stable degradation, timeout, streaming, and bounded backpressure after Meshrix has resolved the operation meaning and governance. The plugin owns adapter configuration and channel-local health only. It receives no Workspace reference, Workspace port, or WorkspaceApplicationEnvelope and cannot resolve, create, read, mutate, materialize, cache, checkpoint, or otherwise touch Workspace state. The Workspace application stage, when selected, runs only in Meshrix Core between the downstream and upstream channels. The plugin cannot activate its own route, change either selected channel, call the Meshrix selection operation, mutate operation identity, authenticated subject, target, resource, input meaning, policy or approval binding, output meaning, audit evidence, insert or skip the application stage, or silently reroute a failed request. Loading, activating, disabling, or updating the plugin changes only the set of available Console Gateway choices and never redirects traffic.",
      requirements: ["REQ-AGENT-MCP-FIXED-GATEWAY-PIPELINE", "REQ-OPTIONAL-WORKSPACE-APPLICATION-STAGE", "REQ-DIRECT-TRANSIT-WORKSPACE-BYPASS", "REQ-GATEWAY-STAGE-PRODUCTION-CONTROLS", "REQ-GATEWAY-SEMANTIC-PRESERVATION", "REQ-EXTERNAL-GATEWAY-BIDIRECTIONAL", "REQ-CONSOLE-GATEWAY-CHANNEL-SELECTION", "REQ-EXTERNAL-GATEWAY-BOUNDARY", "REQ-MODEL-GATEWAY-BOUNDARY", "REQ-GATEWAY-SPLIT-DECOUPLING"],
      acceptance: "The plugin installs, verifies, loads in isolation, and contributes both named Gateway directions without Agents, Workspace, Model Gateway Service, or adapter imports. Focused conformance tests replay equivalent workspace_application and gateway_transit workloads through built-in and plugin downstream and upstream channels and prove identical normalized semantic outcomes and the same mandatory stage order. Test doubles fail if any plugin path calls a Workspace port, receives a WorkspaceApplicationEnvelope, or causes either traffic model to skip a Gateway stage. Adapter tests prove bounded Caddy, Nginx, and direct load distribution, rate and concurrency limits, health and circuit handling, overload degradation, cancellation, streaming, timeout, and backpressure behavior. Loading or activating the plugin leaves both selected Meshrix Gateway channels and all admitted traffic unchanged; plugin code has no route-selection or application-stage port and cannot mutate either semantic envelope. The plugin does not re-export the old nested External Gateway implementation.",
      prerequisites: [gatewayContract],
      next: [gatewayCanonical],
      target: "plugins/external-gateway",
      commands: ["npm --prefix plugins/external-gateway test", "node tools/server-scripts/verify-external-gateway-plugin.ts"],
      paths: ["plugins/external-gateway", "tools/server-scripts/verify-external-gateway-plugin.ts", "tests/vitest/server/external-gateway-plugin.test.ts"],
      ownedPaths: ["plugins/external-gateway", "tools/server-scripts/verify-external-gateway-plugin.ts"],
      acceptancePaths: ["tests/vitest/server/external-gateway-plugin.test.ts"],
      decisions: {
        composition: "the native Runtime Plugin contributes optional downstream and upstream Gateway channels for both traffic models; every application and direct-transit call enters both Gateway stages, while the optional Workspace application stage remains Core-owned between them and Console-controlled Core selection remains outside the plugin",
        dataStructures: "immutable DownstreamGatewayEnvelope and UpstreamGatewayEnvelope contracts plus bounded per-adapter admission, backend, circuit, and health indexes that contain no Workspace, application, Meshrix semantic, or authorization state",
        state: "the plugin owns adapter configuration and channel-local health; Meshrix Core owns available-channel registration and each direction's selected channel generation; plugin lifecycle changes availability only",
        isolation: "the plugin receives no Workspace port or reference, WorkspaceApplicationEnvelope, channel-selection port, Operation Permission implementation, identity authority, credential authority, Model Gateway lifecycle, or mutable Meshrix semantic object",
      },
    }),
    node({
      key: gatewayCanonical,
      role: "implementation",
      code: "GATE-CANONICAL",
      title: "Install the mandatory dual-Gateway pipeline, optional application stage, and canonical authorities",
      goal: "Route every Agent MCP call through downstream Gateway, optional Workspace application processing, and upstream Gateway; expose explicit per-direction Console switching, install the standalone Model Gateway adapter, and delete retired paths.",
      description: "Scope: Closure: scenario - canonical Agent MCP Gateway pipeline and maintenance cutover; add a mandatory immutable trafficModel to every registered downstream operation descriptor and migrate every current descriptor exactly once to workspace_application or gateway_transit. Build one Core AgentMcpGatewayPipeline that reads only the registered descriptor after authentication and operation resolution, pins the classification and both selected Gateway generations for the request lifetime, and rejects missing, unknown, caller-supplied, or conflicting classification before Gateway admission, Workspace resolution, credential access, or network egress. Normalize every admitted call into DownstreamGatewayEnvelope and route it through exactly one selected downstream built-in or plugin channel. A downstream rejection, overload, timeout, cancellation, or unavailable result stops before application or upstream execution. After downstream success, route workspace_application through the existing Workspace application authority: require authorized Workspace context, resolve Workspace input, and retain the completed Working Set, Working View, Change Set, Resource delta, checkpoint, collaboration cache, and materialization efficiency model. Route gateway_transit past that application stage without calling resolveMcpWorkspaceInput, publicMcpToolPayload Workspace projection, Working Set, Working View, Change Set, Workspace storage, cache, materialization, checkpoint, or any other Workspace port. A direct-transit request carrying a workspaceId treats it as non-authoritative input and never uses it to select or create Workspace state. Both modes then normalize to UpstreamGatewayEnvelope and route through exactly one selected upstream built-in or plugin channel before the upstream Service. The response follows the pinned upstream channel, the selected optional application response stage, and the pinned downstream channel back to the Agent. No request may change trafficModel, skip either Gateway stage, or fall back between application modes after admission. Add gatewayChannels to the signed Runtime Plugin manifest, schema, loader, isolated host, and transactional contribution registry. Build one Core GatewayChannelRouter whose built-in downstream and upstream channels are always available and whose per-direction selected-channel generation is changed only by a governed administrator action originating in the Meshrix Console. Both traffic models use the same selected channel for a named direction. Plugin load, activation, reload, disable, uninstall, health change, or recovery only updates channel availability and never selects or redirects traffic. The Console lists compatible choices, requires an explicit direction and target gateway, preflights that choice, and calls one Core selection operation; each call admitted before the commit remains pinned to its prior direction-specific generation until completion, while later calls use the new choice. Selection failure leaves that direction unchanged. An unavailable selected plugin channel returns one stable unavailable result with no hidden fallback; an administrator must explicitly select another gateway in Console. Built-in and plugin channels implement bounded load distribution, rate and concurrency admission, health and circuit handling, overload degradation, cancellation, timeout, streaming, and backpressure without changing the common operation semantics or bypassing the optional application stage. Add the default-disabled plugins/model-gateway adapter with only an explicit serviceRef and bounded timeout, publish its operator-supplied external-Service descriptor as gateway_transit, and route model_gateway.call and models.* through the complete downstream-Gateway, application-bypass, upstream-Gateway pipeline, Operation Permission, and the Core externalService Host. Keep the local maintenance plugin outside Meshrix composition and reject it from runtime.enabledPlugins. Complete Model Gateway adapter confinement, opaque-origin Plugin Console isolation, operation and protocol projections, and ordinary Meshrix effect authorization. Delete the old unconditional Workspace-resolution assumption, the old Agent Gateway, mixed Agent model registry, embedded model transport, packages/agents/src/maintenance, the old nested External Gateway profile manager, renderer ownership, management provider, endpoint probe, runtime.external_gateway.apply and runtime.external_gateway.switch_direct surfaces, Core maintenance scheduler, queue, recovery, worker, feature and provider, every maintenance_agent.* projection, maintenance Console panel, diagnostics, state machine, Host ports, internal channel, backend handle, and every compatibility path without migrating or probing retired data; then run and discard one residue audit. This is the only node allowed to edit shared composition, operation descriptors, registries, projections, old-source deletion, Console, and documentation.",
      requirements: ["REQ-MODEL-GATEWAY-BOUNDARY", "REQ-MODEL-GATEWAY-ADMISSION", "REQ-MODEL-GATEWAY-BILLING", "REQ-AGENT-MCP-FIXED-GATEWAY-PIPELINE", "REQ-OPTIONAL-WORKSPACE-APPLICATION-STAGE", "REQ-DIRECT-TRANSIT-WORKSPACE-BYPASS", "REQ-GATEWAY-STAGE-PRODUCTION-CONTROLS", "REQ-GATEWAY-SEMANTIC-PRESERVATION", "REQ-EXTERNAL-GATEWAY-BIDIRECTIONAL", "REQ-CONSOLE-GATEWAY-CHANNEL-SELECTION", "REQ-LOCAL-AGENT-MAINTENANCE-PLUGIN", "REQ-MAINTENANCE-NO-INBOUND-CONTROL", "REQ-ONE-WAY-MAINTENANCE-AUTHORITY", "REQ-BASELINE-EXTERNAL-PLUGIN-PACKAGING-LOADING", "REQ-EXTERNAL-GATEWAY-BOUNDARY", "REQ-GATEWAY-SPLIT-REMOVAL"],
      acceptance: "The production graph contains one explicit AgentMcpGatewayPipeline, the retained Workspace application authority, one Core-owned GatewayChannelRouter, built-in choices for both directions, an optional bidirectional External Gateway Runtime Plugin, exactly one independently startable Model Gateway Service, at most one default-disabled stateless Meshrix adapter, and one separately started outbound-only local maintenance plugin rejected by the Runtime Plugin loader. Every downstream-visible operation descriptor has exactly one immutable trafficModel and no caller can override it. Focused stage-order spies prove both workspace_application and gateway_transit call downstream Gateway once and upstream Gateway once in that order; workspace_application alone calls Workspace collaboration between them, while gateway_transit records zero Workspace resolution, read, mutation, materialization, cache, checkpoint, or collaboration calls. Missing or conflicting classification reaches no Gateway or application stage. Equivalent built-in and plugin workloads for both traffic models preserve operation identity, subject, target, resource, policy decision, input and output meaning, cancellation, stable errors, audit evidence, and the required stage order while proving bounded load distribution, rate and concurrency limits, circuit and health behavior, and stable overload degradation at both Gateway stages. Loading or activating the plugin changes only available choices and does not change either direction's selected channel or traffic. Only an explicit Console action changes the requested direction; upstream and downstream are not implicitly switched together. In-flight calls drain on both pinned generations, failed selections leave state unchanged, and selected-channel failure has no implicit fallback or application bypass. External Gateway owns no Workspace, application-stage, semantic, or route-selection authority. Meshrix contains no self-maintenance control or observation surface. A temporary residue audit records zero unclassified operations, unconditional MCP Workspace resolution, Gateway-bypassing Agent MCP paths, old Agent Gateway, old nested External Gateway ownership, and Core maintenance paths before being removed.",
      prerequisites: [modelGateway, agentMaintenance, externalGateway],
      next: [DELIVERY_ACCEPTANCE_REMAINDER_KEY, DELIVERY_TYPING_REMAINDER_KEY, DELIVERY_FEEDBACK_REMAINDER_KEY],
      target: "packages/server-runtime/src/composition",
      commands: ["node tools/server-scripts/verify-model-gateway-service.ts", "npm run server:verify:model-gateway", "npm run server:verify:model-gateway-detachment", "npm run server:verify:agent-self-maintenance-boundary", "npm run verify:plugin-runtime", "npm run verify:operation-permission-protocol-consistency", "npm test -- --suite domains.manifest", "npm run server:verify:architecture-graph"],
      paths: ["apps/console", "packages", "plugins/model-gateway", "plugins/registry", "plugins/schemas", "tools/registry", "tools/server-scripts", "tests", "docs"],
      ownedPaths: [...GATEWAY_CANONICAL_OWNED_PATHS],
      acceptancePaths: ["tests/acceptance/agent-mcp-fixed-gateway-pipeline.test.ts", "tests/acceptance/gateway-application-stage-bypass.test.ts", "tests/acceptance/gateway-channel-canonical-cutover.test.ts", "tests/acceptance/gateway-channel-console-selection.test.ts", "tests/acceptance/agent-self-maintenance-directionality.test.ts", "tests/vitest/server/plugin-console-isolation.test.ts", "tests/vitest/console/plugin-console-isolation.test.ts"],
      decisions: {
        composition: "one necessary shared-authority join installs the mandatory downstream-Gateway, optional Workspace-application, upstream-Gateway pipeline, Core channel router, Console-controlled per-direction selection, default-disabled Service adapter, and plugin contribution kind; keeps local maintenance outside Meshrix; deletes retired assumptions and authorities; and discards one residue audit",
        dataStructures: "a descriptor-keyed immutable trafficModel lookup selects only the middle stage in constant time; immutable DownstreamGatewayEnvelope and UpstreamGatewayEnvelope surround the optional WorkspaceApplicationEnvelope, and no Workspace state crosses into either Gateway channel",
        state: "Workspace authorities own optional application state; Meshrix Core owns one immutable selection snapshot per Gateway direction and pins every admitted call to both generations; Runtime Plugin lifecycle owns channel availability only; External Gateway owns adapter configuration and channel-local admission, circuit, backend, and health state; Meshrix owns no Model Gateway ledger or maintenance runtime state",
        isolation: "both traffic models share the mandatory Gateway stages but only workspace_application receives Workspace ports; Model Gateway Service, Meshrix and the maintenance plugin have independent processes and state; External Gateway receives no Workspace, application-stage, semantic, authorization, selection, Model Gateway lifecycle, or maintenance authority",
        concurrency: "Console explicitly switches one direction and target at a time; plugin activation never switches; old in-flight calls drain on their pinned generation, new calls use the committed generation, and failures never trigger implicit fallback",
      },
    }),
    node({
      key: DELIVERY_ACCEPTANCE_REMAINDER_KEY,
      role: "implementation",
      code: "DQ-ACCEPTANCE",
      title: "Close remaining acceptance-gate provenance",
      goal: "Pass project-level verify:acceptance on the cutover candidate.",
      description: "Scope: Closure: scenario - remaining acceptance-gate remainder; pass npm run verify:acceptance with zero provenance mismatch and no skipped required evidence on the cutover candidate. Require fresh maintenance-plugin-config-only, maintenance-plugin-one-way-meshrix-control, maintenance-plugin-direct-model-gateway, and maintenance-plugin-backend-unreachable reports in addition to standalone Service, Meshrix-only, attached, unavailable, detached, zero-shared-state, independent-lifecycle, denial-with-zero-egress, Agent-MCP-fixed-Gateway-stage-order, Workspace-application-collaboration-efficiency, direct-transit-Workspace-zero-touch, missing-classification-denial, application-and-transit-built-in/plugin-semantic-equivalence, downstream-and-upstream-load-admission-and-degradation, external-gateway-activation-no-switch, Console-selected downstream switch, Console-selected upstream switch, dual-generation-drain, and no-implicit-fallback evidence.",
      requirements: ["REQ-REL-BASELINE", "REQ-DELIVERY-PROVENANCE"],
      acceptance: "npm run verify:acceptance passes with zero provenance mismatch and no skipped required evidence. Fresh reports separately prove independent Model Gateway startup and direct-client operation, Meshrix without the Service, attached invocation, Service unavailable, complete detachment, independent reverse shutdown, zero shared state, denial with zero provider credential resolution and egress, maintenance-plugin directionality, complete explicit trafficModel coverage, caller non-override, mandatory downstream-then-upstream Gateway traversal for both traffic models, Workspace collaboration efficiency only between those stages for workspace_application, zero Workspace calls and state effects for gateway_transit, denial before any stage for missing classification, semantic equivalence across built-in and External Gateway channels for both modes and both directions, bounded load distribution, rate and concurrency admission, circuit and health handling, stable overload degradation, plugin activation with zero route change, explicit Console-controlled per-direction switching, pinned dual-generation drain, selected-channel failure without implicit fallback or application bypass, and explicit Console switch-back to built-in. The Service artifact is absent from Meshrix runtime-ui and offline bundles. DQ-ACCEPTANCE only connects evidence sources.",
      prerequisites: [gatewayCanonical],
      next: [gatewayBoundaryFinal],
      target: "tools/server-scripts",
      commands: ["npm run verify:acceptance"],
      paths: [
        "tools/server-scripts/lib/platform-acceptance-requirement-evidence.ts",
        "tools/server-scripts/lib/platform-acceptance-plan-receipts.ts",
        "tools/server-scripts/lib/required-report-validator.ts",
        "tools/server-scripts/lib/release-evidence-readiness.ts",
        "tools/server-scripts/lib/release-evidence-readiness-common.ts",
        "tools/server-scripts/lib/release-evidence-freshness.ts",
        "tests/vitest/server/platform-acceptance-plan-receipts.test.ts",
        "tests/vitest/server/platform-acceptance-requirement-evidence.test.ts",
        "tests/vitest/server/required-report-validator.test.ts",
        "tests/vitest/server/release-evidence-freshness.test.ts",
      ],
      ownedPaths: [
        "tools/server-scripts/lib/platform-acceptance-requirement-evidence.ts",
        "tools/server-scripts/lib/platform-acceptance-plan-receipts.ts",
        "tools/server-scripts/lib/required-report-validator.ts",
        "tools/server-scripts/lib/release-evidence-readiness.ts",
        "tools/server-scripts/lib/release-evidence-readiness-common.ts",
        "tools/server-scripts/lib/release-evidence-freshness.ts",
      ],
      acceptancePaths: [
        "tests/vitest/server/platform-acceptance-plan-receipts.test.ts",
        "tests/vitest/server/platform-acceptance-requirement-evidence.test.ts",
        "tests/vitest/server/required-report-validator.test.ts",
        "tests/vitest/server/release-evidence-freshness.test.ts",
      ],
    }),
    node({
      key: DELIVERY_TYPING_REMAINDER_KEY,
      role: "implementation",
      code: "DQ-TYPING-REST",
      title: "Remove remaining explicit any outside the thin batch",
      goal: "Deny explicit any on remaining package subtrees after canonical cutover.",
      description: "Scope: Closure: capability - remaining typing remainder; deny typescript/no-explicit-any with oxlint on remaining package subtrees that do not overlap GATE or thin-typing writes.",
      requirements: ["REQ-REL-BASELINE", "REQ-DELIVERY-TYPING"],
      acceptance: "oxlint denies typescript/no-explicit-any on remaining explicit-any package subtrees outside GATE and thin-typing writes; module-system, apps/console, and composition stay with GATE-CANONICAL.",
      prerequisites: [gatewayCanonical],
      next: [gatewayBoundaryFinal],
      target: "tools/plan",
      commands: [
        oxlintOwnedBatch(TYPING_REMAINDER_OWNED_PATHS),
        "npx vitest run tests/vitest/server/delivery-typing-remainder.test.ts",
      ],
      paths: [...TYPING_REMAINDER_OWNED_PATHS, "tests/vitest/server/delivery-typing-remainder.test.ts"],
      ownedPaths: [...TYPING_REMAINDER_OWNED_PATHS],
      acceptancePaths: ["tests/vitest/server/delivery-typing-remainder.test.ts"],
    }),
    node({
      key: DELIVERY_FEEDBACK_REMAINDER_KEY,
      role: "implementation",
      code: "DQ-FEEDBACK-SCALE",
      title: "Scale verification with merge, cache, and shard",
      goal: "Merge suites and processes and add cache and sharding without editing ci.yml.",
      description: "Scope: Closure: capability - remaining verification scale; implement suite and process merging plus cache and sharding in the test runner and registry, including vitest --shard args when needed, without editing ci.yml.",
      requirements: ["REQ-REL-BASELINE", "REQ-DELIVERY-FEEDBACK"],
      acceptance: "The test runner and registry merge suites and processes and apply cache and sharding, including vitest --shard args when needed, without editing ci.yml.",
      prerequisites: [gatewayCanonical],
      next: [gatewayBoundaryFinal],
      target: "tests/run.ts",
      commands: ["npx vitest run tests/vitest/server/delivery-feedback-remainder.test.ts"],
      paths: [
        "tools/registry/tests.registry.json",
        "tools/registry/test-suite-reachability.ts",
        "tools/registry/schema/test-suite.schema.json",
        "tests/run.ts",
        "tests/lib/unified-test-runner-execution.ts",
        "tests/vitest/server/delivery-feedback-remainder.test.ts",
      ],
      ownedPaths: [
        "tools/registry/tests.registry.json",
        "tools/registry/test-suite-reachability.ts",
        "tools/registry/schema/test-suite.schema.json",
        "tests/run.ts",
        "tests/lib/unified-test-runner-execution.ts",
      ],
      acceptancePaths: ["tests/vitest/server/delivery-feedback-remainder.test.ts"],
    }),
    node({
      key: gatewayBoundaryFinal,
      role: "final_validation",
      code: "GATE-FINAL",
      title: "Validate the mandatory dual-Gateway pipeline, optional Workspace application stage, standalone Model Gateway, and local self-maintenance",
      goal: "Accept one fixed downstream-Gateway, optional-application, upstream-Gateway architecture for both Agent MCP traffic models, independent Model Gateway and maintenance lifecycles, and explicit Console control over each Gateway direction.",
      description: "Scope: Closure: scenario - mandatory downstream and upstream Gateway stages, optional Workspace application processing, standalone Model Gateway, Console-selected built-in and External Gateway channels, and one-way local self-maintenance final acceptance; first prove the exact Model Gateway artifact starts, serves a direct client, settles usage, restarts, and remains healthy without Meshrix or External Gateway. Prove Meshrix starts with built-in downstream and upstream Gateway channels, remains ready, and executes named non-model operations without the Service, adapter, maintenance plugin, or External Gateway plugin. Publish one workspace_application operation and one gateway_transit operation through the same downstream MCP catalog. Call the application operation and prove the exact order downstream Gateway, authorized Workspace application, upstream Gateway, upstream Service; prove Working View reuse, bounded Change Set commit, Resource delta delivery, and the named collaboration-efficiency counters. Call the direct-transit operation with no Workspace and with a forged workspaceId and prove the exact order downstream Gateway, application bypass, upstream Gateway, upstream Service while every Workspace resolution, read, mutation, materialization, cache, checkpoint, and collaboration counter remains zero. On the mirrored response path, prove upstream Gateway returns through the optional application-response stage and downstream Gateway before the Agent response. Missing, unknown, caller-overridden, or descriptor-conflicting trafficModel fails before either Gateway stage, Workspace, credential access, or egress. Prove neither admitted call can change modes, skip a Gateway stage, or silently bypass the selected application stage. With built-in channels selected, exercise both traffic models against downstream and upstream connection distribution, rate and concurrency limits, health and circuit behavior, overload shedding, timeout, cancellation, streaming, and stable degradation; prove downstream rejection reaches neither application nor upstream, and upstream failure does not cause application-mode or channel fallback. Load and activate the External Gateway plugin and prove availability changes while both selected Gateway directions remain built-in. Through the Meshrix Console, explicitly switch downstream only and prove both traffic models now use the selected External downstream channel, retain their respective application or bypass behavior, and continue through the unchanged upstream channel. Run equivalent semantic workloads and in-flight traffic, then explicitly switch upstream and prove both traffic models use the selected upstream channel while each old call drains on its pinned downstream and upstream generations. Repeat the production-control matrix for the External channels and prove operation identity, subject, target, resource, authorization, application-stage decision, input and output meaning, errors, cancellation, streaming, and audit evidence remain equivalent. Fail one selected plugin channel and prove stable unavailability with no hidden fallback to built-in, another channel, or a different application mode, then explicitly switch each affected direction back to built-in from Console. Start the maintenance plugin under a separate non-privileged OS identity with only its fixed local configuration file, no listener and no command surface; keep the Meshrix Model Gateway adapter disabled while the plugin directly calls the Service. Through a valid configuration revision, let the plugin propose and request one existing ordinary Meshrix operation as its independent external service principal, then prove Operation Permission and the final sink decide only the Meshrix effect. Revoke the grant, change sink authority, forge model output and request an operation outside configuration: all produce zero Meshrix effect without stopping or controlling the plugin. Attempts through HTTP, RPC, MCP, CLI, argv, environment, stdin, Console, Host port, backend import, plugin loader or runtime setting cannot trigger, pause, cancel, observe or configure the maintenance plugin, and do not change run count. Only an atomic configuration replacement changes its behavior. Stop Meshrix while the Service and maintenance plugin remain independent; stop the maintenance plugin while Meshrix and Model Gateway remain healthy. Preserve privacy, resource bounds, cancellation, recovery, replay protection, detachment and one-pass old-path deletion.",
      requirements: ["REQ-MODEL-GATEWAY-BOUNDARY", "REQ-MODEL-GATEWAY-ADMISSION", "REQ-MODEL-GATEWAY-BILLING", "REQ-AGENT-MCP-FIXED-GATEWAY-PIPELINE", "REQ-OPTIONAL-WORKSPACE-APPLICATION-STAGE", "REQ-DIRECT-TRANSIT-WORKSPACE-BYPASS", "REQ-GATEWAY-STAGE-PRODUCTION-CONTROLS", "REQ-GATEWAY-SEMANTIC-PRESERVATION", "REQ-EXTERNAL-GATEWAY-BIDIRECTIONAL", "REQ-CONSOLE-GATEWAY-CHANNEL-SELECTION", "REQ-EXTERNAL-GATEWAY-BOUNDARY", "REQ-LOCAL-AGENT-MAINTENANCE-PLUGIN", "REQ-MAINTENANCE-NO-INBOUND-CONTROL", "REQ-ONE-WAY-MAINTENANCE-AUTHORITY", "REQ-BASELINE-EXTERNAL-PLUGIN-PACKAGING-LOADING", "REQ-GATEWAY-SPLIT-FINAL"],
      acceptance: "One sequential scenario proves Service-only direct operation; mandatory downstream and upstream Gateway traversal for efficient Workspace application and Workspace-free direct transit; complete immutable classification and caller non-override; missing-classification denial before any stage; zero cross-mode calls and state effects; built-in and External Gateway production controls at both stages; plugin activation without route change; explicit Console downstream selection affecting both traffic models without changing their application-stage decision; explicit Console upstream selection affecting both traffic models without implicit downstream coupling; semantic equivalence; direction isolation; pinned dual-generation drain; selected-channel failure without fallback to built-in, another channel, Workspace, or application bypass; explicit Console switch-back; attached Model Gateway adapter operation; stable Service-unavailable behavior; complete detachment; maintenance-plugin configuration-only control; ordinary governed plugin-to-Meshrix effects; backend unreachability; and independent reverse shutdown. The current graphs keep optional Workspace application processing, direct transit, the shared dual-Gateway pipeline, Model Gateway Service, and External Gateway Runtime Plugin as distinct capabilities. Meshrix Core owns immutable application-stage classification; Meshrix Core and Console alone own per-direction Gateway selection; External Gateway has no Workspace, application-stage, semantic, selection, model, authorization, credential, settlement, or lifecycle authority. The Service is absent from Meshrix runtime-ui and offline bundles. The repository contains no unconditional MCP Workspace resolution, Gateway-bypassing Agent MCP path, unclassified downstream operation, old Agent Gateway, old nested External Gateway ownership, Core-owned maintenance implementation, compatibility path, or second model runtime.",
      prerequisites: [DELIVERY_ACCEPTANCE_REMAINDER_KEY, DELIVERY_TYPING_REMAINDER_KEY, DELIVERY_FEEDBACK_REMAINDER_KEY],
      target: "tools/server-scripts",
      commands: ["node tools/server-scripts/verify-model-gateway-service.ts", "npm run server:verify:model-gateway-detachment", "node tools/server-scripts/verify-agent-self-maintenance-runtime.ts", "npm run server:verify:agent-self-maintenance-boundary", "npm run verify:security", "npm test", "npm run repo:local-info-hygiene"],
      paths: ["apps", "packages", "plugins", "services/model-gateway", "tools", "tests", "docs"],
      decisions: {
        isolation: "one bounded scenario proves Service-only, Meshrix-only mandatory dual-Gateway operation for both application modes, production controls at both stages, plugin availability without route change, Console-selected per-direction switching for both modes, semantic equivalence, dual-generation drain, no implicit fallback or stage bypass, attached adapter operation, maintenance directionality, full detachment, and independent reverse shutdown before one repository regression",
      },
    }),
  ];
}

export function planMarkdown() : any {
  return `# Agent MCP Dual-Gateway Pipeline And Optional Application Plan

## Current Outcome

The only current Meshrix.js plan is one enterprise single-node functional candidate that combines the completed Workspace-backed Agent MCP application-collaboration efficiency baseline with pending delivery-quality closures and one pending mandatory downstream-Gateway, optional-application, upstream-Gateway pipeline, independently deployable Model Gateway Service, default-disabled Meshrix adapter, one-way local Agent self-maintenance plugin, Console-controlled per-direction Gateway selection, and bidirectional External Gateway Runtime Plugin. Delivery-quality work adds provenance, security-critical typing, and faster verification on that same Plan; it is not a new product direction.

Implemented runtime capacity and concurrency improvements are substrate. They are not a separate current Plan. The current Plan measures their behavior only where the new interaction profile needs fresh evidence or an objectively failing final regression requires repair.

## Mandatory Dual-Gateway Pipeline, Optional Application Stage, Standalone Model Gateway, And Local Maintenance Boundary

The current Agent Gateway and Core-owned Maintenance Agent are replaced once by an independently deployable Model Gateway Service, a default-disabled stateless Meshrix adapter, and a separately started local Agent self-maintenance plugin. Every downstream MCP call follows one mandatory pipeline: downstream Gateway, optional application stage, upstream Gateway, upstream Service. The registered operation descriptor declares whether the middle stage is \`workspace_application\` or \`gateway_transit\`; this choice never bypasses either Gateway. The existing nested External Gateway implementation is replaced once by a native default-disabled Runtime Plugin contributing optional downstream and upstream channels usable by both traffic models. Meshrix establishes the common operation meaning and governance before channel execution. Loading or activating the External Gateway plugin only makes Gateway choices available; it never redirects traffic. An administrator changes one direction and target gateway explicitly from the Meshrix Console. The maintenance plugin can control Meshrix only as an ordinary governed external client; Meshrix cannot control the maintenance plugin. There is no implicit classification, Gateway-bypassing application path, cross-model fallback, embedded Model Gateway runtime, Core maintenance runtime, dual implementation, alias, redirect, or compatibility route.

1. **Standalone Model Gateway Service.** The Service builds, starts, configures, persists, serves direct authenticated clients, restarts, upgrades, and shuts down without Meshrix.js or the External Gateway Runtime Plugin. Its published language-neutral HTTP and JSON contract owns health, readiness, model calls, model and provider management, routing, pricing, client authentication, cancellation, stable errors, and idempotency. It imports no Meshrix runtime and accesses no Meshrix process, address, data root, database, configuration, secret store, ledger, cache, lock, event bus, or lifecycle.
2. **Service-owned admission and settlement.** Before provider egress, the Service enforces bounded request rate, input-token budget, requested output-token budget, total-token quota, concurrent calls, and cost quota against its authenticated tenant, subject, workload, model, provider, and policy-revision partitions. Each admitted call has one Service-owned idempotent ledger bound to model identity, immutable pricing revision, currency, reservation, and terminal \`released\`, \`settled\`, or \`in_doubt\` state with fixed-point amounts and bounded per-attempt usage. Denial resolves no provider credential and causes no egress. The ledger retains minimum numeric metadata only.
3. **Default-disabled Meshrix adapter.** Meshrix exposes \`model_gateway.call\` and \`models.*\` only when a verified operator-selected adapter is active with an explicit \`serviceRef\`. Local Operation Permission decides whether the Meshrix caller may invoke the remote Service; the Service independently authenticates the Meshrix client and applies its own scopes and admission. A Meshrix permit is never sent as Service authority. The adapter holds no endpoint, credential, model, provider, route, quota, price, usage, ledger, cache, or lifecycle state; the Core externalService Host resolves the operator-owned binding and secretRef.
4. **One-way local Agent self-maintenance plugin.** The separately started local plugin artifact owns its configuration-selected planning, strategies, schedules, queue, cancellation, recovery, budgets, run journal and evidence. One fixed, closed-schema local configuration file replaced atomically is the only behavior-control input. Missing configuration is inert; invalid or unreadable configuration fails closed for new admission. The plugin listens on no port, exposes no HTTP, RPC, MCP, CLI, argv, environment override, stdin, Console, Host port, callback, runtime contribution, status or lifecycle interface, and runs under a separate non-privileged OS identity with storage and credentials isolated from Meshrix. It calls the standalone Model Gateway Service directly with its own client identity and calls Meshrix only through existing ordinary governed operations as an independent external service principal.
5. **Authorization is not runtime control.** Model output remains an untrusted proposal. Every protected Meshrix effect resolves a declared Operation Permission operation and consumes a current sink-bound permit immediately before execution. Meshrix may refuse or revoke its own effect, but cannot call, schedule, cancel, observe, configure, start, stop, restart or otherwise control the plugin runtime. Service authentication, process proximity, configuration allowlisting, scheduling, or prior approval never supplies Meshrix effect authority.
6. **Side-effect-free detachment.** Meshrix never starts, stops, restarts, migrates, recovers, upgrades, bundles, or monitors the Service process; the Service never discovers, calls back to, starts, stops, or repairs Meshrix. The Service and Meshrix share no process, database, data root, configuration, secret store, ledger, cache, lock, event bus, or lifecycle. The Meshrix runtime-ui image and offline bundle contain no Service process or second backend port. With the adapter disabled or removed, Meshrix performs no Service DNS lookup, connection, credential resolution, background retry, timer, listener, subscription, child-process launch, shared-state read, or Service-driven durable mutation. Meshrix startup, readiness, and non-model operations remain available. Stopping Meshrix leaves the Service healthy for direct clients; stopping or deleting the Service affects only attached model operations.
7. **Plugin and Console confinement.** A compromised local maintenance plugin remains limited to the current grants of its independent Meshrix service principal; it cannot mint permits, read Core secrets, gain undeclared operations, or obtain reusable authority. Forged Service responses and third-party Console code cannot trigger unauthorized effects. GATE-CANONICAL removes every maintenance control and observation surface from Meshrix and completes opaque-origin Plugin Console isolation; GATE-FINAL proves the one-way boundary.
8. **One mandatory Gateway pipeline.** Every admitted downstream MCP call traverses exactly one selected downstream Gateway channel before any application work and exactly one selected upstream Gateway channel before the upstream Service. Responses mirror the pinned upstream Gateway, optional application-response stage, and downstream Gateway. Neither traffic model may skip a Gateway stage.
9. **Two optional-application decisions.** Every downstream-visible operation descriptor declares exactly one immutable \`trafficModel\`: \`workspace_application\` or \`gateway_transit\`. The caller cannot set or override it. Meshrix does not infer it from URLs, tool names, payloads, Workspace fields, or health. The field selects only the middle stage. Missing or conflicting classification fails before Gateway admission; once admitted, a request cannot change modes or fall back to the other.
10. **Workspace application stage.** \`workspace_application\` provides Meshrix application capabilities to downstream Agents between the downstream and upstream Gateways. It requires an authorized Workspace context and owns Working Sets, Working Views, bounded Change Sets, Resource deltas, collaboration caches, checkpoints, materialization, conflict handling, and the cloud-document-style efficiency profile. It still traverses both selected Gateway channels.
11. **Workspace-free direct transit.** \`gateway_transit\` bypasses only the middle application stage. It still traverses the selected downstream and upstream Gateway channels and never resolves, creates, reads, mutates, materializes, caches, checkpoints, or otherwise touches Workspace state. A supplied Workspace identifier has no transit authority.
12. **Availability is not selection.** The External Gateway Runtime Plugin contributes optional downstream and upstream choices through \`gatewayChannels\` for both traffic models. Plugin load, activation, reload, disable, uninstall, health change and recovery only affect availability. They never alter the current path. Meshrix Core owns one selected-channel generation per direction, and only an explicit governed administrator action from the Meshrix Console changes the named direction and target. Switching downstream does not implicitly switch upstream, or vice versa. Each admitted call remains pinned to both generations until completion; failed selection leaves state unchanged, selected-channel failure returns stable unavailability, and no hidden fallback to built-in, another channel, Workspace, or application bypass occurs.
13. **Production Gateway controls.** Both the built-in and External Gateway implementations may provide connection management, bounded load distribution, rate and concurrency admission, health and circuit handling, overload shedding, timeout, cancellation, streaming, backpressure, and stable transport degradation at their respective stages. These controls must apply to both traffic models and cannot rewrite Meshrix operation meaning or alter whether the optional application stage runs.

**Agent MCP fixed Gateway pipeline.** The Model Gateway Service is an independent upstream model service. Meshrix reads the immutable traffic model from the registered operation descriptor, but both values use the same mandatory Gateway layers. The downstream Gateway protects ingress before any optional application work; the upstream Gateway protects egress before Model Gateway or another upstream Service. The selected built-in or External channel can change independently in each direction through the Console, while the application-stage decision remains unchanged.

\`\`\`text
downstream Agent MCP request
  -> DownstreamGatewayEnvelope
  -> downstream Gateway selector -> built-in or External Gateway channel
  -> trafficModel
     -> workspace_application -> Workspace application stage
     -> gateway_transit       -> bypass application stage
  -> UpstreamGatewayEnvelope
  -> upstream Gateway selector -> built-in or External Gateway channel
  -> upstream Service
\`\`\`

The Service alone owns its clients, models, providers, credentials, Service API routes, limits, price revisions, usage, ledger, persistence, artifact and lifecycle. Workspace authorities alone own optional application collaboration state. The External Gateway plugin alone owns channel-adapter configuration and bounded channel-local admission, backend, circuit and health state. The maintenance plugin alone owns its configuration, targets, strategies, schedules, queue, cancellation, recovery, private journal, credentials, storage, process and lifecycle. Meshrix owns immutable application-stage classification, DownstreamGatewayEnvelope, WorkspaceApplicationEnvelope, UpstreamGatewayEnvelope, local Operation Permission, common Gateway semantics, available-channel registration, each direction's selected generation, Console selection operations, its optional Model Gateway serviceRef binding and adapter activation, ordinary Operation audit, and protected effects within Meshrix. Meshrix has no maintenance scheduler, queue, configuration, state, status, PID, socket, credential, Host port, process handle or run observation. The old mixed Agent registry is removed, and no retired Agent Gateway, old nested External Gateway, or \`maintenance_agent\` data is migrated, imported, renamed, copied, translated or probed.

## Architecture Reorganization And Real Parallelism

The split uses one unavoidable contract gate, three genuinely independent implementation branches, and one shared-authority cutover. The branches are the standalone Model Gateway Service, one-way local Agent self-maintenance, and bidirectional External Gateway Runtime Plugin. A branch is parallel only when it consumes the frozen Contracts output, writes a disjoint path set, directly tests its new implementation, and imports neither another branch nor the old implementation. GATE-CANONICAL installs the mandatory dual-Gateway pipeline, preserves the Workspace application authority as an optional middle stage, creates the Workspace-free bypass of that stage, connects the optional Meshrix adapter, Core per-direction selectors, Console-controlled switching and plugin contribution registry, then removes old nested Gateway and Core maintenance authorities.

Delivery-quality work is split so plan:next dispatches a thin substrate before GATE-CONTRACT and parks the heavier remainder behind GATE-CANONICAL. DQ-PROVENANCE, DQ-TYPING, and DQ-FEEDBACK become eligible together after EFF-FINAL and join only at GATE-CONTRACT. After GATE-CANONICAL, DQ-ACCEPTANCE, DQ-TYPING-REST, and DQ-FEEDBACK-SCALE become eligible together and join only at GATE-FINAL. GATE-FINAL.next stays empty.

| Node | Exclusive write ownership | Forbidden dependency or write |
| --- | --- | --- |
| **GATE-CONTRACT** | Language-neutral Service wire contracts, immutable application-stage classification, DownstreamGatewayEnvelope, WorkspaceApplicationEnvelope, UpstreamGatewayEnvelope, built-in/plugin channel contracts, production-control semantics, Console-selection contract, and local maintenance contracts | Mutable runtime state, classification or channel-selection implementation, maintenance Host port, shared storage or lifecycle, compatibility alias, or duplicate port |
| **GATE-MODEL** | Standalone Service source, package, image, direct tests, and verifier under \`services/model-gateway/**\`, excluding frozen contracts | Meshrix runtime, adapter, Agents, old Agent Gateway, External Gateway Runtime Plugin, or shared registries |
| **GATE-MAINTENANCE** | \`plugins/agents/meshrix-self-maintenance/**\`, excluding frozen contracts, plus its focused verifier/tests | Meshrix Server Runtime, Operation Permission implementation, Meshrix Model Gateway adapter, runtime contribution, inbound interface, shared configuration or lifecycle, or old Maintenance implementation |
| **GATE-EDGE** | \`plugins/external-gateway/**\` and its focused verifier/tests | Workspace ports or state, application-stage ownership, Agents, Model Gateway Service or adapter, production composition, channel-selection authority, Console selection, MCP interpretation, identity, authorization, credential, or business policy |
| **GATE-CANONICAL** | Explicit trafficModel migration, mandatory downstream-Gateway / optional-application / upstream-Gateway pipeline, Core per-direction selectors, \`gatewayChannels\` plumbing, Console selection, Model Gateway adapter, shared composition, registries, projections, and old-source deletion | Loading or controlling local maintenance, embedding the Service, inference-based classification, Gateway-bypassing route, cross-model fallback, plugin-selected traffic, shared Workspace/Gateway state, or compatibility path |
| **DQ-PROVENANCE** | Command and report registry files, platform-acceptance contract reducer catalog report-catalog generation-store ledger-anchor modules, and clean-checkout PR simulation | Project-level verify:acceptance, remaining evidence modules, or GATE contract freeze |
| **DQ-TYPING** | oxlint config, no-explicit-any verifier, existing contracts sources outside GATE writes, and foundation security except generated-capabilities | GATE-CONTRACT ports, generated operations, or remaining package any batches |
| **DQ-FEEDBACK** | \`.github/workflows/ci.yml\`, failure localization, and its focused test | Suite merging, cache, sharding, tests.registry.json, or verify:acceptance |
| **DQ-ACCEPTANCE** | Remaining platform-acceptance evidence, plan-receipt, required-report, and release-evidence readiness/freshness modules | Thin provenance registry files or GATE cutover authorities |
| **DQ-TYPING-REST** | Remaining explicit-any package subtrees outside GATE and thin-typing writes | module-system, apps/console, composition, or the thin security/contracts batch |
| **DQ-FEEDBACK-SCALE** | tests.registry.json, test-suite reachability, test-suite schema, tests/run.ts, and unified test runner execution | ci.yml or thin-feedback localization |

The three middle branches become eligible together after GATE-CONTRACT. The standalone Model Gateway Service, one-way local Agent self-maintenance plugin, and External Gateway Runtime Plugin write disjoint authorities and compile against frozen contracts without importing one another's implementation. GATE-CANONICAL is the only necessary join because operation-descriptor classification, mandatory downstream and upstream stage routing, retained optional Workspace application composition, direct application-stage bypass, Core selection state, Console controls, plugin contribution plumbing, the optional Meshrix adapter, production composition, generated registries, public operation projections, rejection of the client-peer artifact by the runtime loader, and deletion of old roots are shared authorities. Splitting that join would manufacture ambiguous routing, dual registration, shared lifecycle, merge conflicts, or temporary shims rather than useful parallelism.

GATE-CONTRACT freezes the Service health, readiness, direct-call, management, authentication, stable-error, cancellation, idempotency, admission, pricing, and ledger wire schemas in \`services/model-gateway/contracts\`; the Meshrix model-call client port and operation identities for \`model_gateway.call\` and \`models.*\`; default-disabled adapter configuration containing only explicit serviceRef and bounded timeout; a required descriptor-owned \`trafficModel\` that selects only the optional middle stage; one DownstreamGatewayEnvelope; one WorkspaceApplicationEnvelope; one UpstreamGatewayEnvelope; built-in and plugin channel interfaces for both directions and both traffic models; bounded load, admission, circuit, overload, timeout, cancellation, streaming and backpressure semantics; plugin-lifecycle-as-availability-only; explicit direction-and-target Console selection; the maintenance plugin's fixed local configuration schema and outbound clients; plugin-confinement ports; owner boundaries; and independent lifecycles. External Gateway receives no Workspace, application-stage, semantic, identity, authorization, credential, policy, selection, Model Gateway lifecycle, or maintenance port. The Service never imports Meshrix runtime authority, the maintenance plugin imports neither implementation, and Meshrix has no dependency edge to the maintenance plugin.

No branch may satisfy its closure by re-exporting an old module, dynamically importing an old path, adding a temporary feature flag, or creating a \`bridge\`, \`adapter-v2\`, or phase-specific second state owner. The semantic ports are justified only as one-way dependency boundaries and executable test seams.

## The Shared-Document Model

This model applies only to the optional \`workspace_application\` middle stage. It is the Workspace-backed application-service model, not a universal Agent MCP transport model. Both traffic models still traverse the mandatory downstream and upstream Gateway layers. \`gateway_transit\` bypasses every Workspace concept in this section, not either Gateway.

A person does not reopen a shared document, download every page, resend the editor schema, and save every keystroke as a separate remote command. The person opens it once, keeps a current local view, edits locally, submits a compact transaction, receives an acknowledgement, and consumes later deltas.

An Agent should interact with a Workspace-backed Meshrix application service the same way:

1. **Open once.** Resolve current authorization and open a Service Working Set with opaque Handles, stable entity identities, a confirmed Head, Resource links, cache policy, and Cursor.
2. **Observe locally.** The Connector keeps a private authorization-partitioned Working View of confirmed Resources, catalogs, schemas, acknowledgements, and bounded history. Valid cache hits require no model-visible remote read.
3. **Edit locally.** Agent reasoning and provisional edits update an optimistic view without repeating unchanged schema or state in the model context.
4. **Commit once.** A dirty work turn emits at most one bounded typed Change Set for Core-managed state. A clean or read-only turn emits none.
5. **Acknowledge minimally.** Core returns the assigned revision, changed identities, compact result facts, conflicts, and invalidations rather than the entire Service state.
6. **Subscribe to deltas.** MCP Resources, private cache hints, \`subscriptions/listen\`, and \`notifications/resources/updated\` deliver only relevant change signals. The Connector fetches only invalidated Resources or missing delta pages.
7. **Rebase or resynchronize explicitly.** Eligible typed operations rebase only over relevant indexed operations. Other conflicts return stable facts. A valid Cursor returns bounded missing changes; an expired Cursor returns an authorized Snapshot plus bounded tail.

Workspace is the required application-state foundation. Cloud-document co-editing is the reference scenario, while other Workspace-backed documents, structured records, jobs, configurations, catalogs, or Core-governed Resources may use the same Working View and Change Set contract. A direct forwarding Service is not Workspace-backed application traffic and must use \`gateway_transit\` for the middle-stage bypass while still traversing both Gateway layers.

## State Changes And External Effects

Within \`workspace_application\`, Core-managed state uses stable identities, monotonic Heads, immutable attributed Change Sets, idempotent ChangeIds, causal baselines, bounded typed operations, atomic visibility, indexed history, Snapshots, and Cursors.

Arbitrary external or irreversible effects requested by a Workspace application are not document edits. They remain explicit governed **Effect Commands**. Every effect binds its current principal, grant, target, policy, approval, audience, request, EffectId, idempotency or explicit non-idempotency, cancellation state, terminal or uncertain result, audit, and optional compensation. Meshrix.js never merges arbitrary effects through CRDT rules, retries an uncertain effect silently, or claims that a local rollback reverses an external effect. Direct transit is a separate middle-stage decision and never enters a Workspace Change Set or application Effect Command; the mandatory Gateways remain transport and production-control boundaries for both modes.

The design learns from proven collaboration invariants without transferring Core authority: Yjs state vectors exchange missing updates; Automerge SyncState records peer knowledge and emits nothing when synchronized; CodeMirror and ProseMirror retain a confirmed authority version plus unconfirmed local steps and rebase them over remote changes.

## Efficiency Contract

The verifier freezes equivalent legacy and collaborative \`workspace_application\` scenarios for cold open, warm read, dirty turn, concurrent change, reconnect, conflict, revocation, and explicit side effect. It does not use these reductions to claim Gateway transit efficiency. It records only privacy-safe numeric counters:

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
| **EFF-10** | Close exact offline Linux VM amd64 and arm64 delivery. |
| **EFF-FINAL** | Consume the completed efficiency and delivery evidence as the retained baseline. |
| **DQ-PROVENANCE** | Thin substrate: one command and report registry with unified provenance, stale-report invalidation, and clean-checkout PR simulation. |
| **DQ-TYPING** | Thin substrate: oxlint no-explicit-any on new TypeScript plus the contracts and security-critical batch. |
| **DQ-FEEDBACK** | Thin substrate: PR versus public-gate path split and failure localization to assertion, file, and command. |
| **GATE-CONTRACT** | Freeze the standalone Service wire contract, descriptor-owned optional-application decision, mandatory DownstreamGatewayEnvelope and UpstreamGatewayEnvelope stages, WorkspaceApplicationEnvelope, production-control semantics, Console-only per-direction selection, local maintenance configuration-only control, and independent ownership. |
| **GATE-MODEL** | Build the independently deployable Model Gateway HTTP Service, direct-client API, Service-owned authentication, persistence, provider adapters, admission, accounting, and separate OCI artifact. |
| **GATE-MAINTENANCE** | Build the separately started local Agent self-maintenance plugin with direct Model Gateway use, ordinary governed Meshrix operations, and a local configuration file as its only control input. |
| **GATE-EDGE** | Build the default-disabled External Gateway Runtime Plugin with downstream and upstream Caddy/Nginx/direct channels for both traffic models and no Workspace, application-stage, semantic, or selection authority. |
| **GATE-CANONICAL** | Install immutable middle-stage classification, mandatory downstream and upstream Gateway routing, optional efficient Workspace application processing, direct Workspace-free bypass, Core per-direction selection, Console controls, the plugin contribution kind, and the Model Gateway adapter; delete retired assumptions and authorities. |
| **DQ-ACCEPTANCE** | Remainder: project-level verify:acceptance green with mandatory stage-order coverage, Workspace application efficiency, direct-transit Workspace-zero-touch, both-mode built-in/plugin semantic equivalence, load and degradation controls at both Gateway stages, activation-no-switch, Console selection, dual-generation drain, no-fallback, standalone, attached, detached, and maintenance-directionality evidence. |
| **DQ-TYPING-REST** | Remainder: remaining explicit-any package subtrees outside GATE and thin-typing writes. |
| **DQ-FEEDBACK-SCALE** | Remainder: suite and process merging plus cache and sharding in the test runner and registry. |
| **GATE-FINAL** | Verify the mandatory downstream-Gateway / optional-application / upstream-Gateway order for both modes, Workspace efficiency, direct-transit Workspace-zero-touch, production controls at both stages, classification denial, Service-only, activation without switching, explicit Console switches, semantic equivalence, complete detachment, maintenance directionality, independent shutdown, and security once. |

EFF-3, EFF-4, EFF-5, EFF-8, EFF-9, and EFF-10 retain their completed dependency boundaries. Workspace migration joins the Connector, Core state, and effect semantics, and EFF-FINAL retains that completed baseline. Three thin delivery-quality nodes become eligible together after EFF-FINAL and join only at GATE-CONTRACT. GATE-CONTRACT then unlocks GATE-MODEL, GATE-MAINTENANCE, and GATE-EDGE at the same frontier. Those three branches join only at GATE-CANONICAL. GATE-CANONICAL then unlocks three remainder delivery-quality nodes that join only at GATE-FINAL. GATE-FINAL is the only current terminal candidate decision.

## Capability Acceptance Plan Migration

The consolidated Plan preserves the facts owned by existing capability plans and migrates only the authorities affected by this split at GATE-CANONICAL:

- completed \`agent-gateway-model-routing\` evidence remains historical input, then its active authority, acceptance machine, and command are replaced by standalone Model Gateway Service evidence, a neutral Meshrix adapter acceptance boundary, and separate routing, admission, and usage-accounting evidence owned only by the Service;
- completed Agent-to-Service efficiency evidence is retained only for the optional \`workspace_application\` stage that its Workspace workloads exercise; it creates no efficiency or state-model claim for \`gateway_transit\`, and pending Gateway work must prove that both modes still traverse both mandatory Gateway stages;
- incomplete \`maintenance-agent-collaboration\` is replaced by the independently started \`plugins/agents/meshrix-self-maintenance\` client-peer artifact; its Console/MCP parity and internal Host-port requirements are removed and replaced by proof that one local configuration file is its only control input and no Meshrix surface can call, observe, schedule, cancel or configure it;
- \`plugin-runtime-and-module-system\` rejects the client-peer maintenance artifact from runtime activation and retains process-isolated runtime-plugin confinement plus opaque-origin Console isolation for actual Meshrix Runtime Plugins;
- \`operation-permission-authorization\` gains local pre-egress authorization without permit forwarding plus sink reauthorization after queueing, approval, retry, cancellation, and recovery;
- External Gateway acceptance is removed from Agents and becomes \`external-gateway-runtime\`, a native plugin contributing optional downstream and upstream Gateway channels for both traffic models; Meshrix retains immutable application-stage classification, common Gateway semantics, and Console-controlled per-direction selection; and
- downstream MCP, Workspace application collaboration, Console administration, and state-machine governance retain their existing responsibilities but must prove complete trafficModel coverage, mandatory dual-Gateway traversal, zero Workspace participation in direct transit, and absence of retired Agent maintenance projections and old acceptance definitions.

These plan-authority replacements happen in the canonical cutover, not before implementation exists. This avoids falsifying current implementation status while still making removal of the contradictory old plans a required delivery outcome.

## Complete Migration

The old enterprise child Plans, standalone runtime-capacity Plan, standalone shared Workspace Plan, their receipts, aliases, dependency edges, and old planning documents are removed in the same closure that establishes this Plan. The Agent MCP split removes the unconditional assumption that every tool call resolves Workspace input and migrates every downstream operation descriptor once to \`workspace_application\` or \`gateway_transit\`; that value controls only the optional middle stage, while no Agent MCP call may bypass the mandatory downstream or upstream Gateway. No heuristic classifier, unclassified fallback, cross-model retry, or caller override remains. The Gateway split additionally removes \`agent_gateway.call\`, \`agents.*\` model management, the mixed Agent registry, every embedded Model Gateway or old model transport, the Agent Gateway and Core-owned Maintenance Agent roots and names, every \`maintenance_agent.*\` projection and Core maintenance control surface, the old nested External Gateway ownership, its generic profile-management provider and probe, \`runtime.external_gateway.apply\`, \`runtime.external_gateway.switch_direct\`, and \`/api/agent-gateway\`. Caddy, Nginx and direct adapter capability migrates once into \`plugins/external-gateway\`; no old nested implementation is re-exported or retained, and no \`packages/external-gateway\` compatibility package is created. The only Model Gateway implementation is the separately startable Service; Meshrix contains only a default-disabled stateless adapter. The only Agent self-maintenance implementation is the separately started local client-peer plugin. The External Gateway Runtime Plugin offers selectable downstream and upstream channels for both traffic models but never enters Workspace or becomes the semantic, application-stage, or route-selection authority. Meshrix Core owns immutable application-stage classification and per-direction channel state, and only explicit Console operations change the latter. There is no dual Plan, Gateway-bypassing path, redirect, compatibility graph, compatibility API, old-name gate, implicit fallback, retired-data import or reverse maintenance-control path. One-time residue searches at GATE-CANONICAL prove removal and are then discarded; GATE-FINAL proves mandatory dual-Gateway traversal, optional Workspace application efficiency, direct-transit Workspace-zero-touch, production controls at both Gateway stages, standalone operation, one-way maintenance, activation-without-selection, explicit per-direction switching, semantic equivalence, side-effect-free detachment, and security.

## Remaining Host Qualification

Native host qualification, client-platform qualification, public-cloud qualification, independent recovery-host support, multi-node availability, federation, and hosted operation begin after this functional candidate is accepted. Linux inside a virtual machine closes EFF-10 and EFF-FINAL. Ubuntu is preferred; Debian is accepted.
`;
}

export function capabilities() : any[] {
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
      description: "Pre-release private-deployment governance platform with one current functional-convergence Plan.",
    },
    {
      key: "meshrix/functional-convergence",
      parent: "meshrix",
      title: "Functional Convergence",
      kind: "capability",
      basis: "designed",
      disclosure: "examined",
      touch: "in_scope",
      source_files: [`docs/plans/${ROOT}/Plan.md`],
      description: "One current functional candidate combining efficient optional Workspace-backed Agent MCP application processing with one mandatory downstream-Gateway and upstream-Gateway pipeline, Workspace-free direct transit through that same pipeline, one independently deployable Model Gateway Service, a default-disabled stateless Meshrix adapter, a configuration-controlled one-way local Agent self-maintenance plugin, Console-controlled per-direction selection, and a bidirectional External Gateway Runtime Plugin.",
    },
    {
      key: "meshrix/functional-convergence/agent-service-collaboration-efficiency",
      parent: "meshrix/functional-convergence",
      title: "Workspace Application Collaboration Efficiency",
      kind: "capability",
      basis: "observed",
      disclosure: "examined",
      touch: "in_scope",
      source_files: [`docs/plans/${ROOT}/Plan.md`],
      description: "Retained completed baseline using shared-document interaction mechanics to reduce the optional Workspace-backed Agent MCP application-stage cost; pending Gateway work must place that stage between the mandatory downstream and upstream Gateway layers.",
    },
    {
      key: "meshrix/functional-convergence/model-gateway",
      parent: "meshrix/functional-convergence",
      title: "Standalone Model Gateway Service",
      kind: "capability",
      basis: "designed",
      disclosure: "examined",
      touch: "in_scope",
      source_files: [`docs/plans/${ROOT}/Plan.md`],
      description: "Independently deployable model-only Service owning direct clients, bounded HTTP ingress, authentication, credentials, routing, admission, persistence, usage settlement, cost accounting, and lifecycle, connected to Meshrix only through a default-disabled stateless adapter.",
    },
    {
      key: "meshrix/functional-convergence/gateway-transit",
      parent: "meshrix/functional-convergence",
      title: "Mandatory Dual-Gateway Pipeline And Workspace-Free Direct Transit",
      kind: "capability",
      basis: "designed",
      disclosure: "examined",
      touch: "in_scope",
      source_files: [`docs/plans/${ROOT}/Plan.md`],
      description: "Both traffic models traverse selected downstream and upstream built-in or plugin Gateway channels. Descriptor-classified gateway_transit bypasses only the middle Workspace application stage and performs zero Workspace resolution, state, cache, materialization, checkpoint, or collaboration work.",
    },
    {
      key: "meshrix/functional-convergence/agent-self-maintenance",
      parent: "meshrix/functional-convergence",
      title: "Local Agent Self-Maintenance Plugin Runtime",
      kind: "capability",
      basis: "designed",
      disclosure: "examined",
      touch: "in_scope",
      source_files: [`docs/plans/${ROOT}/Plan.md`],
      description: "Separately started local client-peer plugin controlled only by one local configuration file, calling Model Gateway directly and Meshrix only through ordinary governed operations, with no Meshrix control or observation surface.",
    },
    {
      key: "meshrix/functional-convergence/external-gateway-runtime",
      parent: "meshrix/functional-convergence",
      title: "Bidirectional External Gateway Plugin",
      kind: "capability",
      basis: "designed",
      disclosure: "examined",
      touch: "in_scope",
      source_files: [`docs/plans/${ROOT}/Plan.md`],
      description: "Default-disabled native Runtime Plugin registering optional downstream and upstream Caddy/Nginx/direct channels for both Workspace-application and direct-transit traffic. It receives no Workspace or application-stage authority; plugin lifecycle changes availability only, while Meshrix Core owns channel selection and only explicit Console actions switch one named direction and target.",
    },
    {
      key: "meshrix/functional-convergence/delivery-quality",
      parent: "meshrix/functional-convergence",
      title: "Delivery Quality",
      kind: "capability",
      basis: "designed",
      disclosure: "examined",
      touch: "in_scope",
      source_files: [`docs/plans/${ROOT}/Plan.md`],
      description: "Thin substrate before GATE-CONTRACT for provenance, security-critical typing, and faster verification, plus remainder closures that join only at GATE-FINAL.",
    },
  ];
}

export function manifest() : any[] {
  return [{
    id: stableId(`manifest:${ROOT}`),
    status: "pending",
    title: "Functional Convergence",
    directory: ROOT,
    source_files: [`docs/plans/${ROOT}/Plan.md`, `docs/plans/${ROOT}/DependencyMap.json`],
    purpose: "Own the only current functional candidate, including the mandatory downstream-Gateway, optional Workspace-application, upstream-Gateway architecture, independently deployable Model Gateway Service boundary, Console-selected Gateway channels, External Gateway Runtime Plugin boundary, and exact final receipt.",
    goal: "Accept one immutable enterprise single-node candidate in which both efficient Workspace-backed application traffic and Workspace-free direct transit traverse mandatory downstream and upstream Gateway layers, with one independently deployable Model Gateway Service, a default-disabled side-effect-free Meshrix adapter, a configuration-controlled one-way local Agent self-maintenance plugin, and a bidirectional External Gateway Runtime Plugin selected only from Meshrix Console.",
    description: "Single current Plan containing completed Workspace-application efficiency work, delivery-quality closures, one contract gate, disjoint Model-Gateway-Service, maintenance-plugin, and External-Gateway-Plugin branches, one shared mandatory dual-Gateway pipeline cutover with an optional middle application stage, and final stage-order, production-control, Workspace-zero-touch, activation-without-selection, per-direction hot-switch, semantic-equivalence, one-way, detachment, and security acceptance.",
    checkpoints: `${ROOT}/Checkpoints.json`,
    kind: "group",
    capability_key: "meshrix/functional-convergence",
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
      final_validations: [{ node_id: stableId("gateway-boundary-final"), profiles: [PROFILE] }],
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
    await writeFile(stagingRoot, "FutureGoals.md", `# Future Goals\n\nThese workflows begin after the current functional candidate is accepted.\n\n- Native Linux environment qualification for named amd64 and arm64 hosts.\n- Client platform qualification for macOS, Windows, and supported browser shells.\n- Public-cloud and independent clean-host recovery qualification.\n- Multi-node availability, forwarding, federation, hosted operation, and external identity-provider profiles.\n`);
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
