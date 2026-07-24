import { describe, expect, it, vi } from "vitest";

import {
  requiredPlatformAcceptancePlanReceipts,
  verifyPlatformAcceptancePlanReceipts,
} from "../../../tools/server-scripts/lib/platform-acceptance-plan-receipts.mjs";

function dependencyMap() {
  const provider = (directory, finalNodeId) => ({
    directory,
    parent: null,
    parent_contract_node_id: null,
    parent_integrations: [],
    final_validations: [{ node_id: finalNodeId, profiles: ["enterprise-single-node"] }],
    prerequisite_receipts: [],
    children: [],
    accepted_final_receipts: {
      [finalNodeId]: { receipt_digest: `${directory}:receipt` },
    },
  });
  return {
    schema_version: 3,
    plans: [
      provider("end-to-end-release/platform-foundation", "foundation-final"),
      provider("end-to-end-release/deployment/linux-container", "linux-final"),
      {
        directory: "end-to-end-release/release-acceptance",
        parent: null,
        parent_contract_node_id: null,
        parent_integrations: [],
        final_validations: [{ node_id: "release-final", profiles: ["enterprise-single-node"] }],
        prerequisite_receipts: [
          {
            plan: "end-to-end-release/platform-foundation",
            node_id: "foundation-final",
            kind: "final_validation",
            profiles: ["enterprise-single-node"],
          },
          {
            plan: "end-to-end-release/deployment/linux-container",
            node_id: "linux-final",
            kind: "final_validation",
            profiles: ["enterprise-single-node"],
          },
        ],
        children: [],
        accepted_final_receipts: {},
      },
    ],
  };
}

function binding(planDirectory) {
  const suffix = planDirectory.split("/").at(-1);
  return {
    finalNodeId: suffix === "platform-foundation" ? "foundation-final" : "linux-final",
    platform: suffix === "linux-container" ? "linux" : "any",
    profiles: ["enterprise-single-node"],
    requirements: [`REQ-${suffix}`],
    receiptDigest: `${suffix}-receipt`,
    checkpointDigest: `${suffix}-checkpoints`,
    sourceRevision: `${suffix}-source`,
    repositoryRevision: "repository-revision",
    repositoryTreeDigest: "repository-tree",
    proofProvider: "pactium.operation-proof-substrate",
    proofVerified: true,
    privacySafe: true,
  };
}

describe("platform acceptance Plan receipt preflight", () => {
  it("requires the exact Release Acceptance prerequisite final receipts", () => {
    expect(requiredPlatformAcceptancePlanReceipts(dependencyMap())).toEqual([
      { plan: "end-to-end-release/platform-foundation", finalNodeId: "foundation-final", planProfile: "enterprise-single-node" },
      { plan: "end-to-end-release/deployment/linux-container", finalNodeId: "linux-final", planProfile: "enterprise-single-node" },
    ]);
  });

  it("rejects a missing required accepted receipt before command execution", () => {
    const map = dependencyMap();
    delete map.plans[0].accepted_final_receipts["foundation-final"];
    expect(() => requiredPlatformAcceptancePlanReceipts(map)).toThrow("required-plan-receipt-missing");
  });

  it("rejects a prerequisite that does not identify its provider final node", () => {
    const map = dependencyMap();
    map.plans.at(-1).prerequisite_receipts[0].node_id = "wrong-final";
    expect(() => requiredPlatformAcceptancePlanReceipts(map)).toThrow("plan-receipt-final-node-mismatch");
  });

  it("verifies the Plan DAG and every current proof receipt", async () => {
    const verifyPlan = vi.fn(async () => ({ accepted: true }));
    const loadBinding = vi.fn(async ({ planDirectory }) => binding(planDirectory));
    const result = await verifyPlatformAcceptancePlanReceipts({
      repoRoot: "/synthetic-repo",
      selectedProfile: "enterprise-single-node",
      dependencyMap: dependencyMap(),
      verifyPlan,
      loadBinding,
    });

    expect(verifyPlan).toHaveBeenNthCalledWith(1, {
      repoRoot: "/synthetic-repo",
      writeReport: false,
      requireCompletedReceipts: false,
    });
    expect(verifyPlan).toHaveBeenNthCalledWith(2, {
      repoRoot: "/synthetic-repo",
      writeReport: false,
      requireCompletedReceipts: true,
    });
    expect(loadBinding).toHaveBeenCalledTimes(2);
    expect(loadBinding).toHaveBeenCalledWith(expect.objectContaining({ finalNodeId: expect.any(String) }));
    expect(result.selectedProfile).toBe("enterprise-single-node");
    expect(result.planProfile).toBe("enterprise-single-node");
    expect(result.requiredReceiptCount).toBe(2);
    expect(result.bindings).toHaveLength(2);
    expect(result.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: "linux", profiles: ["enterprise-single-node"] }),
      expect.objectContaining({ platform: "any", profiles: ["enterprise-single-node"] }),
    ]));
    expect(result.planReceiptSetDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("rejects a stale or unverified binding", async () => {
    await expect(verifyPlatformAcceptancePlanReceipts({
      repoRoot: "/synthetic-repo",
      selectedProfile: "enterprise-single-node",
      dependencyMap: dependencyMap(),
      verifyPlan: async () => ({ accepted: true }),
      loadBinding: async ({ planDirectory }) => ({ ...binding(planDirectory), proofVerified: false }),
    })).rejects.toThrow("required-plan-receipt-unverified");
  });

  it("rejects a binding whose profile, platform, or requirement coverage is absent", async () => {
    const verify = async (patch) => verifyPlatformAcceptancePlanReceipts({
      repoRoot: "/synthetic-repo",
      selectedProfile: "enterprise-single-node",
      dependencyMap: dependencyMap(),
      verifyPlan: async () => ({ accepted: true }),
      loadBinding: async ({ planDirectory }) => ({ ...binding(planDirectory), ...patch }),
    });

    await expect(verify({ profiles: ["unsupported-profile"] })).rejects.toThrow("required-plan-receipt-profile-mismatch");
    await expect(verify({ platform: "" })).rejects.toThrow("required-plan-receipt-platform-missing");
    await expect(verify({ requirements: [] })).rejects.toThrow("required-plan-receipt-requirements-missing");
  });

  it("rejects missing or unregistered profile bindings", async () => {
    await expect(verifyPlatformAcceptancePlanReceipts({
      repoRoot: "/synthetic-repo",
      dependencyMap: dependencyMap(),
    })).rejects.toThrow("plan-receipt-profile-invalid");
    await expect(verifyPlatformAcceptancePlanReceipts({
      repoRoot: "/synthetic-repo",
      selectedProfile: "any",
      dependencyMap: dependencyMap(),
    })).rejects.toThrow("plan-receipt-profile-invalid");
  });
});
