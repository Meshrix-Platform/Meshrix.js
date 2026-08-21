import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createOperationProofSubstrate } from "#meshrix/foundation/proof/proof-substrate/index";
import { verifyPlanReceiptProofAnchor } from "../../../tools/plan/plan-final-receipt.ts";
import {
  anchorAcceptanceEvidence,
  verifyAcceptanceEvidenceAnchor
} from "../../../tools/server-scripts/lib/platform-acceptance-ledger-anchor.ts";

describe("platform acceptance ledger anchoring", () : any => {
  const evidenceContext: Readonly<Record<string, any>> = Object.freeze({
    sourceRevision: "a".repeat(40),
    sourceTreeDigest: `sha256:${"f".repeat(64)}`,
    selectedProfile: "enterprise-single-node",
    commandDagDigest: `sha256:${"b".repeat(64)}`,
    ownedReportsInventoryDigest: `sha256:${"c".repeat(64)}`,
    candidateDigest: "d".repeat(64),
    privacySafe: true
  });

  it("anchors report digests and verifies them against the ledger head", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-acceptance-anchor-"));
    const reportPath: any = path.join(root, "sample-report.json");
    await fs.writeFile(reportPath, `${JSON.stringify({
      schemaVersion: "v0.0.1:acceptance:platform-report-3",
      status: "accepted",
      summary: { releaseReady: true }
    }, null, 2)}\n`, "utf8");
    const proofSubstrate: any = createOperationProofSubstrate({ dataDir: path.join(root, "proof") });
    try {
      const anchor: any = await anchorAcceptanceEvidence({
        proofSubstrate,
        reportPaths: ["sample-report.json"],
        evidenceContext,
        releaseId: "unit-release-1",
        repoRoot: root
      });
      expect(anchor.error || "").toBe("");
      expect(anchor.ledgerEventId).toBeTruthy();
      expect(anchor.workspaceId).toBe("release:unit-release-1");
      expect(anchor.reportDigestCount).toBe(1);
      const head: any = await proofSubstrate.pactiumRuntime.core.readLedgerHead();
      expect(head.size).toBe(1);
      await expect(proofSubstrate.pactiumRuntime.core.readLedgerLeaf(0))
        .resolves.toMatchObject({ fact: { factType: "operation.receipt" } });

      const verification: any = await verifyAcceptanceEvidenceAnchor({
        proofSubstrate,
        ledgerEventId: anchor.ledgerEventId,
        envelopeId: anchor.envelopeId,
        workspaceId: anchor.workspaceId,
        expectedReportDigests: anchor.reportDigests,
        expectedEvidenceContext: anchor.evidenceContext
      });
      expect(verification.ok).toBe(true);

      const entries: any = await proofSubstrate.listReceipts({ limit: 20 });
      for (const entry of entries) {
        const serialized: any = JSON.stringify(entry || {});
        expect(serialized.includes("releaseReady")).toBe(false);
      }
    } finally {
      await proofSubstrate.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when releaseId is missing", async () : Promise<any> => {
    const anchor: any = await anchorAcceptanceEvidence({
      proofSubstrate: { recordAcceptanceEvidence: async () : Promise<any> => ({ ledgerEventId: "x" }) },
      reportPaths: ["build/reports/x.json"],
      releaseId: ""
    });
    expect(anchor.ledgerEventId).toBe("");
    expect(anchor.error).toMatch(/releaseId/i);
  });

  it("anchors an exact Plan receipt digest and verifies the Pactium bundle", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plan-receipt-anchor-"));
    const proofSubstrate: any = createOperationProofSubstrate({ dataDir: path.join(root, "proof") });
    try {
      const receiptDigest: any = "e".repeat(64);
      const receipt: Record<string, any> = {
        plan: "end-to-end-release/fixture",
        receipt_digest: receiptDigest,
        checkpoint_digest: "a".repeat(64),
        repository_tree_digest: "b".repeat(64),
        evidence_set_digest: "c".repeat(64),
        prerequisite_receipt_set_digest: "d".repeat(64),
        command_dag_digest: `sha256:${"e".repeat(64)}`,
        owned_reports_inventory_digest: `sha256:${"f".repeat(64)}`,
        privacy_safe: true,
      };
      const context: Record<string, any> = {
        checkpointDigest: receipt.checkpoint_digest,
        repositoryTreeDigest: receipt.repository_tree_digest,
        evidenceSetDigest: receipt.evidence_set_digest,
        prerequisiteReceiptSetDigest: receipt.prerequisite_receipt_set_digest,
        commandDagDigest: receipt.command_dag_digest,
        ownedReportsInventoryDigest: receipt.owned_reports_inventory_digest,
        privacySafe: true,
      };
      const anchor: any = await proofSubstrate.recordPlanReceiptEvidence({
        plan: receipt.plan,
        receiptDigest,
        context
      });
      receipt.proof_anchor = {
        provider: "pactium.operation-proof-substrate",
        receipt_digest: receiptDigest,
        ledger_event_id: anchor.ledgerEventId,
        envelope_id: anchor.envelopeId,
        fact_id: anchor.factId,
        verified: true,
      };
      const bundle: any = await proofSubstrate.exportProofBundle({
        ledgerEventId: anchor.ledgerEventId,
        envelopeId: anchor.envelopeId,
        actor: { type: "system" }
      });
      await expect(proofSubstrate.verifyReceipt({ bundle })).resolves.toMatchObject({ ok: true });
      const entry: any = await proofSubstrate.getReceipt(anchor.ledgerEventId);
      expect(entry.proof).toMatchObject({ profile: "receipt", terminal: true });
      expect(entry).not.toHaveProperty("input");
      await expect(proofSubstrate.verifyReceiptCommitment({
        ledgerEventId: anchor.ledgerEventId,
        commitment: {
          kind: "plan-final-receipt",
          plan: receipt.plan,
          receiptDigest,
          context
        }
      })).resolves.toMatchObject({ ok: true });
      await expect(verifyPlanReceiptProofAnchor({ repoRoot: root, receipt, proofSubstrate }))
        .resolves.toEqual({ ok: true, reason: "verified-proof-entry" });
    } finally {
      await proofSubstrate.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unreadable reports and report-set drift", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-acceptance-anchor-"));
    const proofSubstrate: any = createOperationProofSubstrate({ dataDir: path.join(root, "proof") });
    try {
      const missing: any = await anchorAcceptanceEvidence({
        proofSubstrate,
        reportPaths: ["missing.json"],
        evidenceContext,
        releaseId: "unit-release-missing",
        repoRoot: root
      });
      expect(missing.ledgerEventId).toBe("");
      expect(missing.error).toContain("report digest unavailable");

      await fs.writeFile(path.join(root, "report.json"), JSON.stringify({ schemaVersion: "report-1" }));
      const anchor: any = await anchorAcceptanceEvidence({
        proofSubstrate,
        reportPaths: ["report.json"],
        evidenceContext,
        releaseId: "unit-release-mismatch",
        repoRoot: root
      });
      const verification: any = await verifyAcceptanceEvidenceAnchor({
        proofSubstrate,
        ledgerEventId: anchor.ledgerEventId,
        envelopeId: anchor.envelopeId,
        workspaceId: anchor.workspaceId,
        expectedReportDigests: [{
          ...anchor.reportDigests[0],
          contentHash: `sha256:${"0".repeat(64)}`
        }],
        expectedEvidenceContext: anchor.evidenceContext
      });
      expect(verification).toMatchObject({ ok: false, reason: "receipt-commitment-mismatch" });

      const contextMismatch: any = await verifyAcceptanceEvidenceAnchor({
        proofSubstrate,
        ledgerEventId: anchor.ledgerEventId,
        envelopeId: anchor.envelopeId,
        workspaceId: anchor.workspaceId,
        expectedReportDigests: anchor.reportDigests,
        expectedEvidenceContext: { ...anchor.evidenceContext, selectedProfile: "different" }
      });
      expect(contextMismatch).toMatchObject({ ok: false, reason: "receipt-commitment-mismatch" });
    } finally {
      await proofSubstrate.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
