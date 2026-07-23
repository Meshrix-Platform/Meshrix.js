#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyEndToEndReleasePlan } from "../plan/verify-end-to-end-release-plan.mjs";
import { verifyOrganizationClosure } from "../plan/verify-organization-closure.mjs";
import { validateCanonicalBetterPlanWorkspace } from "../plan/canonical-better-plan-validator.mjs";
import { assertNoLeak as assertNoSensitiveLeak } from "./lib/report-evidence-safety.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(modulePath), "../..");
const REPORT_PATH = "build/reports/better-plan.json";
const LOCAL_INFO_HYGIENE_REPORT_PATH = "build/reports/local-info-hygiene.json";
const LOCAL_INFO_HYGIENE_SCHEMA = "v0.0.1:repository:local-info-hygiene-report-0.0.2";
const DEFAULT_LOCAL_INFO_HYGIENE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const VALIDATION_SCHEMA = "licomesh.better-plan-validation.v1";
const REPORT_SCHEMA = "v0.0.1:release:public-source-boundary-verifier-1";
const CHECK_NAMES = Object.freeze(["schema", "source", "label", "graph", "privacy"]);
const REQUIRED_RECOVERED_CAPABILITIES = new Set([
  "external-plugin-packaging-loading",
  "agent-gateway-model-routing",
  "core-workspace-assets-governance",
]);
// Pinned Strategy evidence identities must remain present even when Version Registry
// nested strings are rewritten; dynamic expansion alone cannot detect that mutation.
const STRATEGY_VERSION_REGISTRY_IDENTITIES = Object.freeze([
  "lico.strategy.strategy-management-browser-report",
  "v0.0.1:schema:strategy-management-browser-report-1",
  "lico.strategy.strategy-management-browser-report@v0.0.1:schema:strategy-management-browser-report-1",
  "v0-0-1-schema-strategy-management-browser-report-1-verifier",
  "tools/server-scripts/verify-strategy-management-browser.mjs",
  "lico.strategy.strategy-management-verification-report",
  "v0.0.1:strategy-management:verification-report-1",
  "lico.strategy.strategy-management-verification-report@v0.0.1:strategy-management:verification-report-1",
  "v0-0-1-strategy-management-verification-report-1-validator",
  "tools/server-scripts/lib/required-report-validator.mjs",
  "v0-0-1-strategy-management-verification-report-1-verifier",
  "tools/server-scripts/verify-strategy-management.mjs",
]);
const CAPABILITY_MATRIX_PATH = "tools/registry/open-platform-capability-matrix.json";
const ACCEPTANCE_REGISTRY_PATH = "tools/registry/capability-acceptance.registry.json";
const TESTS_REGISTRY_PATH = "tools/registry/tests.registry.json";
const VERSION_REGISTRY_PATH = "packages/foundation/src/version-control/version-registry.json";
const OPERATION_REGISTRY_PATH = "packages/contracts/src/operations/operation-registry.mjs";
// Operation IDs are authored in composed definition modules and only aggregated by the
// operation-registry barrel. Observe the full authority set so registry edges stay current.
const OPERATION_REGISTRY_AUTHORITY_PATHS = Object.freeze([
  OPERATION_REGISTRY_PATH,
  "packages/contracts/src/operations/operation-registry-governed-definitions.mjs",
  "packages/contracts/src/operations/protocol-operation-definitions.mjs",
  "packages/contracts/src/operations/authorization-contribution-operation-definitions.mjs",
  "packages/contracts/src/operations/workspace-asset-operation-definitions.mjs",
  "packages/contracts/src/operations/platform-console-operation-definitions.mjs",
  "packages/contracts/src/operations/identity-runtime-operation-definitions.mjs",
  "packages/contracts/src/operations/strategy-permission-operation-definitions.mjs",
  "packages/contracts/src/operations/permission-observability-operation-definitions.mjs",
  "packages/contracts/src/operations/storage-workspace-operation-definitions.mjs",
  "packages/contracts/src/operations/agent-session-operation-definitions.mjs",
  "packages/contracts/src/operations/workspace-context-operation-definitions.mjs",
  "packages/contracts/src/operations/context-job-operation-definitions.mjs",
]);
const GENERATED_OPERATIONS_PATH = "packages/contracts/src/generated/operations.generated.mjs";
const GENERATED_CAPABILITIES_PATH =
  "packages/foundation/src/security/authorization/generated-capabilities.mjs";

