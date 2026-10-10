/**
 * `RELAY_METRICS_DURABLE=0` (persistence-disabled) coverage. Unit-level
 * assertions on `metricsDurableEnabled`/`RelayCounters`/exposition plus one
 * real-Workerd check that the var reaches a live Durable Object: counters
 * route every key to the in-memory tier, `flush()` is a guaranteed no-op
 * (zero counter writes to DO SQLite), previously persisted counters stay
 * visible honestly, and the exposition labels counted values
 * `scope="ephemeral"`. All synthetic.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { env, reset } from "cloudflare:test";

import type { PrivateRelayEnv } from "../src/env.ts";
import { metricsDurableEnabled } from "../src/env.ts";
import { directoryObjectName } from "../src/ids.ts";
import {
  RELAY_COUNTER_KEYS,
  RelayCounters,
  counterMetricName,
  emptyCounters,
  renderPrometheusExposition,
} from "../src/metrics.ts";
import { RELAY_ORIGIN, ROUTE_1, TENANT_A, adminGet, enroll } from "./helpers.ts";

afterEach(async () => {
  await reset();
});

describe("metricsDurableEnabled", () => {
  const envWith = (value?: string): PrivateRelayEnv => ({ RELAY_METRICS_DURABLE: value }) as PrivateRelayEnv;

  it("defaults to durable when the var is unset or empty", () => {
    expect(metricsDurableEnabled(envWith())).toBe(true);
    expect(metricsDurableEnabled(envWith(""))).toBe(true);
    expect(metricsDurableEnabled(envWith("   "))).toBe(true);
  });

  it("treats 0/false/off case-insensitively as disabled", () => {
    for (const value of ["0", "false", "off", "FALSE", "Off", "  off  ", " False "]) {
      expect(metricsDurableEnabled(envWith(value)), value).toBe(false);
    }
  });

  it("keeps durable for every other value", () => {
    for (const value of ["1", "true", "on", "yes", "durable", "00"]) {
      expect(metricsDurableEnabled(envWith(value)), value).toBe(true);
    }
  });
});

describe("RelayCounters with durable persistence disabled", () => {
  it("routes every key — durable-class included — to the in-memory tier", () => {
    const counters = new RelayCounters(undefined, { durable: false });
    counters.count("sessionsAdmitted"); // durable-class key
    counters.count("storageWrites", 2); // durable-class key
    counters.count("httpRequests", 3); // ephemeral-class key

    const { counters: merged, durable, ephemeral } = counters.tieredSnapshot();
    // The durable map stays all-zeros: nothing survives eviction when the
    // durable tier is disabled — honest semantics, no hidden durable map.
    expect(durable).toEqual(emptyCounters());
    expect(ephemeral.sessionsAdmitted).toBe(1);
    expect(ephemeral.storageWrites).toBe(2);
    expect(ephemeral.httpRequests).toBe(3);
    // The merged view still reports the real per-operation totals.
    expect(merged.sessionsAdmitted).toBe(1);
    expect(merged.storageWrites).toBe(2);
    expect(merged.httpRequests).toBe(3);
  });

  it("makes flush() a guaranteed no-op — zero counter writes to storage", async () => {
    const counters = new RelayCounters(undefined, { durable: false });
    counters.count("sessionsAdmitted", 4);
    counters.count("storageWrites", 9);
    counters.count("bytesIn", 1024);
    const put = vi.fn(async (_key: string, _value: unknown) => {});
    await counters.flush(put);
    expect(put).not.toHaveBeenCalled();
  });

  it("keeps previously persisted counters visible while new counts stay ephemeral", async () => {
    const counters = new RelayCounters({ sessionsAdmitted: 7, storageReads: 3 }, { durable: false });
    counters.count("sessionsAdmitted");
    counters.count("httpRequests", 2);

    const { counters: merged, durable, ephemeral } = counters.tieredSnapshot();
    // Loaded history stays on the durable tier — frozen, never re-flushed.
    expect(durable.sessionsAdmitted).toBe(7);
    expect(durable.storageReads).toBe(3);
    expect(ephemeral.sessionsAdmitted).toBe(1);
    expect(ephemeral.httpRequests).toBe(2);
    expect(merged.sessionsAdmitted).toBe(8);

    // Even loaded data is never written again once persistence is off.
    const put = vi.fn(async (_key: string, _value: unknown) => {});
    await counters.flush(put);
    expect(put).not.toHaveBeenCalled();
  });

  it("still flushes honestly when durable persistence is enabled (regression)", async () => {
    const counters = new RelayCounters(undefined, { durable: true });
    counters.count("sessionsAdmitted", 2);
    const put = vi.fn(async (_key: string, _value: unknown) => {});
    await counters.flush(put);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith("counters", expect.objectContaining({ sessionsAdmitted: 2 }));
  });
});

describe("exposition scope labels under disabled persistence", () => {
  const labels = { object: "session" as const, tenant: TENANT_A, route: ROUTE_1, device: "" };

  it("emits scope=ephemeral for counted durable-class keys", () => {
    const counters = new RelayCounters(undefined, { durable: false });
    counters.count("sessionsAdmitted", 5);
    counters.count("httpRequests", 2);
    const { durable, ephemeral } = counters.tieredSnapshot();
    const text = renderPrometheusExposition([{ labels, durable, ephemeral }]);

    const admitted = `${counterMetricName("sessionsAdmitted")}{object="session",tenant="${TENANT_A}",route="${ROUTE_1}",device="",scope="ephemeral"} 5`;
    const requests = `${counterMetricName("httpRequests")}{object="session",tenant="${TENANT_A}",route="${ROUTE_1}",device="",scope="ephemeral"} 2`;
    expect(text).toContain(admitted);
    expect(text).toContain(requests);
    // No non-zero sample may claim the durable tier in disabled mode.
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const scope = line.match(/scope="(durable|ephemeral)"\} (\d+)$/u);
      expect(scope, line).not.toBeNull();
      if (Number(scope![2]) > 0) expect(scope![1]).toBe("ephemeral");
    }
    // The value did not vanish: sessionsAdmitted reports the counted 5.
    expect(text).not.toContain(`${counterMetricName("sessionsAdmitted")}{object="session",tenant="${TENANT_A}",route="${ROUTE_1}",device="",scope="durable"} 5`);
  });

  it("emits both tiers when previously persisted data meets disabled counting", () => {
    const counters = new RelayCounters({ sessionsAdmitted: 7 }, { durable: false });
    counters.count("sessionsAdmitted", 1);
    const { durable, ephemeral } = counters.tieredSnapshot();
    const text = renderPrometheusExposition([{ labels, durable, ephemeral }]);

    // Persisted history stays visible under its honest durable label while
    // the new in-memory count reports ephemeral — nothing is hidden.
    expect(text).toContain(`${counterMetricName("sessionsAdmitted")}{object="session",tenant="${TENANT_A}",route="${ROUTE_1}",device="",scope="durable"} 7`);
    expect(text).toContain(`${counterMetricName("sessionsAdmitted")}{object="session",tenant="${TENANT_A}",route="${ROUTE_1}",device="",scope="ephemeral"} 1`);
  });

  it("keeps the durable scope label in the enabled shape (regression)", () => {
    const counters = new RelayCounters(undefined, { durable: true });
    counters.count("sessionsAdmitted", 4);
    const { durable, ephemeral } = counters.tieredSnapshot();
    const text = renderPrometheusExposition([{ labels, durable, ephemeral }]);
    expect(text).toContain(`${counterMetricName("sessionsAdmitted")}{object="session",tenant="${TENANT_A}",route="${ROUTE_1}",device="",scope="durable"} 4`);
    expect(text).not.toContain(`${counterMetricName("sessionsAdmitted")}{object="session",tenant="${TENANT_A}",route="${ROUTE_1}",device="",scope="ephemeral"}`);
  });
});

describe("disabled persistence on a real Durable Object", () => {
  it("reports all counted values on the in-memory tier with an all-zero durable tier", async () => {
    // vitest-pool-workers exposes the same bindings object the DOs receive,
    // so flipping the var before a fresh object is constructed exercises the
    // real env → DO wiring (reset() evicts every object between tests).
    const previous = env.RELAY_METRICS_DURABLE;
    env.RELAY_METRICS_DURABLE = "0";
    try {
      const enrolled = await enroll(TENANT_A, "dev.test.mx.durable.off", ROUTE_1, "entry");
      expect(enrolled.deviceId).toBe("dev.test.mx.durable.off");

      const stub = env.RELAY_DIRECTORY.get(env.RELAY_DIRECTORY.idFromName(directoryObjectName(TENANT_A)));
      const response = await stub.fetch(`${RELAY_ORIGIN}/internal/counters`);
      expect(response.ok).toBe(true);
      const tiers = await response.json() as {
        counters: Record<string, number>;
        durable: Record<string, number>;
        ephemeral: Record<string, number>;
      };

      // Every counted tier is in memory: durable all-zeros (nothing was
      // ever persisted), ephemeral carries the real reads/requests.
      for (const key of RELAY_COUNTER_KEYS) expect(tiers.durable[key], key).toBe(0);
      expect(tiers.ephemeral.storageReads).toBeGreaterThanOrEqual(1);
      expect(tiers.ephemeral.httpRequests).toBeGreaterThanOrEqual(1);
      expect(tiers.counters.storageReads).toBe(tiers.ephemeral.storageReads);
      expect(tiers.counters.httpRequests).toBe(tiers.ephemeral.httpRequests);

      // The Prometheus exposition carries only scope="ephemeral" samples
      // for counted values — the honest "nothing survives eviction" label.
      const exposition = await (await adminGet(`/admin/metrics?tenant=${TENANT_A}`)).text();
      for (const line of exposition.split("\n")) {
        if (!line || line.startsWith("#")) continue;
        const scope = line.match(/scope="(durable|ephemeral)"\} (\d+)$/u);
        expect(scope, line).not.toBeNull();
        if (Number(scope![2]) > 0) expect(scope![1], line).toBe("ephemeral");
      }
      expect(exposition).toContain(`scope="ephemeral"} `);
    } finally {
      env.RELAY_METRICS_DURABLE = previous;
    }
  });
});
