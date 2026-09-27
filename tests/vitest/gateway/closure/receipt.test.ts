import { describe, expect, it } from "vitest";
import { context, createTestGateway, descriptor, route } from "../support";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayPermitAuthority } from "@meshrix/foundation/security/gateway-permit";
import { createSqliteGatewayContinuationLedger } from "@meshrix/foundation/security/gateway-continuation-ledger";
import type { ExecutionPermit, PermitAuthorityPort, PreparedInvocation, UpstreamResponse } from "@meshrix/contracts/gateway";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function readIntentStates(filePath: string): Map<string, string> {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    return new Map((db.prepare("SELECT intent_id, state FROM gateway_execution_intents").all() as Array<{ intent_id: string; state: string }>).map(({ intent_id, state }) => [intent_id, state]));
  } finally { db.close(); }
}

function durableIntentReceiptOwner(ledger: ReturnType<typeof createSqliteGatewayContinuationLedger>) {
  return {
    recordIssued(permit: ExecutionPermit) { ledger.recordIssuedWithIntent(permit); },
    recordConsumed(id: string) { ledger.recordConsumed(id); },
    recordUnknown(id: string) { ledger.recordUnknown(id); },
    transitionIntent(permit: ExecutionPermit, phase: "dispatch_started" | "not_started" | "succeeded" | "failed") { ledger.transitionExecutionIntent(permit, phase); },
    lookupReceipt(id: string) { return ledger.lookupReceipt(id); }
  };
}

function permitAuthorityWithHeldDispatchFence() {
  const authority = createGatewayPermitAuthority();
  const started = deferred<void>();
  const release = deferred<void>();
  const phases: Array<{ id: string; phase: string }> = [];
  const permits: PermitAuthorityPort = {
    issue: (input) => authority.issue(input),
    consume: (input) => authority.consume(input),
    markOutcomeUnknown: (permit) => authority.markOutcomeUnknown(permit),
    async transition(permit, phase) {
      phases.push({ id: permit.id, phase });
      if (phase === "dispatch_started") { started.resolve(); await release.promise; }
      authority.transition(permit, phase);
    }
  };
  return { permits, started: started.promise, release: () => release.resolve(), phases };
}

