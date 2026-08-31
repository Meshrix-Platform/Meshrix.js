import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createOperationProofSubstrate } from "#meshrix/foundation/proof/proof-substrate/index";

import {
  anchorAcceptanceEvidence,
  verifyAcceptanceEvidenceAnchor,
} from "../../../tools/server-scripts/lib/platform-acceptance-ledger-anchor.ts";

describe("platform acceptance ledger anchoring", () => {
  it("anchors candidate evidence without exposing a parallel Plan-receipt API", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-acceptance-anchor-"));
    const reportPath = path.join(root, "sample-report.json");
    await fs.writeFile(reportPath, `${JSON.stringify({
      schemaVersion: "v0.0.1:acceptance:platform-report-3",
      status: "accepted",
    })}\n`, "utf8");
    const proofSubstrate: any = createOperationProofSubstrate({ dataDir: path.join(root, "proof") });
    try {
      expect(proofSubstrate.recordPlanReceiptEvidence).toBeUndefined();
      const anchor: any = await anchorAcceptanceEvidence({
        proofSubstrate,
        reportPaths: ["sample-report.json"],
        evidenceContext: {
          sourceRevision: "a".repeat(40),
          sourceTreeDigest: `sha256:${"f".repeat(64)}`,
          selectedProfile: "enterprise-single-node",
          commandDagDigest: `sha256:${"b".repeat(64)}`,
          ownedReportsInventoryDigest: `sha256:${"c".repeat(64)}`,
          candidateDigest: "d".repeat(64),
          privacySafe: true,
        },
        releaseId: "unit-release-1",
        repoRoot: root,
      });
      expect(anchor.error || "").toBe("");
      expect(anchor.workspaceId).toBe("release:unit-release-1");
      await expect(verifyAcceptanceEvidenceAnchor({
        proofSubstrate,
        ledgerEventId: anchor.ledgerEventId,
        envelopeId: anchor.envelopeId,
        workspaceId: anchor.workspaceId,
        expectedReportDigests: anchor.reportDigests,
        expectedEvidenceContext: anchor.evidenceContext,
      })).resolves.toMatchObject({ ok: true });
    } finally {
      await proofSubstrate.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
