#!/usr/bin/env node
/**
 * Acceptance evidence ledger anchoring coverage.
 * Anchors report digests through the foundation proof substrate and verifies
 * the readiness-shaped ledgerAnchor reference against the ledger head.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOperationProofSubstrate } from "#lico/foundation/proof/proof-substrate/index";
import {
  anchorAcceptanceEvidence,
  verifyAcceptanceEvidenceAnchor
} from "./lib/platform-acceptance-ledger-anchor.mjs";

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-acceptance-ledger-anchor-"));
  const reportPath = path.join(root, "sample-report.json");
  await fs.writeFile(reportPath, `${JSON.stringify({
    schemaVersion: "v0.0.1:acceptance:platform-report-2",
    status: "accepted",
    summary: { releaseReady: true }
  }, null, 2)}\n`, "utf8");

  const proofSubstrate = createOperationProofSubstrate({ dataDir: path.join(root, "proof") });
  try {
    const releaseId = "verify-acceptance-ledger-anchor";
    const digest = (label) => `sha256:${Buffer.from(label).toString("hex").padEnd(64, "0").slice(0, 64)}`;
    const anchor = await anchorAcceptanceEvidence({
      proofSubstrate,
      reportPaths: ["sample-report.json"],
      repoRoot: root,
      releaseId,
      evidenceContext: {
        sourceRevision: "a".repeat(40),
        sourceTreeDigest: digest("source-tree"),
        selectedProfile: "core",
        commandDagDigest: digest("command-dag"),
        ownedReportsInventoryDigest: digest("owned-reports"),
        planReceiptSetDigest: digest("plan-receipts"),
        privacySafe: true
      }
    });
    assert.equal(anchor.error || "", "", `anchor error: ${anchor.error || ""}`);
    assert.ok(anchor.ledgerEventId, "ledgerEventId required");
    assert.equal(anchor.workspaceId, `release:${releaseId}`);

    const verification = await verifyAcceptanceEvidenceAnchor({
      proofSubstrate,
      ledgerEventId: anchor.ledgerEventId,
      envelopeId: anchor.envelopeId,
      workspaceId: anchor.workspaceId,
      expectedReportDigests: anchor.reportDigests,
      expectedEvidenceContext: anchor.evidenceContext
    });
    assert.equal(verification.ok, true, `verification failed: ${verification.reason || ""}`);

    const readinessShape = {
      ledgerAnchor: {
        ledgerEventId: anchor.ledgerEventId,
        envelopeId: anchor.envelopeId,
        factId: anchor.factId,
        workspaceId: anchor.workspaceId,
        recordedAt: anchor.recordedAt,
        reportDigestCount: anchor.reportDigestCount,
        verification
      },
      summary: {
        ledgerEventId: anchor.ledgerEventId,
        ledgerAnchorReady: Boolean(anchor.ledgerEventId) && verification.ok === true
      }
    };
    assert.equal(readinessShape.summary.ledgerAnchorReady, true);
    assert.ok(readinessShape.ledgerAnchor.ledgerEventId);

    const serialized = JSON.stringify(readinessShape);
    assert.equal(serialized.includes("releaseReady"), false, "must not embed report bodies");
  } finally {
    await proofSubstrate.close?.();
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log("acceptance ledger anchor verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
