import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createReport as createLocalInfoHygieneReport } from "../../../tools/config-scanner.ts";
import {
  PlanExecutionPolicyError,
  PLAN_EXECUTION_RESOURCE_DISCIPLINE,
  assertRepositoryIdentity,
  evaluatePlanExecutionEligibility,
} from "../../../tools/plan/plan-execution-eligibility.ts";
import {
  PLAN_SHARED_STATE_AUTHORITY,
  assertCurrentDependencyMapShape,
} from "../../../tools/plan/plan-dependency-map.ts";
import {
  assertSelectionContract,
  boundedSelectionError,
  boundedSelectionOutput,
  selectNextPlanNode,
} from "../../../tools/plan/select-next-plan-node.ts";
import { canonicalDigest } from "../../../tools/plan/plan-final-receipt.ts";
import { verifyBetterPlan } from "../../../tools/server-scripts/verify-better-plan.ts";
import {
  GOVERNED_OBJECT_STORAGE_DISCIPLINE,
  assertGovernedObjectStorageCapabilities,
} from "../../../packages/foundation/src/storage/governed-object-storage.ts";
import { createStorageProvider } from "../../../packages/foundation/src/storage/storage-provider.ts";
import {
  GATEWAY_VALKEY_DISCIPLINE,
  assertGatewayValkeyCapabilities,
} from "../../../packages/foundation/src/security/gateway-valkey-discipline.ts";
import { createGatewayValkeyProvider } from "../../../packages/foundation/src/security/gateway-valkey-provider.ts";
import {
  RUNTIME_ROLES_ELASTICITY_DISCIPLINE,
  assertRuntimeRolesElasticityBoundaries,
  assertRuntimeRolesElasticityCapabilities,
} from "../../../packages/foundation/src/runtime/runtime-roles-elasticity-discipline.ts";
import { createRuntimeRolesElasticityProvider } from "../../../packages/foundation/src/runtime/runtime-roles-elasticity-provider.ts";
import {
  OBSERVABILITY_PIPELINE_DISCIPLINE,
  assertObservabilityPipelineBoundaries,
  assertObservabilityPipelineCapabilities,
} from "../../../packages/foundation/src/observability/observability-pipeline-discipline.ts";
import { createObservabilityPipelineProvider } from "../../../packages/foundation/src/observability/observability-pipeline-provider.ts";
import {
  DURABLE_EVENT_DELIVERY_DISCIPLINE,
  assertDurableEventDeliveryBoundaries,
  assertOutboxTransitionMethods,
} from "../../../packages/foundation/src/workflow/durable-event-delivery.ts";
import { createQueuePushDispatcher } from "../../../packages/foundation/src/work-queue/push-dispatcher.ts";
import { WORK_QUEUE_STORE_ADAPTER_METHODS } from "../../../packages/foundation/src/work-queue/store-adapter-contract.ts";
import {
  M7_HA_DISCIPLINE,
  assertM7HaReportShape,
} from "../../../packages/foundation/src/scale/m7-ha-discipline.ts";
import {
  M7_SCALE_DISCIPLINE,
  assertM7ScaleReportShape,
} from "../../../packages/foundation/src/scale/m7-scale-discipline.ts";
import {
  M7_REGIONAL_DR_DISCIPLINE,
  M7_REGIONAL_DR_ENVIRONMENT_VAR,
  assertM7RegionalDrEnvironmentReceipt,
  assertM7RegionalDrReportShape,
} from "../../../packages/foundation/src/scale/m7-regional-dr-discipline.ts";

const REPO_ROOT: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE_CANDIDATE_DIGEST: any =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function checkpoint({ id, status, role, prerequisites, next, platform = "any", repository = ".git" }: Record<string, any>) : any {
  return {
    id,
    status,
    role,
    prerequisites,
    next,
    platform,
    commit: { repository },
  };
}

function planFixture() : any {
  const manifest: any[] = [
    { directory: "release", checkpoints: "release/Checkpoints.json" },
    { directory: "release/macos", checkpoints: "release/macos/Checkpoints.json" },
    { directory: "release/windows", checkpoints: "release/windows/Checkpoints.json" },
  ];
  const dependencyMap: Record<string, any> = {
    schema_version: 3,
    plans: [
      {
        directory: "release",
        parent: null,
        parent_contract_node_id: null,
        parent_integrations: [],
        final_validations: [{ node_id: "root-final", profiles: ["enterprise-single-node"] }],
        prerequisite_receipts: [],
        children: ["release/macos", "release/windows"],
        accepted_final_receipts: {},
      },
      {
        directory: "release/macos",
        parent: "release",
        parent_contract_node_id: "root-contract",
        parent_integrations: [{
          child_final_node_id: "mac-final",
          parent_node_id: "root-integrate-macos",
          profiles: ["enterprise-single-node"],
        }],
        final_validations: [{ node_id: "mac-final", profiles: ["enterprise-single-node"] }],
        prerequisite_receipts: [],
        children: [],
        accepted_final_receipts: {},
      },
      {
        directory: "release/windows",
        parent: "release",
        parent_contract_node_id: "root-contract",
        parent_integrations: [{
          child_final_node_id: "win-final",
          parent_node_id: "root-integrate-windows",
          profiles: ["enterprise-single-node"],
        }],
        final_validations: [{ node_id: "win-final", profiles: ["enterprise-single-node"] }],
        prerequisite_receipts: [],
        children: [],
        accepted_final_receipts: {},
      },
    ],
  };
  const neutralImplementations: any[] = [
    "root-resume-first",
    "root-resume-second",
    "root-pending",
  ];
  const rootImplementations: any[] = [
    ...neutralImplementations,
    "root-integrate-macos",
    "root-integrate-windows",
  ];
  const checkpoints: Record<string, any> = {
    release: [
      checkpoint({
        id: "root-contract",
        status: "completed",
        role: "architecture_scaffold",
        prerequisites: [],
        next: rootImplementations,
      }),
      checkpoint({
        id: "root-resume-first",
        status: "in_progress",
        role: "implementation",
        prerequisites: ["root-contract"],
        next: ["root-final"],
      }),
      checkpoint({
        id: "root-resume-second",
        status: "in_progress",
        role: "implementation",
        prerequisites: ["root-contract"],
        next: ["root-final"],
      }),
      checkpoint({
        id: "root-pending",
        status: "pending",
        role: "implementation",
        prerequisites: ["root-contract"],
        next: ["root-final"],
      }),
      checkpoint({
        id: "root-integrate-macos",
        status: "pending",
        role: "evidence",
        prerequisites: ["root-contract"],
        next: [],
        platform: "macos",
      }),
      checkpoint({
        id: "root-integrate-windows",
        status: "pending",
        role: "evidence",
        prerequisites: ["root-contract"],
        next: [],
        platform: "windows",
      }),
      checkpoint({
        id: "root-final",
        status: "pending",
        role: "final_validation",
        prerequisites: neutralImplementations,
        next: [],
      }),
    ],
    "release/macos": [
      checkpoint({
        id: "mac-requirements",
        status: "completed",
        role: "product_requirements",
        prerequisites: [],
        next: ["mac-implementation"],
        platform: "macos",
      }),
      checkpoint({
        id: "mac-implementation",
        status: "in_progress",
        role: "implementation",
        prerequisites: ["mac-requirements"],
        next: ["mac-final"],
        platform: "macos",
      }),
      checkpoint({
        id: "mac-final",
        status: "pending",
        role: "final_validation",
        prerequisites: ["mac-implementation"],
        next: [],
        platform: "macos",
      }),
    ],
    "release/windows": [
      checkpoint({
        id: "win-requirements",
        status: "completed",
        role: "product_requirements",
        prerequisites: [],
        next: ["win-implementation"],
        platform: "windows",
      }),
      checkpoint({
        id: "win-implementation",
        status: "pending",
        role: "implementation",
        prerequisites: ["win-requirements"],
        next: ["win-final"],
        platform: "windows",
      }),
      checkpoint({
        id: "win-final",
        status: "pending",
        role: "final_validation",
        prerequisites: ["win-implementation"],
        next: [],
        platform: "windows",
      }),
    ],
  };
  return { manifest, dependencyMap, checkpoints };
}

function evaluate(fixture?: any, hostPlatform: any = "darwin") : any {
  return evaluatePlanExecutionEligibility({ ...fixture, hostPlatform });
}

function node(fixture?: any, planDirectory?: any, nodeId?: any) : any {
  return fixture.checkpoints[planDirectory].find((candidate?: any) : any => candidate.id === nodeId);
}