describe("query-only uncertain execution receipt", () => {
  it("keeps only active effectful permits protected past their authorization expiry and retains terminal receipts through their existing lifetime", () => {
    let now = 10_000;
    const transitions: Array<{ id: string; phase: string }> = [];
    const unknown: string[] = [];
    const receiptLedger = {
      recordIssued(_permit: ExecutionPermit) {},
      recordConsumed(_id: string) {},
      recordUnknown(id: string) { unknown.push(id); },
      transitionIntent(permit: ExecutionPermit, phase: string) { transitions.push({ id: permit.id, phase }); },
      lookupReceipt(_id: string) { return undefined; }
    };
    const authority = createGatewayPermitAuthority({ now: () => now, maxRecords: 3, receiptLedger });
    const prepared = (): PreparedInvocation => {
      const effectClass = "safe_write" as const;
      const selectedRoute = route({ effectClass });
      return { invocation: { routeRef: selectedRoute.logicalRoute, method: "tools/call", params: {} }, route: selectedRoute,
        authority: { decisionRef: "decision", grantRevision: "grant-1", policyRevision: "policy-1", target: selectedRoute.endpointIdentity, effectClass, expiresAt: now + 600_000 },
        inputDigest: "input" };
    };
    const consume = (): ExecutionPermit => {
      const input = prepared();
      const issued = authority.issue({ context, prepared: input, audience: input.route.endpointIdentity });
      return authority.consume({ permit: issued, context, prepared: input });
    };

    const completed = consume();
    authority.transition(completed, "dispatch_started");
    authority.transition(completed, "succeeded");
    expect(authority.lookup({ receiptId: completed.id, context })).toMatchObject({ state: "consumed" });

    const activeSuccess = consume();
    const activeUnknown = consume();
    authority.transition(activeSuccess, "dispatch_started");
    authority.transition(activeUnknown, "dispatch_started");
    now += 60_001;
    expect(authority.stats().records).toBe(2);

    authority.transition(activeSuccess, "succeeded");
    authority.markOutcomeUnknown(activeUnknown);
    expect(transitions).toEqual([
      { id: completed.id, phase: "dispatch_started" }, { id: completed.id, phase: "succeeded" },
      { id: activeSuccess.id, phase: "dispatch_started" }, { id: activeUnknown.id, phase: "dispatch_started" },
      { id: activeSuccess.id, phase: "succeeded" }
    ]);
    expect(unknown).toEqual([activeUnknown.id]);
    expect(authority.stats().records).toBe(0);

    const afterCompletion = authority.issue({ context, prepared: prepared(), audience: "endpoint.demo" });
    expect(afterCompletion.state).toBe("issued");
  });

  it("[GC-051] returns a scoped stable receipt for an unknown write without dispatching a query as a second effect", async () => {
    let sends = 0;
    const original = descriptor({ route: route({ effectClass: "safe_write" }) });
    const gateway = createTestGateway({ descriptors: [original], upstream: { async invoke() { sends += 1; throw new Error("synthetic disconnect after dispatch"); } } });
    await gateway.start();
    try {
      const result = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} });
      expect(result).toMatchObject({ kind: "failure", effectOutcome: "unknown", details: { receiptId: expect.any(String) } });
      const receiptId = result.kind === "failure" ? String(result.details?.receiptId) : "";
      expect(await gateway.receiptStatus(context, receiptId)).toMatchObject({ receiptId, state: "outcome_unknown" });
      expect(await gateway.receiptStatus({ ...context, principal: "other" }, receiptId)).toMatchObject({ kind: "failure", code: "receipt_not_found" });
      expect(await gateway.receiptStatus({ ...context, grant: { ...context.grant, revoked: true } }, receiptId)).toMatchObject({ kind: "failure", code: "receipt_not_found" });
      expect(sends).toBe(1);
      gateway.publishCatalog([{ ...original, route: { ...original.route, endpointIdentity: "rotated", revision: "rotated" } }]);
      expect(await gateway.receiptStatus(context, receiptId)).toMatchObject({ kind: "failure", code: "receipt_target_changed" });
      expect(sends).toBe(1);
    } finally { await gateway.close(); }
  });

  it("[GC-051] retains a scoped unknown receipt across an owned durable profile restart without a second peer effect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-durable-receipt-"));
    const filePath = join(directory, "claims.sqlite");
    const declaration = descriptor({ route: route({ effectClass: "safe_write" }) });
    let peerEffects = 0;
    const firstLedger = createSqliteGatewayContinuationLedger({ filePath });
    const first = createTestGateway({ descriptors: [declaration], permits: createGatewayPermitAuthority({ receiptLedger: firstLedger }),
      upstream: { async invoke() { peerEffects += 1; throw new Error("synthetic peer response disappeared after dispatch"); } } });
    let second: ReturnType<typeof createTestGateway> | undefined;
    let reopened: ReturnType<typeof createSqliteGatewayContinuationLedger> | undefined;
    try {
      await first.start();
      const uncertain = await first.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} });
      expect(uncertain).toMatchObject({ kind: "failure", effectOutcome: "unknown", details: { receiptId: expect.any(String) } });
      const receiptId = uncertain.kind === "failure" ? String(uncertain.details?.receiptId) : "";
      expect(peerEffects).toBe(1);
      await first.close();
      firstLedger.close();

      reopened = createSqliteGatewayContinuationLedger({ filePath });
      const newAuthority = createGatewayPermitAuthority({ receiptLedger: reopened });
      second = createTestGateway({ descriptors: [declaration], permits: newAuthority,
        upstream: { async invoke() { peerEffects += 1; throw new Error("query must never dispatch"); } } });
      await second.start();
      expect(await second.receiptStatus(context, receiptId)).toMatchObject({ receiptId, state: "outcome_unknown" });
      expect(await second.receiptStatus({ ...context, principal: "other" }, receiptId)).toMatchObject({ kind: "failure", code: "receipt_not_found" });
      expect(() => newAuthority.consume({ permit: reopened!.lookupReceipt(receiptId)!, context, prepared: {} as never })).toThrowError(expect.objectContaining({ code: "permit_replayed" }));
      expect(peerEffects).toBe(1);
    } finally {
      await first.close();
      await second?.close();
      firstLedger.close();
      reopened?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("awaits the durable dispatch fence before final authority checks and never reaches a denied sink", async () => {
    const held = permitAuthorityWithHeldDispatchFence();
    let authorityReads = 0;
    let sends = 0;
    const declaration = descriptor({ route: route({ effectClass: "safe_write" }) });
    const gateway = createTestGateway({ permits: held.permits, descriptors: [declaration],
      currentAuthority: { async read({ context: original }) {
        authorityReads += 1;
        return authorityReads === 1 ? original : { ...original, grant: { ...original.grant, revoked: true } };
      } },
      upstream: { async invoke() { sends += 1; return { status: 200, body: { resultType: "complete" } }; } }
    });
    await gateway.start();
    try {
      const pending = gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} });
      await held.started;
      expect(sends).toBe(0);
      held.release();
      expect(await pending).toMatchObject({ kind: "failure", code: "grant_revoked", effectOutcome: "not_started" });
      expect(sends).toBe(0);
      expect(held.phases.map(({ phase }) => phase)).toEqual(["dispatch_started", "not_started"]);
    } finally { held.release(); await gateway.close(); }
  });

  it("settles a caller cancellation during the awaited dispatch fence without entering the sink", async () => {
    const held = permitAuthorityWithHeldDispatchFence();
    let sends = 0;
    const gateway = createTestGateway({ permits: held.permits,
      descriptors: [descriptor({ route: route({ effectClass: "safe_write" }) })],
      upstream: { async invoke() { sends += 1; return { status: 200, body: { resultType: "complete" } }; } }
    });
    const controller = new AbortController();
    await gateway.start();
    try {
      const pending = gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {}, signal: controller.signal });
      await held.started;
      controller.abort();
      held.release();
      expect(await pending).toMatchObject({ kind: "failure", effectOutcome: "cancelled" });
      expect(sends).toBe(0);
      expect(held.phases.map(({ phase }) => phase)).toEqual(["dispatch_started", "not_started"]);
    } finally { held.release(); await gateway.close(); }
  });

  it("associates concurrent sink completion with each exact consumed permit", async () => {
    const transitions: Array<{ id: string; phase: string }> = [];
    const receiptLedger = {
      recordIssued(_permit: ExecutionPermit) {},
      recordConsumed(_id: string) {},
      recordUnknown(_id: string) {},
      transitionIntent(permit: ExecutionPermit, phase: "dispatch_started" | "not_started" | "succeeded" | "failed") { transitions.push({ id: permit.id, phase }); },
      lookupReceipt(_id: string) { return undefined; }
    };
    const authority = createGatewayPermitAuthority({ receiptLedger });
    const consumed = new Map<string, ExecutionPermit>();
    const permits: PermitAuthorityPort = {
      issue(input) { return authority.issue(input); },
      consume(input) {
        const permit = authority.consume(input);
        consumed.set(permit.id, permit);
        return permit;
      },
      markOutcomeUnknown(permit) { return authority.markOutcomeUnknown(permit); },
      transition(permit, phase) { authority.transition(permit, phase); }
    };
    const inFlight = new Map<string, (value: UpstreamResponse) => void>();
    const permitByCase = new Map<string, string>();
    const bothSinksEntered = deferred<void>();
    const calls: Array<Promise<unknown>> = [];
    const gateway = createTestGateway({ permits,
      descriptors: [descriptor({ route: route({ effectClass: "safe_write" }) })],
      upstream: { invoke(input) {
        const permit = input.permit;
        if (!permit) throw new Error("The kernel omitted its consumed permit.");
        expect(permit).toBe(consumed.get(permit.id));
        const scenario = String((input.request.params as { scenario?: unknown }).scenario);
        permitByCase.set(scenario, permit.id);
        let resolve!: (value: UpstreamResponse) => void;
        const pending = new Promise<UpstreamResponse>((complete) => { resolve = complete; });
        inFlight.set(scenario, resolve);
        if (inFlight.size === 2) bothSinksEntered.resolve();
        return pending;
      } }
    });
    await gateway.start();
    try {
      const first = gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: { scenario: "first" } });
      const second = gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: { scenario: "second" } });
      calls.push(first, second);
      await bothSinksEntered.promise;
      inFlight.get("second")!({ status: 200, headers: {}, body: { resultType: "complete", structuredContent: { scenario: "second" } } });
      expect(await second).toMatchObject({ kind: "complete" });
      inFlight.get("first")!({ status: 200, headers: {}, body: { resultType: "complete", structuredContent: { scenario: "first" } } });
      expect(await first).toMatchObject({ kind: "complete" });
      for (const id of permitByCase.values()) {
        expect(transitions.filter((transition) => transition.id === id).map(({ phase }) => phase)).toEqual(["dispatch_started", "succeeded"]);
      }
    } finally {
      for (const resolve of inFlight.values()) resolve({ status: 200, headers: {}, body: { resultType: "complete", structuredContent: { ok: true } } });
      await Promise.allSettled(calls);
      await gateway.close();
    }
  });

  it("persists terminal and uncertain outcomes only after the result decoder and output schema finish", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-kernel-intent-outcomes-"));
    const filePath = join(directory, "gateway", "execution.sqlite");
    const ledger = createSqliteGatewayContinuationLedger({ filePath, ownershipRoot: directory });
    const permits = createGatewayPermitAuthority({ receiptLedger: durableIntentReceiptOwner(ledger) });
    const permitByCase = new Map<string, string>();
    const gateway = createTestGateway({ permits,
      descriptors: [descriptor({ route: route({ effectClass: "safe_write" }), outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false } })],
      upstream: { async invoke(input) {
        const scenario = String((input.request.params as { scenario?: unknown }).scenario);
        if (!input.permit) throw new Error("The kernel omitted its consumed permit.");
        permitByCase.set(scenario, input.permit.id);
        if (scenario === "peer-error") return { status: 200, headers: {}, body: { resultType: "complete", isError: true, structuredContent: { ok: true } } };
        if (scenario === "schema-invalid") return { status: 200, headers: {}, body: { resultType: "complete", structuredContent: { wrong: true } } };
        if (scenario === "input-required") return { status: 200, headers: {}, body: { resultType: "input_required", inputRequests: { confirm: { method: "elicitation/create" } } } };
        if (scenario === "modern-untagged") return { status: 200, headers: {}, body: { content: [{ type: "text", text: "unnegotiated" }] } };
        if (scenario === "trusted-extension") return { kind: "negotiated_extension", extension: "meshrix/extension", value: { ok: true } };
        return { status: 200, headers: {}, body: { resultType: "complete", structuredContent: { ok: true } } };
      } }
    });
    try {
      await gateway.start();
      expect(await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: { scenario: "success" } })).toMatchObject({ kind: "complete" });
      expect(await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: { scenario: "peer-error" } })).toMatchObject({ kind: "complete", isError: true });
      expect(await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: { scenario: "schema-invalid" } })).toMatchObject({ kind: "failure", code: "schema_validation_failed", effectOutcome: "unknown" });
      expect(await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: { scenario: "input-required" } })).toMatchObject({ kind: "failure", code: "continuation_unavailable", effectOutcome: "unknown" });
      expect(await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: { scenario: "modern-untagged" } })).toMatchObject({ kind: "failure", code: "upstream_result_type_unnegotiated", effectOutcome: "unknown" });
      expect(await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: { scenario: "trusted-extension" } })).toMatchObject({ kind: "negotiated_extension", extension: "meshrix/extension" });

      const states = readIntentStates(filePath);
      expect(Object.fromEntries([...permitByCase].map(([scenario, id]) => [scenario, states.get(id)]))).toEqual({
        success: "succeeded",
        "peer-error": "failed",
        "schema-invalid": "in_doubt",
        "input-required": "in_doubt",
        "modern-untagged": "in_doubt",
        "trusted-extension": "in_doubt"
      });
    } finally { await gateway.close(); ledger.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps terminal settlement failure uncertain instead of reclassifying a dispatched call", async () => {
    const delegate = createGatewayPermitAuthority();
    const phases: string[] = [];
    let sends = 0;
    const permits: PermitAuthorityPort = {
      issue: (input) => delegate.issue(input),
      consume: (input) => delegate.consume(input),
      markOutcomeUnknown: (permit) => delegate.markOutcomeUnknown(permit),
      transition(permit, phase) {
        phases.push(phase);
        if (phase === "succeeded") throw Object.assign(new Error("synthetic durable settlement failure"), { code: "intent_commit_failed" });
        delegate.transition(permit, phase);
      }
    };
    const gateway = createTestGateway({ permits,
      descriptors: [descriptor({ route: route({ effectClass: "safe_write" }) })],
      upstream: { async invoke() { sends += 1; return { status: 200, headers: {}, body: { resultType: "complete" } }; } }
    });
    await gateway.start();
    try {
      expect(await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} })).toMatchObject({ kind: "failure", code: "gateway_intent_settlement_failed", effectOutcome: "unknown" });
      expect(sends).toBe(1);
      expect(phases).toEqual(["dispatch_started", "succeeded"]);
    } finally { await gateway.close(); }
  });

  it("keeps a sink failure uncertain when unknown-outcome persistence itself fails", async () => {
    const delegate = createGatewayPermitAuthority();
    const phases: string[] = [];
    let unknownWrites = 0;
    const permits: PermitAuthorityPort = {
      issue: (input) => delegate.issue(input),
      consume: (input) => delegate.consume(input),
      markOutcomeUnknown() { unknownWrites += 1; throw Object.assign(new Error("synthetic unknown settlement failure"), { code: "intent_commit_failed" }); },
      transition(permit, phase) { phases.push(phase); delegate.transition(permit, phase); }
    };
    const gateway = createTestGateway({ permits,
      descriptors: [descriptor({ route: route({ effectClass: "safe_write" }) })],
      upstream: { async invoke() { throw new Error("synthetic response lost after dispatch"); } }
    });
    await gateway.start();
    try {
      expect(await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} })).toMatchObject({ kind: "failure", effectOutcome: "unknown" });
      expect(unknownWrites).toBe(1);
      expect(phases).toEqual(["dispatch_started"]);
    } finally { await gateway.close(); }
  });
});
