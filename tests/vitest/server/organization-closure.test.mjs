import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.mjs";
import {
  SERVER_API_OPERATIONS as GENERATED_OPERATIONS,
} from "../../../packages/contracts/src/generated/operations.generated.mjs";
import {
  KERNEL_API_OPERATION_IDS,
} from "../../../packages/foundation/src/security/authorization/generated-capabilities.mjs";
import { verifyOrganizationClosure } from "../../../tools/plan/verify-organization-closure.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
}

const CAPABILITY_MATRIX_PATH = "tools/registry/open-platform-capability-matrix.json";
const VERSION_REGISTRY_PATH = "packages/foundation/src/version-control/version-registry.json";
const ACCEPTANCE_REGISTRY_PATH = "tools/registry/capability-acceptance.registry.json";
const TESTS_REGISTRY_PATH = "tools/registry/tests.registry.json";
const OPERATION_REGISTRY_PATH = "packages/contracts/src/operations/operation-registry.mjs";
const GENERATED_OPERATIONS_PATH = "packages/contracts/src/generated/operations.generated.mjs";
const GENERATED_CAPABILITIES_PATH = "packages/foundation/src/security/authorization/generated-capabilities.mjs";
const capabilityMatrix = readJson(CAPABILITY_MATRIX_PATH);
const versionRegistry = readJson(VERSION_REGISTRY_PATH);
const acceptanceRegistry = readJson(ACCEPTANCE_REGISTRY_PATH);
const testsRegistry = readJson(TESTS_REGISTRY_PATH);

const REQUIRED_RECOVERED_CAPABILITIES = Object.freeze([
  "external-plugin-packaging-loading",
  "agent-gateway-model-routing",
  "core-workspace-assets-governance",
]);
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

const ORGANIZATION_LAYERS = Object.freeze([
  "application-entry",
  "runtime-composition",
  "contracts",
  "foundation",
  "domain-capabilities",
  "agents-and-protocols",
  "optional-plugins",
  "ui-console",
  "deployment-and-operations",
  "cross-cutting-governance",
]);

const ORGANIZATION_ROOT_FACTS = Object.freeze({
  "application-entry": {
    layer: "application-entry",
    code_owner: "apps/server/bin/lico.mjs",
    document_owner: "docs/functionality/SERVER-RUNTIME.md",
    plan_owner: "docs/plans/end-to-end-release",
    plan_node: "10000000-0000-4000-8000-000000000004",
    verifier_identities: ["tools/server-scripts/verify-composition-source.mjs"],
    acceptance_capability: "state-machine-governance",
  },
  "server-runtime-composition": {
    layer: "runtime-composition",
    code_owner: "packages/server-runtime/src/composition/index.mjs",
    document_owner: "docs/functionality/SERVER-RUNTIME.md",
    plan_owner: "docs/plans/end-to-end-release",
    plan_node: "10000000-0000-4000-8000-000000000005",
    verifier_identities: ["tools/server-scripts/verify-composition-source.mjs"],
    acceptance_capability: "state-machine-governance",
  },
  "public-contracts": {
    layer: "contracts",
    code_owner: "packages/contracts/src/operations/operation-registry.mjs",
    document_owner: "docs/protocols/PROTOCOLS.md",
    plan_owner: "docs/plans/end-to-end-release",
    plan_node: "10000000-0000-4000-8000-000000000008",
    verifier_identities: ["tools/server-scripts/verify-operation-permission-protocol-consistency.mjs"],
    acceptance_capability: "operation-permission-authorization",
  },
});