function acceptedFinalReceipt(fixture?: any, planDirectory?: any) : any {
  const mapPlan: any = fixture.dependencyMap.plans.find((plan?: any) : any => plan.directory === planDirectory);
  const finalBinding: any = mapPlan.final_validations[0];
  const finalNode: any = node(fixture, planDirectory, finalBinding.node_id);
  const parentIntegration: any = mapPlan.parent_integrations[0]?.parent_node_id ?? null;
  const facts: Record<string, any> = {
    schema_version: "v0.0.1:meshrix:plan-final-receipt-4",
    plan: planDirectory,
    final_node_id: finalNode.id,
    parent_contract_node_id: mapPlan.parent_contract_node_id,
    parent_integration_node_id: parentIntegration,
    status: "completed",
    role: "final_validation",
    platform: finalNode.platform,
    profiles: [...finalBinding.profiles],
    candidate_digest: FIXTURE_CANDIDATE_DIGEST,
    privacy_safe: true,
  };
  const receiptDigest: any = canonicalDigest(facts);
  mapPlan.accepted_final_receipts[finalNode.id] = {
    ...facts,
    receipt_digest: receiptDigest,
    proof_anchor: { verified: true, receipt_digest: receiptDigest },
  };
  return mapPlan.accepted_final_receipts[finalNode.id];
}

function selectionContract(target?: any, scope: any = "focused") : any {
  target.description = "Scope: Closure: capability - Core checkpoint execution admission; verify the selected node.";
  target.acceptance_criteria = [{ checked: false, text: "Focused contract passes." }];
  target.regression = {
    scope,
    commands: ["npm test -- focused"],
    criteria: [0],
    paths: ["tools/plan"],
  };
}

function profileFixture() : any {
  const checkpoints: Record<string, any> = {
    release: [
      checkpoint({
        id: "shared-work",
        status: "pending",
        role: "implementation",
        prerequisites: [],
        next: ["ha-work"],
      }),
      checkpoint({
        id: "ha-work",
        status: "pending",
        role: "implementation",
        prerequisites: ["shared-work"],
        next: ["ha-final"],
      }),
      checkpoint({
        id: "ha-final",
        status: "pending",
        role: "final_validation",
        prerequisites: ["ha-work"],
        next: [],
      }),
    ],
  };
  return {
    manifest: [{ directory: "release", checkpoints: "release/Checkpoints.json" }],
    dependencyMap: {
      schema_version: 3,
      plans: [{
        directory: "release",
        parent: null,
        parent_contract_node_id: null,
        parent_integrations: [],
        final_validations: [
          { node_id: "ha-final", profiles: ["enterprise-single-node"] },
        ],
        prerequisite_receipts: [],
        children: [],
        accepted_final_receipts: {},
      }],
    },
    checkpoints,
  };
}

const BETTER_PLAN_CHECKS: readonly any[] = Object.freeze([
  "schema",
  "source",
  "label",
  "graph",
  "privacy",
]);
const LOCAL_INFO_HYGIENE_SCHEMA: any = "v0.0.1:repository:local-info-hygiene-report-0.0.2";
const LOCAL_INFO_HYGIENE_REPORT_PATH: any = "build/reports/local-info-hygiene.json";
const LOCAL_INFO_HYGIENE_NOW: any = Date.parse("2026-07-19T00:00:00.000Z");
const LOCAL_INFO_HYGIENE_MAX_AGE_MS: any = 60_000;
const GOVERNING_REGISTRY_PATHS: Readonly<Record<string, any>> = Object.freeze({
  operation: "packages/contracts/src/operations/operation-registry.ts",
  // Operation IDs are authored in composed definition modules observed by Better Plan.
  operationDefinition: "packages/contracts/src/operations/strategy-permission-operation-definitions.ts",
  tests: "tools/registry/tests.registry.json",
  acceptance: "tools/registry/capability-acceptance.registry.json",
  version: "packages/foundation/src/version-control/version-registry.json",
  generatedOperations: "packages/contracts/src/generated/operations.generated.ts",
  generatedCapabilities: "packages/foundation/src/security/authorization/generated-capabilities.ts",
});

function zeroWarningLocalInfoHygieneReport(generatedAt: any = "2026-07-19T00:00:00.000Z") : any {
  return createLocalInfoHygieneReport([], generatedAt);
}

function warningLocalInfoHygieneReport() : any {
  return createLocalInfoHygieneReport([{
    severity: "warning",
    rule: "controlled-fixture-warning",
    category: "controlled-fixture-warning",
    file: "tests/fixtures/privacy-safe.txt",
    line: 1,
    column: 1,
    matchLength: 1,
    fingerprint: "0".repeat(64),
    message: "Controlled schema fixture warning.",
  }], "2026-07-19T00:00:00.000Z");
}

function betterPlanResult(overrides: Record<string, any> = {}) : any {
  const checks: any = Object.fromEntries(BETTER_PLAN_CHECKS.map((check?: any) : any => [check, true]));
  Object.assign(checks, overrides);
  return {
    schema_version: "v0.0.1:meshrix:better-plan-validation-1",
    accepted: (Object.values(checks) as any[]).every(Boolean),
    checks,
  };
}

