import { describe, expect, it } from "vitest";

import { containsSensitiveReportData, finalizeSensitiveReport } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import {
  ENTERPRISE_OPERATIONS_CLOSURE_REPORT_RELATIVE_PATH,
  ENTERPRISE_OPERATIONS_CLOSURE_SCHEMA,
  ENTERPRISE_OPERATIONS_CLOSURE_VERIFIER,
  ENTERPRISE_OPERATIONS_ENVIRONMENT_BLOCKERS,
  ENTERPRISE_OPERATIONS_NON_CERTIFICATION_REASON,
  ENTERPRISE_OPERATIONS_PRODUCERS,
  ENTERPRISE_OPERATIONS_PROFILE,
  ENTERPRISE_OPERATIONS_REQUIREMENTS,
  ENTERPRISE_OPERATIONS_SLOT_IDS,
  ENTERPRISE_OPERATIONS_SLOTS,
  assertCapacityNeverCertified,
  assertEnterpriseOperationsClosure,
  assertEnterpriseOperationsNonClaims,
  buildEnterpriseOperationsClosureReport,
  executeKeyLifecycleProof,
  executeCleanRootRestoreProof,
  executeUpgradeStateMachineProof,
  orderedEnterpriseOperationsProducers,
  passingInProcessFixture,
  passingProducerMap,
  probeContainerEnvironment,
  reduceEnterpriseOperationsClosure
} from "../../../tools/server-scripts/enterprise-operations-closure.ts";

const ABSOLUTE_PATH_PATTERN: any = /(?:\/(?:Users|home|private|var\/folders|root)\/|[A-Za-z]:\\)/u;
const CANDIDATE: any = {
  profile: ENTERPRISE_OPERATIONS_PROFILE,
  digest: `sha256:${"a".repeat(64)}`
};

function serialized(value?: any) : any {
  return JSON.stringify(value);
}

function reduce(overrides: Record<string, any> = {}) : any {
  return reduceEnterpriseOperationsClosure({
    candidate: CANDIDATE,
    producers: passingProducerMap(),
    inProcess: passingInProcessFixture(),
    ...overrides
  });
}

