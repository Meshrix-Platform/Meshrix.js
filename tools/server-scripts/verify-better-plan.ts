#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyEndToEndReleasePlan } from "../plan/verify-end-to-end-release-plan.ts";
import { verifyOrganizationClosure } from "../plan/verify-organization-closure.ts";
import { assertNoLeak as assertNoSensitiveLeak } from "./lib/report-evidence-safety.ts";

const modulePath: any = fileURLToPath(import.meta.url);
const defaultRepoRoot: any = path.resolve(path.dirname(modulePath), "../..");
const REPORT_PATH: any = "build/reports/better-plan.json";
const LOCAL_INFO_HYGIENE_REPORT_PATH: any = "build/reports/local-info-hygiene.json";
const LOCAL_INFO_HYGIENE_SCHEMA: any = "v0.0.1:repository:local-info-hygiene-report-0.0.2";
const DEFAULT_LOCAL_INFO_HYGIENE_MAX_AGE_MS: any = 24 * 60 * 60 * 1000;
const VALIDATION_SCHEMA: any = "v0.0.1:meshrix:better-plan-validation-1";
const REPORT_SCHEMA: any = "v0.0.1:release:public-source-boundary-verifier-1";
const CHECK_NAMES: readonly any[] = Object.freeze(["schema", "source", "label", "graph", "privacy"]);
const REQUIRED_RECOVERED_CAPABILITIES: any = new Set<any>([
  "external-plugin-packaging-loading",
  "model-gateway-service",
  "core-workspace-assets-governance",
]);
// Pinned Strategy evidence identities must remain present even when Version Registry
// nested strings are rewritten; dynamic expansion alone cannot detect that mutation.
const STRATEGY_VERSION_REGISTRY_IDENTITIES: readonly any[] = Object.freeze([
  "meshrix.strategy.strategy-management-browser-report",
  "v0.0.1:schema:strategy-management-browser-report-1",
  "meshrix.strategy.strategy-management-browser-report@v0.0.1:schema:strategy-management-browser-report-1",
  "v0-0-1-schema-strategy-management-browser-report-1-verifier",
  "tools/server-scripts/verify-strategy-management-browser.ts",
  "meshrix.strategy.strategy-management-verification-report",
  "v0.0.1:strategy-management:verification-report-1",
  "meshrix.strategy.strategy-management-verification-report@v0.0.1:strategy-management:verification-report-1",
  "v0-0-1-strategy-management-verification-report-1-validator",
  "tools/server-scripts/lib/required-report-validator.ts",
  "v0-0-1-strategy-management-verification-report-1-verifier",
  "tools/server-scripts/verify-strategy-management.ts",
]);
const CAPABILITY_MATRIX_PATH: any = "tools/registry/internal-platform-capability-matrix.json";
const ACCEPTANCE_REGISTRY_PATH: any = "tools/registry/capability-acceptance.registry.json";
const TESTS_REGISTRY_PATH: any = "tools/registry/tests.registry.json";
const VERSION_REGISTRY_PATH: any = "packages/foundation/src/version-control/version-registry.json";
const OPERATION_REGISTRY_PATH: any = "packages/contracts/src/operations/operation-registry.ts";
// Operation IDs are authored in composed definition modules and only aggregated by the
// operation-registry barrel. Observe the full authority set so registry edges stay current.
const OPERATION_REGISTRY_AUTHORITY_PATHS: readonly any[] = Object.freeze([
  OPERATION_REGISTRY_PATH,
  "packages/contracts/src/operations/operation-registry-governed-definitions.ts",
  "packages/contracts/src/operations/protocol-operation-definitions.ts",
  "packages/contracts/src/operations/authorization-contribution-operation-definitions.ts",
  "packages/contracts/src/operations/workspace-asset-operation-definitions.ts",
  "packages/contracts/src/operations/platform-console-operation-definitions.ts",
  "packages/contracts/src/operations/identity-runtime-operation-definitions.ts",
  "packages/contracts/src/operations/strategy-permission-operation-definitions.ts",
  "packages/contracts/src/operations/permission-observability-operation-definitions.ts",
  "packages/contracts/src/operations/storage-workspace-operation-definitions.ts",
  "packages/contracts/src/operations/agent-session-operation-definitions.ts",
  "packages/contracts/src/operations/workspace-context-operation-definitions.ts",
  "packages/contracts/src/operations/context-job-operation-definitions.ts",
]);
const GENERATED_OPERATIONS_PATH: any = "packages/contracts/src/generated/operations.generated.ts";
const GENERATED_CAPABILITIES_PATH: any =
  "packages/foundation/src/security/authorization/generated-capabilities.ts";

const REQUIRED_PUBLIC_DOCS: readonly any[] = Object.freeze([
  "README.md", "README.zh-CN.md", "docs/README.md", "docs/RUNBOOK.md", "docs/examples/README.md",
  "docs/COMPATIBILITY.md", "docs/architecture/ARCHITECTURE.md",
  "docs/architecture/EXECUTION-SANDBOX.md", "docs/protocols/PROTOCOLS.md",
  "docs/functionality/GATEWAY.md",
  "docs/functionality/OPERATION-PERMISSION.md", "docs/functionality/SECURITY-AUTHORIZATION.md",
  "docs/functionality/SERVER-RUNTIME.md",
  "docs/functionality/WORKSPACE-ASSETS.md", "docs/architecture/STATE-MACHINES.md",
]);