const MATRIX_CAPABILITY_FACTS = Object.freeze({
  "upstream-gateway": {
    layer: "agents-and-protocols",
    code_owner: "packages/agents/src/upstream-gateway/index.mjs",
    plan_owner: "docs/plans/end-to-end-release/gateway-distribution",
    plan_node: "10000000-0000-4000-8000-000000000172",
    acceptance_capabilities: ["upstream-service-publishing"],
  },
  "downstream-mcp": {
    layer: "agents-and-protocols",
    code_owner: "packages/protocols/mcp/adapter/gateway-installer/bin/lico-mcp.mjs",
    plan_owner: "docs/plans/end-to-end-release/gateway-distribution/downstream-mcp",
    plan_node: "10000000-0000-4000-8000-000000000179",
    acceptance_capabilities: ["downstream-mcp-gateway"],
  },
  "strategy-management": {
    layer: "cross-cutting-governance",
    code_owner: "packages/server-runtime/src/composition/strategy-management-provider.mjs",
    plan_owner: "docs/plans/end-to-end-release/operator-administration",
    plan_node: "34000000-0000-4000-8000-000000000030",
    acceptance_capabilities: ["strategy-management"],
  },
  "enterprise-governance": {
    layer: "foundation",
    code_owner: "packages/foundation/src/security/authorization/authorization-engine.mjs",
    plan_owner: "docs/plans/end-to-end-release/platform-foundation/observability-alerts-reporting",
    plan_node: "10000000-0000-4000-8000-000000000091",
    acceptance_capabilities: ["operation-permission-authorization", "observability-alerts-reporting"],
  },
  "console-administration": {
    layer: "ui-console",
    code_owner: "apps/console/router/admin-route-registry.mjs",
    plan_owner: "docs/plans/end-to-end-release/operator-administration/console-administration",
    plan_node: "10000000-0000-4000-8000-000000000289",
    acceptance_capabilities: ["console-administration"],
  },
  "container-deployment": {
    layer: "deployment-and-operations",
    code_owner: "docker-compose.yml",
    plan_owner: "docs/plans/end-to-end-release/deployment",
    plan_node: "34000000-0000-4000-8000-000000000040",
    acceptance_capabilities: ["container-deployment-resumability"],
  },
  storage: {
    layer: "domain-capabilities",
    code_owner: "packages/foundation/src/storage/storage-provider.mjs",
    plan_owner: "docs/plans/end-to-end-release/platform-foundation/storage-backup",
    plan_node: "10000000-0000-4000-8000-000000000076",
    acceptance_capabilities: ["storage-backup-runtime"],
  },
  jobs: {
    layer: "domain-capabilities",
    code_owner: "packages/foundation/src/work-queue/worker-runtime.mjs",
    plan_owner: "docs/plans/end-to-end-release/platform-foundation/jobs-work-queues",
    plan_node: "10000000-0000-4000-8000-000000000083",
    acceptance_capabilities: ["jobs-work-queue-runtime"],
  },
  "external-plugin-packaging-loading": {
    layer: "optional-plugins",
    code_owner: "packages/foundation/src/module-system/plugin-runtime.mjs",
    document_owner: "docs/protocols/PLUGIN-PACKAGE-AND-LOADING.md",
    plan_owner: "docs/plans/end-to-end-release/capability-runtime/plugin-runtime",
    plan_node: "34000000-0000-4000-8000-000000000001",
    verifier_identities: ["tools/server-scripts/verify-plugin-runtime.mjs"],
    acceptance_capabilities: ["plugin-runtime-and-module-system"],
  },
  "agent-gateway-model-routing": {
    layer: "agents-and-protocols",
    code_owner: "packages/agents/src/agent-gateway/gateway-core.mjs",
    document_owner: "docs/functionality/AGENT-GATEWAY.md",
    plan_owner: "docs/plans/end-to-end-release/operator-administration",
    plan_node: "34000000-0000-4000-8000-000000000031",
    verifier_identities: [
      "tools/server-scripts/verify-agent-gateway.mjs",
      "tools/server-scripts/verify-model-routing.mjs",
    ],
    acceptance_capabilities: ["agent-gateway-model-routing"],
  },
  "core-workspace-assets-governance": {
    layer: "domain-capabilities",
    code_owner: "packages/agents/src/workspace-asset-registry/index.mjs",
    document_owner: "docs/functionality/WORKSPACE-ASSETS.md",
    plan_owner: "docs/plans/end-to-end-release/capability-runtime",
    plan_node: "34000000-0000-4000-8000-000000000020",
    verifier_identities: ["tools/server-scripts/verify-workspace-asset-management.mjs"],
    acceptance_capabilities: ["core-workspace-assets-governance"],
  },
});

