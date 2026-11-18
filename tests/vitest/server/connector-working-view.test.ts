import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { containsSensitiveReportData } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import {
  SERVICE_COLLABORATION_LOOKUP_FACTS,
  containsForbiddenKeys,
  createCommitRequest,
  createObserveResponse,
  createOpenResponse,
  lookupFactIsAuthority
} from "../../../packages/contracts/src/service-collaboration-contract.ts";
import {
  CONNECTOR_WORKING_VIEW_CAPACITY_CERTIFIED,
  CONNECTOR_WORKING_VIEW_NON_CERTIFICATION_REASON,
  CONNECTOR_WORKING_VIEW_OWNED_MODULE,
  createConnectorWorkingView,
  projectConnectorMcpEnvelope
} from "../../../packages/protocols/mcp/adapter/gateway-installer/connector-working-view.ts";
import {
  CONNECTOR_WORKING_VIEW_REPORT_RELATIVE_PATH,
  CONNECTOR_WORKING_VIEW_VERIFIER,
  assertConnectorWorkingView,
  buildConnectorWorkingViewReport
} from "../../../tools/server-scripts/verify-connector-working-view.ts";

const PROJECT_ROOT: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ABSOLUTE_PATH_PATTERN: any = /(?:\/(?:Users|home|private|var\/folders|root)\/|[A-Za-z]:\\)/u;
const corpus: any = JSON.parse(fs.readFileSync(
  path.join(PROJECT_ROOT, "packages/contracts/src/fixtures/service-collaboration-wire-corpus.json"),
  "utf8"
));

function hydrateView(options: Record<string, any> = {}) : any {
  const view: any = createConnectorWorkingView({
    grantLookup: "gr.sc.1",
    nowMs: options.nowMs || (() : any => 1_000),
    budgets: options.budgets || {}
  });
  const hydrated: any = view.hydrate({
    open: corpus.valid["open-response"],
    observe: corpus.valid["observe-response"],
    grantLookup: options.grantLookup || "gr.sc.1"
  });
  return { view, hydrated };
}