function readRepositoryFile(relativePath?: any) : any {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function strategyVersionRegistryIdentities() : any {
  const registry: any = JSON.parse(readRepositoryFile(GOVERNING_REGISTRY_PATHS.version));
  const artifacts: any = registry.artifacts.filter((artifact?: any) : any => [
    "meshrix.strategy.strategy-management-browser-report",
    "meshrix.strategy.strategy-management-verification-report",
  ].includes(artifact.artifactId));
  expect(artifacts).toHaveLength(2);
  return [...new Set<any>(artifacts.flatMap((artifact?: any) : any => [
    artifact.artifactId,
    artifact.activeVersion,
    ...artifact.versions.flatMap((version?: any) : any => [
      version.version,
      version.ref,
      ...(version.artifactRefs ?? []).flatMap((reference?: any) : any => [reference.artifactId, reference.version]),
      ...(version.evidenceRefs ?? []).flatMap((reference?: any) : any => [reference.evidenceId, reference.uri]),
    ]),
  ]).filter((identity?: any) : any => typeof identity === "string" && identity.length > 0))];
}

function governingRegistryMutations() : any {
  return [
    {
      category: "operation registry",
      relativePath: GOVERNING_REGISTRY_PATHS.operationDefinition,
      identity: "strategy.describe",
    },
    {
      category: "tests registry",
      relativePath: GOVERNING_REGISTRY_PATHS.tests,
      identity: "strategy-management.runtime",
    },
    {
      category: "capability acceptance registry",
      relativePath: GOVERNING_REGISTRY_PATHS.acceptance,
      identity: "strategy-management",
    },
    ...strategyVersionRegistryIdentities().map((identity?: any) : any => ({
      category: "Strategy Version Registry identity",
      relativePath: GOVERNING_REGISTRY_PATHS.version,
      identity,
    })),
    {
      category: "generated operation projection",
      relativePath: GOVERNING_REGISTRY_PATHS.generatedOperations,
      identity: "strategy.describe",
    },
    {
      category: "generated capability projection",
      relativePath: GOVERNING_REGISTRY_PATHS.generatedCapabilities,
      identity: "cap:api:strategy.describe",
    },
  ];
}

function mutatingRepositoryReader(relativePath?: any, identity?: any, reads?: any) : any {
  const original: any = readRepositoryFile(relativePath);
  const encodedIdentity: any = JSON.stringify(identity);
  expect(original).toContain(encodedIdentity);
  const mutated: any = original.split(encodedIdentity)
    .join(JSON.stringify(`mutated-governing-identity-${identity.length}`));
  expect(mutated).not.toBe(original);
  return async (requestedPath?: any) : Promise<any> => {
    reads.add(requestedPath);
    return requestedPath === relativePath ? mutated : readRepositoryFile(requestedPath);
  };
}

async function selectThroughRealBetterPlan({
  customResult,
  canonicalResult,
  loadInputs,
  localInfoHygieneReport = zeroWarningLocalInfoHygieneReport(),
}: Record<string, any>) : Promise<any> {
  return selectNextPlanNode({
    selectedRepoRoot: ".",
    verifyPlan: (options?: any) : any => verifyBetterPlan({
      ...options,
      customValidator: async () : Promise<any> => customResult,
      canonicalValidator: async () : Promise<any> => canonicalResult,
      readLocalInfoHygieneReport: async (reportPath?: any) : Promise<any> => {
        expect(reportPath).toBe(LOCAL_INFO_HYGIENE_REPORT_PATH);
        return localInfoHygieneReport;
      },
      now: () : any => LOCAL_INFO_HYGIENE_NOW,
      localInfoHygieneMaxAgeMs: LOCAL_INFO_HYGIENE_MAX_AGE_MS,
    }),
    loadInputs,
  });
}

describe("Core Plan execution eligibility", () : any => {
  it.each(BETTER_PLAN_CHECKS)(
    "fails closed before loading selection inputs when custom and canonical %s validation disagree",
    async (mismatch?: any) : Promise<any> => {
      let loaded: any = false;
      await expect(selectThroughRealBetterPlan({
        customResult: betterPlanResult(),
        canonicalResult: betterPlanResult({ [mismatch]: false }),
        loadInputs: async () : Promise<any> => {
          loaded = true;
          return planFixture();
        },
      })).rejects.toMatchObject({ code: "planning_repair_required" });
      expect(loaded).toBe(false);
    },
  );

  it.each(BETTER_PLAN_CHECKS)(
    "fails closed before loading selection inputs when canonical %s passes but the custom gate disagrees",
    async (mismatch?: any) : Promise<any> => {
      let loaded: any = false;
      await expect(selectThroughRealBetterPlan({
        customResult: betterPlanResult({ [mismatch]: false }),
        canonicalResult: betterPlanResult(),
        loadInputs: async () : Promise<any> => {
          loaded = true;
          return planFixture();
        },
      })).rejects.toMatchObject({ code: "planning_repair_required" });
      expect(loaded).toBe(false);
    },
  );

  it("uses the real agreeing Better Plan gate with receipt freshness disabled before selection", async () : Promise<any> => {
    const fixture: any = planFixture();
    selectionContract(node(fixture, "release", "root-resume-first"));
    let loaded: any = false;
    const result: any = await selectThroughRealBetterPlan({
      customResult: betterPlanResult(),
      canonicalResult: betterPlanResult(),
      loadInputs: async () : Promise<any> => {
        loaded = true;
        return fixture;
      },
    });

    expect(loaded).toBe(true);
    expect(result.selected.node_id).toBe("root-resume-first");
  });

  it("uses the production default custom collector to read every governing registry projection", async () : Promise<any> => {
    const reads: any = new Set<any>();
    const result: any = await verifyBetterPlan({
      repoRoot: REPO_ROOT,
      canonicalValidator: async () : Promise<any> => betterPlanResult(),
      readRepositoryFile: async (relativePath?: any) : Promise<any> => {
        reads.add(relativePath);
        return readRepositoryFile(relativePath);
      },
      readLocalInfoHygieneReport: async () : Promise<any> => zeroWarningLocalInfoHygieneReport(),
      now: () : any => LOCAL_INFO_HYGIENE_NOW,
      localInfoHygieneMaxAgeMs: LOCAL_INFO_HYGIENE_MAX_AGE_MS,
    });

    expect(result.accepted).toBe(true);
    expect([...(Object.values(GOVERNING_REGISTRY_PATHS) as any[])].every((relativePath?: any) : any =>
      reads.has(relativePath))).toBe(true);
  });

  it("default collection rejects a public source root outside the matrix before Plan selection", async () : Promise<any> => {
    const independentPublicSource: Readonly<Record<string, any>> = Object.freeze({
      capability: "independent-public-source",
      layer: "domain-capabilities",
      code_owner: "packages/capabilities/src/index.ts",
      platform: "any",
      repository: ".git",
      source_digest: "synthetic-public-source-capability",
    });
    const expectedPending: readonly any[] = Object.freeze([
      {
        capability: independentPublicSource.capability,
        layer: independentPublicSource.layer,
        code: "missing-acceptance-machine",
        edge: "acceptance-machine",
        state: "pending",
      },
      {
        capability: independentPublicSource.capability,
        layer: independentPublicSource.layer,
        code: "missing-document",
        edge: "document",
        state: "pending",
      },
      {
        capability: independentPublicSource.capability,
        layer: independentPublicSource.layer,
        code: "missing-owner",
        edge: "plan",
        state: "pending",
      },
      {
        capability: independentPublicSource.capability,
        layer: independentPublicSource.layer,
        code: "missing-registry",
        edge: "registry",
        state: "pending",
      },
      {
        capability: independentPublicSource.capability,
        layer: independentPublicSource.layer,
        code: "missing-verifier",
        edge: "verifier",
        state: "pending",
      },
    ]);
    let enumerationCalls: any = 0;
    const enumeratePublicSourceRoots: any = async ({ repoRoot }: Record<string, any>) : Promise<any> => {
      enumerationCalls += 1;
      expect(repoRoot).toBe(REPO_ROOT);
      return [independentPublicSource];
    };
    const verifierOptions: Record<string, any> = {
      repoRoot: REPO_ROOT,
      canonicalValidator: async () : Promise<any> => betterPlanResult(),
      enumeratePublicSourceRoots,
      readLocalInfoHygieneReport: async () : Promise<any> => zeroWarningLocalInfoHygieneReport(),
      now: () : any => LOCAL_INFO_HYGIENE_NOW,
      localInfoHygieneMaxAgeMs: LOCAL_INFO_HYGIENE_MAX_AGE_MS,
    };

    let validationError: any;
    try {
      await verifyBetterPlan(verifierOptions);
    } catch (error: any) {
      validationError = error;
    }

    expect(validationError).toMatchObject({
      code: "invalid_plan_authority",
      report: {
        accepted: false,
        checks: { graph: false },
      },
    });
    expect(validationError.report.organization_closure).toMatchObject({
      accepted: false,
      pending_total: expectedPending.length,
      pending_truncated: 0,
    });
    expect(validationError.report.organization_closure.pending).toEqual(expectedPending);

    let loaded: any = false;
    await expect(selectNextPlanNode({
      selectedRepoRoot: REPO_ROOT,
      verifyPlan: (options?: any) : any => verifyBetterPlan({ ...verifierOptions, ...options }),
      loadInputs: async () : Promise<any> => {
        loaded = true;
        return planFixture();
      },
    })).rejects.toMatchObject({ code: "planning_repair_required" });
    expect(loaded).toBe(false);
    expect(enumerationCalls).toBe(2);
  });

  it.each(governingRegistryMutations())(
    "default custom fact collection fails closed when $category $identity is mutated",
    async ({ relativePath, identity }: Record<string, any>) : Promise<any> => {
      const reads: any = new Set<any>();

      await expect(verifyBetterPlan({
        repoRoot: REPO_ROOT,
        canonicalValidator: async () : Promise<any> => betterPlanResult(),
        readRepositoryFile: mutatingRepositoryReader(relativePath, identity, reads),
        readLocalInfoHygieneReport: async () : Promise<any> => zeroWarningLocalInfoHygieneReport(),
        now: () : any => LOCAL_INFO_HYGIENE_NOW,
        localInfoHygieneMaxAgeMs: LOCAL_INFO_HYGIENE_MAX_AGE_MS,
      })).rejects.toMatchObject({
        code: "invalid_plan_authority",
        report: {
          accepted: false,
          agreement: false,
          checks: { graph: false },
        },
      });

      expect(reads).toContain(relativePath);
    },
  );

  it("admits only a zero-warning local-info report produced by the production scanner contract", async () : Promise<any> => {
    const report: any = zeroWarningLocalInfoHygieneReport();
    expect(report).toMatchObject({
      schemaVersion: LOCAL_INFO_HYGIENE_SCHEMA,
      verifier: "tools/config-scanner.ts",
      sourceOfTruth: "tools/config-scanner.ts#repo-local-info-hygiene",
      summary: {
        warningCount: 0,
        highRiskCount: 0,
        releaseReady: true,
        reportLeakScan: true,
      },
    });

    const fixture: any = planFixture();
    selectionContract(node(fixture, "release", "root-resume-first"));
    const result: any = await selectThroughRealBetterPlan({
      customResult: betterPlanResult(),
      canonicalResult: betterPlanResult(),
      localInfoHygieneReport: report,
      loadInputs: async () : Promise<any> => fixture,
    });
    expect(result.selected.node_id).toBe("root-resume-first");
  });

  it.each([
    { label: "missing", report: null },
    { label: "stale", report: zeroWarningLocalInfoHygieneReport("2026-07-18T00:00:00.000Z") },
    { label: "nonzero-warning", report: warningLocalInfoHygieneReport() },
  ])("blocks selection when the production local-info hygiene report is $label", async ({ report }: Record<string, any>) : Promise<any> => {
    let loaded: any = false;
    await expect(selectThroughRealBetterPlan({
      customResult: betterPlanResult(),
      canonicalResult: betterPlanResult(),
      localInfoHygieneReport: report,
      loadInputs: async () : Promise<any> => {
        loaded = true;
        return planFixture();
      },
    })).rejects.toMatchObject({ code: "planning_repair_required" });
    expect(loaded).toBe(false);
  });

  it("normalizes macOS and excludes pending Windows checkpoints", () : any => {
    const result: any = evaluate(planFixture());
    const eligibleIds: any = result.eligible.map((candidate?: any) : any => candidate.nodeId);

    expect(result.hostPlatform).toBe("macos");
    expect(eligibleIds).not.toContain("win-implementation");
    expect(result.deferred.find((candidate?: any) : any => candidate.nodeId === "win-implementation")?.reasons)
      .toContain("platform_mismatch");
  });

  it("selects shared work under the only supported enterprise profile", () : any => {
    const fixture: any = profileFixture();
    selectionContract(node(fixture, "release", "shared-work"));
    selectionContract(node(fixture, "release", "ha-work"));

    const shared: any = boundedSelectionOutput(evaluatePlanExecutionEligibility({
      ...fixture,
      hostPlatform: "linux",
    }), fixture.checkpoints);
    expect(shared.selected).toMatchObject({
      node_id: "shared-work",
      profiles: ["enterprise-single-node"],
    });

    expect(shared.selected.profiles).toEqual(["enterprise-single-node"]);
  });

  it("rejects unsupported profile bindings", () : any => {
    const fixture: any = planFixture();
    const macPlan: any = fixture.dependencyMap.plans.find((plan?: any) : any => plan.directory === "release/macos");
    const windowsPlan: any = fixture.dependencyMap.plans.find((plan?: any) : any => plan.directory === "release/windows");
    macPlan.final_validations[0].profiles = ["ha"];
    macPlan.parent_integrations[0].profiles = ["ha"];
    windowsPlan.final_validations[0].profiles = ["scale"];
    windowsPlan.parent_integrations[0].profiles = ["scale"];
    windowsPlan.prerequisite_receipts = [{
      plan: "release/macos",
      node_id: "mac-final",
      kind: "final_validation",
      profiles: ["scale"],
    }];

    expect(() : any => evaluate(fixture)).toThrow(
      "invalid_dependency_map: Plan final-validation or receipt bindings are malformed",
    );
  });

  it("keeps Windows integration Windows-owned without blocking platform-neutral macOS work", () : any => {
    const fixture: any = planFixture();
    const macosAdmission: any = evaluate(fixture);
    expect(macosAdmission.eligible.map((candidate?: any) : any => candidate.nodeId)).toContain("root-pending");
    expect(macosAdmission.eligible.map((candidate?: any) : any => candidate.nodeId)).not.toContain("root-integrate-windows");
    expect(macosAdmission.deferred.find((candidate?: any) : any => candidate.nodeId === "root-integrate-windows")?.reasons)
      .toContain("platform_mismatch");
    expect(macosAdmission.deferred.find((candidate?: any) : any => candidate.nodeId === "root-integrate-windows")?.reasons)
      .toContain("incomplete_dependencies");

    node(fixture, "release/windows", "win-implementation").status = "completed";
    node(fixture, "release/windows", "win-final").status = "completed";
    acceptedFinalReceipt(fixture, "release/windows");
    expect(evaluate(fixture).eligible.map((candidate?: any) : any => candidate.nodeId)).not.toContain("root-integrate-windows");
    expect(evaluate(fixture, "win32").eligible.map((candidate?: any) : any => candidate.nodeId))
      .toContain("root-integrate-windows");
  });

  it("rejects a platform child integration that is mislabeled as platform-neutral", () : any => {
    const fixture: any = planFixture();
    const integration: any = node(fixture, "release", "root-integrate-windows");
    integration.platform = "any";
    integration.next = ["root-final"];
    node(fixture, "release", "root-final").prerequisites.push(integration.id);

    expect(() : any => evaluate(fixture)).toThrow(
      "platform_integration_mismatch: parent integration checkpoint must remain owned by the child final platform",
    );
  });

  it("rejects a platform child integration mislabeled as neutral implementation", () : any => {
    const fixture: any = planFixture();
    node(fixture, "release", "root-integrate-windows").role = "implementation";

    expect(() : any => evaluate(fixture)).toThrow(
      "invalid_graph: parent integration checkpoint role does not match the child platform scope",
    );
  });

  it("rejects a platform-specific checkpoint that gates platform-neutral work", () : any => {
    const fixture: any = planFixture();
    node(fixture, "release", "root-integrate-windows").next = ["root-final"];
    node(fixture, "release", "root-final").prerequisites.push("root-integrate-windows");

    expect(() : any => evaluate(fixture)).toThrow(
      "platform_dependency_mismatch: platform-specific checkpoint cannot gate platform-neutral or different-platform work",
    );
  });

  it("keeps an entirely pending Manifest-only draft outside the active release graph", () : any => {
    const fixture: any = planFixture();
    fixture.manifest.push({
      directory: "release/draft-capability",
      checkpoints: "release/draft-capability/Checkpoints.json",
      status: "pending",
    });
    fixture.checkpoints["release/draft-capability"] = [checkpoint({
      id: "draft-implementation",
      status: "pending",
      role: "implementation",
      prerequisites: [],
      next: [],
    })];

    const result: any = evaluate(fixture);

    expect(result.graph.planCount).toBe(3);
    expect(result.eligible.every((candidate?: any) : any => candidate.planDirectory !== "release/draft-capability")).toBe(true);
  });

  it("rejects a Manifest-only Plan after work starts but before DependencyMap integration", () : any => {
    const fixture: any = planFixture();
    fixture.manifest.push({
      directory: "release/unintegrated-capability",
      checkpoints: "release/unintegrated-capability/Checkpoints.json",
      status: "in_progress",
    });
    fixture.checkpoints["release/unintegrated-capability"] = [checkpoint({
      id: "unintegrated-implementation",
      status: "in_progress",
      role: "implementation",
      prerequisites: [],
      next: [],
    })];

    expect(() : any => evaluate(fixture)).toThrow(
      "invalid_graph: A Manifest-only Plan must remain an entirely pending draft until it is integrated into DependencyMap",
    );
  });

  it("fails closed when a completed checkpoint has an incomplete incoming dependency", () : any => {
    const fixture: any = planFixture();
    node(fixture, "release", "root-final").status = "completed";

    expect(() : any => evaluate(fixture)).toThrow(
      "invalid_completed_dependency: completed checkpoint has an incomplete incoming dependency",
    );
  });

  it("defers parent integration until its child receipt is exact, verified, and privacy-safe", () : any => {
    const fixture: any = planFixture();
    node(fixture, "release/windows", "win-implementation").status = "completed";
    node(fixture, "release/windows", "win-final").status = "completed";
    const reasons: any = () : any => evaluate(fixture, "win32").deferred
      .find((candidate?: any) : any => candidate.nodeId === "root-integrate-windows")?.reasons;

    expect(reasons()).toContain("invalid_receipt");

    const receipt: any = acceptedFinalReceipt(fixture, "release/windows");
    receipt.final_node_id = "mac-final";
    expect(reasons()).toContain("invalid_receipt");

    receipt.final_node_id = "win-final";
    receipt.proof_anchor.verified = false;
    expect(reasons()).toContain("invalid_receipt");

    receipt.proof_anchor.verified = true;
    receipt.privacy_safe = false;
    expect(reasons()).toContain("invalid_receipt");
  });

  it("rejects a retained accepted receipt when its Plan final is incomplete", () : any => {
    const fixture: any = planFixture();
    acceptedFinalReceipt(fixture, "release/windows");

    expect(() : any => evaluate(fixture)).toThrow("invalid_final_receipt: incomplete Plan retains an accepted final receipt");
  });

  it("requires an exact accepted receipt for a completed final-validation cross-Plan dependency", () : any => {
    const fixture: any = planFixture();
    fixture.dependencyMap.plans.find((plan?: any) : any => plan.directory === "release/windows").prerequisite_receipts = [
      {
        plan: "release/macos",
        node_id: "mac-final",
        kind: "final_validation",
        profiles: ["enterprise-single-node"],
      },
    ];
    node(fixture, "release/macos", "mac-implementation").status = "completed";
    node(fixture, "release/macos", "mac-final").status = "completed";

    expect(() : any => evaluate(fixture, "win32")).not.toThrow();
    expect(evaluate(fixture, "win32").deferred.find((candidate?: any) : any => candidate.nodeId === "win-implementation")?.reasons)
      .toContain("invalid_receipt");

    acceptedFinalReceipt(fixture, "release/macos");
    expect(evaluate(fixture, "win32").eligible.map((candidate?: any) : any => candidate.nodeId)).toContain("win-implementation");
  });

  it("defers a valid non-Core repository handoff while retaining selectable Core work", () : any => {
    const fixture: any = planFixture();
    node(fixture, "release", "root-resume-first").commit.repository = "../plugin-repository/.git";

    const result: any = evaluate(fixture);
    expect(result.eligible.map((candidate?: any) : any => candidate.nodeId)).not.toContain("root-resume-first");
    expect(result.eligible[0]?.nodeId).toBe("root-resume-second");
    expect(result.deferredReasonCounts.repository_mismatch).toBe(1);
  });

  it("fails closed for an unknown checkpoint platform", () : any => {
    const fixture: any = planFixture();
    node(fixture, "release", "root-pending").platform = "unknown-os";

    expect(() : any => evaluate(fixture)).toThrow("unknown_platform: unknown checkpoint platform");
  });

  it("fails closed for an unknown host platform", () : any => {
    expect(() : any => evaluate(planFixture(), "solaris")).toThrow("unknown_host_platform: unknown host platform");
  });

  it("fails closed when a platform-named Plan contains the wrong node platform", () : any => {
    const fixture: any = planFixture();
    node(fixture, "release/macos", "mac-implementation").platform = "any";

    expect(() : any => evaluate(fixture)).toThrow(
      "platform_plan_mismatch: platform-named Plan contains a checkpoint for another platform",
    );
  });

  it("fails closed for a malformed cross-Plan receipt reference", () : any => {
    const fixture: any = planFixture();
    fixture.dependencyMap.plans.find((plan?: any) : any => plan.directory === "release/windows").prerequisite_receipts = [
      {
        plan: "release/macos",
        node_id: "missing-final",
        kind: "final_validation",
        profiles: ["enterprise-single-node"],
      },
    ];

    expect(() : any => evaluate(fixture)).toThrow("unknown_reference: unknown cross-Plan receipt node reference");
  });

  it("orders resumable work before pending work, then by Manifest and checkpoint order", () : any => {
    const result: any = evaluate(planFixture());

    expect(result.eligible.map((candidate?: any) : any => candidate.nodeId)).toEqual([
      "root-resume-first",
      "root-resume-second",
      "mac-implementation",
      "root-pending",
    ]);
  });

  it("fails selection instead of bypassing the first eligible node without Closure and regression contracts", () : any => {
    const fixture: any = planFixture();
    selectionContract(node(fixture, "release", "root-resume-second"));
    const evaluation: any = evaluate(fixture);

    expect(() : any => boundedSelectionOutput(evaluation, fixture.checkpoints)).toThrow(
      "missing_closure_contract: selected checkpoint must declare exactly one capability, module, or scenario Closure scope",
    );
    expect(evaluation.eligible[0].nodeId).toBe("root-resume-first");
  });

  it("requires role-appropriate regression scope and valid criterion indexes", () : any => {
    const fixture: any = planFixture();
    const selected: any = node(fixture, "release", "root-resume-first");
    selectionContract(selected, "full");
    const evaluation: any = evaluate(fixture);

    expect(() : any => boundedSelectionOutput(evaluation, fixture.checkpoints)).toThrow(
      "invalid_regression_contract: selected implementation checkpoint must declare a focused regression contract",
    );

    selected.regression.scope = "focused";
    selected.regression.criteria = [1];
    expect(() : any => boundedSelectionOutput(evaluation, fixture.checkpoints)).toThrow("invalid_regression_contract");

    selected.regression.criteria = [0];
    expect(boundedSelectionOutput(evaluation, fixture.checkpoints).selected.node_id).toBe("root-resume-first");

    selected.description = "Scope: Closure: module - plan selection policy; verify one bounded module.";
    expect(boundedSelectionOutput(evaluation, fixture.checkpoints).selected.node_id).toBe("root-resume-first");

    selected.regression.paths = ["tools", "tools/plan"];
    expect(() : any => boundedSelectionOutput(evaluation, fixture.checkpoints)).toThrow("invalid_regression_contract");
  });

  it("requires a full regression contract for final validation", () : any => {
    const fixture: any = planFixture();
    const finalNode: any = node(fixture, "release", "root-final");
    selectionContract(finalNode, "focused");
    const selected: Record<string, any> = { planDirectory: "release", nodeId: "root-final" };

    expect(() : any => assertSelectionContract(selected, fixture.checkpoints)).toThrow(
      "invalid_regression_contract: selected final_validation checkpoint must declare a full regression contract",
    );
    finalNode.regression.scope = "full";
    expect(() : any => assertSelectionContract(selected, fixture.checkpoints)).not.toThrow();
  });

  it("fails closed when no checkpoint is eligible and projects only a bounded error code", () : any => {
    const fixture: any = planFixture();
    for (const nodes of (Object.values(fixture.checkpoints) as any[])) {
      for (const checkpointNode of nodes) {
        if (checkpointNode.status === "pending" || checkpointNode.status === "in_progress") {
          checkpointNode.status = "blocked";
        }
      }
    }
    const evaluation: any = evaluate(fixture);

    let error: any;
    try {
      boundedSelectionOutput(evaluation, fixture.checkpoints);
    } catch (caught: any) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PlanExecutionPolicyError);
    expect(boundedSelectionError(error)).toEqual({
      schema_version: "v0.0.1:meshrix:plan-execution-selection-1",
      accepted: false,
      error_code: "no_eligible_node",
    });
    expect(boundedSelectionError(new Error("sensitive detail"))).toEqual({
      schema_version: "v0.0.1:meshrix:plan-execution-selection-1",
      accepted: false,
      error_code: "invalid_policy_input",
    });
  });

  it("returns receipt-blocked execution to native-main planning without hiding unrelated work", () : any => {
    const fixture: any = planFixture();
    for (const candidate of [
      "root-resume-first",
      "root-resume-second",
      "root-pending",
      "root-integrate-macos",
      "mac-implementation",
    ]) {
      for (const nodes of (Object.values(fixture.checkpoints) as any[])) {
        const target: any = nodes.find((entry?: any) : any => entry.id === candidate);
        if (target) target.status = "blocked";
      }
    }
    node(fixture, "release/windows", "win-implementation").status = "completed";
    node(fixture, "release/windows", "win-final").status = "completed";
    const evaluation: any = evaluate(fixture, "win32");

    expect(evaluation.eligible).toEqual([]);
    expect(evaluation.deferred.find((candidate?: any) : any => candidate.nodeId === "root-integrate-windows")?.reasons)
      .toContain("invalid_receipt");
    expect(() : any => boundedSelectionOutput(evaluation, fixture.checkpoints)).toThrow(
      "planning_repair_required: eligible execution is waiting for a valid prerequisite Plan receipt",
    );
  });

  it("validates Git top-level, Core package, and canonical Plan root identity", () : any => {
    const identity: Record<string, any> = {
      repoRoot: "/workspace/core",
      gitTopLevel: "/workspace/core",
      planRoot: "/workspace/core/docs/plans",
      packageManifest: { name: "meshrix" },
      gitMarkerPresent: true,
    };
    expect(() : any => assertRepositoryIdentity(identity)).not.toThrow();
    expect(() : any => assertRepositoryIdentity({ ...identity, gitTopLevel: "/workspace" })).toThrow(
      "repository_identity_mismatch: repository root is not the current Git top-level",
    );
    expect(() : any => assertRepositoryIdentity({ ...identity, packageManifest: { name: "other" } })).toThrow(
      "repository_identity_mismatch: repository root is not the Meshrix Core package",
    );
    expect(() : any => assertRepositoryIdentity({ ...identity, planRoot: "/workspace/core/plan" })).toThrow(
      "repository_identity_mismatch: plan root is not the canonical Core Plan root",
    );
  });
});