const CAPABILITY_REGISTRY_CONTRACTS = Object.freeze({
  "upstream-gateway": {
    operation_ids: ["gateway.forward"], acceptance_ids: ["upstream-service-publishing"],
    test_suite_ids: ["upstream-gateway.e2e"], version_artifact_ids: ["lico.upstream-gateway.e2e-report"],
  },
  "downstream-mcp": {
    operation_ids: ["operation_permission.catalog"], acceptance_ids: ["downstream-mcp-gateway"],
    test_suite_ids: ["downstream-mcp.completeness-audit"], version_artifact_ids: ["lico.mcp.downstream-completeness-audit"],
  },
  "strategy-management": {
    operation_ids: ["strategy.describe"], acceptance_ids: ["strategy-management"],
    test_suite_ids: ["strategy-management.runtime"],
    version_artifact_ids: [
      "lico.strategy.strategy-management-browser-report",
      "lico.strategy.strategy-management-verification-report",
    ],
    additional_registry_identities: STRATEGY_VERSION_REGISTRY_IDENTITIES,
  },
  "enterprise-governance": {
    operation_ids: ["operation_permission.catalog"],
    acceptance_ids: ["operation-permission-authorization", "observability-alerts-reporting"],
    test_suite_ids: ["observability.semantic-baseline"], version_artifact_ids: ["lico.observability.semantics"],
  },
  "console-administration": {
    operation_ids: ["system.console_state"], acceptance_ids: ["console-administration"],
    test_suite_ids: ["console.administration-coverage"], version_artifact_ids: ["lico.console.administration-coverage-report"],
  },
  "container-deployment": {
    operation_ids: [], acceptance_ids: ["container-deployment-resumability"],
    test_suite_ids: ["container.deployment-flow"], version_artifact_ids: ["lico.deployment.container-flow-report"],
  },
  storage: {
    operation_ids: ["storage.summary"], acceptance_ids: ["storage-backup-runtime"],
    test_suite_ids: ["storage.backup-restore"], version_artifact_ids: ["lico.storage.production-restore-drill-report"],
  },
  jobs: {
    operation_ids: ["jobs.list"], acceptance_ids: ["jobs-work-queue-runtime"],
    test_suite_ids: ["jobs.work-queue"], version_artifact_ids: ["lico.workflow.job-work-queue-report"],
  },
  "external-plugin-packaging-loading": {
    operation_ids: [], acceptance_ids: ["plugin-runtime-and-module-system"],
    test_suite_ids: [],
    version_artifact_ids: ["lico.state-machine.capability-acceptance-plugin-runtime-and-module-system"],
  },
  "agent-gateway-model-routing": {
    operation_ids: ["agent_gateway.call"], acceptance_ids: ["agent-gateway-model-routing"],
    test_suite_ids: ["agent-gateway.runtime", "model-routing.runtime"], version_artifact_ids: ["lico.strategy.model-routing"],
  },
  "core-workspace-assets-governance": {
    operation_ids: ["workspace.file.list"], acceptance_ids: ["core-workspace-assets-governance"],
    test_suite_ids: ["workspace-asset-management.runtime", "workspace-governance.runtime"],
    version_artifact_ids: ["lico.workspace.asset-registry"],
  },
});

function versionIdentities(artifact) {
  return [
    artifact.artifactId,
    artifact.activeVersion,
    ...artifact.versions.flatMap((version) => [
      version.version,
      version.ref,
      ...(version.artifactRefs ?? []).flatMap((reference) => [reference.artifactId, reference.version]),
      ...(version.evidenceRefs ?? []).flatMap((reference) => [reference.evidenceId, reference.uri]),
    ]),
  ];
}

function requiredVersionRegistryIdentities(capability) {
  const contract = CAPABILITY_REGISTRY_CONTRACTS[capability];
  return [...new Set(contract.version_artifact_ids.flatMap((artifactId) => {
    const artifact = versionRegistry.artifacts
      .find((candidate) => candidate.artifactId === artifactId);
    expect(artifact, `${artifactId} must remain a current Version Registry fact`).toBeDefined();
    return [`${VERSION_REGISTRY_PATH}#${artifactId}`, ...versionIdentities(artifact)];
  }))];
}

function requiredRegistryIdentities(capability) {
  const contract = CAPABILITY_REGISTRY_CONTRACTS[capability];
  return [
    matrixRegistryIdentity(capability),
    `${OPERATION_REGISTRY_PATH}#SERVER_API_OPERATIONS`,
    ...contract.operation_ids.map((id) => `${OPERATION_REGISTRY_PATH}#${id}`),
    ...contract.acceptance_ids.map((id) => `${ACCEPTANCE_REGISTRY_PATH}#${id}`),
    ...contract.test_suite_ids.map((id) => `${TESTS_REGISTRY_PATH}#${id}`),
    ...requiredVersionRegistryIdentities(capability),
    ...(contract.additional_registry_identities ?? []),
    `${GENERATED_OPERATIONS_PATH}#SERVER_API_OPERATIONS`,
    ...contract.operation_ids.map((id) => `${GENERATED_OPERATIONS_PATH}#${id}`),
    `${GENERATED_CAPABILITIES_PATH}#KERNEL_API_OPERATION_IDS`,
    ...contract.operation_ids.map((id) => `${GENERATED_CAPABILITIES_PATH}#cap:api:${id}`),
  ];
}

