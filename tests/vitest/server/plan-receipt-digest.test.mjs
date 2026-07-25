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
} from "../../../tools/plan/plan-final-receipt.mjs";
import {
  reduceEndToEndReleaseReceipt,
  runReceiptReductionMutationTests,
} from "../../../tools/plan/reduce-end-to-end-release-receipt.mjs";
import { verifyPlanEvidenceCurrent } from "../../../tools/plan/plan-evidence-verifier.mjs";
import {
  createPlanContractReceipt,
  normalizePlanDirectory,
  planReceiptSourceTreeDigest
} from "../../../tools/plan/plan-receipt-context.mjs";
import { planReceiptKey } from "../../../tools/plan/plan-dependency-map.mjs";

const temporaryRoots = [];
const RECORDED_AT = "2026-07-19T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function finalNode(evidenceRef = { type: "file", path: "build/reports/example.json", sha256: "a".repeat(64) }) {
  return {
    id: "final-node",
    role: "final_validation",
    status: "completed",
    platform: "any",
    requirements: ["REQ-1"],
    commit: { delivered: "source-revision" },
    acceptance_criteria: [{ checked: true, text: "accepted", evidence_refs: [evidenceRef] }]
  };
}

function buildReceipt(options) {
  return buildPlanFinalReceipt(options);
}

function currentMapPlan(directory = "end-to-end-release/example", {
  finalNodeId = "final-node",
  profiles = ["enterprise-single-node"],
  prerequisiteReceipts = [],
} = {}) {
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

function evidenceNode(...evidenceRefs) {
  return {
    acceptance_criteria: [{ checked: true, evidence_refs: evidenceRefs }],
  };
}

function fileEvidence(pathname, sha256, overrides = {}) {
  return {
    type: "file",
    path: pathname,
    sha256,
    recorded_at: RECORDED_AT,
    ...overrides,
  };
}

function commandEvidence(overrides = {}) {
  return {
    type: "command",
    command_sha256: "d".repeat(64),
    exit_code: 0,
    recorded_at: RECORDED_AT,
    ...overrides,
  };
}

async function createEvidenceRepository() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plan-evidence-"));
  temporaryRoots.push(repoRoot);
  const reportPath = path.join(repoRoot, "reports", "result.json");
  const reportBytes = Buffer.from('{"accepted":true}\n');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, reportBytes);
  return {
    repoRoot,
    reportPath,
    reportDigest: crypto.createHash("sha256").update(reportBytes).digest("hex"),
  };
}