describe("Algorithmic Resource Discipline", () : any => {
  it("declares bounded validation, scheduling, caching, and lock ownership", () : any => {
    expect(PLAN_EXECUTION_RESOURCE_DISCIPLINE).toMatchObject({
      id: "plan-execution-eligibility",
      bounds: {
        maxDirectoryLength: 512,
        maxNodeIdLength: 256,
        maxRepositoryLength: 256,
        maxPlanCount: 256,
        maxCheckpointCount: 4096,
        maxEdgeCount: 16_384,
      },
      scheduling: {
        statusPriority: ["in_progress", "pending"],
      },
      caching: {
        receiptValidation: "once-per-evaluation",
      },
      lockOwnership: {
        graphState: "evaluation-local",
        inputMutation: "forbidden",
      },
    });
    expect(Object.isFrozen(PLAN_EXECUTION_RESOURCE_DISCIPLINE)).toBe(true);
  });

  it("rejects checkpoint identifiers that exceed the memory budget", () : any => {
    const fixture: any = profileFixture();
    selectionContract(node(fixture, "release", "shared-work"));
    node(fixture, "release", "shared-work").id =
      "n".repeat(PLAN_EXECUTION_RESOURCE_DISCIPLINE.bounds.maxNodeIdLength + 1);

    expect(() : any => evaluatePlanExecutionEligibility({
      ...fixture,
      hostPlatform: "linux",
    })).toThrow("invalid_checkpoints: checkpoint node id is missing");
  });

  it("schedules resumable work before pending work deterministically", () : any => {
    const result: any = evaluate(planFixture());
    expect(result.eligible.map((candidate?: any) : any => candidate.nodeId)).toEqual([
      "root-resume-first",
      "root-resume-second",
      "mac-implementation",
      "root-pending",
    ]);
  });

  it("evaluates the production plan graph within declared budgets", async () : Promise<any> => {
    const { loadPlanExecutionInputs } = await import("../../../tools/plan/plan-execution-eligibility.ts");
    const inputs: any = await loadPlanExecutionInputs({ repoRoot: REPO_ROOT });
    const result: any = evaluatePlanExecutionEligibility({ ...inputs, hostPlatform: "macos" });
    expect(result.graph.planCount).toBeLessThanOrEqual(
      PLAN_EXECUTION_RESOURCE_DISCIPLINE.bounds.maxPlanCount,
    );
    expect(result.graph.nodeCount).toBeLessThanOrEqual(
      PLAN_EXECUTION_RESOURCE_DISCIPLINE.bounds.maxCheckpointCount,
    );
    expect(result.graph.edgeCount).toBeLessThanOrEqual(
      PLAN_EXECUTION_RESOURCE_DISCIPLINE.bounds.maxEdgeCount,
    );
  });

  it("returns identical eligible ordering across repeated evaluations", () : any => {
    const fixture: any = planFixture();
    selectionContract(node(fixture, "release", "root-resume-first"));
    const first: any = evaluate(fixture).eligible.map((candidate?: any) : any => candidate.nodeId);
    const second: any = evaluate(fixture).eligible.map((candidate?: any) : any => candidate.nodeId);
    expect(second).toEqual(first);
  });
});