function observedGoverningRegistryIdentities(capability) {
  const contract = CAPABILITY_REGISTRY_CONTRACTS[capability];
  const observed = [
    `${OPERATION_REGISTRY_PATH}#SERVER_API_OPERATIONS`,
    `${GENERATED_OPERATIONS_PATH}#SERVER_API_OPERATIONS`,
    `${GENERATED_CAPABILITIES_PATH}#KERNEL_API_OPERATION_IDS`,
  ];
  for (const operationId of contract.operation_ids) {
    if (SERVER_API_OPERATIONS.some((operation) => operation.id === operationId)) {
      observed.push(`${OPERATION_REGISTRY_PATH}#${operationId}`);
    }
    if (GENERATED_OPERATIONS.some((operation) => operation.id === operationId)) {
      observed.push(`${GENERATED_OPERATIONS_PATH}#${operationId}`);
    }
    // KERNEL_API_OPERATION_IDS is projected without the cap:api: prefix at runtime,
    // while registry edge identities retain the authoritative source form.
    if (
      KERNEL_API_OPERATION_IDS.includes(operationId) ||
      KERNEL_API_OPERATION_IDS.includes(`cap:api:${operationId}`)
    ) {
      observed.push(`${GENERATED_CAPABILITIES_PATH}#cap:api:${operationId}`);
    }
  }
  for (const acceptanceId of contract.acceptance_ids) {
    if (acceptanceRegistry.entries.some((entry) => entry.capabilityId === acceptanceId)) {
      observed.push(`${ACCEPTANCE_REGISTRY_PATH}#${acceptanceId}`);
    }
  }
  for (const suiteId of contract.test_suite_ids) {
    if (testsRegistry.suites.some((suite) => suite.id === suiteId)) {
      observed.push(`${TESTS_REGISTRY_PATH}#${suiteId}`);
    }
  }
  for (const artifactId of contract.version_artifact_ids) {
    const artifact = versionRegistry.artifacts.find((candidate) => candidate.artifactId === artifactId);
    if (artifact) {
      observed.push(`${VERSION_REGISTRY_PATH}#${artifactId}`, ...versionIdentities(artifact));
    }
  }
  return [...new Set(observed)];
}

function assertRepositoryFact(relativePath) {
  expect(path.posix.isAbsolute(relativePath)).toBe(false);
  expect(relativePath.startsWith("../")).toBe(false);
  expect(fs.existsSync(path.join(REPO_ROOT, relativePath)), relativePath).toBe(true);
}

function acceptanceMachineIdentities(capabilityIds) {
  return capabilityIds.map((capabilityId) => {
    const acceptance = acceptanceRegistry.entries
      .find((entry) => entry.capabilityId === capabilityId);
    expect(acceptance, `${capabilityId} must remain a current acceptance registry fact`).toBeDefined();
    assertRepositoryFact(acceptance.checkpointPath);
    assertRepositoryFact(acceptance.definitionPath);
    assertRepositoryFact(acceptance.verifier);
    return acceptance.acceptanceMachineId;
  });
}

function matrixRegistryIdentity(capability) {
  return `${CAPABILITY_MATRIX_PATH}#${capability}`;
}

function observedMatrixRegistryIdentities() {
  return capabilityMatrix.capabilities.map((entry) => matrixRegistryIdentity(entry.id));
}

function sourceFact(capability, owners, matrix = null) {
  const documentOwners = matrix ? [...matrix.docs] : [owners.document_owner];
  const verifierIdentities = matrix ? [...matrix.verifierScripts] : [...owners.verifier_identities];
  const acceptanceCapabilities = owners.acceptance_capabilities ?? [owners.acceptance_capability];
  const requiredRegistryIdentitySet = CAPABILITY_REGISTRY_CONTRACTS[capability]
    ? requiredRegistryIdentities(capability)
    : [CAPABILITY_MATRIX_PATH];
  for (const owner of [owners.code_owner, ...documentOwners, ...verifierIdentities]) {
    assertRepositoryFact(owner);
  }
  return {
    capability,
    layer: owners.layer,
    code_owner: owners.code_owner,
    document_owner: documentOwners,
    verifier_identities: verifierIdentities,
    acceptance_machine_identity: acceptanceMachineIdentities(acceptanceCapabilities),
    required_registry_identities: requiredRegistryIdentitySet,
    platform: "any",
    repository: ".git",
    source_digest: `${capabilityMatrix.schemaVersion}:${capability}`,
  };
}