const REQUIRED_PUBLIC_DOCS = Object.freeze([
  "README.md", "README.zh-CN.md", "docs/README.md", "docs/RUNBOOK.md", "docs/examples/README.md",
  "docs/COMPATIBILITY.md", "docs/architecture/ARCHITECTURE.md",
  "docs/architecture/EXECUTION-SANDBOX.md", "docs/protocols/PROTOCOLS.md",
  "docs/functionality/GATEWAY.md",
  "docs/functionality/OPERATION-PERMISSION.md", "docs/functionality/SECURITY-AUTHORIZATION.md",
  "docs/functionality/SERVER-RUNTIME.md",
  "docs/functionality/WORKSPACE-ASSETS.md", "docs/architecture/STATE-MACHINES.md",
]);

const FACT_SOURCE_AUTHORITY_REGISTRY = "tools/registry/fact-source-authority.registry.json";
const REQUIRED_FACT_AUTHORITY_KEYS = Object.freeze({
  "server.operations": "packages/contracts/src/operations/operation-registry.mjs",
  "release.readiness-reduction": "tools/server-scripts/lib/release-evidence-readiness.mjs",
  "platform.acceptance-workflow": "tools/server-scripts/verify-platform-acceptance.mjs",
  "private-deployment.open-platform-e2e-catalog": "tools/server-scripts/lib/platform-acceptance-command-catalog.mjs",
  "upstream-fixture.transit-evidence": "tools/server-scripts/lib/upstream-fixture-transit-evidence.mjs",
  "downstream-agent.tool-loop-evidence": "tools/server-scripts/lib/downstream-agent-tool-loop-evidence.mjs",
  "mcp-client.proxy-transport-evidence": "tools/server-scripts/lib/mcp-proxy-transport-evidence.mjs",
  "mcp-release.targets": "packages/protocols/mcp/adapter/mcp-release-targets.mjs",
  "mcp-process-identity.credential-store-evidence": "tools/server-scripts/lib/mcp-process-identity-credential-store-evidence.mjs",
  "composition.source-package": "tools/server-scripts/package-server-source.mjs",
  "package-scripts.classification": "tools/scripts/package-script-registry.mjs",
  "open-platform.capability-surface": "tools/registry/open-platform-capability-matrix.json",
});

