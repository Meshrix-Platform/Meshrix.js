import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { containsSensitiveReportData } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import {
  SERVICE_COLLABORATION_CORE_STATE_GENERATION,
  SERVICE_COLLABORATION_LOOKUP_FACTS,
  SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED,
  containsForbiddenKeys,
  lookupFactIsAuthority
} from "../../../packages/contracts/src/service-collaboration-contract.ts";
import {
  WORKSPACE_REFERENCE_MIGRATION_AUTHORITY_ID,
  WORKSPACE_REFERENCE_MIGRATION_NON_CERTIFICATION_REASON,
  WORKSPACE_REFERENCE_MIGRATION_OWNED_MODULE,
  createWorkspaceReferenceMigration
} from "../../../packages/agents/src/agent-workspace/workspace-reference-migration.ts";
import {
  WORKSPACE_COLLABORATION_MIGRATION_REPORT_RELATIVE_PATH,
  WORKSPACE_COLLABORATION_MIGRATION_VERIFIER,
  assertWorkspaceCollaborationResidue,
  assertWorkspaceReferenceMigration,
  buildWorkspaceCollaborationMigrationReport
} from "../../../tools/server-scripts/verify-workspace-collaboration-migration.ts";

const PROJECT_ROOT: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ABSOLUTE_PATH_PATTERN: any = /(?:\/(?:Users|home|private|var\/folders|root)\/|[A-Za-z]:\\)/u;

describe("workspace reference migration", () : any => {
  it("keeps lookup facts from becoming authority and forbids a second Core generation", () : any => {
    for (const fact of SERVICE_COLLABORATION_LOOKUP_FACTS) {
      expect(lookupFactIsAuthority(fact)).toBe(false);
    }
    expect(SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED).toBe(false);
    expect(WORKSPACE_REFERENCE_MIGRATION_AUTHORITY_ID).toBe("WorkspaceReferenceMigration");
    expect(assertWorkspaceCollaborationResidue(PROJECT_ROOT).residueAbsent).toBe(true);
  });

  it("converges peers through bounded deltas, one dirty apply, and restore-as-new-change", async () : Promise<any> => {
    const session: any = createWorkspaceReferenceMigration({
      instanceId: "test.wrm.1",
      workingSetId: "ws.wrm.test"
    });
    const opened: any = await session.open({
      assets: [{ assetId: "ast.wrm.1", entityId: "ent.wrm.file.1", handle: "hdl_wrm_1" }]
    });
    expect(opened.head).toBe(0);
    expect(session.observeLocal({ handle: "hdl_wrm_1" }).cacheHit).toBe(true);

    const suggested: any = session.suggest({ handle: "hdl_wrm_1", attributionRef: "attr.wrm.suggest" });
    expect(suggested.dualWrite).toBe(false);
    expect(suggested.changeSetApplyCalls).toBe(0);

    const clean: any = await session.commitTurn({ handle: "hdl_wrm_1", dirty: false });
    expect(clean.applyDelta).toBe(0);
    expect(clean.assignedHead).toBe(0);

    const dirty: any = await session.commitTurn({
      handle: "hdl_wrm_1",
      dirty: true,
      changeId: "chg.wrm.test.1",
      opId: "op.wrm.test.1",
      baselineHead: 0
    });
    expect(dirty.applyDelta).toBe(1);
    expect(dirty.assignedHead).toBe(1);
    expect(session.peers().converged).toBe(true);

    const restored: any = await session.restoreAsNewChange({
      handle: "hdl_wrm_1",
      checkpointId: "ckpt.wrm.1"
    });
    expect(restored.restoreAsNewChange).toBe(true);
    expect(restored.rewound).toBe(false);
    expect(restored.reversesUnownedEffect).toBe(false);
    expect(restored.assignedHead).toBe(2);
    expect(session.routeEffect({ kind: "unshare", effectId: "eff.wrm.unshare" }).mergedIntoChangeSet).toBe(false);
    session.close();
  });

  it("writes a privacy-safe non-certifying report", async () : Promise<any> => {
    const assertion: any = await assertWorkspaceReferenceMigration();
    const report: any = buildWorkspaceCollaborationMigrationReport(assertion, {
      generatedAt: "1970-01-01T00:00:00.000Z",
      focusedSuitePassed: true
    });
    const text: any = JSON.stringify(report);
    expect(assertion.coreStateGeneration).toBe(SERVICE_COLLABORATION_CORE_STATE_GENERATION);
    expect(assertion.capacityCertified).toBe(false);
    expect(assertion.reason).toBe(WORKSPACE_REFERENCE_MIGRATION_NON_CERTIFICATION_REASON);
    expect(assertion.peersConverged).toBe(true);
    expect(assertion.residueAbsent).toBe(true);
    expect(report.schemaVersion).toBe(assertion.schemaVersion);
    expect(report.verifier).toBe(WORKSPACE_COLLABORATION_MIGRATION_VERIFIER);
    expect(WORKSPACE_COLLABORATION_MIGRATION_REPORT_RELATIVE_PATH.startsWith("build/reports/")).toBe(true);
    expect(WORKSPACE_REFERENCE_MIGRATION_OWNED_MODULE).toContain("workspace-reference-migration.ts");
    expect(containsForbiddenKeys(report)).toBe(false);
    expect(containsSensitiveReportData(report)).toBe(false);
    expect(ABSOLUTE_PATH_PATTERN.test(text)).toBe(false);
  });
});