describe("M1 Shared State Authority And Migration", () : any => {
  it("declares one DependencyMap authority with transactional multi-replica isolation", () : any => {
    expect(PLAN_SHARED_STATE_AUTHORITY).toMatchObject({
      id: "plan-shared-state-authority",
      authority: {
        dependencyMap: "end-to-end-release/DependencyMap.json",
        checkpointOwner: "per-plan Checkpoints.json",
      },
      transactional: {
        writeMode: "atomic-rename",
        receiptBinding: "final-node-key",
      },
      releaseScope: {
        profileIsolation: "exact-receipt-match",
        crossProfilePromotion: "forbidden",
        supportedProfile: "enterprise-single-node",
      },
      migration: {
        supersededPaths: "removed-in-same-closure",
      },
    });
    expect(Object.isFrozen(PLAN_SHARED_STATE_AUTHORITY)).toBe(true);
  });

  it("requires keyed final receipts for every current DependencyMap Plan entry", async () : Promise<any> => {
    const { loadPlanExecutionInputs } = await import("../../../tools/plan/plan-execution-eligibility.ts");
    const inputs: any = await loadPlanExecutionInputs({ repoRoot: REPO_ROOT });
    const dependencyMap: any = assertCurrentDependencyMapShape(inputs.dependencyMap);

    for (const mapPlan of dependencyMap.plans) {
      expect(mapPlan.accepted_final_receipts).toBeTypeOf("object");
      expect(Array.isArray(mapPlan.accepted_final_receipts)).toBe(false);
      expect(mapPlan.final_validations.length).toBeGreaterThan(0);
    }
  });
});

