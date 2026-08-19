import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  bindPlanReceiptProofAnchor,
  buildPlanFinalReceipt,
  assertReceiptCurrent,
  assertReceiptPlanCurrent,
  REPORT_DIGEST_ALGORITHM,
  reportDigest,
  verifyPlanReceiptProofAnchor,
} from "../../../tools/plan/plan-final-receipt.ts";
import {
  reduceEndToEndReleaseReceipt,
  runReceiptReductionMutationTests,
} from "../../../tools/plan/reduce-end-to-end-release-receipt.ts";
import { verifyPlanEvidenceCurrent } from "../../../tools/plan/plan-evidence-verifier.ts";
import {
  createPlanContractReceipt,
  planAuthorityPaths,
  normalizePlanDirectory,
  planReceiptSourceTreeDigest
} from "../../../tools/plan/plan-receipt-context.ts";
import { planReceiptKey } from "../../../tools/plan/plan-dependency-map.ts";

const temporaryRoots: any[] = [];
const RECORDED_AT: any = "2026-07-19T00:00:00.000Z";
const CANDIDATE_DIGEST: any = "c".repeat(64);

afterEach(async () : Promise<any> => {
  await Promise.all(temporaryRoots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

function finalNode(evidenceRef: Record<string, any> = { type: "file", path: "build/reports/example.json", sha256: "a".repeat(64) }) : any {
  return {
    id: "final-node",
    role: "final_validation",
    status: "completed",
    platform: "any",
    requirements: ["REQ-1"],
    candidate_digest: CANDIDATE_DIGEST,
    commit: { delivered: "source-revision" },
    acceptance_criteria: [{ checked: true, text: "accepted", evidence_refs: [evidenceRef] }]
  };
}

function buildReceipt(options?: any) : any {
  return buildPlanFinalReceipt(options);
}

function currentMapPlan(directory: any = "end-to-end-release/example", {
  finalNodeId = "final-node",
  profiles = ["enterprise-single-node"],
  prerequisiteReceipts = [],
}: Record<string, any> = {}) : any {
  return {
    directory,
    parent: null,
    parent_contract_node_id: null,
    parent_integrations: [],
    final_validations: [{ node_id: finalNodeId, profiles }],
    prerequisite_receipts: prerequisiteReceipts,
    children: [],
    accepted_final_receipts: {},
  };
}

function evidenceNode(...evidenceRefs: any[]) : any {
  return {
    acceptance_criteria: [{ checked: true, evidence_refs: evidenceRefs }],
  };
}

function fileEvidence(pathname?: any, sha256?: any, overrides: Record<string, any> = {}) : any {
  return {
    type: "file",
    path: pathname,
    sha256,
    recorded_at: RECORDED_AT,
    ...overrides,
  };
}

function commandEvidence(overrides: Record<string, any> = {}) : any {
  return {
    type: "command",
    command_sha256: "d".repeat(64),
    exit_code: 0,
    recorded_at: RECORDED_AT,
    ...overrides,
  };
}

async function createEvidenceRepository() : Promise<any> {
  const repoRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "plan-evidence-"));
  temporaryRoots.push(repoRoot);
  const reportPath: any = path.join(repoRoot, "reports", "result.json");
  const reportBytes: any = Buffer.from('{"accepted":true}\n');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, reportBytes);
  return {
    repoRoot,
    reportPath,
    reportDigest: crypto.createHash("sha256").update(reportBytes).digest("hex"),
  };
}

