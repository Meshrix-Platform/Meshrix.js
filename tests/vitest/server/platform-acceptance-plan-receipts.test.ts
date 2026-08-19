import { describe, expect, it, vi } from "vitest";

import {
  requiredPlatformAcceptancePlanReceipts,
  verifyPlatformAcceptancePlanReceipts,
} from "../../../tools/server-scripts/lib/platform-acceptance-plan-receipts.ts";

const FIXTURE_CANDIDATE: Readonly<Record<string, any>> = Object.freeze({
  candidateDigest:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sourceRevision: "b".repeat(40),
  repositoryRevision: "b".repeat(40),
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
      provider("end-to-end-release/fixture-alpha", "alpha-final"),
      provider("end-to-end-release/fixture-beta", "beta-final"),
      {
        directory: "end-to-end-release",
        parent: null,
        parent_contract_node_id: null,
        parent_integrations: [],
        final_validations: [{ node_id: "release-final", profiles: ["enterprise-single-node"] }],
        prerequisite_receipts: [
          {
            plan: "end-to-end-release/fixture-alpha",
            node_id: "alpha-final",
            kind: "final_validation",
            profiles: ["enterprise-single-node"],
          },
          {
            plan: "end-to-end-release/fixture-beta",
            node_id: "beta-final",
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
    finalNodeId: suffix === "fixture-alpha" ? "alpha-final" : "beta-final",
    platform: suffix === "fixture-beta" ? "linux" : "any",
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
  it("accepts the consolidated Plan without cyclic prerequisite receipts", async () : Promise<any> => {
    const prerequisiteCodes: any[] = ["EFF-7", "EFF-8", "EFF-9", "EFF-10"];
    const prerequisites: any[] = prerequisiteCodes.map((code?: any) : any => ({
      id: `${code}-node`,
      code,
      role: "implementation",
      status: "completed",
      candidate_digest: "a".repeat(64),
      commit: { delivered: "b".repeat(40) },
      acceptance_criteria: [{ checked: true, evidence_refs: [{ type: "command" }] }],
    }));
    const map: any = {
      schema_version: 3,
      plans: [{
        directory: "end-to-end-release",
        parent: null,
        parent_contract_node_id: null,
        parent_integrations: [],
        final_validations: [{ node_id: "release-final", profiles: ["enterprise-single-node"] }],
        prerequisite_receipts: [],
        children: [],
        accepted_final_receipts: {},
      }],
    };
    const verifyPlan: any = vi.fn(async () : Promise<any> => ({ accepted: true }));
    const loadBinding: any = vi.fn();

    expect(requiredPlatformAcceptancePlanReceipts(map)).toEqual([]);
    await expect(verifyPlatformAcceptancePlanReceipts({
      repoRoot: "/synthetic-repo",
      selectedProfile: "enterprise-single-node",
      dependencyMap: map,
      verifyPlan,
      loadBinding,
      loadCandidate: async () : Promise<any> => ({
        candidate_digest: "a".repeat(64),
        source_revision: "b".repeat(40),
      }),
      loadCheckpoints: async () : Promise<any> => [
        ...prerequisites,
        {
          id: "release-final",
          code: "EFF-FINAL",
          role: "final_validation",
          status: "pending",
          prerequisites: prerequisites.map((node?: any) : any => node.id),
        },
      ],
      verifyCheckpointEvidence: async () : Promise<any> => ({ evidenceCount: 1 }),
    })).resolves.toMatchObject({
      releaseAcceptancePlan: "end-to-end-release",
      candidateDigest: "a".repeat(64),
      requiredReceiptCount: 0,
      requiredCheckpointCount: 4,
      bindings: [],
      checkpointBindings: expect.arrayContaining(
        prerequisiteCodes.map((code?: any) : any => expect.objectContaining({ code })),
      ),
    });
    expect(verifyPlan).toHaveBeenCalledTimes(2);
    expect(loadBinding).not.toHaveBeenCalled();
  });

  it("rejects an incomplete consolidated prerequisite checkpoint", async () : Promise<any> => {
    const codes: any[] = ["EFF-7", "EFF-8", "EFF-9", "EFF-10"];
    const prerequisites: any[] = codes.map((code?: any) : any => ({
      id: `${code}-node`,
      code,
      role: "implementation",
      status: code === "EFF-9" ? "pending" : "completed",
      candidate_digest: "a".repeat(64),
      commit: { delivered: "b".repeat(40) },
      acceptance_criteria: [{ checked: true }],
    }));
    const map: any = {
      schema_version: 3,
      plans: [{
        directory: "end-to-end-release",
        parent: null,
        parent_contract_node_id: null,
        parent_integrations: [],
        final_validations: [{ node_id: "release-final", profiles: ["enterprise-single-node"] }],
        prerequisite_receipts: [],
        children: [],
        accepted_final_receipts: {},
      }],
    };

    await expect(verifyPlatformAcceptancePlanReceipts({
      repoRoot: "/synthetic-repo",
      selectedProfile: "enterprise-single-node",
      dependencyMap: map,
      verifyPlan: async () : Promise<any> => ({ accepted: true }),
      loadCandidate: async () : Promise<any> => ({
        candidate_digest: "a".repeat(64),
        source_revision: "b".repeat(40),
      }),
      loadCheckpoints: async () : Promise<any> => [
        ...prerequisites,
        {
          id: "release-final",
          role: "final_validation",
          status: "pending",
          prerequisites: prerequisites.map((node?: any) : any => node.id),
        },
      ],
      verifyCheckpointEvidence: async () : Promise<any> => ({ evidenceCount: 1 }),
    })).rejects.toThrow("release-prerequisite-incomplete");
  });

  it("binds an in-progress consolidated Plan to its latest completed shared frontier", async () : Promise<any> => {
    const canonical: any = {
      id: "canonical-node",
      code: "GATE-CANONICAL",
      role: "implementation",
      status: "completed",
      prerequisites: [],
      acceptance_criteria: [{ checked: true, evidence_refs: [{ type: "command" }] }],
    };
    const remainders: any[] = ["DQ-ACCEPTANCE", "DQ-TYPING-REST", "DQ-FEEDBACK-SCALE"].map((code?: any) : any => ({
      id: `${code}-node`,
      code,
      role: "implementation",
      status: "pending",
      prerequisites: [canonical.id],
      acceptance_criteria: [{ checked: false }],
    }));
    const map: any = {
      schema_version: 3,
      plans: [{
        directory: "end-to-end-release",
        parent: null,
        parent_contract_node_id: null,
        parent_integrations: [],
        final_validations: [{ node_id: "release-final", profiles: ["enterprise-single-node"] }],
        prerequisite_receipts: [],
        children: [],
        accepted_final_receipts: {},
      }],
    };

    await expect(verifyPlatformAcceptancePlanReceipts({
      repoRoot: "/synthetic-repo",
      selectedProfile: "enterprise-single-node",
      dependencyMap: map,
      verifyPlan: async () : Promise<any> => ({ accepted: true }),
      loadCandidate: async () : Promise<any> => ({
        candidate_digest: "a".repeat(64),
        source_revision: "b".repeat(40),
      }),
      loadCheckpoints: async () : Promise<any> => [
        canonical,
        ...remainders,
        {
          id: "release-final",
          code: "GATE-FINAL",
          role: "final_validation",
          status: "pending",
          prerequisites: remainders.map((node?: any) : any => node.id),
        },
      ],
      verifyCheckpointEvidence: async () : Promise<any> => ({ evidenceCount: 1 }),
    })).resolves.toMatchObject({
      requiredCheckpointCount: 1,
      checkpointBindings: [expect.objectContaining({ code: "GATE-CANONICAL" })],
    });
  });

  it("binds a completed GATE-FINAL receipt as the functional candidate", async () : Promise<any> => {
    const loadCandidate: any = vi.fn(async () : Promise<any> => {
      throw new Error("must not construct a new release-candidate identity");
    });
    const loadBinding: any = vi.fn(async () : Promise<any> => ({
      finalNodeId: "release-final",
      platform: "any",
      profiles: ["enterprise-single-node"],
      requirements: ["REQ-GATEWAY-SPLIT-FINAL"],
      receiptDigest: "completed-receipt",
      checkpointDigest: "completed-checkpoints",
      candidateDigest: "a".repeat(64),
      sourceRevision: "c5e40c5",
      repositoryRevision: "b".repeat(40),
      repositoryTreeDigest: "sha256:completed-tree",
      proofProvider: "pactium.operation-proof-substrate",
      proofVerified: true,
      privacySafe: true,
    }));
    const map: any = {
      schema_version: 3,
      plans: [{
        directory: "end-to-end-release",
        parent: null,
        parent_contract_node_id: null,
        parent_integrations: [],
        final_validations: [{ node_id: "release-final", profiles: ["enterprise-single-node"] }],
        prerequisite_receipts: [],
        children: [],
        accepted_final_receipts: {
          "release-final": { receipt_digest: "completed-receipt" },
        },
      }],
    };

    await expect(verifyPlatformAcceptancePlanReceipts({
      repoRoot: "/synthetic-repo",
      selectedProfile: "enterprise-single-node",
      dependencyMap: map,
      verifyPlan: async () : Promise<any> => ({ accepted: true }),
      loadBinding,
      loadCandidate,
      loadCheckpoints: async () : Promise<any> => [
        {
          id: "release-final",
          code: "GATE-FINAL",
          role: "final_validation",
          status: "completed",
          platform: "any",
          requirements: ["REQ-GATEWAY-SPLIT-FINAL"],
          prerequisites: [],
          acceptance_criteria: [{ checked: true, evidence_refs: [{ type: "command" }] }],
        },
      ],
      verifyCheckpointEvidence: async () : Promise<any> => ({ evidenceCount: 1 }),
    })).resolves.toMatchObject({
      requiredReceiptCount: 0,
      requiredCheckpointCount: 0,
      candidateDigest: "a".repeat(64),
      bindings: [expect.objectContaining({
        finalNodeId: "release-final",
        receiptDigest: "completed-receipt",
        repositoryRevision: "b".repeat(40),
      })],
    });
    expect(loadCandidate).not.toHaveBeenCalled();
    expect(loadBinding).toHaveBeenCalledTimes(1);
  });

  it("requires the exact Release Acceptance prerequisite final receipts", () : any => {
    expect(requiredPlatformAcceptancePlanReceipts(dependencyMap())).toEqual([
      { plan: "end-to-end-release/fixture-alpha", finalNodeId: "alpha-final", planProfile: "enterprise-single-node" },
      { plan: "end-to-end-release/fixture-beta", finalNodeId: "beta-final", planProfile: "enterprise-single-node" },
    ]);
  });

  it("rejects a missing required accepted receipt before command execution", () : any => {
    const map: any = dependencyMap();
    delete map.plans[0].accepted_final_receipts["alpha-final"];
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
      requireCompletedReceipts: false,
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
        ...(planDirectory.endsWith("/fixture-beta") ? patch : {}),
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