describe("plan receipt report digests", () => {
  it("accepts current file and successful digest-bound command evidence", async () => {
    const { repoRoot, reportDigest } = await createEvidenceRepository();

    await expect(verifyPlanEvidenceCurrent({
      repoRoot,
      finalNode: evidenceNode(
        fileEvidence("reports/result.json", reportDigest),
        commandEvidence(),
      ),
    })).resolves.toEqual({ evidenceCount: 2, fileCount: 1, commandCount: 1 });
  });

  it("rejects tampered, missing, escaping, and symlink file evidence", async () => {
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

    const targetPath = path.join(repoRoot, "reports", "target.json");
    const symlinkPath = path.join(repoRoot, "reports", "linked.json");
    await fs.writeFile(targetPath, "synthetic\n", "utf8");
    await fs.symlink(targetPath, symlinkPath);
    const targetDigest = crypto.createHash("sha256").update("synthetic\n").digest("hex");
    await expect(verifyPlanEvidenceCurrent({
      repoRoot,
      finalNode: evidenceNode(fileEvidence("reports/linked.json", targetDigest)),
    })).rejects.toThrow("Plan file evidence is not a regular file");
  });

  it("rejects failed commands, non-canonical timestamps, and unsupported evidence fields", async () => {
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

  it("keeps historical environment facts immutable while requiring current Plan authority", () => {
    const mapPlan = currentMapPlan();
    const context = {
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
    const receipt = bindPlanReceiptProofAnchor(buildReceipt(context), {
      provider: "pactium.operation-proof-substrate",
      receipt_digest: buildReceipt(context).receipt_digest,
      ledger_event_id: "ledger-event",
      envelope_id: "envelope",
      fact_id: "fact",
      verified: true,
    });

    expect(() => assertReceiptPlanCurrent(receipt, {
      ...context,
      repositoryRevision: "new-revision",
      repositoryTreeDigest: "sha256:new-tree",
      commandDagDigest: "sha256:new-command-dag",
      ownedReportsInventoryDigest: "sha256:new-reports",
    })).not.toThrow();
    expect(() => assertReceiptCurrent(receipt, {
      ...context,
      repositoryRevision: "new-revision",
    })).toThrow("facts are absent or stale");
    expect(() => assertReceiptPlanCurrent(receipt, {
      ...context,
      planText: "Plan.md\nchanged\n",
    })).toThrow("facts are absent or stale");
  });

  it("binds v4 receipts to the enterprise profile and rejects the superseded single-final shape", () => {
    const mapPlan = currentMapPlan("end-to-end-release/example", {
      profiles: ["enterprise-single-node"],
    });
    const receipt = buildPlanFinalReceipt({
      planDirectory: mapPlan.directory,
      mapPlan,
      checkpointsText: "[]",
      finalNode: finalNode(),
    });
    expect(receipt.profiles).toEqual(["enterprise-single-node"]);
    expect(receipt).not.toHaveProperty("selected_profile");

    expect(() => buildPlanFinalReceipt({
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

  it("reverifies the proof entry and its complete receipt context instead of trusting a boolean", async () => {
    const mapPlan = currentMapPlan();
    const draft = buildReceipt({
      planDirectory: mapPlan.directory,
      mapPlan,
      checkpointsText: "[]",
      finalNode: finalNode(),
    });
    const receipt = bindPlanReceiptProofAnchor(draft, {
      provider: "pactium.operation-proof-substrate",
      receipt_digest: draft.receipt_digest,
      ledger_event_id: "ledger-event",
      envelope_id: "envelope",
      fact_id: "fact",
      verified: true,
    });
    const anchoredContext = {
      checkpointDigest: receipt.checkpoint_digest,
      repositoryTreeDigest: receipt.repository_tree_digest,
      evidenceSetDigest: receipt.evidence_set_digest,
      prerequisiteReceiptSetDigest: receipt.prerequisite_receipt_set_digest,
      commandDagDigest: receipt.command_dag_digest,
      ownedReportsInventoryDigest: receipt.owned_reports_inventory_digest,
      privacySafe: true,
    };
    const entry = {
      ledgerEventId: "ledger-event",
      workspaceId: `plan-receipt:${receipt.plan}`,
      pactium: { receiptId: "fact" },
    };
    const committedReceipt = {
      kind: "plan-final-receipt",
      plan: receipt.plan,
      receiptDigest: receipt.receipt_digest,
      context: anchoredContext,
    };
    const proofSubstrate = {
      exportProofBundle: async () => ({ proof: true }),
      verifyReceipt: async () => ({ ok: true }),
      getReceipt: async () => entry,
      verifyReceiptCommitment: async ({ commitment }) => ({
        ok: JSON.stringify(commitment) === JSON.stringify(committedReceipt),
      }),
    };

    await expect(verifyPlanReceiptProofAnchor({ repoRoot: "/synthetic-repo", receipt, proofSubstrate }))
      .resolves.toMatchObject({ ok: true });
    receipt.privacy_safe = false;
    await expect(verifyPlanReceiptProofAnchor({ repoRoot: "/synthetic-repo", receipt, proofSubstrate }))
      .resolves.toMatchObject({ ok: false, reason: "proof-entry-binding-mismatch" });
  });

  it("keeps parent acceptance state outside a child source-tree fingerprint", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plan-receipt-tree-"));
    temporaryRoots.push(repoRoot);
    const strategyPlan = path.join(
      repoRoot,
      "docs",
      "plans",
      "end-to-end-release",
      "operator-administration",
      "strategy-management",
    );
    await fs.mkdir(strategyPlan, { recursive: true });
    await fs.writeFile(path.join(repoRoot, "docs", "plans", "Manifest.json"), "[]\n", "utf8");
    await fs.writeFile(path.join(strategyPlan, "Checkpoints.json"), "[]\n", "utf8");
    await fs.writeFile(path.join(strategyPlan, "Plan.md"), "# Strategy Management\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "source.mjs"), "export const value = 1;\n", "utf8");
    const initialized = spawnSync("git", ["init", "--quiet"], { cwd: repoRoot });
    expect(initialized.status).toBe(0);
    expect(spawnSync("git", ["add", "."], { cwd: repoRoot }).status).toBe(0);
    expect(spawnSync("git", [
      "-c", "user.name=Plan Receipt Test",
      "-c", "user.email=plan-receipt@example.invalid",
      "commit", "--quiet", "-m", "initial",
    ], { cwd: repoRoot }).status).toBe(0);

    const initialDigest = planReceiptSourceTreeDigest(repoRoot);
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

    await fs.writeFile(path.join(repoRoot, "source.mjs"), "export const value = 2;\n", "utf8");
    expect(planReceiptSourceTreeDigest(repoRoot)).toBe(initialDigest);
    expect(spawnSync("git", ["add", "source.mjs"], { cwd: repoRoot }).status).toBe(0);
    expect(spawnSync("git", [
      "-c", "user.name=Plan Receipt Test",
      "-c", "user.email=plan-receipt@example.invalid",
      "commit", "--quiet", "-m", "change source",
    ], { cwd: repoRoot }).status).toBe(0);
    expect(planReceiptSourceTreeDigest(repoRoot)).not.toBe(initialDigest);

    const mapPlan = currentMapPlan(
      "end-to-end-release/operator-administration/strategy-management",
    );
    const stableTreeDigest = planReceiptSourceTreeDigest(repoRoot);
    const firstReceipt = buildReceipt({
      planDirectory: mapPlan.directory,
      mapPlan,
      checkpointsText: "checkpoint-state-a",
      finalNode: finalNode(),
      repositoryTreeDigest: stableTreeDigest,
    });
    const changedReceipt = buildReceipt({
      planDirectory: mapPlan.directory,
      mapPlan,
      checkpointsText: "checkpoint-state-b",
      finalNode: finalNode(),
      repositoryTreeDigest: stableTreeDigest,
    });
    expect(changedReceipt.receipt_digest).not.toBe(firstReceipt.receipt_digest);
  });

  it("ignores observation timestamps while preserving semantic changes", () => {
    const first = JSON.stringify({
      schemaVersion: "report-schema",
      generatedAt: "2026-01-01T00:00:00.000Z",
      checkedAt: "2026-01-01T00:00:01.000Z",
      summary: { accepted: true, count: 3 },
    });
    const rerun = JSON.stringify({
      checkedAt: "2026-02-01T00:00:01.000Z",
      summary: { count: 3, accepted: true },
      generatedAt: "2026-02-01T00:00:00.000Z",
      schemaVersion: "report-schema",
    });
    const changed = JSON.stringify({
      schemaVersion: "report-schema",
      generatedAt: "2026-02-01T00:00:00.000Z",
      checkedAt: "2026-02-01T00:00:01.000Z",
      summary: { accepted: false, count: 3 },
    });

    expect(REPORT_DIGEST_ALGORITHM).toBe("canonical-json-without-observation-time");
    expect(reportDigest(rerun)).toBe(reportDigest(first));
    expect(reportDigest(changed)).not.toBe(reportDigest(first));
  });

  it("rejects every final receipt mutation even when the fixture has no prerequisites", async () => {
    const result = await runReceiptReductionMutationTests();

    expect(result.accepted).toBe(true);
    expect(result.mutation_case_count).toBe(10);
    expect(result.cases).toContainEqual(expect.objectContaining({
      name: "stale-prerequisite-receipts",
      rejected: true,
    }));
  });

  it("binds contract prerequisites to the completed contract node instead of a sibling final receipt", () => {
    const completed = createPlanContractReceipt({
      plan: "end-to-end-release/example-provider",
      nodeId: "contract-node",
      node: { id: "contract-node", role: "implementation", status: "completed", requirements: ["REQ-1"] }
    });
    const changed = createPlanContractReceipt({
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

  it("fails closed for missing prerequisites and incomplete contract nodes", () => {
    expect(() => createPlanContractReceipt({
      plan: "end-to-end-release/provider",
      nodeId: "contract-node",
      node: { id: "contract-node", status: "pending" }
    })).toThrow("completed contract node");

    expect(() => buildReceipt({
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

    const providerReceipt = buildReceipt({
      planDirectory: "end-to-end-release/provider",
      mapPlan: currentMapPlan("end-to-end-release/provider"),
      checkpointsText: "[]",
      finalNode: finalNode()
    });
    expect(() => buildReceipt({
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

  it("accepts only digest-bound command evidence and never retains command text", () => {
    const mapPlan = currentMapPlan();
    expect(() => buildReceipt({
      planDirectory: "end-to-end-release/example",
      mapPlan,
      checkpointsText: "[]",
      finalNode: finalNode({ type: "command", command: "npm test", exit_code: 0, recorded_at: null })
    })).toThrow("must not contain command text");

    const receipt = buildReceipt({
      planDirectory: "end-to-end-release/example",
      mapPlan,
      checkpointsText: "[]",
      finalNode: finalNode({ type: "command", command_sha256: "b".repeat(64), exit_code: 0, recorded_at: null })
    });
    expect(receipt.evidence_refs[0]).toMatchObject({ type: "command", command_sha256: "b".repeat(64) });
    expect(receipt.evidence_refs[0]).not.toHaveProperty("command");
  });

  it("normalizes Plan directories before reads and leaves authority bytes unchanged on rejection", async () => {
    expect(normalizePlanDirectory("end-to-end-release/example")).toBe("end-to-end-release/example");
    expect(() => normalizePlanDirectory("end-to-end-release/../outside")).toThrow("canonical contained Plan path");

    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plan-receipt-containment-"));
    temporaryRoots.push(repoRoot);
    const mapPath = path.join(repoRoot, "docs", "plans", "end-to-end-release", "DependencyMap.json");
    await fs.mkdir(path.dirname(mapPath), { recursive: true });
    const original = "synthetic-authority-bytes\n";
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