describe("plan receipt report digests", () : any => {
  it("uses the consolidated root Plan.md as the complete receipt authority", async () : Promise<any> => {
    const repoRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "plan-authority-root-"));
    temporaryRoots.push(repoRoot);
    const planRoot: any = path.join(repoRoot, "docs", "plans");
    const rootPlan: any = path.join(planRoot, "end-to-end-release");
    await fs.mkdir(rootPlan, { recursive: true });
    await fs.writeFile(path.join(rootPlan, "Plan.md"), "# Consolidated Plan\n", "utf8");

    expect(planAuthorityPaths(planRoot, "end-to-end-release")).toEqual([
      path.join(await fs.realpath(rootPlan), "Plan.md"),
    ]);
  });

  it("accepts current file and successful digest-bound command evidence", async () : Promise<any> => {
    const { repoRoot, reportDigest } = await createEvidenceRepository();

    await expect(verifyPlanEvidenceCurrent({
      repoRoot,
      finalNode: evidenceNode(
        fileEvidence("reports/result.json", reportDigest),
        commandEvidence(),
      ),
    })).resolves.toEqual({ evidenceCount: 2, fileCount: 1, commandCount: 1 });
  });

  it("rejects functional-gate owned reports as plan file evidence", async () : Promise<any> => {
    const { repoRoot, reportDigest } = await createEvidenceRepository();

    await expect(verifyPlanEvidenceCurrent({
      repoRoot,
      finalNode: evidenceNode(fileEvidence("reports/result.json", reportDigest)),
      disallowedFilePaths: ["reports/result.json"],
    })).rejects.toThrow("Plan file evidence is a functional-gate output");
  });

  it("rejects tampered, missing, escaping, and symlink file evidence", async () : Promise<any> => {
    const { repoRoot, reportPath, reportDigest } = await createEvidenceRepository();

    await fs.writeFile(reportPath, '{"accepted":false}\n', "utf8");
    await expect(verifyPlanEvidenceCurrent({
      repoRoot,
      finalNode: evidenceNode(fileEvidence("reports/result.json", reportDigest)),
    })).rejects.toThrow("Plan file evidence digest is stale");

    await expect(verifyPlanEvidenceCurrent({
      repoRoot,
      finalNode: evidenceNode(fileEvidence("reports/missing.json", reportDigest)),
    })).rejects.toThrow("Plan file evidence is unavailable");

    await expect(verifyPlanEvidenceCurrent({
      repoRoot,
      finalNode: evidenceNode(fileEvidence("../outside.json", reportDigest)),
    })).rejects.toThrow("Plan file evidence path is invalid");

    const targetPath: any = path.join(repoRoot, "reports", "target.json");
    const symlinkPath: any = path.join(repoRoot, "reports", "linked.json");
    await fs.writeFile(targetPath, "synthetic\n", "utf8");
    await fs.symlink(targetPath, symlinkPath);
    const targetDigest: any = crypto.createHash("sha256").update("synthetic\n").digest("hex");
    await expect(verifyPlanEvidenceCurrent({
      repoRoot,
      finalNode: evidenceNode(fileEvidence("reports/linked.json", targetDigest)),
    })).rejects.toThrow("Plan file evidence is not a regular file");
  });

  it("rejects failed commands, non-canonical timestamps, and unsupported evidence fields", async () : Promise<any> => {
    const { repoRoot } = await createEvidenceRepository();

    await expect(verifyPlanEvidenceCurrent({
      repoRoot,
      finalNode: evidenceNode(commandEvidence({ exit_code: 1 })),
    })).rejects.toThrow("Plan command evidence did not succeed");

    await expect(verifyPlanEvidenceCurrent({
      repoRoot,
      finalNode: evidenceNode(commandEvidence({ recorded_at: "2026-07-19T08:00:00+08:00" })),
    })).rejects.toThrow("Plan evidence timestamp is invalid");

    await expect(verifyPlanEvidenceCurrent({
      repoRoot,
      finalNode: evidenceNode(commandEvidence({ source_tree_sha256: "e".repeat(64) })),
    })).rejects.toThrow("Plan command evidence contains unsupported fields");
  });

  it("keeps historical environment facts immutable while requiring current Plan authority", () : any => {
    const mapPlan: any = currentMapPlan();
    const context: Record<string, any> = {
      planDirectory: mapPlan.directory,
      mapPlan,
      planText: "Plan.md\ncurrent\n",
      checkpointsText: "current-checkpoints",
      finalNode: finalNode(),
      repositoryRevision: "old-revision",
      repositoryTreeDigest: "sha256:old-tree",
      commandDagDigest: "sha256:old-command-dag",
      ownedReportsInventoryDigest: "sha256:old-reports",
    };
    const receipt: any = bindPlanReceiptProofAnchor(buildReceipt(context), {
      provider: "pactium.operation-proof-substrate",
      receipt_digest: buildReceipt(context).receipt_digest,
      ledger_event_id: "ledger-event",
      envelope_id: "envelope",
      fact_id: "fact",
      verified: true,
    });

    expect(() : any => assertReceiptPlanCurrent(receipt, {
      ...context,
      repositoryRevision: "new-revision",
      repositoryTreeDigest: "sha256:new-tree",
      commandDagDigest: "sha256:new-command-dag",
      ownedReportsInventoryDigest: "sha256:new-reports",
    })).not.toThrow();
    expect(() : any => assertReceiptCurrent(receipt, {
      ...context,
      repositoryRevision: "new-revision",
    })).toThrow("facts are absent or stale");
    expect(() : any => assertReceiptPlanCurrent(receipt, {
      ...context,
      planText: "Plan.md\nchanged\n",
    })).toThrow("facts are absent or stale");
  });

  it("binds v4 receipts to the enterprise profile and rejects the superseded single-final shape", () : any => {
    const mapPlan: any = currentMapPlan("end-to-end-release/example", {
      profiles: ["enterprise-single-node"],
    });
    const receipt: any = buildPlanFinalReceipt({
      planDirectory: mapPlan.directory,
      mapPlan,
      checkpointsText: "[]",
      finalNode: finalNode(),
    });
    expect(receipt.profiles).toEqual(["enterprise-single-node"]);
    expect(receipt).not.toHaveProperty("selected_profile");

    expect(() : any => buildPlanFinalReceipt({
      planDirectory: mapPlan.directory,
      mapPlan: {
        directory: mapPlan.directory,
        final_validation_node_id: "final-node",
        prerequisite_receipts: [],
      },
      checkpointsText: "[]",
      finalNode: finalNode(),
    })).toThrow("Plan final-validations are missing");
  });

  it("requires an explicit candidate digest and never derives one from revision-tree facts", () : any => {
    const mapPlan: any = currentMapPlan();
    const missingCandidate: any = finalNode();
    delete missingCandidate.candidate_digest;

    expect(() : any => buildReceipt({
      planDirectory: mapPlan.directory,
      mapPlan,
      checkpointsText: "[]",
      finalNode: missingCandidate,
      repositoryRevision: "a".repeat(40),
      repositoryTreeDigest: `sha256:${"b".repeat(64)}`,
    })).toThrow("Final node candidate digest is required");

    const malformedCandidate: any = finalNode();
    malformedCandidate.candidate_digest = `sha256:${CANDIDATE_DIGEST}`;
    expect(() : any => buildReceipt({
      planDirectory: mapPlan.directory,
      mapPlan,
      checkpointsText: "[]",
      finalNode: malformedCandidate,
    })).toThrow("Final node candidate digest is invalid");

    const receipt: any = buildReceipt({
      planDirectory: mapPlan.directory,
      mapPlan,
      checkpointsText: "[]",
      finalNode: finalNode(),
    });
    expect(receipt.candidate_digest).toBe(CANDIDATE_DIGEST);
  });

  it("reverifies the proof entry and its complete receipt context instead of trusting a boolean", async () : Promise<any> => {
    const mapPlan: any = currentMapPlan();
    const draft: any = buildReceipt({
      planDirectory: mapPlan.directory,
      mapPlan,
      checkpointsText: "[]",
      finalNode: finalNode(),
    });
    const receipt: any = bindPlanReceiptProofAnchor(draft, {
      provider: "pactium.operation-proof-substrate",
      receipt_digest: draft.receipt_digest,
      ledger_event_id: "ledger-event",
      envelope_id: "envelope",
      fact_id: "fact",
      verified: true,
    });
    const anchoredContext: Record<string, any> = {
      checkpointDigest: receipt.checkpoint_digest,
      repositoryTreeDigest: receipt.repository_tree_digest,
      evidenceSetDigest: receipt.evidence_set_digest,
      prerequisiteReceiptSetDigest: receipt.prerequisite_receipt_set_digest,
      commandDagDigest: receipt.command_dag_digest,
      ownedReportsInventoryDigest: receipt.owned_reports_inventory_digest,
      privacySafe: true,
    };
    const entry: Record<string, any> = {
      ledgerEventId: "ledger-event",
      workspaceId: `plan-receipt:${receipt.plan}`,
      pactium: { receiptId: "fact" },
    };
    const committedReceipt: Record<string, any> = {
      kind: "plan-final-receipt",
      plan: receipt.plan,
      receiptDigest: receipt.receipt_digest,
      context: anchoredContext,
    };
    const proofSubstrate: Record<string, any> = {
      exportProofBundle: async () : Promise<any> => ({ proof: true }),
      verifyReceipt: async () : Promise<any> => ({ ok: true }),
      getReceipt: async () : Promise<any> => entry,
      verifyReceiptCommitment: async ({ commitment }: Record<string, any>) : Promise<any> => ({
        ok: JSON.stringify(commitment) === JSON.stringify(committedReceipt),
      }),
    };

    await expect(verifyPlanReceiptProofAnchor({ repoRoot: "/synthetic-repo", receipt, proofSubstrate }))
      .resolves.toMatchObject({ ok: true });
    receipt.privacy_safe = false;
    await expect(verifyPlanReceiptProofAnchor({ repoRoot: "/synthetic-repo", receipt, proofSubstrate }))
      .resolves.toMatchObject({ ok: false, reason: "proof-entry-binding-mismatch" });
  });

  it("keeps parent acceptance state outside a child source-tree fingerprint", async () : Promise<any> => {
    const repoRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "plan-receipt-tree-"));
    temporaryRoots.push(repoRoot);
    const strategyPlan: any = path.join(
      repoRoot,
      "docs",
      "plans",
      "end-to-end-release",
      "example-nested",
    );
    await fs.mkdir(strategyPlan, { recursive: true });
    await fs.writeFile(path.join(repoRoot, "docs", "plans", "Manifest.json"), "[]\n", "utf8");
    await fs.writeFile(path.join(strategyPlan, "Checkpoints.json"), "[]\n", "utf8");
    await fs.writeFile(path.join(strategyPlan, "Plan.md"), "# Strategy Management\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "source.ts"), "export const value = 1;\n", "utf8");
    const initialized: any = spawnSync("git", ["init", "--quiet"], { cwd: repoRoot });
    expect(initialized.status).toBe(0);
    expect(spawnSync("git", ["add", "."], { cwd: repoRoot }).status).toBe(0);
    expect(spawnSync("git", [
      "-c", "user.name=Plan Receipt Test",
      "-c", "user.email=plan-receipt@example.invalid",
      "commit", "--quiet", "-m", "initial",
    ], { cwd: repoRoot }).status).toBe(0);

    const initialDigest: any = planReceiptSourceTreeDigest(repoRoot);
    await fs.writeFile(
      path.join(strategyPlan, "Checkpoints.json"),
      '[{"acceptance":{"phase":"auditor_running"}}]\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, "docs", "plans", "Manifest.json"),
      '[{"status":"in_progress"}]\n',
      "utf8",
    );
    expect(planReceiptSourceTreeDigest(repoRoot)).toBe(initialDigest);

    await fs.writeFile(path.join(repoRoot, "source.ts"), "export const value = 2;\n", "utf8");
    expect(planReceiptSourceTreeDigest(repoRoot)).toBe(initialDigest);
    expect(spawnSync("git", ["add", "source.ts"], { cwd: repoRoot }).status).toBe(0);
    expect(spawnSync("git", [
      "-c", "user.name=Plan Receipt Test",
      "-c", "user.email=plan-receipt@example.invalid",
      "commit", "--quiet", "-m", "change source",
    ], { cwd: repoRoot }).status).toBe(0);
    expect(planReceiptSourceTreeDigest(repoRoot)).not.toBe(initialDigest);

    const mapPlan: any = currentMapPlan(
      "end-to-end-release/example-nested",
    );
    const stableTreeDigest: any = planReceiptSourceTreeDigest(repoRoot);
    const firstReceipt: any = buildReceipt({
      planDirectory: mapPlan.directory,
      mapPlan,
      checkpointsText: "checkpoint-state-a",
      finalNode: finalNode(),
      repositoryTreeDigest: stableTreeDigest,
    });
    const changedReceipt: any = buildReceipt({
      planDirectory: mapPlan.directory,
      mapPlan,
      checkpointsText: "checkpoint-state-b",
      finalNode: finalNode(),
      repositoryTreeDigest: stableTreeDigest,
    });
    expect(changedReceipt.receipt_digest).not.toBe(firstReceipt.receipt_digest);
  });

  it("ignores observation timestamps while preserving semantic changes", () : any => {
    const first: any = JSON.stringify({
      schemaVersion: "report-schema",
      generatedAt: "2026-01-01T00:00:00.000Z",
      checkedAt: "2026-01-01T00:00:01.000Z",
      summary: { accepted: true, count: 3 },
    });
    const rerun: any = JSON.stringify({
      checkedAt: "2026-02-01T00:00:01.000Z",
      summary: { count: 3, accepted: true },
      generatedAt: "2026-02-01T00:00:00.000Z",
      schemaVersion: "report-schema",
    });
    const changed: any = JSON.stringify({
      schemaVersion: "report-schema",
      generatedAt: "2026-02-01T00:00:00.000Z",
      checkedAt: "2026-02-01T00:00:01.000Z",
      summary: { accepted: false, count: 3 },
    });

    expect(REPORT_DIGEST_ALGORITHM).toBe("canonical-json-without-observation-time");
    expect(reportDigest(rerun)).toBe(reportDigest(first));
    expect(reportDigest(changed)).not.toBe(reportDigest(first));
  });

  it("rejects every final receipt mutation even when the fixture has no prerequisites", async () : Promise<any> => {
    const result: any = await runReceiptReductionMutationTests();

    expect(result.accepted).toBe(true);
    expect(result.mutation_case_count).toBe(10);
    expect(result.cases).toContainEqual(expect.objectContaining({
      name: "stale-prerequisite-receipts",
      rejected: true,
    }));
  });

  it("binds contract prerequisites to the completed contract node instead of a sibling final receipt", () : any => {
    const completed: any = createPlanContractReceipt({
      plan: "end-to-end-release/example-provider",
      nodeId: "contract-node",
      node: { id: "contract-node", role: "implementation", status: "completed", requirements: ["REQ-1"] }
    });
    const changed: any = createPlanContractReceipt({
      plan: "end-to-end-release/example-provider",
      nodeId: "contract-node",
      node: { id: "contract-node", role: "implementation", status: "completed", requirements: ["REQ-1", "REQ-2"] }
    });

    expect(completed).toMatchObject({
      schema_version: "v0.0.1:meshrix:plan-contract-receipt-1",
      kind: "contract",
      status: "completed"
    });
    expect(completed.receipt_digest).not.toBe(changed.receipt_digest);
  });

  it("fails closed for missing prerequisites and incomplete contract nodes", () : any => {
    expect(() : any => createPlanContractReceipt({
      plan: "end-to-end-release/provider",
      nodeId: "contract-node",
      node: { id: "contract-node", status: "pending" }
    })).toThrow("completed contract node");

    expect(() : any => buildReceipt({
      planDirectory: "end-to-end-release/consumer",
      mapPlan: currentMapPlan("end-to-end-release/consumer", {
        prerequisiteReceipts: [{
          plan: "end-to-end-release/provider",
          node_id: "provider-final",
          kind: "final_validation",
          profiles: ["enterprise-single-node"],
        }],
      }),
      checkpointsText: "[]",
      finalNode: finalNode()
    })).toThrow("Prerequisite final_validation receipt is missing");

    const providerReceipt: any = buildReceipt({
      planDirectory: "end-to-end-release/provider",
      mapPlan: currentMapPlan("end-to-end-release/provider"),
      checkpointsText: "[]",
      finalNode: finalNode()
    });
    expect(() : any => buildReceipt({
      planDirectory: "end-to-end-release/consumer",
      mapPlan: currentMapPlan("end-to-end-release/consumer", {
        prerequisiteReceipts: [{
          plan: "end-to-end-release/provider",
          node_id: "final-node",
          kind: "final_validation",
          profiles: ["enterprise-single-node"],
        }],
      }),
      checkpointsText: "[]",
      finalNode: finalNode(),
      prerequisiteReceiptsByKey: {
        [planReceiptKey("end-to-end-release/provider", "final-node")]: providerReceipt,
      },
    })).toThrow("Prerequisite receipt is not verified");
  });

  it("accepts only digest-bound command evidence and never retains command text", () : any => {
    const mapPlan: any = currentMapPlan();
    expect(() : any => buildReceipt({
      planDirectory: "end-to-end-release/example",
      mapPlan,
      checkpointsText: "[]",
      finalNode: finalNode({ type: "command", command: "npm test", exit_code: 0, recorded_at: null })
    })).toThrow("must not contain command text");

    const receipt: any = buildReceipt({
      planDirectory: "end-to-end-release/example",
      mapPlan,
      checkpointsText: "[]",
      finalNode: finalNode({ type: "command", command_sha256: "b".repeat(64), exit_code: 0, recorded_at: null })
    });
    expect(receipt.evidence_refs[0]).toMatchObject({ type: "command", command_sha256: "b".repeat(64) });
    expect(receipt.evidence_refs[0]).not.toHaveProperty("command");
  });

  it("normalizes Plan directories before reads and leaves authority bytes unchanged on rejection", async () : Promise<any> => {
    expect(normalizePlanDirectory("end-to-end-release/example")).toBe("end-to-end-release/example");
    expect(() : any => normalizePlanDirectory("end-to-end-release/../outside")).toThrow("canonical contained Plan path");

    const repoRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "plan-receipt-containment-"));
    temporaryRoots.push(repoRoot);
    const mapPath: any = path.join(repoRoot, "docs", "plans", "end-to-end-release", "DependencyMap.json");
    await fs.mkdir(path.dirname(mapPath), { recursive: true });
    const original: any = "synthetic-authority-bytes\n";
    await fs.writeFile(mapPath, original, "utf8");

    await expect(reduceEndToEndReleaseReceipt({
      repoRoot,
      planDirectory: "end-to-end-release/../outside",
      planProfile: "enterprise-single-node",
      write: true
    })).rejects.toThrow("canonical contained Plan path");
    await expect(fs.readFile(mapPath, "utf8")).resolves.toBe(original);
    await expect(fs.stat(path.join(repoRoot, "build", "plan-proof-ledger"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