const CAPABILITY_OWNERS = Object.freeze({
  "upstream-gateway": ["agents-and-protocols", "packages/agents/src/upstream-gateway/index.mjs", "docs/plans/end-to-end-release/current-baseline", "REQ-BASELINE-UPSTREAM-GATEWAY", "upstream-service-publishing"],
  "downstream-mcp": ["agents-and-protocols", "packages/protocols/mcp/adapter/gateway-installer/bin/lico-mcp.mjs", "docs/plans/end-to-end-release/current-baseline", "REQ-BASELINE-DOWNSTREAM-MCP", "downstream-mcp-gateway"],
  "strategy-management": ["cross-cutting-governance", "packages/server-runtime/src/composition/strategy-management-provider.mjs", "docs/plans/end-to-end-release/current-baseline", "REQ-BASELINE-STRATEGY-MANAGEMENT", "strategy-management"],
  "enterprise-governance": ["foundation", "packages/foundation/src/security/authorization/authorization-engine.mjs", "docs/plans/end-to-end-release/current-baseline", "REQ-BASELINE-ENTERPRISE-GOVERNANCE", ["operation-permission-authorization", "observability-alerts-reporting"]],
  "console-administration": ["ui-console", "apps/console/router/admin-route-registry.mjs", "docs/plans/end-to-end-release/current-baseline", "REQ-BASELINE-CONSOLE-ADMINISTRATION", "console-administration"],
  "container-deployment": ["deployment-and-operations", "docker-compose.yml", "docs/plans/end-to-end-release/current-baseline", "REQ-BASELINE-CONTAINER-DEPLOYMENT", "container-deployment-resumability"],
  storage: ["domain-capabilities", "packages/foundation/src/storage/storage-provider.mjs", "docs/plans/end-to-end-release/current-baseline", "REQ-BASELINE-STORAGE", "storage-backup-runtime"],
  jobs: ["domain-capabilities", "packages/foundation/src/work-queue/worker-runtime.mjs", "docs/plans/end-to-end-release/current-baseline", "REQ-BASELINE-JOBS", "jobs-work-queue-runtime"],
  "external-plugin-packaging-loading": ["optional-plugins", "packages/foundation/src/module-system/plugin-runtime.mjs", "docs/plans/end-to-end-release/current-baseline", "REQ-BASELINE-EXTERNAL-PLUGIN-PACKAGING-LOADING", "plugin-runtime-and-module-system"],
  "agent-gateway-model-routing": ["agents-and-protocols", "packages/agents/src/agent-gateway/gateway-core.mjs", "docs/plans/end-to-end-release/current-baseline", "REQ-BASELINE-AGENT-GATEWAY-MODEL-ROUTING", "agent-gateway-model-routing"],
  "core-workspace-assets-governance": ["domain-capabilities", "packages/agents/src/workspace-asset-registry/index.mjs", "docs/plans/end-to-end-release/current-baseline", "REQ-BASELINE-CORE-WORKSPACE-ASSETS-GOVERNANCE", "core-workspace-assets-governance"],
});

const ORGANIZATION_ROOT_FACTS = Object.freeze({
  "application-entry": ["application-entry", "apps/server/bin/lico.mjs",
    "docs/functionality/SERVER-RUNTIME.md", "docs/plans/end-to-end-release",
    "REQ-REL-BASELINE", "tools/server-scripts/verify-composition-source.mjs",
    "state-machine-governance"],
  "server-runtime-composition": ["runtime-composition", "packages/server-runtime/src/composition/index.mjs",
    "docs/functionality/SERVER-RUNTIME.md", "docs/plans/end-to-end-release",
    "REQ-REL-BASELINE", "tools/server-scripts/verify-composition-source.mjs",
    "state-machine-governance"],
  "public-contracts": ["contracts", OPERATION_REGISTRY_PATH, "docs/protocols/PROTOCOLS.md",
    "docs/plans/end-to-end-release", "REQ-REL-BASELINE",
    "tools/server-scripts/verify-operation-permission-protocol-consistency.mjs",
    "operation-permission-authorization"],
});

