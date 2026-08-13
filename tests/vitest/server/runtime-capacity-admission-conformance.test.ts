import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createModelRoutingAdmissionStore,
  getModelRoutingAdmissionDatabasePath,
  migrateModelRoutingAdmission
} from "../../../packages/agents/src/agent-gateway/model-routing/model-routing-admission-store.ts";
import {
  runModelRouting,
  inspectModelRouting
} from "../../../packages/agents/src/agent-gateway/model-routing/index.ts";

const tempRoots: any[] = [];

function tempRoot() : any {
  const root: any = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-capacity-model-routing-"));
  tempRoots.push(root);
  return root;
}

afterEach(() : any => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function barrier() : any {
  let release: any = null;
  const promise: any = new Promise((resolve?: any) : any => {
    release = resolve;
  });
  return { promise, release };
}

function basePolicy(overrides: Record<string, any> = {}) : any {
  return {
    settings: {
      modelRouting: {
        enabled: true,
        routeId: "cap-01-route",
        candidateChain: ["primary"],
        rateLimit: {
          maxConcurrent: 2,
          maxInFlightMs: 10_000,
          maxCalls: 100,
          windowMs: 60_000
        },
        circuitBreaker: { enabled: true, failureThreshold: 2, openMs: 30_000 }
      }
    },
    ...overrides
  };
}

function executingCandidate(result?: any, gate?: any) : any {
  return async ({ dryRun }: Record<string, any>) : Promise<any> => {
    if (!dryRun && gate) {
      await gate.promise;
    }
    return result || {
      config: { provider: "verifier", model: "primary" },
      result: {
        answer: "ok",
        upstream: { provider: "verifier", model: "primary" },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }
    };
  };
}

describe("model routing admission authority", () : any => {
  it("never exceeds configured slots under concurrent route calls", async () : Promise<any> => {
    const root: any = tempRoot();
    const gate: any = barrier();
    const calls: any[] = [];
    for (let index: any = 0; index < 6; index += 1) {
      const call: any = runModelRouting({
        ...basePolicy(),
        userDataPath: root,
        executeCandidate: executingCandidate(undefined, gate),
        input: { question: `call-${index}` }
      });
      call.catch(() : any => undefined);
      calls.push(call);
    }
    await new Promise((resolve?: any) : any => setTimeout(resolve, 120));
    const store: any = createModelRoutingAdmissionStore({ userDataPath: root });
    const observed: any = store.inspect({ limit: 10 }).state.inFlight["cap-01-route"]?.slots || {};
    store.close();
    expect(Object.keys(observed).length).toBeLessThanOrEqual(2);
    gate.release();
    const results: any = await Promise.allSettled(calls);
    const fulfilled: any = results.filter((result?: any) : any => result.status === "fulfilled");
    const rejected: any = results.filter((result?: any) : any => result.status === "rejected");
    expect(fulfilled.length).toBe(2);
    expect(rejected.length).toBe(4);
    for (const rejectedResult of rejected) {
      expect(rejectedResult.reason.code).toBe("model_routing_concurrency_limit_exceeded");
    }
  });

  it("prunes expired slots at window edges", () : any => {
    const root: any = tempRoot();
    const store: any = createModelRoutingAdmissionStore({ userDataPath: root });
    const policy: any = {
      rateLimit: { maxConcurrent: 1, maxInFlightMs: 1000, maxCalls: 0, windowMs: 0 }
    };
    const first: any = store.admitRouteCall({ routeId: "r", policy, slotId: "s1", nowMs: 1000 });
    expect(first.reserved).toBe(true);
    expect(() : any => store.admitRouteCall({ routeId: "r", policy, slotId: "s2", nowMs: 1500 })).toThrow(
      /concurrency limit exceeded/
    );
    const afterExpiry: any = store.admitRouteCall({ routeId: "r", policy, slotId: "s2", nowMs: 2500 });
    expect(afterExpiry.reserved).toBe(true);
    store.close();
  });

  it("counts only in-window success permits with fixed statement work", () : any => {
    const root: any = tempRoot();
    const store: any = createModelRoutingAdmissionStore({ userDataPath: root });
    const policy: any = {
      rateLimit: { maxConcurrent: 0, maxInFlightMs: 0, maxCalls: 2, windowMs: 10_000 }
    };
    for (let index: any = 0; index < 2; index += 1) {
      store.admitRouteCall({ routeId: "w", policy, slotId: `p${index}`, nowMs: 1_000 + index });
      store.recordLedgerRow({
        ledgerId: `ledger-${index}`,
        routeCallId: `call-${index}`,
        routeId: "w",
        alias: "primary",
        status: "success",
        ts: new Date(1_000 + index).toISOString()
      });
    }
    expect(() : any => store.admitRouteCall({ routeId: "w", policy, slotId: "p2", nowMs: 5_000 })).toThrow(
      /rate limit exceeded/
    );
    const afterWindow: any = store.admitRouteCall({ routeId: "w", policy, slotId: "p2", nowMs: 12_000 });
    expect(afterWindow.reserved).toBe(false);
    store.close();
  });

  it("keeps admission statement counts fixed across short and long ledgers", () : any => {
    const shortRoot: any = tempRoot();
    const longRoot: any = tempRoot();
    const policy: any = {
      rateLimit: { maxConcurrent: 1, maxInFlightMs: 5000, maxCalls: 10, windowMs: 60_000 }
    };
    const shortStore: any = createModelRoutingAdmissionStore({ userDataPath: shortRoot });
    for (let index: any = 0; index < 10; index += 1) {
      shortStore.recordLedgerRow({
        ledgerId: `short-${index}`,
        routeCallId: `c${index}`,
        routeId: "s",
        alias: "primary",
        status: "success",
        ts: new Date(1000 + index).toISOString()
      });
    }
    const longStore: any = createModelRoutingAdmissionStore({ userDataPath: longRoot });
    for (let index: any = 0; index < 2000; index += 1) {
      longStore.recordLedgerRow({
        ledgerId: `long-${index}`,
        routeCallId: `c${index}`,
        routeId: "s",
        alias: "primary",
        status: "success",
        ts: new Date(1000 + index).toISOString()
      });
    }
    shortStore.admitRouteCall({ routeId: "s", policy, slotId: "x1", nowMs: 100_000 });
    longStore.admitRouteCall({ routeId: "s", policy, slotId: "x1", nowMs: 100_000 });
    const shortInstrumentation: any = shortStore.getAdmissionInstrumentation();
    const longInstrumentation: any = longStore.getAdmissionInstrumentation();
    expect(shortInstrumentation.admitStatements).toBe(longInstrumentation.admitStatements);
    expect(shortInstrumentation.ledgerTailReads).toBe(0);
    expect(longInstrumentation.ledgerTailReads).toBe(0);
    shortStore.close();
    longStore.close();
  });

  it("never loses circuit increments under concurrent generation conflicts", () : any => {
    const root: any = tempRoot();
    const store: any = createModelRoutingAdmissionStore({ userDataPath: root });
    const policy: any = { circuitBreaker: { enabled: true, failureThreshold: 100, openMs: 1000 } };
    const updates: any[] = [];
    for (let index: any = 0; index < 8; index += 1) {
      updates.push(Promise.resolve().then(() : any => {
        store.recordCircuitFailure({ alias: "primary", error: new Error(`failure-${index}`), policy });
      }));
    }
    return Promise.all(updates).then(() : any => {
      const circuit: any = store.readCircuitState("primary");
      expect(circuit.failureCount).toBe(8);
      expect(circuit.generation).toBe(9);
      store.close();
    });
  });

  it("migrates legacy evidence byte-equivalently and opens only the new store", async () : Promise<any> => {
    const root: any = tempRoot();
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
    fs.mkdirSync(path.join(root, "logs"), { recursive: true });
    const legacyState: any = {
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: "v0.0.1:strategy:model-routing-1",
      updatedAt: "2026-08-13T00:00:00.000Z",
      circuits: {
        primary: {
          state: "open",
          failureCount: 3,
          openedAt: "2026-08-13T00:00:01.000Z",
          openUntil: "2026-08-13T00:10:00.000Z",
          lastFailureAt: "2026-08-13T00:00:02.000Z",
          lastError: "legacy failure"
        }
      },
      inFlight: {}
    };
    const ledgerRows: any[] = [
      {
        schemaVersion: "v0.0.1:schema:definition-1",
        protocolVersion: "v0.0.1:strategy:model-routing-1",
        ts: "2026-08-13T00:00:03.000Z",
        ledgerId: "legacy-1",
        routeCallId: "call-1",
        routeId: "cap-01-route",
        alias: "primary",
        status: "success",
        budget: { estimatedTotalUsd: 0.0001 },
        inputHash: "abc123",
        metadata: {}
      },
      {
        schemaVersion: "v0.0.1:schema:definition-1",
        protocolVersion: "v0.0.1:strategy:model-routing-1",
        ts: "2026-08-13T00:00:04.000Z",
        ledgerId: "legacy-2",
        routeCallId: "call-2",
        routeId: "cap-01-route",
        alias: "primary",
        status: "failed",
        errorCode: "agent_gateway_upstream_unavailable",
        retryable: true,
        budget: { estimatedTotalUsd: 0.0001 },
        inputHash: "def456",
        metadata: {}
      }
    ];
    const statePath: any = path.join(root, "state", "model-routing-state.json");
    const ledgerPath: any = path.join(root, "logs", "model-routing-ledger.jsonl");
    fs.writeFileSync(statePath, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");
    fs.writeFileSync(ledgerPath, ledgerRows.map((row?: any) : any => JSON.stringify(row)).join("\n") + "\n", "utf8");

    const migration: any = migrateModelRoutingAdmission({ userDataPath: root });
    expect(migration.migrated).toBe(true);
    expect(migration.ledgerRowCount).toBe(2);
    expect(fs.existsSync(path.join(root, "state", "model-routing-admission.sqlite"))).toBe(true);
    expect(migration.backupPaths.length).toBe(2);

    const store: any = createModelRoutingAdmissionStore({ userDataPath: root });
    const circuit: any = store.readCircuitState("primary");
    expect(circuit.state).toBe("open");
    expect(circuit.failureCount).toBe(3);
    expect(circuit.openUntil).toBe("2026-08-13T00:10:00.000Z");
    const inspection: any = store.inspect({ limit: 10 });
    expect(inspection.ledgerSummary.total).toBe(2);
    expect(inspection.ledgerSummary.byStatus.success).toBe(1);
    expect(inspection.ledgerSummary.byStatus.failed).toBe(1);
    const migratedRow: any = inspection.recentLedger.find((row?: any) : any => row.ledgerId === "legacy-1");
    expect(JSON.stringify(migratedRow)).toBe(JSON.stringify(ledgerRows[0]));
    store.close();

    const stateBefore: any = fs.readFileSync(statePath, "utf8");
    const ledgerBefore: any = fs.readFileSync(ledgerPath, "utf8");
    await runModelRouting({
      ...basePolicy({ settings: { modelRouting: { ...basePolicy().settings.modelRouting, candidateChain: ["secondary"], circuitBreaker: { enabled: false } } } }),
      userDataPath: root,
      executeCandidate: executingCandidate(),
      input: { question: "after-migration" }
    });
    expect(fs.readFileSync(statePath, "utf8")).toBe(stateBefore);
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(ledgerBefore);
    const storeAfter: any = createModelRoutingAdmissionStore({ userDataPath: root });
    expect(storeAfter.migration.alreadyMigrated).toBe(true);
    expect(storeAfter.getAdmissionInstrumentation().openedAfterMigration).toBe(true);
    storeAfter.close();
  });

  it("rolls back before the migration marker on conversion failure", () : any => {
    const root: any = tempRoot();
    fs.mkdirSync(path.join(root, "logs"), { recursive: true });
    const ledgerPath: any = path.join(root, "logs", "model-routing-ledger.jsonl");
    fs.writeFileSync(ledgerPath, "{not-json}\n", "utf8");
    const ledgerBytes: any = fs.readFileSync(ledgerPath);
    expect(() : any => migrateModelRoutingAdmission({ userDataPath: root })).toThrow(
      /migration failed/
    );
    expect(fs.readFileSync(ledgerPath).equals(ledgerBytes)).toBe(true);
    const dbPath: any = getModelRoutingAdmissionDatabasePath(root);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(() : any => createModelRoutingAdmissionStore({ userDataPath: root })).toThrow(
      /migration failed/
    );
    expect(fs.readFileSync(ledgerPath).equals(ledgerBytes)).toBe(true);
    fs.writeFileSync(ledgerPath, '{"ledgerId":"fixed-1","routeId":"r","alias":"primary","status":"success","ts":"2026-08-13T00:00:00.000Z"}\n', "utf8");
    const retried: any = migrateModelRoutingAdmission({ userDataPath: root });
    expect(retried.migrated).toBe(true);
    const store: any = createModelRoutingAdmissionStore({ userDataPath: root });
    expect(store.migration.alreadyMigrated).toBe(true);
    store.close();
  });

  it("exposes the migrated store through public inspection only", async () : Promise<any> => {
    const root: any = tempRoot();
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
    fs.mkdirSync(path.join(root, "logs"), { recursive: true });
    fs.writeFileSync(path.join(root, "state", "model-routing-state.json"), `${JSON.stringify({ circuits: {}, inFlight: {} })}\n`, "utf8");
    fs.writeFileSync(path.join(root, "logs", "model-routing-ledger.jsonl"), "", "utf8");
    const routed: any = await runModelRouting({
      ...basePolicy({ settings: { modelRouting: { ...basePolicy().settings.modelRouting, circuitBreaker: { enabled: false } } } }),
      userDataPath: root,
      executeCandidate: executingCandidate(),
      input: { question: "inspect" }
    });
    expect(routed.routing.traffic.algorithm).toBe("sliding_window_success_count_with_concurrency");
    const inspection: any = await inspectModelRouting({ userDataPath: root, limit: 5 });
    expect(inspection.ledgerSummary.byStatus.success).toBe(1);
    expect(inspection.state.inFlight).toEqual({});
    expect(inspection.statePath).toBe("state/model-routing-admission.sqlite");
  });
});