const FACT_SOURCE_AUTHORITY_REGISTRY: any = "tools/registry/fact-source-authority.registry.json";
const REQUIRED_FACT_AUTHORITY_KEYS: Readonly<Record<string, any>> = Object.freeze({
  "server.operations": "packages/contracts/src/operations/operation-registry.ts",
  "release.readiness-reduction": "tools/server-scripts/lib/release-evidence-readiness.ts",
  "platform.acceptance-workflow": "tools/server-scripts/verify-platform-acceptance.ts",
  "private-deployment.internal-platform-e2e-catalog": "tools/server-scripts/lib/platform-acceptance-command-catalog.ts",
  "upstream-fixture.transit-evidence": "tools/server-scripts/lib/upstream-fixture-transit-evidence.ts",
  "downstream-agent.tool-loop-evidence": "tools/server-scripts/lib/downstream-agent-tool-loop-evidence.ts",
  "mcp-client.proxy-transport-evidence": "tools/server-scripts/lib/mcp-proxy-transport-evidence.ts",
  "mcp-release.targets": "packages/protocols/mcp/adapter/mcp-release-targets.ts",
  "composition.source-package": "tools/server-scripts/package-server-source.ts",
  "package-scripts.classification": "tools/scripts/package-script-registry.ts",
  "internal-platform.capability-surface": "tools/registry/internal-platform-capability-matrix.json",
});

const CAPABILITY_OWNERS: Readonly<Record<string, any>> = Object.freeze({
  "upstream-gateway": ["agents-and-protocols", "packages/agents/src/upstream-gateway/index.ts", "docs/plans/end-to-end-release", "REQ-BASELINE-UPSTREAM-GATEWAY", "upstream-service-publishing"],
  "downstream-mcp": ["agents-and-protocols", "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts", "docs/plans/end-to-end-release", "REQ-BASELINE-DOWNSTREAM-MCP", "downstream-mcp-gateway"],
  "strategy-management": ["cross-cutting-governance", "packages/server-runtime/src/composition/strategy-management-provider.ts", "docs/plans/end-to-end-release", "REQ-BASELINE-STRATEGY-MANAGEMENT", "strategy-management"],
  "enterprise-governance": ["foundation", "packages/foundation/src/security/authorization/authorization-engine.ts", "docs/plans/end-to-end-release", "REQ-BASELINE-ENTERPRISE-GOVERNANCE", ["operation-permission-authorization", "observability-alerts-reporting"]],
  "console-administration": ["ui-console", "apps/console/router/admin-route-registry.ts", "docs/plans/end-to-end-release", "REQ-BASELINE-CONSOLE-ADMINISTRATION", "console-administration"],
  "container-deployment": ["deployment-and-operations", "docker-compose.yml", "docs/plans/end-to-end-release", "REQ-BASELINE-CONTAINER-DEPLOYMENT", "container-deployment-resumability"],
  storage: ["domain-capabilities", "packages/foundation/src/storage/storage-provider.ts", "docs/plans/end-to-end-release", "REQ-BASELINE-STORAGE", "storage-backup-runtime"],
  jobs: ["domain-capabilities", "packages/foundation/src/work-queue/worker-runtime.ts", "docs/plans/end-to-end-release", "REQ-BASELINE-JOBS", "jobs-work-queue-runtime"],
  "external-plugin-packaging-loading": ["optional-plugins", "packages/foundation/src/module-system/plugin-runtime.ts", "docs/plans/end-to-end-release", "REQ-BASELINE-EXTERNAL-PLUGIN-PACKAGING-LOADING", "plugin-runtime-and-module-system"],
  "model-gateway-service": ["agents-and-protocols", "services/model-gateway/src/main.mjs", "docs/plans/end-to-end-release", "REQ-MODEL-GATEWAY-BOUNDARY", "model-gateway-service"],
  "core-workspace-assets-governance": ["domain-capabilities", "packages/agents/src/workspace-asset-registry/index.ts", "docs/plans/end-to-end-release", "REQ-BASELINE-CORE-WORKSPACE-ASSETS-GOVERNANCE", "core-workspace-assets-governance"],
});

const ORGANIZATION_ROOT_FACTS: Readonly<Record<string, any>> = Object.freeze({
  "application-entry": ["application-entry", "apps/server/bin/meshrix.ts",
    "docs/functionality/SERVER-RUNTIME.md", "docs/plans/end-to-end-release",
    "REQ-REL-BASELINE", "tools/server-scripts/verify-composition-source.ts",
    "state-machine-governance"],
  "server-runtime-composition": ["runtime-composition", "packages/server-runtime/src/composition/index.ts",
    "docs/functionality/SERVER-RUNTIME.md", "docs/plans/end-to-end-release",
    "REQ-REL-BASELINE", "tools/server-scripts/verify-composition-source.ts",
    "state-machine-governance"],
  "public-contracts": ["contracts", OPERATION_REGISTRY_PATH, "docs/protocols/PROTOCOLS.md",
    "docs/plans/end-to-end-release", "REQ-REL-BASELINE",
    "tools/server-scripts/verify-operation-permission-protocol-consistency.ts",
    "operation-permission-authorization"],
});

