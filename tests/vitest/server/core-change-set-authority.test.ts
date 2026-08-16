import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { containsSensitiveReportData } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import {
  SERVICE_COLLABORATION_CORE_STATE_GENERATION,
  SERVICE_COLLABORATION_LOOKUP_FACTS,
  containsForbiddenKeys,
  lookupFactIsAuthority,
  parseAcknowledge,
  parseObserveResponse,
  parseOpenResponse,
  parseResyncResponse
} from "../../../packages/contracts/src/service-collaboration-contract.ts";
import {
  CORE_CHANGE_SET_AUTHORITY_ID,
  CORE_CHANGE_SET_NON_CERTIFICATION_REASON,
  CORE_CHANGE_SET_REPORT_SCHEMA_VERSION,
  assertHotPathIndependence,
  createCoreChangeSet,
  createCoreChangeSetAuthority,
  createCoreChangeSetOperation,
  rejectEffectCommand
} from "../../../packages/agents/src/core-change-set-authority.ts";
import {
  createAgentWorkspaceChangeSetSeam,
  createJobStateChangeSetSeam
} from "../../../packages/agents/src/agent-workspace/agent-workspace-change-set-seam.ts";
import {
  CORE_CHANGE_SET_AUTHORITY_REPORT_RELATIVE_PATH,
  CORE_CHANGE_SET_AUTHORITY_VERIFIER,
  assertCoreChangeSetAuthority,
  assertCoreChangeSetAuthoritySource,
  buildCoreChangeSetAuthorityReport
} from "../../../tools/server-scripts/verify-core-change-set-authority.ts";

const PROJECT_ROOT: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ABSOLUTE_PATH_PATTERN: any = /(?:\/(?:Users|home|private|var\/folders|root)\/|[A-Za-z]:\\)/u;

function changeSet(changeId?: any, baselineHead?: any, entityId?: any, opId?: any, type: any = "insert") : any {
  return createCoreChangeSet({
    changeId,
    baselineHead,
    attributionRef: "attr.ccs.1",
    operations: [createCoreChangeSetOperation({ opId, type, entityId, index: 0 })]
  });
}

