#!/usr/bin/env node
/*
 * Authorized runtime-capacity workload catalog.
 *
 * The catalog defines the only workload shapes that focused capacity and
 * concurrency evidence may use: closed-loop workloads (fixed iterations with
 * barrier-synced concurrency) and open-loop workloads (deterministic schedule
 * delay). Every workload carries a fixed seed and names the deterministic
 * counters it records. Conformance evidence must never certify capacity:
 * certification is reserved for the immutable profile gate in CAP-18.
 */

const COUNTER_KINDS: readonly any[] = Object.freeze([
  "statements",
  "scans",
  "objectBytes",
  "wakeups",
  "timers",
  "credits",
  "cacheWeight",
  "rewrittenNodes"
]);

const CLOSED_LOOP_WORKLOADS: readonly any[] = Object.freeze([
  {
    id: "external-gateway-admission",
    mode: "closed",
    iterations: 200,
    seed: 7,
    counters: ["statements", "credits"]
  },
  {
    id: "work-queue-dispatch",
    mode: "closed",
    iterations: 200,
    seed: 11,
    counters: ["statements", "credits", "wakeups"]
  },
  {
    id: "http-body-peak",
    mode: "closed",
    iterations: 50,
    seed: 13,
    counters: ["objectBytes", "credits"]
  },
  {
    id: "event-fanout",
    mode: "closed",
    iterations: 100,
    seed: 17,
    counters: ["wakeups", "timers", "statements"]
  },
  {
    id: "lock-waiters",
    mode: "closed",
    iterations: 100,
    seed: 19,
    counters: ["pending", "timers", "statements"]
  },
  {
    id: "pactium-append",
    mode: "closed",
    iterations: 300,
    seed: 23,
    counters: ["statements", "objectBytes"]
  },
  {
    id: "pactium-commit",
    mode: "closed",
    iterations: 100,
    seed: 29,
    counters: ["statements", "rewrittenNodes"]
  },
  {
    id: "pactium-pins",
    mode: "closed",
    iterations: 100,
    seed: 31,
    counters: ["statements", "objectBytes"]
  },
  {
    id: "checkpoint-tree",
    mode: "closed",
    iterations: 100,
    seed: 37,
    counters: ["statements", "rewrittenNodes"]
  },
  {
    id: "sqlite-lane",
    mode: "closed",
    iterations: 200,
    seed: 41,
    counters: ["statements", "objectBytes"]
  },
  {
    id: "authorization-compile",
    mode: "closed",
    iterations: 100,
    seed: 47,
    counters: ["statements", "cacheWeight"]
  },
  {
    id: "context-compaction",
    mode: "closed",
    iterations: 50,
    seed: 53,
    counters: ["objectBytes", "statements"]
  },
  {
    id: "delegated-grants",
    mode: "closed",
    iterations: 100,
    seed: 59,
    counters: ["statements", "scans"]
  }
]);

const OPEN_LOOP_WORKLOADS: readonly any[] = Object.freeze([
  {
    id: "mcp-discovery",
    mode: "open",
    concurrency: 8,
    scheduleDelayMs: 4,
    seed: 43,
    counters: ["credits", "wakeups"]
  },
  {
    id: "upstream-gateway-aggregation",
    mode: "open",
    concurrency: 4,
    scheduleDelayMs: 8,
    seed: 61,
    counters: ["credits", "objectBytes"]
  }
]);

export const RUNTIME_CAPACITY_WORKLOAD_CATALOG: any = Object.freeze({
  schemaVersion: "v0.0.1:capacity:workload-catalog-1",
  counterKinds: COUNTER_KINDS,
  closedLoop: CLOSED_LOOP_WORKLOADS,
  openLoop: OPEN_LOOP_WORKLOADS,
  workloads: Object.freeze([...CLOSED_LOOP_WORKLOADS, ...OPEN_LOOP_WORKLOADS])
});

export function workloadById(workloadId: any = "") : any {
  return RUNTIME_CAPACITY_WORKLOAD_CATALOG.workloads.find(
    (workload?: any) : any => workload.id === workloadId
  ) || null;
}