const CAPABILITY_REGISTRY_CONTRACTS: Readonly<Record<string, any>> = Object.freeze({
  "upstream-gateway": [["gateway.forward"], ["upstream-service-publishing"],
    ["upstream-gateway.e2e"], ["meshrix.upstream-gateway.e2e-report"]],
  "downstream-mcp": [["operation_permission.catalog"], ["downstream-mcp-gateway"],
    ["downstream-mcp.completeness-audit"], ["meshrix.mcp.downstream-completeness-audit"]],
  "strategy-management": [["strategy.describe"], ["strategy-management"],
    ["strategy-management.runtime"], ["meshrix.strategy.strategy-management-browser-report",
      "meshrix.strategy.strategy-management-verification-report"],
    STRATEGY_VERSION_REGISTRY_IDENTITIES],
  "enterprise-governance": [["operation_permission.catalog"],
    ["operation-permission-authorization", "observability-alerts-reporting"],
    ["observability.semantic-baseline"], ["meshrix.observability.semantics"]],
  "console-administration": [["system.console_state"], ["console-administration"],
    ["console.administration-coverage"], ["meshrix.console.administration-coverage-report"]],
  "container-deployment": [[], ["container-deployment-resumability"],
    ["container.deployment-flow"], ["meshrix.deployment.container-flow-report"]],
  storage: [["storage.summary"], ["storage-backup-runtime"], ["storage.backup-restore"],
    ["meshrix.storage.production-restore-drill-report"]],
  jobs: [["jobs.list"], ["jobs-work-queue-runtime"], ["jobs.work-queue"],
    ["meshrix.workflow.job-work-queue-report"]],
  "external-plugin-packaging-loading": [[], ["plugin-runtime-and-module-system"],
    ["release.acceptance-unit"],
    ["meshrix.state-machine.capability-acceptance-plugin-runtime-and-module-system"]],
  "model-gateway-service": [[], ["model-gateway-service"], [], []],
  "core-workspace-assets-governance": [["workspace.file.list"], ["core-workspace-assets-governance"],
    ["workspace-asset-management.runtime", "workspace-governance.runtime"],
    ["meshrix.workspace.asset-registry"]],
});

export class BetterPlanValidationError extends Error {
  code: any;
  name: any;
  report: any;
  constructor(report?: any) {
    super("Better Plan validation failed closed.");
    this.name = "BetterPlanValidationError";
    this.code = "invalid_plan_authority";
    this.report = report;
  }
}

function repoPath(repoRoot?: any, relativePath?: any) : any {
  return path.join(repoRoot, relativePath);
}

