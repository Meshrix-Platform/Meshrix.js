import { describe, expect, it, vi } from "vitest";

import {
  requiredPlatformAcceptancePlanReceipts,
  verifyPlatformAcceptancePlanReceipts,
} from "../../../tools/server-scripts/lib/platform-acceptance-plan-receipts.ts";

const FIXTURE_CANDIDATE: Readonly<Record<string, any>> = Object.freeze({
  candidateDigest:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sourceRevision: "candidate-source-revision",
  repositoryRevision: "candidate-repository-revision",
  repositoryTreeDigest: "candidate-repository-tree",
});

function dependencyMap() : any {
  const provider: any = (directory?: any, finalNodeId?: any) : any => ({
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
        directory: "end-to-end-release/functional-release-acceptance",
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

function binding(planDirectory?: any) : any {
  const suffix: any = planDirectory.split("/").at(-1);
  return {
    finalNodeId: suffix === "platform-foundation" ? "foundation-final" : "linux-final",
    platform: suffix === "linux-container" ? "linux" : "any",
    profiles: ["enterprise-single-node"],
    requirements: [`REQ-${suffix}`],
    receiptDigest: `${suffix}-receipt`,
    checkpointDigest: `${suffix}-checkpoints`,
    ...FIXTURE_CANDIDATE,
    proofProvider: "pactium.operation-proof-substrate",
    proofVerified: true,
    privacySafe: true,
  };
}

describe("platform acceptance Plan receipt preflight", () : any => {
  it("requires the exact Release Acceptance prerequisite final receipts", () : any => {
    expect(requiredPlatformAcceptancePlanReceipts(dependencyMap())).toEqual([
      { plan: "end-to-end-release/platform-foundation", finalNodeId: "foundation-final", planProfile: "enterprise-single-node" },
      { plan: "end-to-end-release/deployment/linux-container", finalNodeId: "linux-final", planProfile: "enterprise-single-node" },
    ]);
  });

  it("rejects a missing required accepted receipt before command execution", () : any => {
    const map: any = dependencyMap();
    delete map.plans[0].accepted_final_receipts["foundation-final"];
    expect(() : any => requiredPlatformAcceptancePlanReceipts(map)).toThrow("required-plan-receipt-missing");
  });

  it("rejects a prerequisite that does not identify its provider final node", () : any => {
    const map: any = dependencyMap();
    map.plans.at(-1).prerequisite_receipts[0].node_id = "wrong-final";
    expect(() : any => requiredPlatformAcceptancePlanReceipts(map)).toThrow("plan-receipt-final-node-mismatch");
  });

  it("verifies the Plan DAG and every current proof receipt", async () : Promise<any> => {
    const verifyPlan: any = vi.fn(async () : Promise<any> => ({ accepted: true }));
    const loadBinding: any = vi.fn(async ({ planDirectory }: Record<string, any>) : Promise<any> => binding(planDirectory));
    const result: any = await verifyPlatformAcceptancePlanReceipts({
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

  it("rejects a stale or unverified binding", async () : Promise<any> => {
    await expect(verifyPlatformAcceptancePlanReceipts({
      repoRoot: "/synthetic-repo",
      selectedProfile: "enterprise-single-node",
      dependencyMap: dependencyMap(),
      verifyPlan: async () : Promise<any> => ({ accepted: true }),
      loadBinding: async ({ planDirectory }: Record<string, any>) : Promise<any> => ({ ...binding(planDirectory), proofVerified: false }),
    })).rejects.toThrow("required-plan-receipt-unverified");
  });

  it("rejects cross-receipt candidate, source, repository revision, and tree mismatches independently", async () : Promise<any> => {
    const verifyMismatch: any = async (patch?: any) : Promise<any> => verifyPlatformAcceptancePlanReceipts({
      repoRoot: "/synthetic-repo",
      selectedProfile: "enterprise-single-node",
      dependencyMap: dependencyMap(),
      verifyPlan: async () : Promise<any> => ({ accepted: true }),
      loadBinding: async ({ planDirectory }: Record<string, any>) : Promise<any> => ({
        ...binding(planDirectory),
        ...(planDirectory.endsWith("/linux-container") ? patch : {}),
      }),
    });

    await expect(verifyMismatch({
      candidateDigest:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    })).rejects.toThrow("required-plan-receipt-candidate-mismatch");
    await expect(verifyMismatch({
      sourceRevision: "different-source-revision",
    })).rejects.toThrow("required-plan-receipt-source-mismatch");
    await expect(verifyMismatch({
      repositoryRevision: "different-repository-revision",
    })).rejects.toThrow("required-plan-receipt-source-mismatch");
    await expect(verifyMismatch({
      repositoryTreeDigest: "different-repository-tree",
    })).rejects.toThrow("required-plan-receipt-tree-mismatch");
  });

  it("rejects a binding whose profile, platform, or requirement coverage is absent", async () : Promise<any> => {
    const verify: any = async (patch?: any) : Promise<any> => verifyPlatformAcceptancePlanReceipts({
      repoRoot: "/synthetic-repo",
      selectedProfile: "enterprise-single-node",
      dependencyMap: dependencyMap(),
      verifyPlan: async () : Promise<any> => ({ accepted: true }),
      loadBinding: async ({ planDirectory }: Record<string, any>) : Promise<any> => ({ ...binding(planDirectory), ...patch }),
    });

    await expect(verify({ profiles: ["unsupported-profile"] })).rejects.toThrow("required-plan-receipt-profile-mismatch");
    await expect(verify({ platform: "" })).rejects.toThrow("required-plan-receipt-platform-missing");
    await expect(verify({ requirements: [] })).rejects.toThrow("required-plan-receipt-requirements-missing");
  });

  it("rejects missing or unregistered profile bindings", async () : Promise<any> => {
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