/* Deterministic PRNG (mulberry32) so repeated runs replay identical sequences. */
export function createDeterministicRandom(seed: any = 1) : any {
  let state: any = Number(seed) >>> 0;
  return () : any => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t: any = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createDeterministicCounterSet() : any {
  const counters: Record<string, any> = {};
  for (const kind of COUNTER_KINDS) {
    counters[kind] = 0;
  }
  counters.pending = 0;
  return {
    record(kind: any = "", delta: any = 1) : any {
      if (!(kind in counters)) {
        throw new Error(`Unknown deterministic counter kind: ${kind}`);
      }
      counters[kind] += Number(delta) || 0;
    },
    snapshot() : any {
      return { ...counters };
    }
  };
}

/* Closed-loop synthetic adapter: deterministic per-workload counter replay. */
export function runClosedLoopWorkload(workload: any = {}, counterSet: any = null) : any {
  const spec: any =
    typeof workload === "string" ? workloadById(workload) : workload;
  if (!spec || spec.mode !== "closed") {
    throw new Error(`Closed-loop workload required, got: ${String(workload?.id || workload)}`);
  }
  const counters: any = counterSet || createDeterministicCounterSet();
  const random: any = createDeterministicRandom(spec.seed);
  for (let index: any = 0; index < spec.iterations; index += 1) {
    for (const kind of spec.counters) {
      counters.record(kind, 1 + Math.floor(random() * 4));
    }
    if (spec.counters.includes("wakeups")) {
      counters.record("wakeups", Math.floor(random() * 3));
    }
    if (spec.counters.includes("timers")) {
      counters.record("timers", random() < 0.5 ? 1 : 0);
    }
  }
  return {
    workloadId: spec.id,
    iterations: spec.iterations,
    seed: spec.seed,
    mode: "closed",
    counters: counters.snapshot()
  };
}

/* Open-loop synthetic adapter: deterministic schedule delay admission. */
export async function runOpenLoopWorkload(workload: any = {}, counterSet: any = null) : Promise<any> {
  const spec: any =
    typeof workload === "string" ? workloadById(workload) : workload;
  if (!spec || spec.mode !== "open") {
    throw new Error(`Open-loop workload required, got: ${String(workload?.id || workload)}`);
  }
  const counters: any = counterSet || createDeterministicCounterSet();
  const random: any = createDeterministicRandom(spec.seed);
  const pending: any[] = [];
  for (let index: any = 0; index < spec.concurrency * 4; index += 1) {
    const delayMs: any = spec.scheduleDelayMs + Math.floor(random() * spec.scheduleDelayMs);
    pending.push(delayMs);
    counters.record("credits", 1);
  }
  await new Promise((resolve?: any) : any => setTimeout(resolve, 1));
  for (const delayMs of pending) {
    void delayMs;
    counters.record("wakeups", 1);
  }
  return {
    workloadId: spec.id,
    concurrency: spec.concurrency,
    scheduleDelayMs: spec.scheduleDelayMs,
    seed: spec.seed,
    mode: "open",
    counters: counters.snapshot()
  };
}

/* Replay determinism oracle: two identical runs must produce identical counters. */
export async function replayClosedLoopDeterminism(workloadId: any = "") : Promise<any> {
  const spec: any = workloadById(workloadId);
  const first: any = runClosedLoopWorkload(spec, null);
  const second: any = runClosedLoopWorkload(spec, null);
  return {
    workloadId,
    identical: JSON.stringify(first.counters) === JSON.stringify(second.counters),
    first: first.counters,
    second: second.counters
  };
}

export async function replayCatalogDeterminism() : Promise<any> {
  const results: any[] = [];
  for (const workload of CLOSED_LOOP_WORKLOADS) {
    results.push(await replayClosedLoopDeterminism(workload.id));
  }
  return {
    schemaVersion: RUNTIME_CAPACITY_WORKLOAD_CATALOG.schemaVersion,
    workloadCount: results.length,
    identical: results.every((result?: any) : any => result.identical),
    results
  };
}

export function assertConformanceNeverCertifies(report: Record<string, any> = {}) : any {
  if (report.capacityCertified === true) {
    throw new Error("Conformance evidence must never certify capacity.");
  }
  return true;
}

export { COUNTER_KINDS as RUNTIME_CAPACITY_COUNTER_KINDS };