describe("M2 Object Storage", () : any => {
  it("declares governed byte storage separate from ownership authority", () : any => {
    expect(GOVERNED_OBJECT_STORAGE_DISCIPLINE).toMatchObject({
      id: "governed-object-storage",
      byteStore: {
        capabilityId: "object-store",
        kind: "blob-store",
        operations: [
          "putObject",
          "putObjectsFromFiles",
          "getObject",
          "readObject",
          "statObject",
          "resolveStoredObjectPath",
        ],
      },
      ownershipAuthority: {
        capabilityId: "storage-object-ownership",
        kind: "metadata",
        operations: [
          "findObjectOwner",
          "listObjectStoragePathsByOwner",
          "deleteObjectRecordsByOwner",
          "getDeletionOperationByOwnerId",
          "upsertDeletionOperation",
          "updateDeletionOperation",
          "deleteDeletionOperation",
          "listPendingDeletionOperations",
        ],
      },
      separation: {
        sharedObjectBytes: "object-store",
        ownershipRecords: "storage-object-ownership",
        ownershipMutationViaByteStore: "forbidden",
      },
    });
    expect(Object.isFrozen(GOVERNED_OBJECT_STORAGE_DISCIPLINE)).toBe(true);
  });

  it("keeps shared object bytes behind governed object-store capabilities", () : any => {
    const storageKernel: Record<string, any> = {
      databasePath: "/data/metadata/meshrix.sqlite",
      objectRootPath: "/data/objects",
      getStorageSummary: () : any => ({
        databasePath: "/data/metadata/meshrix.sqlite",
        objectRootPath: "/data/objects",
        objectCount: 0,
      }),
    };
    const provider: any = createStorageProvider({
      userDataPath: "/data",
      storageKernel,
    });
    const { capabilities } = provider.listCapabilities();

    expect(assertGovernedObjectStorageCapabilities(capabilities)).toBe(true);
    expect(capabilities.find((entry?: any) : any => entry.id === "object-store")?.kind).toBe("blob-store");
    expect(capabilities.find((entry?: any) : any => entry.id === "storage-object-ownership")?.kind).toBe("metadata");
  });

  it("rejects capability drift that would merge byte and ownership authority", () : any => {
    expect(() : any => assertGovernedObjectStorageCapabilities([
      {
        id: "object-store",
        kind: "metadata",
        operations: [...GOVERNED_OBJECT_STORAGE_DISCIPLINE.byteStore.operations],
      },
      {
        id: "storage-object-ownership",
        kind: "metadata",
        operations: [...GOVERNED_OBJECT_STORAGE_DISCIPLINE.ownershipAuthority.operations],
      },
    ])).toThrow("Shared object bytes must remain behind the governed object-store capability.");
  });
});

describe("M4 Gateway And Valkey", () : any => {
  it("declares edge traffic governance separate from non-authoritative distributed caching", () : any => {
    expect(GATEWAY_VALKEY_DISCIPLINE).toMatchObject({
      id: "gateway-valkey",
      edgeTrafficGovernance: {
        capabilityId: "edge-traffic-governance",
        kind: "gateway",
        operations: [
          "gateway.policy.preview",
          "gateway.forward",
          "gateway.payload.transit",
          "gateway.artifacts.get",
          "gateway.audit",
          "gateway.metrics",
        ],
      },
      distributedCache: {
        capabilityId: "distributed-cache",
        kind: "cache",
        operations: [
          "getCacheEntry",
          "setCacheEntry",
          "deleteCacheEntry",
          "invalidateCacheNamespace",
        ],
      },
      separation: {
        trafficDecisions: "edge-traffic-governance",
        cacheLayer: "distributed-cache",
        cachePromotionToAuthority: "forbidden",
      },
    });
    expect(Object.isFrozen(GATEWAY_VALKEY_DISCIPLINE)).toBe(true);
  });

  it("keeps edge traffic governance and distributed cache behind governed capabilities", () : any => {
    const provider: any = createGatewayValkeyProvider();
    const { capabilities } = provider.listCapabilities();

    expect(assertGatewayValkeyCapabilities(capabilities)).toBe(true);
    expect(capabilities.find((entry?: any) : any => entry.id === "edge-traffic-governance")?.kind).toBe("gateway");
    expect(capabilities.find((entry?: any) : any => entry.id === "distributed-cache")?.kind).toBe("cache");
  });

  it("rejects capability drift that would promote cache to state authority", () : any => {
    expect(() : any => assertGatewayValkeyCapabilities([
      {
        id: "edge-traffic-governance",
        kind: "cache",
        operations: [...GATEWAY_VALKEY_DISCIPLINE.edgeTrafficGovernance.operations],
      },
      {
        id: "distributed-cache",
        kind: "cache",
        operations: [...GATEWAY_VALKEY_DISCIPLINE.distributedCache.operations],
      },
    ])).toThrow("Edge traffic governance must remain behind the governed gateway capability.");
  });
});

