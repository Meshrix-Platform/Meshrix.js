import { describe, expect, it, vi } from "vitest";

import {
  requiredPlatformAcceptancePlanReceipts,
  verifyPlatformAcceptancePlanReceipts,
} from "../../../tools/server-scripts/lib/platform-acceptance-plan-receipts.mjs";

function dependencyMap() {
  const provider = (directory, finalNodeId) => ({
    directory,
    final_validation_node_id: finalNodeId,
    accepted_final_receipt: { receipt_digest: `${directory}:receipt` },
  });
  return {
    plans: [
      provider("end-to-end-release/platform-foundation", "foundation-final"),
      provider("end-to-end-release/deployment/linux-container", "linux-final"),
      {
        directory: "end-to-end-release/release-acceptance",
        prerequisite_receipts: [
          {
            plan: "end-to-end-release/platform-foundation",
            node_id: "foundation-final",
            kind: "final_validation",
          },
          {
            plan: "end-to-end-release/deployment/linux-container",
            node_id: "linux-final",
            kind: "final_validation",
          },
        ],
      },
    ],
  };
}

function binding(planDirectory) {
  const suffix = planDirectory.split("/").at(-1);
  return {
    finalNodeId: suffix === "platform-foundation" ? "foundation-final" : "linux-final",
    platform: suffix === "linux-container" ? "linux" : "any",
    selectedProfile: "core",
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
      { plan: "end-to-end-release/platform-foundation", finalNodeId: "foundation-final" },
      { plan: "end-to-end-release/deployment/linux-container", finalNodeId: "linux-final" },
    ]);
  });

  it("rejects a missing required accepted receipt before command execution", () => {
    const map = dependencyMap();
    delete map.plans[0].accepted_final_receipt;
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
      selectedProfile: "core",
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
    expect(loadBinding).toHaveBeenCalledWith(expect.objectContaining({ selectedProfile: "core" }));
    expect(result.selectedProfile).toBe("core");
    expect(result.requiredReceiptCount).toBe(2);
    expect(result.bindings).toHaveLength(2);
    expect(result.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: "linux", selectedProfile: "core" }),
      expect.objectContaining({ platform: "any", selectedProfile: "core" }),
    ]));
    expect(result.planReceiptSetDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("rejects a stale or unverified binding", async () => {
    await expect(verifyPlatformAcceptancePlanReceipts({
      repoRoot: "/synthetic-repo",
      selectedProfile: "core",
      dependencyMap: dependencyMap(),
      verifyPlan: async () => ({ accepted: true }),
      loadBinding: async ({ planDirectory }) => ({ ...binding(planDirectory), proofVerified: false }),
    })).rejects.toThrow("required-plan-receipt-unverified");
  });

  it("rejects a binding whose profile, platform, or requirement coverage is absent", async () => {
    const verify = async (patch) => verifyPlatformAcceptancePlanReceipts({
      repoRoot: "/synthetic-repo",
      selectedProfile: "core",
      dependencyMap: dependencyMap(),
      verifyPlan: async () => ({ accepted: true }),
      loadBinding: async ({ planDirectory }) => ({ ...binding(planDirectory), ...patch }),
    });

    await expect(verify({ selectedProfile: "unexpected" })).rejects.toThrow("required-plan-receipt-profile-mismatch");
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