function closureFixture() {
  const matrixIds = capabilityMatrix.capabilities.map((entry) => entry.id);
  expect(new Set(matrixIds).size).toBe(matrixIds.length);

  const sourceFacts = [
    ...Object.entries(ORGANIZATION_ROOT_FACTS)
      .map(([capability, owners]) => sourceFact(capability, owners)),
    ...Object.entries(MATRIX_CAPABILITY_FACTS)
      .map(([capability, owners]) => sourceFact(
        capability,
        owners,
        capabilityMatrix.capabilities.find((matrix) => matrix.id === capability) ?? null,
      )),
  ];
  const allFacts = { ...ORGANIZATION_ROOT_FACTS, ...MATRIX_CAPABILITY_FACTS };
  const planFacts = Object.entries(allFacts).map(([capability, owners]) => {
    const checkpoints = readJson(`${owners.plan_owner}/Checkpoints.json`);
    expect(checkpoints.some((checkpoint) => checkpoint.id === owners.plan_node)).toBe(true);
    return { capability, plan_owner: owners.plan_owner, plan_node: owners.plan_node };
  });
  const registries = Object.keys(allFacts).map((capability) => ({
    capability,
    registry_identities: [
      ...observedMatrixRegistryIdentities()
        .filter((identity) => identity === matrixRegistryIdentity(capability)),
      ...(Object.hasOwn(ORGANIZATION_ROOT_FACTS, capability) ? [CAPABILITY_MATRIX_PATH] : []),
      ...(CAPABILITY_REGISTRY_CONTRACTS[capability]
        ? observedGoverningRegistryIdentities(capability)
        : []),
    ],
  }));
  return { sourceFacts, planFacts, registries };
}

function verify(fixture = closureFixture()) {
  return verifyOrganizationClosure(fixture.sourceFacts, fixture.planFacts, fixture.registries);
}

function pendingReason(report, capability, code, edge) {
  return report.pending.find((finding) =>
    finding.capability === capability && finding.code === code && finding.edge === edge);
}

function ownerRecord(fixture, collection, capability) {
  return fixture[collection].find((candidate) => candidate.capability === capability);
}

const EDGE_CASES = Object.freeze([
  { collection: "sourceFacts", field: "code_owner", code: "missing-owner", edge: "code" },
  { collection: "sourceFacts", field: "document_owner", code: "missing-document", edge: "document" },
  { collection: "planFacts", field: "plan_owner", code: "missing-owner", edge: "plan" },
  { collection: "registries", field: "registry_identities", code: "missing-registry", edge: "registry" },
  { collection: "sourceFacts", field: "verifier_identities", code: "missing-verifier", edge: "verifier" },
  { collection: "sourceFacts", field: "acceptance_machine_identity", code: "missing-acceptance-machine", edge: "acceptance-machine" },
]);