describe("M3 Durable Event Delivery", () : any => {
  function mockStoreAdapter() : any {
    return Object.fromEntries(
      WORK_QUEUE_STORE_ADAPTER_METHODS.map((method?: any) : any => [method, async () : Promise<any> => ({})]),
    );
  }

  it("declares transactional outbox separate from bounded durable delivery", () : any => {
    expect(DURABLE_EVENT_DELIVERY_DISCIPLINE).toMatchObject({
      id: "durable-event-delivery",
      outbox: {
        journal: "work_queue_transition_journal",
        storeMethods: [
          "enqueue",
          "claim",
          "complete",
          "retry",
          "recover",
        ],
        writeMode: "transactional-journal",
      },
      delivery: {
        dispatcherId: "queue-push-dispatcher",
        claimBeforeDispatch: true,
        boundedInFlight: "credit-limit",
        operations: [
          "dispatchOnce",
          "status",
          "drain",
          "cancel",
        ],
      },
      separation: {
        intentPersistence: "work-queue-store",
        handlerExecution: "queue-worker-runtime",
        dispatchWithoutClaim: "forbidden",
      },
    });
    expect(Object.isFrozen(DURABLE_EVENT_DELIVERY_DISCIPLINE)).toBe(true);
  });

  it("keeps asynchronous work behind outbox persistence and bounded dispatch", () : any => {
    const store: any = mockStoreAdapter();
    const dispatcher: any = createQueuePushDispatcher({
      store,
      workerRuntime: {
        workerId: "test-worker",
        runLeased: async () : Promise<any> => ({ action: "completed" }),
      },
      queueDefinitionId: "queue.jobs.test",
    });

    expect(assertDurableEventDeliveryBoundaries({ store, dispatcher })).toBe(true);
    expect(assertOutboxTransitionMethods(DURABLE_EVENT_DELIVERY_DISCIPLINE.outbox.storeMethods)).toBe(true);
  });

  it("rejects delivery drift that would bypass transactional outbox claim", () : any => {
    expect(() : any => assertDurableEventDeliveryBoundaries({
      store: { enqueue: async () : Promise<any> => ({}) },
      dispatcher: { dispatchOnce: async () : Promise<any> => ({}) },
    })).toThrow("Transactional outbox requires a work queue store with claim.");

    const partialStore: any = Object.fromEntries(
      WORK_QUEUE_STORE_ADAPTER_METHODS.slice(0, 3).map((method?: any) : any => [method, async () : Promise<any> => ({})]),
    );
    expect(() : any => assertDurableEventDeliveryBoundaries({
      store: partialStore,
      dispatcher: { dispatchOnce: async () : Promise<any> => ({}) },
    })).toThrow("Transactional outbox store adapter is incomplete.");

    expect(() : any => assertOutboxTransitionMethods([
      "enqueue",
      "claim",
      "complete",
    ])).toThrow("Transactional outbox transition methods changed without updating the delivery contract.");
  });
});

describe("M5 Runtime Roles And Elasticity", () : any => {
  function mockRoleBoundaries() : any {
    return {
      control: {
        previewElasticityBounds: async () : Promise<any> => ({ maxReplicas: 4, currentReplicas: 1 }),
      },
      data: {
        writeRolePartition: async () : Promise<any> => ({ committed: true }),
      },
      workerRuntime: {
        claimWorkerLease: async () : Promise<any> => ({ leaseId: "lease-1" }),
        reportWorkerCapacity: async () : Promise<any> => ({ inFlight: 0, ceiling: 4 }),
      },
    };
  }

  it("declares control, data, and worker roles with fenced bounded elasticity", () : any => {
    expect(RUNTIME_ROLES_ELASTICITY_DISCIPLINE).toMatchObject({
      id: "runtime-roles-elasticity",
      controlRole: {
        capabilityId: "runtime-control",
        kind: "control",
        operations: [
          "admitRoleWorkload",
          "scheduleRoleTopology",
          "previewElasticityBounds",
          "enforceRoleFence",
          "reportRoleTopology",
        ],
      },
      dataRole: {
        capabilityId: "runtime-data",
        kind: "data",
        operations: [
          "readRolePartition",
          "writeRolePartition",
          "commitRoleCheckpoint",
          "listRolePartitions",
        ],
      },
      workerRole: {
        capabilityId: "runtime-worker",
        kind: "worker",
        operations: [
          "claimWorkerLease",
          "releaseWorkerLease",
          "reportWorkerCapacity",
          "drainWorkerRole",
        ],
      },
      elasticity: {
        scaleDecisionOwner: "runtime-control",
        maxReplicas: "configured-ceiling",
        workerSelfPromotion: "forbidden",
        unboundedScale: "forbidden",
      },
      separation: {
        orchestrationDecisions: "runtime-control",
        stateAuthority: "runtime-data",
        executionLayer: "runtime-worker",
        workerPromotionToAuthority: "forbidden",
      },
    });
    expect(Object.isFrozen(RUNTIME_ROLES_ELASTICITY_DISCIPLINE)).toBe(true);
  });

  it("keeps control, data, and worker roles behind governed capabilities", () : any => {
    const provider: any = createRuntimeRolesElasticityProvider();
    const { capabilities } = provider.listCapabilities();

    expect(assertRuntimeRolesElasticityCapabilities(capabilities)).toBe(true);
    expect(capabilities.find((entry?: any) : any => entry.id === "runtime-control")?.kind).toBe("control");
    expect(capabilities.find((entry?: any) : any => entry.id === "runtime-data")?.kind).toBe("data");
    expect(capabilities.find((entry?: any) : any => entry.id === "runtime-worker")?.kind).toBe("worker");
    expect(assertRuntimeRolesElasticityBoundaries(mockRoleBoundaries())).toBe(true);
  });

  it("rejects capability drift that would promote workers to state authority", () : any => {
    expect(() : any => assertRuntimeRolesElasticityCapabilities([
      {
        id: "runtime-control",
        kind: "control",
        operations: [...RUNTIME_ROLES_ELASTICITY_DISCIPLINE.controlRole.operations],
      },
      {
        id: "runtime-data",
        kind: "worker",
        operations: [...RUNTIME_ROLES_ELASTICITY_DISCIPLINE.dataRole.operations],
      },
      {
        id: "runtime-worker",
        kind: "worker",
        operations: [...RUNTIME_ROLES_ELASTICITY_DISCIPLINE.workerRole.operations],
      },
    ])).toThrow("Runtime data must remain behind the governed data-plane capability.");

    expect(() : any => assertRuntimeRolesElasticityBoundaries({
      control: { previewElasticityBounds: async () : Promise<any> => ({}) },
      data: { readRolePartition: async () : Promise<any> => ({}) },
      workerRuntime: { claimWorkerLease: async () : Promise<any> => ({}) },
    })).toThrow("Runtime data authority requires a data plane with writeRolePartition.");
  });
});