const CAPABILITY_REGISTRY_CONTRACTS = Object.freeze({
  "upstream-gateway": [["gateway.forward"], ["upstream-service-publishing"],
    ["upstream-gateway.e2e"], ["lico.upstream-gateway.e2e-report"]],
  "downstream-mcp": [["operation_permission.catalog"], ["downstream-mcp-gateway"],
    ["downstream-mcp.completeness-audit"], ["lico.mcp.downstream-completeness-audit"]],
  "strategy-management": [["strategy.describe"], ["strategy-management"],
    ["strategy-management.runtime"], ["lico.strategy.strategy-management-browser-report",
      "lico.strategy.strategy-management-verification-report"],
    STRATEGY_VERSION_REGISTRY_IDENTITIES],
  "enterprise-governance": [["operation_permission.catalog"],
    ["operation-permission-authorization", "observability-alerts-reporting"],
    ["observability.semantic-baseline"], ["lico.observability.semantics"]],
  "console-administration": [["system.console_state"], ["console-administration"],
    ["console.administration-coverage"], ["lico.console.administration-coverage-report"]],
  "container-deployment": [[], ["container-deployment-resumability"],
    ["container.deployment-flow"], ["lico.deployment.container-flow-report"]],
  storage: [["storage.summary"], ["storage-backup-runtime"], ["storage.backup-restore"],
    ["lico.storage.production-restore-drill-report"]],
  jobs: [["jobs.list"], ["jobs-work-queue-runtime"], ["jobs.work-queue"],
    ["lico.workflow.job-work-queue-report"]],
  "external-plugin-packaging-loading": [[], ["plugin-runtime-and-module-system"],
    ["release.acceptance-unit"],
    ["lico.state-machine.capability-acceptance-plugin-runtime-and-module-system"]],
  "agent-gateway-model-routing": [["agent_gateway.call"], ["agent-gateway-model-routing"],
    ["agent-gateway.runtime", "model-routing.runtime"], ["lico.strategy.model-routing"]],
  "core-workspace-assets-governance": [["workspace.file.list"], ["core-workspace-assets-governance"],
    ["workspace-asset-management.runtime", "workspace-governance.runtime"],
    ["lico.workspace.asset-registry"]],
});

export class BetterPlanValidationError extends Error {
  constructor(report) {
    super("Better Plan validation failed closed.");
    this.name = "BetterPlanValidationError";
    this.code = "invalid_plan_authority";
    this.report = report;
  }
}

function repoPath(repoRoot, relativePath) {
  return path.join(repoRoot, relativePath);
}