describe("enterprise operations closure", () : any => {
  it("inventories every required slot onto existing producers", () : any => {
    expect([...ENTERPRISE_OPERATIONS_SLOT_IDS]).toEqual([
      "governed-mcp-journey",
      "denial-and-uncertainty",
      "diagnostics",
      "emergency-administration",
      "key-lifecycle",
      "clean-root-restore",
      "n-minus-one-upgrade-and-failed-rollback"
    ]);
    expect(ENTERPRISE_OPERATIONS_SLOTS).toHaveLength(ENTERPRISE_OPERATIONS_SLOT_IDS.length);
    expect(ENTERPRISE_OPERATIONS_REQUIREMENTS).toEqual([
      "REQ-EFF-RELEASE",
      "REQ-BASELINE-CONSOLE-ADMINISTRATION",
      "REQ-BASELINE-CONTAINER-DEPLOYMENT",
      "REQ-BASELINE-MANDATORY-GATEWAY-PIPELINE"
    ]);
    const producerIds: any = new Set<any>(ENTERPRISE_OPERATIONS_PRODUCERS.map((entry?: any) : any => entry.id));
    expect(producerIds.has("enterprise-enforcement-coverage")).toBe(true);
    expect(producerIds.has("enterprise-governance-coverage")).toBe(true);
    expect(producerIds.has("enterprise-observability-coverage")).toBe(true);
    expect(producerIds.has("console-administration-coverage")).toBe(true);
    expect(producerIds.has("model-gateway")).toBe(true);
    expect(producerIds.has("model-gateway-detachment")).toBe(true);
    expect(producerIds.has("external-gateway")).toBe(true);
    expect(orderedEnterpriseOperationsProducers().map((entry?: any) : any => entry.id))
      .toContain("enterprise-enforcement-coverage");
    const enforcement: any = ENTERPRISE_OPERATIONS_PRODUCERS.find(
      (entry?: any) : any => entry.id === "enterprise-enforcement-coverage"
    );
    expect(enforcement.dependsOn).toEqual([
      "enterprise-governance-coverage",
      "operation-permission-protocol-consistency",
      "operation-permission-tag-governed-e2e"
    ]);
  });

  it("accepts one complete candidate without certifying capacity or support", () : any => {
    const reduction: any = reduce();
    expect(reduction.scenarioAccepted).toBe(true);
    expect(reduction.capacityCertified).toBe(false);
    expect(reduction.productionReady).toBe(false);
    expect(reduction.environmentSupportClaimed).toBe(false);
    expect(reduction.environmentBlockers).toEqual([]);
    expect(reduction.slots.every((slot?: any) : any => slot.status === "passed")).toBe(true);
    const report: any = buildEnterpriseOperationsClosureReport(reduction, {
      generatedAt: "1970-01-01T00:00:00.000Z",
      focusedSuitePassed: true
    });
    expect(report.schemaVersion).toBe(ENTERPRISE_OPERATIONS_CLOSURE_SCHEMA);
    expect(report.verifier).toBe(ENTERPRISE_OPERATIONS_CLOSURE_VERIFIER);
    expect(report.summary.capacityCertified).toBe(false);
    expect(report.summary.scenarioAccepted).toBe(true);
    expect(report.nonCertificationReason).toBe(ENTERPRISE_OPERATIONS_NON_CERTIFICATION_REASON);
    expect(ENTERPRISE_OPERATIONS_CLOSURE_REPORT_RELATIVE_PATH).toBe(
      "build/reports/enterprise-operations-closure.json"
    );
    expect(assertEnterpriseOperationsClosure(report)).toBe(true);
    expect(assertCapacityNeverCertified(report)).toBe(true);
  });

  it("fails closed when the container environment is unavailable", () : any => {
    const reduction: any = reduce({
      inProcess: {
        ...passingInProcessFixture(),
        container: { available: false, blocker: "container_environment_unavailable" }
      }
    });
    expect(reduction.scenarioAccepted).toBe(false);
    expect(reduction.capacityCertified).toBe(false);
    expect(reduction.environmentBlockers).toEqual(["container_environment_unavailable"]);
    const upgrade: any = reduction.slots.find(
      (slot?: any) : any => slot.id === "n-minus-one-upgrade-and-failed-rollback"
    );
    expect(upgrade).toMatchObject({
      status: "blocked",
      blocker: "container_environment_unavailable"
    });
    const report: any = buildEnterpriseOperationsClosureReport(reduction, {
      generatedAt: "1970-01-01T00:00:00.000Z"
    });
    expect(report.summary.scenarioAccepted).toBe(false);
    expect(report.summary.blockedSlotCount).toBe(1);
    expect(() : any => {
      report.summary.scenarioAccepted = true;
      assertEnterpriseOperationsClosure(report);
    }).toThrow(/blocked environment/);
  });

  it("fails closed when keys or restore environments are unavailable", () : any => {
    const keys: any = reduce({
      inProcess: {
        ...passingInProcessFixture(),
        keyLifecycle: { ok: false, blocker: "key_material_unavailable" }
      }
    });
    expect(keys.slots.find((slot?: any) : any => slot.id === "key-lifecycle")).toMatchObject({
      status: "blocked",
      blocker: "key_material_unavailable"
    });
    const restore: any = reduce({
      inProcess: {
        ...passingInProcessFixture(),
        cleanRootRestore: { ok: false, blocker: "restore_environment_unavailable", restoredFileCount: 0 }
      }
    });
    expect(restore.slots.find((slot?: any) : any => slot.id === "clean-root-restore")).toMatchObject({
      status: "blocked",
      blocker: "restore_environment_unavailable"
    });
    expect(ENTERPRISE_OPERATIONS_ENVIRONMENT_BLOCKERS).toEqual([
      "container_environment_unavailable",
      "key_material_unavailable",
      "restore_environment_unavailable"
    ]);
  });

  it("rejects a missing governed producer instead of synthesizing a green slot", () : any => {
    const producers: any = passingProducerMap();
    producers["operation-permission-tag-governed-e2e"] = {
      ...producers["operation-permission-tag-governed-e2e"],
      passed: false,
      exitCode: 1
    };
    const reduction: any = reduce({ producers });
    expect(reduction.scenarioAccepted).toBe(false);
    expect(reduction.slots.find((slot?: any) : any => slot.id === "governed-mcp-journey")?.status)
      .toBe("failed");
    expect(reduction.slots.find((slot?: any) : any => slot.id === "denial-and-uncertainty")?.status)
      .toBe("failed");
  });

  it("requires failed-rollback and in-doubt uncertainty evidence", () : any => {
    const reduction: any = reduce({
      inProcess: {
        ...passingInProcessFixture(),
        upgradeStateMachine: { rolledBack: true, inDoubt: false }
      }
    });
    expect(reduction.scenarioAccepted).toBe(false);
    expect(reduction.slots.find((slot?: any) : any => slot.id === "denial-and-uncertainty")?.status)
      .toBe("failed");
    expect(reduction.slots.find(
      (slot?: any) : any => slot.id === "n-minus-one-upgrade-and-failed-rollback"
    )?.status).toBe("failed");
  });

  it("keeps reports privacy-safe and rejects support claims", () : any => {
    const report: any = buildEnterpriseOperationsClosureReport(reduce(), {
      generatedAt: "1970-01-01T00:00:00.000Z",
      focusedSuitePassed: true
    });
    const text: any = serialized(report);
    expect(containsSensitiveReportData(report)).toBe(false);
    expect(ABSOLUTE_PATH_PATTERN.test(text)).toBe(false);
    expect(text).not.toMatch(/Bearer\s+(?!\[redacted\])/u);
    expect(assertEnterpriseOperationsNonClaims(report)).toBe(true);
    const finalized: any = finalizeSensitiveReport(report, {
      provenance: {
        producer: "meshrix-core-enterprise-operations-closure",
        commandId: "enterprise-operations-closure",
        sourceRevision: `sha256:${"b".repeat(64)}`
      }
    });
    expect(finalized.producers["enterprise-enforcement-coverage"].script).toBe(
      "tools/server-scripts/verify-enterprise-authorization-enforcement.ts"
    );
    expect(containsSensitiveReportData(finalized)).toBe(false);
    expect(() : any => assertCapacityNeverCertified({ capacityCertified: true })).toThrow(
      /never certify capacity/
    );
    expect(() : any => assertEnterpriseOperationsNonClaims({
      capacityCertified: false,
      productionReady: true
    })).toThrow(/production-readiness or environment support/);
  });

  it("probes missing digest-pinned images as a finite container blocker", () : any => {
    expect(probeContainerEnvironment({})).toEqual({
      available: false,
      blocker: "container_environment_unavailable"
    });
    expect(probeContainerEnvironment({
      candidateImage: "registry.example/meshrix-js/runtime:latest",
      previousImage: "registry.example/meshrix-js/runtime:previous"
    })).toEqual({
      available: false,
      blocker: "container_environment_unavailable"
    });
  });

  it("proves key rotation, clean-root restore, and failed rollback without leaking local paths", async () : Promise<any> => {
    const keys: any = await executeKeyLifecycleProof();
    const restore: any = await executeCleanRootRestoreProof();
    const upgrade: any = await executeUpgradeStateMachineProof();
    expect(keys).toEqual({ ok: true });
    expect(restore).toEqual({ ok: true, restoredFileCount: 1 });
    expect(upgrade).toEqual({ rolledBack: true, inDoubt: true });
    expect(ABSOLUTE_PATH_PATTERN.test(serialized({ keys, restore, upgrade }))).toBe(false);
  });
});