async function exists(repoRoot?: any, relativePath?: any) : Promise<any> {
  try {
    await fs.access(repoPath(repoRoot, relativePath));
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(repoRoot?: any, relativePath?: any) : Promise<any> {
  return JSON.parse(await fs.readFile(repoPath(repoRoot, relativePath), "utf8"));
}

async function defaultReadRepositoryFile(relativePath?: any, repoRoot?: any) : Promise<any> {
  return fs.readFile(repoPath(repoRoot, relativePath), "utf8");
}

function parseRepositoryJson(text?: any) : any {
  return JSON.parse(text);
}

function versionIdentities(artifact?: any) : any {
  return [artifact?.artifactId, artifact?.activeVersion,
    ...(artifact?.versions ?? []).flatMap((version?: any) : any => [
      version?.version, version?.ref,
      ...(version?.artifactRefs ?? []).flatMap((reference?: any) : any =>
        [reference?.artifactId, reference?.version]),
      ...(version?.evidenceRefs ?? []).flatMap((reference?: any) : any =>
        [reference?.evidenceId, reference?.uri]),
    ]),
  ].filter((identity?: any) : any => typeof identity === "string" && identity.length > 0);
}

function textContainsIdentity(text?: any, identity?: any) : any {
  return typeof text === "string" && text.includes(JSON.stringify(identity));
}

function authorityTextContainsIdentity(texts?: any, identity?: any) : any {
  return texts.some((text?: any) : any => textContainsIdentity(text, identity));
}

function checkpointForSelector(checkpoints?: any, selector?: any) : any {
  return checkpoints.find((checkpoint?: any) : any =>
    checkpoint?.id === selector || checkpoint?.requirements?.includes(selector));
}

function safeResult(result?: any) : any {
  if (!result || result.schema_version !== VALIDATION_SCHEMA || typeof result.checks !== "object") return null;
  const checks: any = Object.fromEntries(CHECK_NAMES.map((name?: any) : any => [name, result.checks[name] === true]));
  if (CHECK_NAMES.some((name?: any) : any => typeof result.checks[name] !== "boolean")) return null;
  return { schema_version: VALIDATION_SCHEMA, accepted: result.accepted === true, checks };
}

function checksAccepted(checks?: any) : any {
  return CHECK_NAMES.every((name?: any) : any => checks[name] === true);
}

function normalizedOwnedPath(value?: any) : any {
  return String(value || "").replace(/\\/gu, "/").replace(/\/+$/u, "");
}

function ownedPathsOverlap(left?: any, right?: any) : any {
  const leftPath: any = normalizedOwnedPath(left);
  const rightPath: any = normalizedOwnedPath(right);
  return leftPath.length > 0 && rightPath.length > 0 &&
    (leftPath === rightPath || leftPath.startsWith(`${rightPath}/`) || rightPath.startsWith(`${leftPath}/`));
}

function mutuallyDisjointOwnedPaths(nodes?: any[]) : any {
  const observed: any[] = [];
  for (const node of nodes ?? []) {
    const owned: any[] = node?.design?.owned_paths;
    const acceptance: any[] = node?.design?.acceptance_paths;
    if (!Array.isArray(owned) || owned.length === 0 || !Array.isArray(acceptance) || acceptance.length === 0) {
      return false;
    }
    for (const ownedPath of [...owned, ...acceptance]) {
      if (observed.some((entry?: any) : any => ownedPathsOverlap(entry.path, ownedPath))) return false;
      observed.push({ node: node.id, path: ownedPath });
    }
  }
  return true;
}

function sameReferences(actual?: any, expected: any[] = []) : any {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const normalizedActual: any[] = [...actual].sort();
  const normalizedExpected: any[] = [...expected].sort();
  return normalizedActual.every(
    (value?: any, index?: any) : any => value === normalizedExpected[index],
  );
}

function assertReportSafe(report?: any) : any {
  assertNoSensitiveLeak(report, "Better Plan validation report");
  const text: any = JSON.stringify(report);
  if (/\/Users\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\/u.test(text)) {
    throw new Error("Better Plan validation report contains a local path.");
  }
}

async function factAuthorityAccepted(repoRoot?: any) : Promise<any> {
  const registry: any = await readJson(repoRoot, FACT_SOURCE_AUTHORITY_REGISTRY).catch(() : any => null);
  if (!registry || !["singleAuthority", "uniqueFactKeys", "projectionOnlyReports", "noDocumentOverrides"]
    .every((key?: any) : any => registry?.policy?.[key] === true)) return false;
  const observed: any = new Map<any, any>((registry.authorities ?? []).map((entry?: any) : any => [entry.factKey, entry.authorityPath]));
  return (Object.entries(REQUIRED_FACT_AUTHORITY_KEYS) as [string, any][]).every(([key, owner]: any[]) : any => observed.get(key) === owner);
}

async function organizationClosure({ repoRoot, matrix, readRepositoryFile, enumeratePublicSourceRoots }: Record<string, any>) : Promise<any> {
  const [acceptanceText, testsText, versionText, operationAuthorityTexts, generatedOperationsText,
    generatedCapabilitiesText] = await Promise.all([
    readRepositoryFile(ACCEPTANCE_REGISTRY_PATH),
    readRepositoryFile(TESTS_REGISTRY_PATH),
    readRepositoryFile(VERSION_REGISTRY_PATH),
    Promise.all(OPERATION_REGISTRY_AUTHORITY_PATHS.map((relativePath?: any) : any => readRepositoryFile(relativePath))),
    readRepositoryFile(GENERATED_OPERATIONS_PATH),
    readRepositoryFile(GENERATED_CAPABILITIES_PATH),
  ]);
  const acceptance: any = parseRepositoryJson(acceptanceText);
  const tests: any = parseRepositoryJson(testsText);
  const version: any = parseRepositoryJson(versionText);
  const operationText: any = operationAuthorityTexts[0] ?? "";
  const acceptanceByCapability: any = new Map<any, any>((acceptance.entries ?? [])
    .map((entry?: any) : any => [entry.capabilityId, entry.acceptanceMachineId]));
  const sourceFacts: any[] = [];
  const planFacts: any[] = [];
  const registries: any[] = [];

  for (const [capability, owner] of (Object.entries(ORGANIZATION_ROOT_FACTS) as [string, any][])) {
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
    const checkpoints: any = parseRepositoryJson(await readRepositoryFile(`${planOwner}/Checkpoints.json`));
    const checkpoint: any = checkpointForSelector(checkpoints, planNode);
    planFacts.push(checkpoint
      ? { capability, plan_owner: planOwner, plan_node: checkpoint.id }
      : { capability, plan_node: planNode });
    registries.push({ capability, registry_identities: [CAPABILITY_MATRIX_PATH] });
  }

  for (const entry of matrix.capabilities ?? []) {
    const owner: any = CAPABILITY_OWNERS[entry.id];
    if (!owner) continue;
    const [layer, codeOwner, planOwner, planNode, acceptanceCapability] = owner;
    const acceptanceCapabilities: any = Array.isArray(acceptanceCapability)
      ? acceptanceCapability : [acceptanceCapability];
    const contract: any = CAPABILITY_REGISTRY_CONTRACTS[entry.id];
    const [operationIds = [], acceptanceIds = [], testSuiteIds = [], versionArtifactIds = [],
      pinnedRegistryIdentities = []] = contract ?? [];
    const requiredRegistryIdentities: any[] = [
      `${CAPABILITY_MATRIX_PATH}#${entry.id}`,
      `${OPERATION_REGISTRY_PATH}#SERVER_API_OPERATIONS`,
      ...operationIds.map((id?: any) : any => `${OPERATION_REGISTRY_PATH}#${id}`),
      ...acceptanceIds.map((id?: any) : any => `${ACCEPTANCE_REGISTRY_PATH}#${id}`),
      ...testSuiteIds.map((id?: any) : any => `${TESTS_REGISTRY_PATH}#${id}`),
      ...versionArtifactIds.flatMap((artifactId?: any) : any => {
        const artifact: any = (version.artifacts ?? []).find((candidate?: any) : any => candidate?.artifactId === artifactId);
        return artifact ? [`${VERSION_REGISTRY_PATH}#${artifactId}`, ...versionIdentities(artifact)] :
          [`${VERSION_REGISTRY_PATH}#${artifactId}`];
      }),
      ...pinnedRegistryIdentities,
      `${GENERATED_OPERATIONS_PATH}#SERVER_API_OPERATIONS`,
      ...operationIds.map((id?: any) : any => `${GENERATED_OPERATIONS_PATH}#${id}`),
      `${GENERATED_CAPABILITIES_PATH}#KERNEL_API_OPERATION_IDS`,
      ...operationIds.map((id?: any) : any => `${GENERATED_CAPABILITIES_PATH}#cap:api:${id}`),
    ];
    const observedVersionIdentities: any = versionArtifactIds.flatMap((artifactId?: any) : any => {
      const artifact: any = (version.artifacts ?? []).find((candidate?: any) : any => candidate?.artifactId === artifactId);
      return artifact ? [`${VERSION_REGISTRY_PATH}#${artifactId}`, ...versionIdentities(artifact)] : [];
    });
    const observedRegistryIdentities: any[] = [
      `${CAPABILITY_MATRIX_PATH}#${entry.id}`,
      ...(operationText.includes("SERVER_API_OPERATIONS") ?
        [`${OPERATION_REGISTRY_PATH}#SERVER_API_OPERATIONS`] : []),
      ...operationIds.filter((id?: any) : any => authorityTextContainsIdentity(operationAuthorityTexts, id))
        .map((id?: any) : any => `${OPERATION_REGISTRY_PATH}#${id}`),
      ...acceptanceIds.filter((id?: any) : any => (acceptance.entries ?? [])
        .some((candidate?: any) : any => candidate?.capabilityId === id))
        .map((id?: any) : any => `${ACCEPTANCE_REGISTRY_PATH}#${id}`),
      ...testSuiteIds.filter((id?: any) : any => (tests.suites ?? []).some((candidate?: any) : any => candidate?.id === id))
        .map((id?: any) : any => `${TESTS_REGISTRY_PATH}#${id}`),
      ...observedVersionIdentities,
      ...pinnedRegistryIdentities.filter((identity?: any) : any =>
        observedVersionIdentities.includes(identity)
        || observedVersionIdentities.includes(`${VERSION_REGISTRY_PATH}#${identity}`)
        || textContainsIdentity(versionText, identity)),
      ...(generatedOperationsText.includes("SERVER_API_OPERATIONS") ?
        [`${GENERATED_OPERATIONS_PATH}#SERVER_API_OPERATIONS`] : []),
      ...operationIds.filter((id?: any) : any => textContainsIdentity(generatedOperationsText, id))
        .map((id?: any) : any => `${GENERATED_OPERATIONS_PATH}#${id}`),
      ...(generatedCapabilitiesText.includes("KERNEL_API_OPERATION_IDS") ?
        [`${GENERATED_CAPABILITIES_PATH}#KERNEL_API_OPERATION_IDS`] : []),
      ...operationIds.filter((id?: any) : any => textContainsIdentity(generatedCapabilitiesText, `cap:api:${id}`))
        .map((id?: any) : any => `${GENERATED_CAPABILITIES_PATH}#cap:api:${id}`),
    ];
    sourceFacts.push({
      capability: entry.id,
      layer,
      code_owner: codeOwner,
      document_owner: entry.docs,
      verifier_identities: entry.verifierScripts,
      acceptance_machine_identity: acceptanceCapabilities
        .map((capability?: any) : any => acceptanceByCapability.get(capability))
        .filter(Boolean),
      required_registry_identities: requiredRegistryIdentities,
      platform: "any",
      repository: ".git",
      source_digest: `${matrix.schemaVersion}:${entry.id}`,
    });
    const checkpoints: any = await readRepositoryFile(`${planOwner}/Checkpoints.json`)
      .then(parseRepositoryJson).catch(() : any => []);
    const checkpoint: any = checkpointForSelector(checkpoints, planNode);
    planFacts.push(checkpoint
      ? { capability: entry.id, plan_owner: planOwner, plan_node: checkpoint.id }
      : { capability: entry.id, plan_node: planNode });
    registries.push({
      capability: entry.id,
      registry_identities: [...new Set<any>(observedRegistryIdentities)],
    });
  }
  const discoveredSourceRoots: any = await enumeratePublicSourceRoots({ repoRoot });
  sourceFacts.push(...(Array.isArray(discoveredSourceRoots) ? discoveredSourceRoots : []));
  return verifyOrganizationClosure(sourceFacts, planFacts, registries);
}

async function defaultEnumeratePublicSourceRoots() : Promise<any> {
  return [];
}

async function defaultCustomValidator({ repoRoot, readRepositoryFile, enumeratePublicSourceRoots }: Record<string, any>) : Promise<any> {
  const matrix: any = parseRepositoryJson(await readRepositoryFile(CAPABILITY_MATRIX_PATH));
  const entries: any = Array.isArray(matrix.capabilities) ? matrix.capabilities : [];
  const ids: any = entries.map((entry?: any) : any => entry.id);
  const uniqueIds: any = new Set<any>(ids);
  const closure: any = await organizationClosure({ repoRoot, matrix, readRepositoryFile,
    enumeratePublicSourceRoots });
  const sourcePaths: any = entries.flatMap((entry?: any) : any => [
    CAPABILITY_OWNERS[entry.id]?.[1], ...(entry.docs ?? []), ...(entry.verifierScripts ?? []),
  ]).filter(Boolean);
  const checks: Record<string, any> = {
    schema: matrix?.schemaVersion === "v0.0.1:registry:internal-platform-capability-matrix-1" &&
      ids.length > 0 && uniqueIds.size === ids.length,
    source: (await Promise.all([...REQUIRED_PUBLIC_DOCS, ...sourcePaths]
      .map((relativePath?: any) : any => exists(repoRoot, relativePath)))).every(Boolean) && await factAuthorityAccepted(repoRoot),
    label: entries.every((entry?: any) : any => Array.isArray(entry.requirementRows) && entry.requirementRows.length > 0),
    graph: closure.accepted && [...REQUIRED_RECOVERED_CAPABILITIES].every((id?: any) : any => uniqueIds.has(id)),
    privacy: true,
  };
  return { schema_version: VALIDATION_SCHEMA, accepted: checksAccepted(checks), checks, closure };
}

async function defaultCanonicalValidator({ repoRoot, writeReport = false, requireCompletedReceipts = true }: Record<string, any>) : Promise<any> {
  let schemaAccepted: any = false;
  let sourceAccepted: any = false;
  let labelAccepted: any = false;
  try {
    const [manifest, dependencyMap, checkpoints, planText] = await Promise.all([
      readJson(repoRoot, "docs/plans/Manifest.json"),
      readJson(repoRoot, "docs/plans/end-to-end-release/DependencyMap.json"),
      readJson(repoRoot, "docs/plans/end-to-end-release/Checkpoints.json"),
      fs.readFile(repoPath(repoRoot, "docs/plans/end-to-end-release/Plan.md"), "utf8"),
    ]);
    const manifestPlan: any = Array.isArray(manifest) && manifest.length === 1 ? manifest[0] : null;
    const mapPlan: any = dependencyMap?.plans?.length === 1 ? dependencyMap.plans[0] : null;
    schemaAccepted = dependencyMap?.schema_version === 3 &&
      manifestPlan?.directory === "end-to-end-release" &&
      manifestPlan?.checkpoints === "end-to-end-release/Checkpoints.json" &&
      mapPlan?.directory === "end-to-end-release" && mapPlan?.parent === null &&
      Array.isArray(mapPlan?.children) && mapPlan.children.length === 0 &&
      Array.isArray(mapPlan?.prerequisite_receipts) && mapPlan.prerequisite_receipts.length === 0 &&
      Array.isArray(checkpoints) && checkpoints.length === 24;
    sourceAccepted = manifestPlan?.source_files?.length === 2 &&
      manifestPlan.source_files.includes("docs/plans/end-to-end-release/Plan.md") &&
      manifestPlan.source_files.includes("docs/plans/end-to-end-release/DependencyMap.json") &&
      planText.includes("The Shared-Document Model") &&
      planText.includes("Effect Commands") &&
      planText.includes("Mandatory Dual-Gateway Pipeline, Optional Application Stage, Standalone Model Gateway, And Local Maintenance Boundary") &&
      planText.includes("Architecture Reorganization And Real Parallelism") &&
      planText.includes("Capability Acceptance Plan Migration") &&
      planText.includes("model_gateway.call") &&
      planText.includes("services/model-gateway") &&
      planText.includes("default-disabled stateless Meshrix adapter") &&
      planText.includes("Agent MCP fixed Gateway pipeline") &&
      planText.includes("workspace_application") &&
      planText.includes("gateway_transit") &&
      planText.includes("DownstreamGatewayEnvelope") &&
      planText.includes("UpstreamGatewayEnvelope") &&
      planText.includes("`gateway_transit` bypasses every Workspace concept in this section, not either Gateway") &&
      planText.includes("Both traffic models still traverse the mandatory downstream and upstream Gateway layers") &&
      planText.includes("plugins/external-gateway") &&
      planText.includes("Plugin load, activation, reload, disable, uninstall, health change and recovery only affect availability") &&
      planText.includes("Switching downstream does not implicitly switch upstream") &&
      planText.includes("bounded load distribution, rate and concurrency admission, health and circuit handling, overload shedding") &&
      !planText.includes("Workspace application traffic never reaches it") &&
      !planText.includes("gateway_transit traffic only") &&
      !planText.includes("This path never enters GatewayChannelRouter") &&
      planText.includes("only an explicit governed administrator action from the Meshrix Console") &&
      planText.includes("Side-effect-free detachment") &&
      planText.includes("share no process, database, data root, configuration, secret store, ledger, cache, lock, event bus, or lifecycle") &&
      planText.includes("configuration file replaced atomically is the only behavior-control input") &&
      planText.includes("cannot call, schedule, cancel, observe, configure, start, stop, restart") &&
      planText.includes("no maintenance scheduler, queue, configuration, state, status, PID, socket, credential, Host port, process handle or run observation") &&
      planText.includes("three genuinely independent implementation branches") &&
      planText.includes("only necessary join") &&
      planText.includes("at least 60 percent fewer model-visible calls") &&
      planText.includes("at least 70 percent fewer combined model-context and wire bytes");
    const codes: any = checkpoints.map((node?: any) : any => node?.code);
    const nodesByCode: any = new Map<any, any>(checkpoints.map((node?: any) : any => [node?.code, node]));
    const contractNode: any = nodesByCode.get("GATE-CONTRACT");
    const parallelNodes: any[] = ["GATE-MODEL", "GATE-MAINTENANCE", "GATE-EDGE"]
      .map((code?: any) : any => nodesByCode.get(code));
    const canonicalNode: any = nodesByCode.get("GATE-CANONICAL");
    const gatewayFinalNode: any = nodesByCode.get("GATE-FINAL");
    const efficiencyFinalNode: any = nodesByCode.get("EFF-FINAL");
    const thinNodes: any[] = ["DQ-PROVENANCE", "DQ-TYPING", "DQ-FEEDBACK"]
      .map((code?: any) : any => nodesByCode.get(code));
    const remainderNodes: any[] = ["DQ-ACCEPTANCE", "DQ-TYPING-REST", "DQ-FEEDBACK-SCALE"]
      .map((code?: any) : any => nodesByCode.get(code));
    const parallelIds: any[] = parallelNodes.map((node?: any) : any => node?.id);
    const thinIds: any[] = thinNodes.map((node?: any) : any => node?.id);
    const remainderIds: any[] = remainderNodes.map((node?: any) : any => node?.id);
    const pendingDeliveryAndGate: any[] = [
      ...thinNodes,
      contractNode,
      ...parallelNodes,
      canonicalNode,
      ...remainderNodes,
      gatewayFinalNode,
    ].filter((node?: any) : any => node && node.status === "pending");
    const architectureGraphAccepted: any = Boolean(
      efficiencyFinalNode && contractNode && parallelNodes.every(Boolean) && canonicalNode &&
      gatewayFinalNode && thinNodes.every(Boolean) && remainderNodes.every(Boolean) &&
      sameReferences(efficiencyFinalNode.next, thinIds) &&
      thinNodes.every((node?: any) : any =>
        sameReferences(node.prerequisites, [efficiencyFinalNode.id]) &&
        sameReferences(node.next, [contractNode.id])) &&
      sameReferences(contractNode.prerequisites, thinIds) &&
      sameReferences(contractNode.next, parallelIds) &&
      parallelNodes.every((node?: any) : any =>
        sameReferences(node.prerequisites, [contractNode.id]) && sameReferences(node.next, [canonicalNode.id])) &&
      sameReferences(canonicalNode.prerequisites, parallelIds) &&
      sameReferences(canonicalNode.next, remainderIds) &&
      remainderNodes.every((node?: any) : any =>
        sameReferences(node.prerequisites, [canonicalNode.id]) &&
        sameReferences(node.next, [gatewayFinalNode.id])) &&
      sameReferences(gatewayFinalNode.prerequisites, remainderIds) &&
      sameReferences(gatewayFinalNode.next, []) &&
      mutuallyDisjointOwnedPaths(pendingDeliveryAndGate) &&
      mapPlan?.final_validations?.length === 1 &&
      mapPlan.final_validations[0]?.node_id === gatewayFinalNode.id
    );
    const standaloneModelServiceAccepted: any = Boolean(
      contractNode?.commit?.target === "packages/contracts/src/agent-mcp-traffic" &&
      contractNode?.design?.owned_paths?.includes("services/model-gateway/contracts") &&
      contractNode?.design?.owned_paths?.includes("packages/contracts/src/agent-mcp-traffic") &&
      contractNode?.design?.owned_paths?.includes("packages/contracts/src/gateway-transit") &&
      contractNode?.design?.owned_paths?.includes("plugins/agents/meshrix-self-maintenance/contracts") &&
      parallelNodes[0]?.commit?.target === "services/model-gateway" &&
      parallelNodes[0]?.design?.owned_paths?.includes("services/model-gateway/src") &&
      parallelNodes[1]?.commit?.target === "plugins/agents/meshrix-self-maintenance/src" &&
      parallelNodes[1]?.design?.owned_paths?.includes("plugins/agents/meshrix-self-maintenance/src") &&
      parallelNodes[2]?.commit?.target === "plugins/external-gateway" &&
      parallelNodes[2]?.design?.owned_paths?.includes("plugins/external-gateway") &&
      parallelNodes[2]?.description?.includes("registers one downstream and one upstream External Gateway choice") &&
      parallelNodes[2]?.description?.includes("cannot activate its own route") &&
      parallelNodes[2]?.description?.includes("never redirects traffic") &&
      parallelNodes[2]?.description?.includes("usable by both workspace_application and gateway_transit") &&
      parallelNodes[2]?.description?.includes("receives no Workspace reference, Workspace port, or WorkspaceApplicationEnvelope") &&
      canonicalNode?.description?.includes("per-direction selected-channel generation") &&
      canonicalNode?.description?.includes("originating in the Meshrix Console") &&
      canonicalNode?.description?.includes("Build one Core AgentMcpGatewayPipeline") &&
      canonicalNode?.description?.includes("without calling resolveMcpWorkspaceInput") &&
      canonicalNode?.description?.includes("skip either Gateway stage") &&
      canonicalNode?.design?.owned_paths?.includes("plugins/model-gateway") &&
      canonicalNode?.regression?.commands?.includes("npm run server:verify:agent-self-maintenance-boundary") &&
      canonicalNode?.regression?.commands?.includes("npm run server:verify:model-gateway-detachment") &&
      gatewayFinalNode?.regression?.commands?.includes("node tools/server-scripts/verify-model-gateway-service.ts") &&
      gatewayFinalNode?.regression?.commands?.includes("node tools/server-scripts/verify-agent-self-maintenance-runtime.ts") &&
      gatewayFinalNode?.regression?.commands?.includes("npm run server:verify:model-gateway-detachment")
    );
    labelAccepted = new Set<any>(codes).size === checkpoints.length &&
      ["EFF-0", "EFF-7", "EFF-8", "EFF-9", "EFF-10", "EFF-FINAL",
        "DQ-PROVENANCE", "DQ-TYPING", "DQ-FEEDBACK",
        "GATE-CONTRACT", "GATE-MODEL", "GATE-MAINTENANCE",
        "GATE-EDGE", "GATE-CANONICAL",
        "DQ-ACCEPTANCE", "DQ-TYPING-REST", "DQ-FEEDBACK-SCALE", "GATE-FINAL"]
        .every((code?: any) : any => codes.includes(code)) &&
      architectureGraphAccepted &&
      standaloneModelServiceAccepted &&
      checkpoints.every((node?: any) : any =>
        typeof node?.title === "string" && node.title.length > 0 &&
        Array.isArray(node?.requirements) && node.requirements.length > 0 &&
        Array.isArray(node?.acceptance_criteria) && node.acceptance_criteria.length > 0);
  } catch {
    schemaAccepted = false;
    sourceAccepted = false;
    labelAccepted = false;
  }
  let graphAccepted: any = false;
  try {
    await verifyEndToEndReleasePlan({ repoRoot, writeReport, requireCompletedReceipts });
    graphAccepted = true;
  } catch {
    graphAccepted = false;
  }
  const checks: Record<string, any> = {
    schema: schemaAccepted,
    source: sourceAccepted,
    label: labelAccepted,
    graph: graphAccepted,
    privacy: true,
  };
  return {
    schema_version: VALIDATION_SCHEMA,
    accepted: (Object.values(checks) as any[]).every(Boolean),
    checks,
  };
}

async function defaultReadLocalInfoHygieneReport(relativePath?: any, repoRoot?: any) : Promise<any> {
  return readJson(repoRoot, relativePath).catch(() : any => null);
}

function localInfoHygieneAccepted(report?: any, now?: any, maxAgeMs?: any) : any {
  const generatedAt: any = Date.parse(report?.generatedAt ?? "");
  return report?.schemaVersion === LOCAL_INFO_HYGIENE_SCHEMA &&
    report?.verifier === "tools/config-scanner.ts" &&
    report?.sourceOfTruth === "tools/config-scanner.ts#repo-local-info-hygiene" &&
    Array.isArray(report?.findings) && report.findings.length === 0 &&
    report?.summary?.warningCount === 0 && report?.summary?.highRiskCount === 0 &&
    report?.summary?.releaseReady === true && report?.summary?.reportLeakScan === true &&
    Number.isFinite(generatedAt) && generatedAt <= now && now - generatedAt <= maxAgeMs;
}

async function atomicWriteJson(repoRoot?: any, relativePath?: any, report?: any) : Promise<any> {
  const target: any = repoPath(repoRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary: any = `${target}.tmp-${randomUUID()}`;
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

export async function verifyBetterPlan(options: Record<string, any> = {}) : Promise<any> {
  const repoRoot: any = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const readRepositoryFile: any = options.readRepositoryFile ??
    ((relativePath?: any) : any => defaultReadRepositoryFile(relativePath, repoRoot));
  const enumeratePublicSourceRoots: any = options.enumeratePublicSourceRoots ?? defaultEnumeratePublicSourceRoots;
  const customValidator: any = options.customValidator ?? defaultCustomValidator;
  const canonicalValidator: any = options.canonicalValidator ?? defaultCanonicalValidator;
  const readLocalInfoHygieneReport: any = options.readLocalInfoHygieneReport ??
    ((relativePath?: any) : any => defaultReadLocalInfoHygieneReport(relativePath, repoRoot));
  const now: any = options.now ?? Date.now;
  const maxAgeMs: any = options.localInfoHygieneMaxAgeMs ?? DEFAULT_LOCAL_INFO_HYGIENE_MAX_AGE_MS;
  const requireCompletedReceipts: any = options.requireCompletedReceipts !== false;
  const observedNow: any = Number(now());

  const outcomes: any = await Promise.allSettled([
    customValidator({ repoRoot, writeReport: false, requireCompletedReceipts,
      readRepositoryFile, enumeratePublicSourceRoots }),
    canonicalValidator({ repoRoot, writeReport: false, requireCompletedReceipts }),
    readLocalInfoHygieneReport(LOCAL_INFO_HYGIENE_REPORT_PATH),
  ]);
  const rawCustom: any = outcomes[0].status === "fulfilled" ? outcomes[0].value : null;
  const rawCanonical: any = outcomes[1].status === "fulfilled" ? outcomes[1].value : null;
  const hygiene: any = outcomes[2].status === "fulfilled" ? outcomes[2].value : null;
  const custom: any = safeResult(rawCustom);
  const canonical: any = safeResult(rawCanonical);
  const privacyAccepted: any = localInfoHygieneAccepted(hygiene, observedNow, maxAgeMs);
  const agreement: any = custom !== null && canonical !== null &&
    custom.accepted === canonical.accepted &&
    CHECK_NAMES.every((name?: any) : any => custom.checks[name] === canonical.checks[name]);
  const accepted: any = agreement && custom.accepted && canonical.accepted &&
    checksAccepted(custom.checks) && checksAccepted(canonical.checks) && privacyAccepted;
  const report: Record<string, any> = {
    schemaVersion: REPORT_SCHEMA,
    schema_version: VALIDATION_SCHEMA,
    generatedAt: new Date(observedNow).toISOString(),
    verifier: "tools/server-scripts/verify-better-plan.ts",
    sourceOfTruth: "tools/server-scripts/verify-better-plan.ts#workspace-validation",
    accepted,
    checks: Object.fromEntries(CHECK_NAMES.map((name?: any) : any => [name,
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

async function main(argv: any = process.argv.slice(2)) : Promise<any> {
  if (argv.length > 0) throw new Error("Better Plan verifier received unsupported arguments.");
  await verifyBetterPlan({ publishReport: true });
  process.stdout.write("[better-plan] ok\n");
}

const isDirectRun: any = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isDirectRun) {
  main().catch((error?: any) : any => {
    process.stderr.write(`[better-plan] ${error?.code === "invalid_plan_authority" ? error.code : "verification_failed"}\n`);
    process.exitCode = 1;
  });
}