async function exists(repoRoot, relativePath) {
  try {
    await fs.access(repoPath(repoRoot, relativePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(repoRoot, relativePath) {
  return JSON.parse(await fs.readFile(repoPath(repoRoot, relativePath), "utf8"));
}

async function defaultReadRepositoryFile(relativePath, repoRoot) {
  return fs.readFile(repoPath(repoRoot, relativePath), "utf8");
}

function parseRepositoryJson(text) {
  return JSON.parse(text);
}

function versionIdentities(artifact) {
  return [artifact?.artifactId, artifact?.activeVersion,
    ...(artifact?.versions ?? []).flatMap((version) => [
      version?.version, version?.ref,
      ...(version?.artifactRefs ?? []).flatMap((reference) =>
        [reference?.artifactId, reference?.version]),
      ...(version?.evidenceRefs ?? []).flatMap((reference) =>
        [reference?.evidenceId, reference?.uri]),
    ]),
  ].filter((identity) => typeof identity === "string" && identity.length > 0);
}

function textContainsIdentity(text, identity) {
  return typeof text === "string" && text.includes(JSON.stringify(identity));
}

function authorityTextContainsIdentity(texts, identity) {
  return texts.some((text) => textContainsIdentity(text, identity));
}

function checkpointForSelector(checkpoints, selector) {
  return checkpoints.find((checkpoint) =>
    checkpoint?.id === selector || checkpoint?.requirements?.includes(selector));
}

function safeResult(result) {
  if (!result || result.schema_version !== VALIDATION_SCHEMA || typeof result.checks !== "object") return null;
  const checks = Object.fromEntries(CHECK_NAMES.map((name) => [name, result.checks[name] === true]));
  if (CHECK_NAMES.some((name) => typeof result.checks[name] !== "boolean")) return null;
  return { schema_version: VALIDATION_SCHEMA, accepted: result.accepted === true, checks };
}

function checksAccepted(checks) {
  return CHECK_NAMES.every((name) => checks[name] === true);
}

function assertReportSafe(report) {
  assertNoSensitiveLeak(report, "Better Plan validation report");
  const text = JSON.stringify(report);
  if (/\/Users\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\/u.test(text)) {
    throw new Error("Better Plan validation report contains a local path.");
  }
}

async function factAuthorityAccepted(repoRoot) {
  const registry = await readJson(repoRoot, FACT_SOURCE_AUTHORITY_REGISTRY).catch(() => null);
  if (!registry || !["singleAuthority", "uniqueFactKeys", "projectionOnlyReports", "noDocumentOverrides"]
    .every((key) => registry?.policy?.[key] === true)) return false;
  const observed = new Map((registry.authorities ?? []).map((entry) => [entry.factKey, entry.authorityPath]));
  return Object.entries(REQUIRED_FACT_AUTHORITY_KEYS).every(([key, owner]) => observed.get(key) === owner);
}

async function organizationClosure({ repoRoot, matrix, readRepositoryFile, enumeratePublicSourceRoots }) {
  const [acceptanceText, testsText, versionText, operationAuthorityTexts, generatedOperationsText,
    generatedCapabilitiesText] = await Promise.all([
    readRepositoryFile(ACCEPTANCE_REGISTRY_PATH),
    readRepositoryFile(TESTS_REGISTRY_PATH),
    readRepositoryFile(VERSION_REGISTRY_PATH),
    Promise.all(OPERATION_REGISTRY_AUTHORITY_PATHS.map((relativePath) => readRepositoryFile(relativePath))),
    readRepositoryFile(GENERATED_OPERATIONS_PATH),
    readRepositoryFile(GENERATED_CAPABILITIES_PATH),
  ]);
  const acceptance = parseRepositoryJson(acceptanceText);
  const tests = parseRepositoryJson(testsText);
  const version = parseRepositoryJson(versionText);
  const operationText = operationAuthorityTexts[0] ?? "";
  const acceptanceByCapability = new Map((acceptance.entries ?? [])
    .map((entry) => [entry.capabilityId, entry.acceptanceMachineId]));
  const sourceFacts = [];
  const planFacts = [];
  const registries = [];

  for (const [capability, owner] of Object.entries(ORGANIZATION_ROOT_FACTS)) {
    const [layer, codeOwner, documentOwner, planOwner, planNode, verifier, acceptanceCapability] = owner;
    sourceFacts.push({
      capability,
      layer,
      code_owner: codeOwner,
      document_owner: [documentOwner],
      verifier_identities: [verifier],
      acceptance_machine_identity: [acceptanceByCapability.get(acceptanceCapability)].filter(Boolean),
      required_registry_identities: [CAPABILITY_MATRIX_PATH],
      platform: "any",
      repository: ".git",
      source_digest: `${matrix.schemaVersion}:${capability}`,
    });
    const checkpoints = parseRepositoryJson(await readRepositoryFile(`${planOwner}/Checkpoints.json`));
    const checkpoint = checkpointForSelector(checkpoints, planNode);
    planFacts.push(checkpoint
      ? { capability, plan_owner: planOwner, plan_node: checkpoint.id }
      : { capability, plan_node: planNode });
    registries.push({ capability, registry_identities: [CAPABILITY_MATRIX_PATH] });
  }

  for (const entry of matrix.capabilities ?? []) {
    const owner = CAPABILITY_OWNERS[entry.id];
    if (!owner) continue;
    const [layer, codeOwner, planOwner, planNode, acceptanceCapability] = owner;
    const acceptanceCapabilities = Array.isArray(acceptanceCapability)
      ? acceptanceCapability : [acceptanceCapability];
    const contract = CAPABILITY_REGISTRY_CONTRACTS[entry.id];
    const [operationIds = [], acceptanceIds = [], testSuiteIds = [], versionArtifactIds = [],
      pinnedRegistryIdentities = []] = contract ?? [];
    const requiredRegistryIdentities = [
      `${CAPABILITY_MATRIX_PATH}#${entry.id}`,
      `${OPERATION_REGISTRY_PATH}#SERVER_API_OPERATIONS`,
      ...operationIds.map((id) => `${OPERATION_REGISTRY_PATH}#${id}`),
      ...acceptanceIds.map((id) => `${ACCEPTANCE_REGISTRY_PATH}#${id}`),
      ...testSuiteIds.map((id) => `${TESTS_REGISTRY_PATH}#${id}`),
      ...versionArtifactIds.flatMap((artifactId) => {
        const artifact = (version.artifacts ?? []).find((candidate) => candidate?.artifactId === artifactId);
        return artifact ? [`${VERSION_REGISTRY_PATH}#${artifactId}`, ...versionIdentities(artifact)] :
          [`${VERSION_REGISTRY_PATH}#${artifactId}`];
      }),
      ...pinnedRegistryIdentities,
      `${GENERATED_OPERATIONS_PATH}#SERVER_API_OPERATIONS`,
      ...operationIds.map((id) => `${GENERATED_OPERATIONS_PATH}#${id}`),
      `${GENERATED_CAPABILITIES_PATH}#KERNEL_API_OPERATION_IDS`,
      ...operationIds.map((id) => `${GENERATED_CAPABILITIES_PATH}#cap:api:${id}`),
    ];
    const observedVersionIdentities = versionArtifactIds.flatMap((artifactId) => {
      const artifact = (version.artifacts ?? []).find((candidate) => candidate?.artifactId === artifactId);
      return artifact ? [`${VERSION_REGISTRY_PATH}#${artifactId}`, ...versionIdentities(artifact)] : [];
    });
    const observedRegistryIdentities = [
      `${CAPABILITY_MATRIX_PATH}#${entry.id}`,
      ...(operationText.includes("SERVER_API_OPERATIONS") ?
        [`${OPERATION_REGISTRY_PATH}#SERVER_API_OPERATIONS`] : []),
      ...operationIds.filter((id) => authorityTextContainsIdentity(operationAuthorityTexts, id))
        .map((id) => `${OPERATION_REGISTRY_PATH}#${id}`),
      ...acceptanceIds.filter((id) => (acceptance.entries ?? [])
        .some((candidate) => candidate?.capabilityId === id))
        .map((id) => `${ACCEPTANCE_REGISTRY_PATH}#${id}`),
      ...testSuiteIds.filter((id) => (tests.suites ?? []).some((candidate) => candidate?.id === id))
        .map((id) => `${TESTS_REGISTRY_PATH}#${id}`),
      ...observedVersionIdentities,
      ...pinnedRegistryIdentities.filter((identity) =>
        observedVersionIdentities.includes(identity)
        || observedVersionIdentities.includes(`${VERSION_REGISTRY_PATH}#${identity}`)
        || textContainsIdentity(versionText, identity)),
      ...(generatedOperationsText.includes("SERVER_API_OPERATIONS") ?
        [`${GENERATED_OPERATIONS_PATH}#SERVER_API_OPERATIONS`] : []),
      ...operationIds.filter((id) => textContainsIdentity(generatedOperationsText, id))
        .map((id) => `${GENERATED_OPERATIONS_PATH}#${id}`),
      ...(generatedCapabilitiesText.includes("KERNEL_API_OPERATION_IDS") ?
        [`${GENERATED_CAPABILITIES_PATH}#KERNEL_API_OPERATION_IDS`] : []),
      ...operationIds.filter((id) => textContainsIdentity(generatedCapabilitiesText, `cap:api:${id}`))
        .map((id) => `${GENERATED_CAPABILITIES_PATH}#cap:api:${id}`),
    ];
    sourceFacts.push({
      capability: entry.id,
      layer,
      code_owner: codeOwner,
      document_owner: entry.docs,
      verifier_identities: entry.verifierScripts,
      acceptance_machine_identity: acceptanceCapabilities
        .map((capability) => acceptanceByCapability.get(capability))
        .filter(Boolean),
      required_registry_identities: requiredRegistryIdentities,
      platform: "any",
      repository: ".git",
      source_digest: `${matrix.schemaVersion}:${entry.id}`,
    });
    const checkpoints = await readRepositoryFile(`${planOwner}/Checkpoints.json`)
      .then(parseRepositoryJson).catch(() => []);
    const checkpoint = checkpointForSelector(checkpoints, planNode);
    planFacts.push(checkpoint
      ? { capability: entry.id, plan_owner: planOwner, plan_node: checkpoint.id }
      : { capability: entry.id, plan_node: planNode });
    registries.push({
      capability: entry.id,
      registry_identities: [...new Set(observedRegistryIdentities)],
    });
  }
  const discoveredSourceRoots = await enumeratePublicSourceRoots({ repoRoot });
  sourceFacts.push(...(Array.isArray(discoveredSourceRoots) ? discoveredSourceRoots : []));
  return verifyOrganizationClosure(sourceFacts, planFacts, registries);
}

async function defaultEnumeratePublicSourceRoots() {
  return [];
}

async function defaultCustomValidator({ repoRoot, readRepositoryFile, enumeratePublicSourceRoots }) {
  const matrix = parseRepositoryJson(await readRepositoryFile(CAPABILITY_MATRIX_PATH));
  const entries = Array.isArray(matrix.capabilities) ? matrix.capabilities : [];
  const ids = entries.map((entry) => entry.id);
  const uniqueIds = new Set(ids);
  const closure = await organizationClosure({ repoRoot, matrix, readRepositoryFile,
    enumeratePublicSourceRoots });
  const sourcePaths = entries.flatMap((entry) => [
    CAPABILITY_OWNERS[entry.id]?.[1], ...(entry.docs ?? []), ...(entry.verifierScripts ?? []),
  ]).filter(Boolean);
  const checks = {
    schema: matrix?.schemaVersion === "v0.0.1:registry:open-platform-capability-matrix-1" &&
      ids.length > 0 && uniqueIds.size === ids.length,
    source: (await Promise.all([...REQUIRED_PUBLIC_DOCS, ...sourcePaths]
      .map((relativePath) => exists(repoRoot, relativePath)))).every(Boolean) && await factAuthorityAccepted(repoRoot),
    label: entries.every((entry) => Array.isArray(entry.requirementRows) && entry.requirementRows.length > 0),
    graph: closure.accepted && [...REQUIRED_RECOVERED_CAPABILITIES].every((id) => uniqueIds.has(id)),
    privacy: true,
  };
  return { schema_version: VALIDATION_SCHEMA, accepted: checksAccepted(checks), checks, closure };
}

async function defaultCanonicalValidator({ repoRoot, writeReport = false, requireCompletedReceipts = true }) {
  const workspace = await validateCanonicalBetterPlanWorkspace({ repoRoot });
  let graphAccepted = false;
  try {
    await verifyEndToEndReleasePlan({ repoRoot, writeReport, requireCompletedReceipts });
    graphAccepted = true;
  } catch {
    graphAccepted = false;
  }
  const checks = {
    ...workspace.checks,
    graph: workspace.checks.graph && graphAccepted,
  };
  return {
    schema_version: VALIDATION_SCHEMA,
    accepted: Object.values(checks).every(Boolean),
    checks,
  };
}

async function defaultReadLocalInfoHygieneReport(relativePath, repoRoot) {
  return readJson(repoRoot, relativePath).catch(() => null);
}

function localInfoHygieneAccepted(report, now, maxAgeMs) {
  const generatedAt = Date.parse(report?.generatedAt ?? "");
  return report?.schemaVersion === LOCAL_INFO_HYGIENE_SCHEMA &&
    report?.verifier === "tools/config-scanner.mjs" &&
    report?.sourceOfTruth === "tools/config-scanner.mjs#repo-local-info-hygiene" &&
    Array.isArray(report?.findings) && report.findings.length === 0 &&
    report?.summary?.warningCount === 0 && report?.summary?.highRiskCount === 0 &&
    report?.summary?.releaseReady === true && report?.summary?.reportLeakScan === true &&
    Number.isFinite(generatedAt) && generatedAt <= now && now - generatedAt <= maxAgeMs;
}

async function atomicWriteJson(repoRoot, relativePath, report) {
  const target = repoPath(repoRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function verifyBetterPlan(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const readRepositoryFile = options.readRepositoryFile ??
    ((relativePath) => defaultReadRepositoryFile(relativePath, repoRoot));
  const enumeratePublicSourceRoots = options.enumeratePublicSourceRoots ?? defaultEnumeratePublicSourceRoots;
  const customValidator = options.customValidator ?? defaultCustomValidator;
  const canonicalValidator = options.canonicalValidator ?? defaultCanonicalValidator;
  const readLocalInfoHygieneReport = options.readLocalInfoHygieneReport ??
    ((relativePath) => defaultReadLocalInfoHygieneReport(relativePath, repoRoot));
  const now = options.now ?? Date.now;
  const maxAgeMs = options.localInfoHygieneMaxAgeMs ?? DEFAULT_LOCAL_INFO_HYGIENE_MAX_AGE_MS;
  const requireCompletedReceipts = options.requireCompletedReceipts !== false;
  const observedNow = Number(now());

  const outcomes = await Promise.allSettled([
    customValidator({ repoRoot, writeReport: false, requireCompletedReceipts,
      readRepositoryFile, enumeratePublicSourceRoots }),
    canonicalValidator({ repoRoot, writeReport: false, requireCompletedReceipts }),
    readLocalInfoHygieneReport(LOCAL_INFO_HYGIENE_REPORT_PATH),
  ]);
  const rawCustom = outcomes[0].status === "fulfilled" ? outcomes[0].value : null;
  const rawCanonical = outcomes[1].status === "fulfilled" ? outcomes[1].value : null;
  const hygiene = outcomes[2].status === "fulfilled" ? outcomes[2].value : null;
  const custom = safeResult(rawCustom);
  const canonical = safeResult(rawCanonical);
  const privacyAccepted = localInfoHygieneAccepted(hygiene, observedNow, maxAgeMs);
  const agreement = custom !== null && canonical !== null &&
    custom.accepted === canonical.accepted &&
    CHECK_NAMES.every((name) => custom.checks[name] === canonical.checks[name]);
  const accepted = agreement && custom.accepted && canonical.accepted &&
    checksAccepted(custom.checks) && checksAccepted(canonical.checks) && privacyAccepted;
  const report = {
    schemaVersion: REPORT_SCHEMA,
    schema_version: VALIDATION_SCHEMA,
    generatedAt: new Date(observedNow).toISOString(),
    verifier: "tools/server-scripts/verify-better-plan.mjs",
    sourceOfTruth: "tools/server-scripts/verify-better-plan.mjs#workspace-validation",
    accepted,
    checks: Object.fromEntries(CHECK_NAMES.map((name) => [name,
      Boolean(custom?.checks?.[name] && canonical?.checks?.[name] &&
        custom.checks[name] === canonical.checks[name] && (name !== "privacy" || privacyAccepted)),
    ])),
    agreement,
    organization_closure: rawCustom?.closure && typeof rawCustom.closure === "object"
      ? rawCustom.closure : null,
    local_info_hygiene: privacyAccepted ? "accepted" : "rejected",
    summary: { releaseReady: accepted, reportLeakScan: true },
  };
  assertReportSafe(report);
  if (options.publishReport === true) await atomicWriteJson(repoRoot, options.reportPath ?? REPORT_PATH, report);
  if (!accepted) throw new BetterPlanValidationError(report);
  return report;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length > 0) throw new Error("Better Plan verifier received unsupported arguments.");
  await verifyBetterPlan({ publishReport: true });
  process.stdout.write("[better-plan] ok\n");
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`[better-plan] ${error?.code === "invalid_plan_authority" ? error.code : "verification_failed"}\n`);
    process.exitCode = 1;
  });
}