describe("M6 Observability Pipeline", () : any => {
  function mockPipelineBoundaries() : any {
    return {
      telemetryExport: {
        exportMetricBatch: async () : Promise<any> => ({ recorded: 1 }),
        exportTraceBatch: async () : Promise<any> => ({ exported: 0 }),
        listExportPartitions: async () : Promise<any> => [],
        finalizeExportBatch: async (batch?: any) : Promise<any> => ({ ...batch, finalized: true }),
      },
      evidenceStorage: {
        storeEvidenceReport: async (report?: any) : Promise<any> => report,
        readEvidenceReport: async () : Promise<any> => ({}),
        listEvidenceReports: async () : Promise<any> => [],
        finalizeSensitiveReport: (report?: any) : any => report,
      },
      alertLifecycle: {
        createAlertRecord: () : any => ({ alertId: "alert-1", lifecycleStatus: "rule_loaded" }),
        transitionAlertRecord: (record?: any) : any => record,
        activateAlertRecord: (signal?: any) : any => ({ ...signal, active: true }),
        alertLifecycleDefinition: () : any => ({ states: [] }),
      },
    };
  }

  it("declares telemetry export, evidence storage, and alerts with privacy-safe separation", () : any => {
    expect(OBSERVABILITY_PIPELINE_DISCIPLINE).toMatchObject({
      id: "observability-pipeline",
      telemetryExport: {
        capabilityId: "telemetry-export",
        kind: "telemetry",
        operations: [
          "exportMetricBatch",
          "exportTraceBatch",
          "listExportPartitions",
          "finalizeExportBatch",
        ],
      },
      operationalEvidence: {
        capabilityId: "operational-evidence",
        kind: "evidence",
        operations: [
          "storeEvidenceReport",
          "readEvidenceReport",
          "listEvidenceReports",
          "finalizeSensitiveReport",
        ],
      },
      operationalAlerts: {
        capabilityId: "operational-alerts",
        kind: "alerts",
        operations: [
          "createAlertRecord",
          "transitionAlertRecord",
          "activateAlertRecord",
          "alertLifecycleDefinition",
        ],
      },
      separation: {
        telemetryExport: "telemetry-export",
        evidenceStorage: "operational-evidence",
        alertLifecycle: "operational-alerts",
        rawEvidencePromotion: "forbidden",
      },
    });
    expect(Object.isFrozen(OBSERVABILITY_PIPELINE_DISCIPLINE)).toBe(true);
  });

  it("keeps telemetry export, evidence storage, and alerts behind governed capabilities", () : any => {
    const provider: any = createObservabilityPipelineProvider();
    const { capabilities } = provider.listCapabilities();

    expect(assertObservabilityPipelineCapabilities(capabilities)).toBe(true);
    expect(capabilities.find((entry?: any) : any => entry.id === "telemetry-export")?.kind).toBe("telemetry");
    expect(capabilities.find((entry?: any) : any => entry.id === "operational-evidence")?.kind).toBe("evidence");
    expect(capabilities.find((entry?: any) : any => entry.id === "operational-alerts")?.kind).toBe("alerts");
    expect(assertObservabilityPipelineBoundaries(provider.resolveBoundaries())).toBe(true);
  });

  it("rejects capability drift that would promote raw evidence without privacy scanning", () : any => {
    expect(() : any => assertObservabilityPipelineCapabilities([
      {
        id: "telemetry-export",
        kind: "evidence",
        operations: [...OBSERVABILITY_PIPELINE_DISCIPLINE.telemetryExport.operations],
      },
      {
        id: "operational-evidence",
        kind: "evidence",
        operations: [...OBSERVABILITY_PIPELINE_DISCIPLINE.operationalEvidence.operations],
      },
      {
        id: "operational-alerts",
        kind: "alerts",
        operations: [...OBSERVABILITY_PIPELINE_DISCIPLINE.operationalAlerts.operations],
      },
    ])).toThrow("Bounded telemetry export must remain behind the governed telemetry capability.");

    expect(() : any => assertObservabilityPipelineBoundaries({
      telemetryExport: { exportMetricBatch: async () : Promise<any> => ({}) },
      evidenceStorage: { storeEvidenceReport: async () : Promise<any> => ({}) },
      alertLifecycle: { createAlertRecord: () : any => ({}) },
    })).toThrow("Bounded telemetry export requires finalizeExportBatch.");

    expect(() : any => assertObservabilityPipelineBoundaries({
      telemetryExport: {
        exportMetricBatch: async () : Promise<any> => ({}),
        finalizeExportBatch: async () : Promise<any> => ({}),
      },
      evidenceStorage: { storeEvidenceReport: async () : Promise<any> => ({}) },
      alertLifecycle: { createAlertRecord: () : any => ({}) },
    })).toThrow("Privacy-safe evidence requires finalizeSensitiveReport.");

    expect(() : any => assertObservabilityPipelineBoundaries(mockPipelineBoundaries())).not.toThrow();
  });
});

describe("M7 ha Capacity And Fault Acceptance", () : any => {
  it("declares profile-scoped capacity, memory, and fault reports with fresh-process isolation", () : any => {
    expect(M7_HA_DISCIPLINE).toMatchObject({
      id: "m7-ha-capacity-fault",
      profile: "ha",
      requirement: "REQ-SCALE-M7-HA",
      processIsolation: {
        capacity: "fresh-process",
        memory: "fresh-process",
        fault: "fresh-process",
        crossReportReuse: "forbidden",
        crossProfilePromotion: "forbidden",
      },
    });
    expect(Object.isFrozen(M7_HA_DISCIPLINE)).toBe(true);
    expect(M7_HA_DISCIPLINE.reports.capacity.path).toBe("build/reports/m7-ha/capacity.json");
    expect(M7_HA_DISCIPLINE.reports.memory.path).toBe("build/reports/m7-ha/memory.json");
    expect(M7_HA_DISCIPLINE.reports.fault.path).toBe("build/reports/m7-ha/fault.json");
  });

  it("rejects reports produced by the parent acceptance process", () : any => {
    expect(() : any => assertM7HaReportShape({
      schema_version: M7_HA_DISCIPLINE.reports.capacity.schemaVersion,
      profile: "ha",
      claim: "capacity_profile",
      processPid: process.pid,
      accepted: true,
    }, "capacity")).toThrow("must not be produced by the parent acceptance process");
  });
});

describe("M7 scale Capacity And Fault Acceptance", () : any => {
  it("declares profile-scoped capacity, memory, and fault reports with fresh-process isolation", () : any => {
    expect(M7_SCALE_DISCIPLINE).toMatchObject({
      id: "m7-scale-capacity-fault",
      profile: "scale",
      requirement: "REQ-SCALE-M7-SCALE",
      processIsolation: {
        capacity: "fresh-process",
        memory: "fresh-process",
        fault: "fresh-process",
        crossReportReuse: "forbidden",
        crossProfilePromotion: "forbidden",
      },
    });
    expect(Object.isFrozen(M7_SCALE_DISCIPLINE)).toBe(true);
    expect(M7_SCALE_DISCIPLINE.reports.capacity.path).toBe("build/reports/m7-scale/capacity.json");
    expect(M7_SCALE_DISCIPLINE.reports.memory.path).toBe("build/reports/m7-scale/memory.json");
    expect(M7_SCALE_DISCIPLINE.reports.fault.path).toBe("build/reports/m7-scale/fault.json");
  });

  it("rejects reports produced by the parent acceptance process", () : any => {
    expect(() : any => assertM7ScaleReportShape({
      schema_version: M7_SCALE_DISCIPLINE.reports.capacity.schemaVersion,
      profile: "scale",
      claim: "capacity_profile",
      processPid: process.pid,
      accepted: true,
    }, "capacity")).toThrow("must not be produced by the parent acceptance process");
  });
});

describe("M7 regional-dr Capacity And Fault Acceptance", () : any => {
  it("declares profile-scoped capacity, memory, and fault reports with fresh-process isolation", () : any => {
    expect(M7_REGIONAL_DR_DISCIPLINE).toMatchObject({
      id: "m7-regional-dr-capacity-fault",
      profile: "regional-dr",
      requirement: "REQ-SCALE-M7-REGIONAL-DR",
      environment: {
        variable: M7_REGIONAL_DR_ENVIRONMENT_VAR,
      },
      processIsolation: {
        capacity: "fresh-process",
        memory: "fresh-process",
        fault: "fresh-process",
        crossReportReuse: "forbidden",
        crossProfilePromotion: "forbidden",
      },
    });
    expect(Object.isFrozen(M7_REGIONAL_DR_DISCIPLINE)).toBe(true);
    expect(M7_REGIONAL_DR_DISCIPLINE.reports.capacity.path).toBe("build/reports/m7-regional-dr/capacity.json");
    expect(M7_REGIONAL_DR_DISCIPLINE.reports.memory.path).toBe("build/reports/m7-regional-dr/memory.json");
    expect(M7_REGIONAL_DR_DISCIPLINE.reports.fault.path).toBe("build/reports/m7-regional-dr/fault.json");
  });

  it("requires a declared regional-DR environment receipt for capacity and memory claims", () : any => {
    expect(() : any => assertM7RegionalDrEnvironmentReceipt({
      schema_version: "v0.0.1:meshrix:m7-regional-dr-environment-1",
      profile: "regional-dr",
      classification: "declared-regional-dr",
      primary: { serviceUrl: "<service-url>" },
      secondary: { serviceUrl: "<service-url>" },
    })).not.toThrow();

    expect(() : any => assertM7RegionalDrEnvironmentReceipt({
      schema_version: "v0.0.1:meshrix:m7-regional-dr-environment-1",
      profile: "ha",
      classification: "declared-regional-dr",
      primary: { serviceUrl: "<service-url>" },
      secondary: { serviceUrl: "<service-url>" },
    })).toThrow("Regional-DR M7 environment receipt profile must be regional-dr.");
  });

  it("rejects reports produced by the parent acceptance process", () : any => {
    expect(() : any => assertM7RegionalDrReportShape({
      schema_version: M7_REGIONAL_DR_DISCIPLINE.reports.capacity.schemaVersion,
      profile: "regional-dr",
      claim: "capacity_profile",
      processPid: process.pid,
      accepted: true,
    }, "capacity")).toThrow("must not be produced by the parent acceptance process");
  });
});