describe("core change set authority", () : any => {
  it("keeps lookup facts from becoming authority and rejects Effect Commands", () : any => {
    for (const fact of SERVICE_COLLABORATION_LOOKUP_FACTS) {
      expect(lookupFactIsAuthority(fact)).toBe(false);
    }
    expect(CORE_CHANGE_SET_AUTHORITY_ID).toBe("CoreChangeSetAuthority");
    expect(() : any => rejectEffectCommand({ family: "effect-command" })).toThrow(/separate family/);
    expect(assertCoreChangeSetAuthoritySource(PROJECT_ROOT)).toBe(true);
  });

  it("sends no apply on a clean turn and at most one Change Set on a dirty turn", async () : Promise<any> => {
    const authority: any = createCoreChangeSetAuthority({ instanceId: "test.ccs.clean" });
    const opened: any = await authority.open({
      workingSetId: "ws.ccs.1",
      entities: [
        { entityId: "ent.ccs.doc", handle: "hdl_ccs_1" },
        { entityId: "ent.ccs.file", kind: "workspace-file", handle: "hdl_ccs_2" }
      ]
    });
    expect(parseOpenResponse(opened)).toBeTruthy();
    const clean: any = await authority.commitTurn({
      workingSetId: "ws.ccs.1",
      handle: "hdl_ccs_1",
      dirty: false,
      changeSet: null
    });
    expect(parseAcknowledge(clean).assignedHead).toBe(0);
    expect(authority.snapshotCounters().applyCalls).toBe(0);

    const dirty: any = await authority.commitTurn({
      workingSetId: "ws.ccs.1",
      handle: "hdl_ccs_1",
      dirty: true,
      changeSet: changeSet("chg.ccs.1", 0, "ent.ccs.doc", "op.ccs.1")
    });
    expect(dirty.assignedHead).toBe(1);
    expect(authority.snapshotCounters().changeSetApplyCalls).toBe(1);
    const duplicate: any = await authority.commitTurn({
      workingSetId: "ws.ccs.1",
      handle: "hdl_ccs_1",
      dirty: true,
      changeSet: changeSet("chg.ccs.1", 0, "ent.ccs.doc", "op.ccs.1")
    });
    expect(duplicate).toEqual(dirty);
    expect(authority.snapshotCounters().applyCalls).toBe(1);
    expect(authority.snapshotCounters().duplicateDeliveries).toBe(1);
    authority.close();
  });

  it("rebases only relevant intervening ops and recovers from Snapshot plus Cursor", async () : Promise<any> => {
    const authority: any = createCoreChangeSetAuthority({
      instanceId: "test.ccs.rebase",
      limits: { maxHistoryEntries: 2 }
    });
    await authority.open({
      workingSetId: "ws.ccs.1",
      catalogSize: 4000,
      connectedClients: 800,
      entities: [
        { entityId: "ent.ccs.doc", handle: "hdl_ccs_1" },
        { entityId: "ent.ccs.job", kind: "job", handle: "hdl_ccs_2" }
      ]
    });
    await createAgentWorkspaceChangeSetSeam(authority).commitFileTurn({
      workingSetId: "ws.ccs.1",
      handle: "hdl_ccs_1",
      dirty: true,
      changeSet: changeSet("chg.ccs.doc", 0, "ent.ccs.doc", "op.ccs.doc")
    });
    await createJobStateChangeSetSeam(authority).commitJobTurn({
      workingSetId: "ws.ccs.1",
      handle: "hdl_ccs_2",
      dirty: true,
      changeSet: changeSet("chg.ccs.job", 1, "ent.ccs.job", "op.ccs.job")
    });
    const before: any = authority.snapshotCounters();
    const rebased: any = await authority.commitTurn({
      workingSetId: "ws.ccs.1",
      handle: "hdl_ccs_1",
      dirty: true,
      changeSet: changeSet("chg.ccs.late", 0, "ent.ccs.doc", "op.ccs.late")
    });
    expect(rebased.assignedHead).toBe(3);
    expect(rebased.conflicts).toEqual([]);
    assertHotPathIndependence(before, authority.snapshotCounters(), {
      changedEntityCount: 1,
      relevantOpCount: 1
    });

    const observed: any = await authority.observe({
      workingSetId: "ws.ccs.1",
      handle: "hdl_ccs_1"
    });
    expect(parseObserveResponse(observed).history).toHaveLength(2);
    const expired: any = parseResyncResponse(await authority.resync({
      workingSetId: "ws.ccs.1",
      handle: "hdl_ccs_1",
      cursor: { cursor: "cur.ccs.1", indexedHead: 0, cursorState: "valid" }
    }));
    expect(expired.outcome).toBe("snapshot-tail");
    expect(expired.snapshot.head).toBeGreaterThanOrEqual(0);
    const valid: any = parseResyncResponse(await authority.resync({
      workingSetId: "ws.ccs.1",
      handle: "hdl_ccs_1",
      cursor: authority.inspect("ws.ccs.1").lastCursor
    }));
    expect(valid.outcome).toBe("delta");
    authority.close();
  });

  it("re-resolves current authorization and writes a privacy-safe non-certifying report", async () : Promise<any> => {
    const assertion: any = await assertCoreChangeSetAuthority();
    const report: any = buildCoreChangeSetAuthorityReport(assertion, {
      generatedAt: "1970-01-01T00:00:00.000Z",
      focusedSuitePassed: true
    });
    const text: any = JSON.stringify(report);
    expect(assertion.coreStateGeneration).toBe(SERVICE_COLLABORATION_CORE_STATE_GENERATION);
    expect(assertion.capacityCertified).toBe(false);
    expect(assertion.reason).toBe(CORE_CHANGE_SET_NON_CERTIFICATION_REASON);
    expect(report.schemaVersion).toBe(CORE_CHANGE_SET_REPORT_SCHEMA_VERSION);
    expect(report.verifier).toBe(CORE_CHANGE_SET_AUTHORITY_VERIFIER);
    expect(CORE_CHANGE_SET_AUTHORITY_REPORT_RELATIVE_PATH.startsWith("build/reports/")).toBe(true);
    expect(report.summary.connectorRuntimePresent).toBe(false);
    expect(report.summary.effectCommandRuntimePresent).toBe(false);
    expect(report.summary.changeSetRuntimePresent).toBe(true);
    expect(containsForbiddenKeys(report)).toBe(false);
    expect(containsSensitiveReportData(report)).toBe(false);
    expect(ABSOLUTE_PATH_PATTERN.test(text)).toBe(false);
  });
});