describe("organization-ordered closure audit", () => {
  it("derives the controlled closure from current matrix, Plan, source, Version, and acceptance facts", () => {
    const fixture = closureFixture();
    const report = verify(fixture);

    expect(report.accepted).toBe(true);
    expect(report.pending).toEqual([]);
    expect(new Set(report.mapped.map((entry) => entry.layer))).toEqual(new Set(ORGANIZATION_LAYERS));
    const matrixIds = capabilityMatrix.capabilities.map((entry) => entry.id);
    expect(matrixIds).toEqual(expect.arrayContaining(REQUIRED_RECOVERED_CAPABILITIES));
    expect(fixture.sourceFacts.filter((entry) => matrixIds.includes(entry.capability))
      .map((entry) => entry.capability)).toEqual(expect.arrayContaining(matrixIds));
    for (const matrix of capabilityMatrix.capabilities) {
      const source = ownerRecord(fixture, "sourceFacts", matrix.id);
      const plan = ownerRecord(fixture, "planFacts", matrix.id);
      const owners = MATRIX_CAPABILITY_FACTS[matrix.id];
      expect(source).toMatchObject({
        code_owner: owners.code_owner,
        document_owner: matrix.docs,
        verifier_identities: matrix.verifierScripts,
      });
      expect(source.acceptance_machine_identity).toEqual(
        acceptanceMachineIdentities(owners.acceptance_capabilities),
      );
      expect(plan).toEqual({
        capability: matrix.id,
        plan_owner: owners.plan_owner,
        plan_node: owners.plan_node,
      });
    }
    for (const capability of Object.keys(CAPABILITY_REGISTRY_CONTRACTS)) {
      expect(ownerRecord(fixture, "sourceFacts", capability).required_registry_identities)
        .toEqual(requiredRegistryIdentities(capability));
      expect(requiredRegistryIdentities(capability).every((identity) =>
        ownerRecord(fixture, "registries", capability).registry_identities.includes(identity))).toBe(true);
    }
  });

  it.each(REQUIRED_RECOVERED_CAPABILITIES)(
    "keeps recovered capability %s mandatory when its matrix entry is absent",
    (capability) => {
      const fixture = closureFixture();
      const registry = ownerRecord(fixture, "registries", capability);
      registry.registry_identities = registry.registry_identities
        .filter((identity) => identity !== matrixRegistryIdentity(capability));

      const report = verify(fixture);
      expect(report.accepted).toBe(false);
      expect(pendingReason(report, capability, "missing-registry", "registry")).toEqual({
        capability,
        layer: MATRIX_CAPABILITY_FACTS[capability].layer,
        code: "missing-registry",
        edge: "registry",
        state: "pending",
      });
    },
  );

  it.each(REQUIRED_RECOVERED_CAPABILITIES.flatMap((capability) => [
    {
      capability,
      collection: "planFacts",
      field: "plan_owner",
      code: "missing-owner",
      edge: "plan",
    },
    {
      capability,
      collection: "sourceFacts",
      field: "acceptance_machine_identity",
      code: "missing-acceptance-machine",
      edge: "acceptance-machine",
    },
  ]))(
    "rejects recovered capability $capability when its former missing $edge edge regresses",
    ({ capability, collection, field, code, edge }) => {
      const fixture = closureFixture();
      delete ownerRecord(fixture, collection, capability)[field];

      const report = verify(fixture);
      expect(report.accepted).toBe(false);
      expect(pendingReason(report, capability, code, edge)).toEqual({
        capability,
        layer: MATRIX_CAPABILITY_FACTS[capability].layer,
        code,
        edge,
        state: "pending",
      });
    },
  );

  it.each(capabilityMatrix.capabilities)(
    "orphaning current matrix capability $id from its source owner fails precisely",
    (matrix) => {
      const fixture = closureFixture();
      delete ownerRecord(fixture, "sourceFacts", matrix.id).code_owner;

      const report = verify(fixture);
      expect(report.accepted).toBe(false);
      expect(pendingReason(report, matrix.id, "missing-owner", "code")).toEqual({
        capability: matrix.id,
        layer: MATRIX_CAPABILITY_FACTS[matrix.id].layer,
        code: "missing-owner",
        edge: "code",
        state: "pending",
      });
    },
  );

  it.each(capabilityMatrix.capabilities)(
    "deleting current matrix entry $id from observed registry facts fails precisely",
    (matrix) => {
      const fixture = closureFixture();
      const registry = ownerRecord(fixture, "registries", matrix.id);
      registry.registry_identities = registry.registry_identities
        .filter((identity) => identity !== matrixRegistryIdentity(matrix.id));

      const report = verify(fixture);
      expect(report.accepted).toBe(false);
      expect(pendingReason(report, matrix.id, "missing-registry", "registry")).toEqual({
        capability: matrix.id,
        layer: MATRIX_CAPABILITY_FACTS[matrix.id].layer,
        code: "missing-registry",
        edge: "registry",
        state: "pending",
      });
    },
  );

  it.each(EDGE_CASES)("removes the real $edge edge and reports only that capability pending", (testCase) => {
    const fixture = closureFixture();
    const capability = "strategy-management";
    delete ownerRecord(fixture, testCase.collection, capability)[testCase.field];

    const report = verify(fixture);
    expect(report.accepted).toBe(false);
    expect(pendingReason(report, capability, testCase.code, testCase.edge)).toEqual({
      capability,
      layer: "cross-cutting-governance",
      code: testCase.code,
      edge: testCase.edge,
      state: "pending",
    });
    expect(report.mapped).toHaveLength(fixture.sourceFacts.length - 1);
  });

  it.each(EDGE_CASES)("rejects duplicate authority for the real $edge edge", (testCase) => {
    const fixture = closureFixture();
    const capability = "strategy-management";
    const original = ownerRecord(fixture, testCase.collection, capability);
    const duplicate = structuredClone(original);
    duplicate[testCase.field] = Array.isArray(original[testCase.field])
      ? [...original[testCase.field], "tools/registry/docs.registry.json"]
      : "tools/registry/docs.registry.json";
    fixture[testCase.collection].push(duplicate);

    const report = verify(fixture);
    expect(pendingReason(report, capability, "contradictory-authority", testCase.edge)).toBeDefined();
  });

  it.each(EDGE_CASES.flatMap((testCase) => [
    { ...testCase, unsafeOwner: "/absolute/owner" },
    { ...testCase, unsafeOwner: "../outside-owner" },
  ]))("rejects non-repository-relative $edge owner $unsafeOwner", (testCase) => {
    const fixture = closureFixture();
    const capability = "strategy-management";
    const record = ownerRecord(fixture, testCase.collection, capability);
    record[testCase.field] = Array.isArray(record[testCase.field])
      ? [testCase.unsafeOwner]
      : testCase.unsafeOwner;

    const report = verify(fixture);
    expect(pendingReason(report, capability, "invalid-owner-path", testCase.edge)).toBeDefined();
    expect(JSON.stringify(report)).not.toContain(testCase.unsafeOwner);
  });

  it.each(Object.keys(CAPABILITY_REGISTRY_CONTRACTS).flatMap((capability) =>
    requiredRegistryIdentities(capability)
      .filter((identity) =>
        identity !== matrixRegistryIdentity(capability)
        && !requiredVersionRegistryIdentities(capability).includes(identity))
      .map((identity) => ({ capability, identity }))))(
    "blocks $capability when independently required registry identity $identity is removed",
    ({ capability, identity }) => {
      const fixture = closureFixture();
      const registry = ownerRecord(fixture, "registries", capability);
      const retained = registry.registry_identities.filter((candidate) => candidate !== identity);
      expect(retained.length).toBe(registry.registry_identities.length - 1);
      expect(retained.length).toBeGreaterThan(0);
      registry.registry_identities = retained;

      const report = verify(fixture);
      expect(pendingReason(report, capability, "missing-registry", "registry")).toEqual({
        capability,
        layer: MATRIX_CAPABILITY_FACTS[capability].layer,
        code: "missing-registry",
        edge: "registry",
        state: "pending",
      });
      // Control capability remains mapped unless it is the mutated subject.
      expect(report.mapped.some((entry) => entry.capability === "jobs"))
        .toBe(capability !== "jobs");
    },
  );

  it.each(Object.keys(CAPABILITY_REGISTRY_CONTRACTS).flatMap((capability) =>
    requiredVersionRegistryIdentities(capability).flatMap((identity) => [
      { capability, identity, mutation: "deleted" },
      { capability, identity, mutation: "tampered" },
    ])))(
    "blocks $capability when required Version Registry identity $identity is $mutation",
    ({ capability, identity, mutation }) => {
      const fixture = closureFixture();
      const registry = ownerRecord(fixture, "registries", capability);
      const originalIdentities = [...registry.registry_identities];
      const otherIdentities = originalIdentities.filter((candidate) => candidate !== identity);
      expect(otherIdentities.length).toBe(originalIdentities.length - 1);
      expect(otherIdentities.length).toBeGreaterThan(0);

      registry.registry_identities = mutation === "deleted"
        ? otherIdentities
        : originalIdentities.map((candidate) =>
          candidate === identity ? `${identity}:tampered` : candidate);

      expect(registry.registry_identities).not.toContain(identity);
      expect(otherIdentities.every((candidate) =>
        registry.registry_identities.includes(candidate))).toBe(true);
      const report = verify(fixture);
      const expectedFinding = {
        capability,
        layer: MATRIX_CAPABILITY_FACTS[capability].layer,
        code: "missing-registry",
        edge: "registry",
        state: "pending",
      };
      expect(report.accepted).toBe(false);
      expect(pendingReason(report, capability, "missing-registry", "registry"))
        .toEqual(expectedFinding);
      expect(report.pending).toEqual([expectedFinding]);
      expect(report.mapped.some((entry) => entry.capability === "jobs"))
        .toBe(capability !== "jobs");
    },
  );

  it("rejects an unsupported platform and a foreign repository without echoing their values", () => {
    for (const [field, value, code, edge] of [
      ["platform", "unsupported-platform", "invalid-platform", "platform"],
      ["repository", "../external-repository/.git", "invalid-repository-target", "repository"],
    ]) {
      const fixture = closureFixture();
      ownerRecord(fixture, "sourceFacts", "strategy-management")[field] = value;
      const report = verify(fixture);
      expect(pendingReason(report, "strategy-management", code, edge)).toBeDefined();
      expect(JSON.stringify(report)).not.toContain(value);
    }
  });

  it.each([
    { field: "platform", code: "invalid-platform", edge: "platform" },
    { field: "repository", code: "invalid-repository-target", edge: "repository" },
  ])("deleting the real $edge edge fails closed without a fallback", ({ field, code, edge }) => {
    const fixture = closureFixture();
    delete ownerRecord(fixture, "sourceFacts", "strategy-management")[field];

    const report = verify(fixture);
    expect(report.accepted).toBe(false);
    expect(pendingReason(report, "strategy-management", code, edge)).toEqual({
      capability: "strategy-management",
      layer: "cross-cutting-governance",
      code,
      edge,
      state: "pending",
    });
  });

  it.each([
    { label: "missing", mutate: (record) => delete record.layer },
    { label: "invalid", mutate: (record) => { record.layer = "unregistered-layer"; } },
  ])("reports an exact invalid-layer finding when the organization layer is $label", ({ mutate }) => {
    const fixture = closureFixture();
    const capability = "strategy-management";
    mutate(ownerRecord(fixture, "sourceFacts", capability));

    const report = verify(fixture);
    const capabilityFindings = report.pending.filter((finding) => finding.capability === capability);

    expect(report.accepted).toBe(false);
    expect(capabilityFindings).toEqual([{
      capability,
      layer: "cross-cutting-governance",
      code: "invalid-layer",
      edge: "layer",
      state: "pending",
    }]);
  });

  it("bounds pending findings with stable ordering, exact totals, and privacy-safe projection", () => {
    const fixture = closureFixture();
    const expectedFindingsPerSyntheticFact = Object.freeze([
      { code: "invalid-layer", edge: "layer" },
      { code: "invalid-owner-path", edge: "code" },
      { code: "missing-document", edge: "document" },
      { code: "missing-owner", edge: "plan" },
      { code: "missing-registry", edge: "registry" },
      { code: "missing-verifier", edge: "verifier" },
      { code: "missing-acceptance-machine", edge: "acceptance-machine" },
    ]);
    const syntheticFacts = Array.from({ length: 300 }, (_, index) => ({
      capability: `unmapped-public-capability-${String(index).padStart(3, "0")}`,
      layer: `invalid-layer-private-marker-${index}`,
      code_owner: `../private-source-marker-${index}`,
      platform: "any",
      repository: ".git",
      source_digest: `private-source-digest-marker-${index}`,
    }));
    const expectedPendingTotal = syntheticFacts.length * expectedFindingsPerSyntheticFact.length;
    const expectedPendingTruncated = expectedPendingTotal - 256;
    fixture.sourceFacts.push(...syntheticFacts);

    const first = verify(fixture);
    const replayed = verify({
      sourceFacts: [...fixture.sourceFacts].reverse(),
      planFacts: [...fixture.planFacts].reverse(),
      registries: [...fixture.registries].reverse(),
    });

    expect(first.accepted).toBe(false);
    expect(first.pending).toHaveLength(256);
    expect(first.pending_total).toBe(expectedPendingTotal);
    expect(first.pending_truncated).toBe(expectedPendingTruncated);
    expect(replayed.pending).toEqual(first.pending);
    expect(replayed.pending_total).toBe(first.pending_total);
    expect(replayed.pending_truncated).toBe(first.pending_truncated);
    expect(replayed.fingerprint).toBe(first.fingerprint);
    expect(first.pending).toEqual([...first.pending].sort((left, right) => {
      const layerDifference = ORGANIZATION_LAYERS.indexOf(left.layer) -
        ORGANIZATION_LAYERS.indexOf(right.layer);
      return layerDifference || left.capability.localeCompare(right.capability) ||
        left.edge.localeCompare(right.edge) || left.code.localeCompare(right.code);
    }));
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("private-source-marker");
    expect(serialized).not.toContain("private-source-digest-marker");
    expect(serialized).not.toContain("invalid-layer-private-marker");
  });

  it("is deterministic under replay and invalidates its fingerprint on a current source change", () => {
    const fixture = closureFixture();
    const snapshot = structuredClone(fixture);
    const first = verify(fixture);
    const replayed = verify({
      sourceFacts: [...fixture.sourceFacts].reverse(),
      planFacts: [...fixture.planFacts].reverse(),
      registries: [...fixture.registries].reverse(),
    });
    fixture.sourceFacts[0].source_digest = "changed-source-digest";
    const changed = verify(fixture);

    expect(snapshot).toEqual(closureFixture());
    expect(replayed).toEqual(first);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });
});