describe("connector working view", () : any => {
  it("serves valid warm cache hits with zero remote reads and zero unchanged schema bytes", () : any => {
    const { view, hydrated } = hydrateView();
    expect(hydrated.remoteReads).toBe(1);
    const warm: any = view.observeLocal({ handle: "hdl_sc_entity_a" });
    expect(warm.cacheHit).toBe(true);
    expect(warm.needsRemote).toBe(false);
    expect(warm.remoteReads).toBe(0);
    expect(warm.schemaModelContextBytes).toBe(0);
    expect(warm.modelContextBytes).toBe(0);
    expect(view.counters().remoteReads).toBe(1);
    const edited: any = view.editLocal({ dirtyEntityIds: ["ent.sc.a"] });
    expect(edited.omittedUnchanged).toBe(true);
    expect(edited.schemaModelContextBytes).toBe(0);
    expect(edited.changeSetApplyCalls).toBe(0);
    expect(projectConnectorMcpEnvelope({ message: edited.view }).local).toBe(true);
  });

  it("retains unacknowledged outbox and inbox items under backpressure", () : any => {
    const { view } = hydrateView({ budgets: { maxOutboxCount: 1, maxInboxCount: 1 } });
    expect(view.queueCommit(corpus.valid["commit-request-dirty"]).unacknowledgedChanges).toBe(1);
    const changeSet: any = JSON.parse(JSON.stringify(corpus.valid["commit-request-dirty"].changeSet));
    changeSet.changeId = "chg.sc.2";
    changeSet.operations[0].opId = "op.sc.9";
    const pressured: any = view.queueCommit(createCommitRequest({
      workingSetId: "ws.sc.1",
      handle: "hdl_sc_entity_a",
      dirty: true,
      changeSet
    }));
    expect(pressured.outcome).toBe("backpressure");
    expect(pressured.dropped).toBe(0);
    expect(pressured.unacknowledgedChanges).toBe(1);
    expect(view.counters().droppedUnacknowledgedChanges).toBe(0);
    expect(view.counters().changeSetApplyCalls).toBe(0);
    expect(view.acceptRemote(corpus.valid["resource-updated"]).ok).toBe(true);
    const inboxPressure: any = view.acceptRemote(corpus.valid["resource-updated"]);
    expect(inboxPressure.outcome).toBe("backpressure");
    expect(inboxPressure.dropped).toBe(0);
    expect(view.counters().unacknowledgedChanges).toBeGreaterThanOrEqual(1);
  });

  it("purges only the revoked authorization partition", () : any => {
    const { view } = hydrateView();
    view.reResolve("gr.sc.2");
    view.hydrate({
      grantLookup: "gr.sc.2",
      open: createOpenResponse({
        workingSetId: "ws.sc.2",
        entityIds: ["ent.sc.b"],
        handles: [{ handle: "hdl_sc_entity_b", entityId: "ent.sc.b" }],
        head: 1,
        resourceLinks: [{
          uri: "meshrix://collaboration/ws.sc.2/ent.sc.b",
          head: 1,
          cacheHint: { ttlMs: 60000, cacheScope: "private" }
        }],
        cacheHint: { ttlMs: 60000, cacheScope: "private" },
        cursor: { cursor: "cur.sc.b1", indexedHead: 1, cursorState: "valid" }
      }),
      observe: createObserveResponse({
        workingSetId: "ws.sc.2",
        head: 1,
        resourceLinks: [{
          uri: "meshrix://collaboration/ws.sc.2/ent.sc.b",
          head: 1,
          cacheHint: { ttlMs: 60000, cacheScope: "private" }
        }],
        catalogRevision: "cat.sc.2",
        schemaRevision: "sch.sc.2",
        acknowledgements: [],
        history: [],
        cacheHit: false,
        cacheHint: { ttlMs: 60000, cacheScope: "private" }
      })
    });
    expect(view.observeLocal({ handle: "hdl_sc_entity_b" }).cacheHit).toBe(true);
    expect(view.observeLocal({ handle: "hdl_sc_entity_a" }).cacheHit).toBe(false);
    view.revoke({ grantLookup: "gr.sc.1" });
    expect(view.partitionPresent("gr.sc.1")).toBe(false);
    expect(view.partitionPresent("gr.sc.2")).toBe(true);
    view.reResolve("gr.sc.1");
    expect(view.observeLocal({ handle: "hdl_sc_entity_a" }).cacheHit).toBe(false);
    view.reResolve("gr.sc.2");
    expect(view.observeLocal({ handle: "hdl_sc_entity_b" }).cacheHit).toBe(true);
  });

  it("treats handles, cursors, and cache as lookup facts and re-resolves the current grant", () : any => {
    for (const fact of SERVICE_COLLABORATION_LOOKUP_FACTS) {
      expect(lookupFactIsAuthority(fact)).toBe(false);
    }
    const { view } = hydrateView();
    expect(view.lookupFactIsAuthority("handle")).toBe(false);
    expect(view.lookupFactIsAuthority("cursor")).toBe(false);
    expect(view.lookupFactIsAuthority("cachedBytes")).toBe(false);
    view.reResolve("gr.sc.missing");
    expect(view.observeLocal({ handle: "hdl_sc_entity_a" }).cacheHit).toBe(false);
    expect(view.observeLocal({ handle: "hdl_sc_entity_a" }).needsRemote).toBe(true);
  });

  it("projects incremental MCP envelopes without privacy fields and never certifies capacity", () : any => {
    const { view } = hydrateView();
    const envelope: any = projectConnectorMcpEnvelope({
      id: "connector-1",
      message: corpus.valid["open-request"]
    });
    expect(envelope.local).toBe(false);
    expect(envelope.envelope.method).toBe("meshrix/collaboration/open");
    expect(containsForbiddenKeys(envelope.envelope)).toBe(false);
    expect(view.acceptRemote(corpus.invalid.privacyContent).ok).toBe(false);
    expect(view.acceptRemote(corpus.valid["effect-command"]).outcome).toBe("effect-command-not-executed");
    const facts: any = view.snapshot();
    expect(facts.capacityCertified).toBe(false);
    expect(facts.nonCertificationReason).toBe(CONNECTOR_WORKING_VIEW_NON_CERTIFICATION_REASON);
    expect(CONNECTOR_WORKING_VIEW_CAPACITY_CERTIFIED).toBe(false);
    expect(facts.changeSetApplyCalls).toBe(0);
    expect(containsForbiddenKeys(facts)).toBe(false);
  });

  it("writes a privacy-safe Working View report without Core or capacity claims", () : any => {
    const assertion: any = assertConnectorWorkingView(PROJECT_ROOT);
    const report: any = buildConnectorWorkingViewReport(assertion, {
      generatedAt: "1970-01-01T00:00:00.000Z",
      focusedSuitePassed: true
    });
    const text: any = JSON.stringify(report);
    expect(assertion.warmCacheRemoteReads).toBe(0);
    expect(assertion.unchangedSchemaModelContextBytes).toBe(0);
    expect(assertion.revocationPurgedPartition).toBe(true);
    expect(assertion.unacknowledgedChangesRetained).toBe(true);
    expect(assertion.capacityCertified).toBe(false);
    expect(assertion.changeSetRuntimePresent).toBe(false);
    expect(report.verifier).toBe(CONNECTOR_WORKING_VIEW_VERIFIER);
    expect(CONNECTOR_WORKING_VIEW_OWNED_MODULE).toBe(
      "packages/protocols/mcp/adapter/gateway-installer/connector-working-view.ts"
    );
    expect(CONNECTOR_WORKING_VIEW_REPORT_RELATIVE_PATH.startsWith("build/reports/")).toBe(true);
    expect(report.summary.capacityCertified).toBe(false);
    expect(containsSensitiveReportData(report)).toBe(false);
    expect(ABSOLUTE_PATH_PATTERN.test(text)).toBe(false);
  });
});
