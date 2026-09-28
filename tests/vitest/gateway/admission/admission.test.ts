import { describe, expect, it, vi } from "vitest";
import { createUpstreamAdmission } from "@meshrix/gateway";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("per-upstream bounded admission", () => {
  it("[CASE-B01] isolates slow upstream capacity and preserves FIFO for the same upstream", async () => {
    const admission = createUpstreamAdmission({ maxInFlight: 1, queueSize: 2, defaultQueueDeadlineMs: 1000 });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = admission.run("slow", async () => blocked);
    const queued = admission.run("slow", async () => "queued");
    const independent = await admission.run("fast", async () => "independent");
    expect(independent).toBe("independent");
    release();
    await expect(first).resolves.toBeUndefined();
    await expect(queued).resolves.toBe("queued");
    expect(admission.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it("[CASE-B02] cancels a queued request without consuming an execution slot", async () => {
    const admission = createUpstreamAdmission({ maxInFlight: 1, queueSize: 1, defaultQueueDeadlineMs: 1000 });
    let release!: () => void;
    const first = admission.run("same", async () => new Promise<void>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const queued = admission.run("same", async () => "never", { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "gateway_cancelled" });
    expect(admission.stats()).toMatchObject({ queued: 0 });
    release();
    await first;
    admission.close();
  });

  it("[CASE-B03] keeps unbounded-deadline work in FIFO after the former default cutoff", async () => {
    vi.useFakeTimers();
    const admission = createUpstreamAdmission({ maxInFlight: 1, queueSize: 2 });
    const hold = deferred<void>();
    const executionOrder: string[] = [];
    try {
      const first = admission.run("same", async () => { executionOrder.push("first"); await hold.promise; return "first"; });
      const second = admission.run("same", async () => { executionOrder.push("second"); return "second"; });
      const third = admission.run("same", async () => { executionOrder.push("third"); return "third"; });

      expect(admission.stats()).toMatchObject({ active: 1, queued: 2, timers: 0 });
      await vi.advanceTimersByTimeAsync(30_001);
      expect(admission.stats()).toMatchObject({ active: 1, queued: 2, timers: 0 });
      expect(executionOrder).toEqual(["first"]);

      hold.resolve();
      await expect(Promise.all([first, second, third])).resolves.toEqual(["first", "second", "third"]);
      expect(executionOrder).toEqual(["first", "second", "third"]);
      expect(admission.stats()).toMatchObject({ active: 0, queued: 0, timers: 0 });
    } finally {
      hold.resolve();
      admission.close();
      vi.useRealTimers();
    }
  });

  it("[CASE-B04] expires queued work under an explicitly configured operator budget", async () => {
    vi.useFakeTimers();
    const admission = createUpstreamAdmission({ maxInFlight: 1, queueSize: 1, defaultQueueDeadlineMs: 1_000 });
    const hold = deferred<void>();
    let queuedInvocations = 0;
    try {
      const first = admission.run("same", async () => hold.promise);
      const queued = admission.run("same", async () => { queuedInvocations += 1; });
      const expired = expect(queued).rejects.toMatchObject({ code: "admission_queue_deadline" });

      expect(admission.stats()).toMatchObject({ active: 1, queued: 1, timers: 1 });
      await vi.advanceTimersByTimeAsync(1_000);
      await expired;
      expect(admission.stats()).toMatchObject({ active: 1, queued: 0, timers: 0 });
      expect(queuedInvocations).toBe(0);

      hold.resolve();
      await first;
    } finally {
      hold.resolve();
      admission.close();
      vi.useRealTimers();
    }
  });

  it("[CASE-B05] expires queued work at its trusted invocation deadline", async () => {
    vi.useFakeTimers();
    const admission = createUpstreamAdmission({ maxInFlight: 1, queueSize: 1 });
    const hold = deferred<void>();
    let queuedInvocations = 0;
    try {
      const first = admission.run("same", async () => hold.promise);
      const queued = admission.run("same", async () => { queuedInvocations += 1; }, { deadline: Date.now() + 1_000 });
      const expired = expect(queued).rejects.toMatchObject({ code: "admission_queue_deadline" });

      expect(admission.stats()).toMatchObject({ active: 1, queued: 1, timers: 1 });
      vi.setSystemTime(Date.now() + 1_000);
      hold.resolve();
      await first;
      await expired;
      expect(admission.stats()).toMatchObject({ active: 0, queued: 0, timers: 0 });
      expect(queuedInvocations).toBe(0);
    } finally {
      hold.resolve();
      admission.close();
      vi.useRealTimers();
    }
  });

  it("[CASE-B06] honors the trusted caller deadline ahead of a shorter operator queue budget", async () => {
    vi.useFakeTimers();
    const admission = createUpstreamAdmission({ maxInFlight: 1, queueSize: 1, defaultQueueDeadlineMs: 1_000 });
    const hold = deferred<void>();
    let queuedInvocations = 0;
    try {
      const first = admission.run("same", async () => hold.promise);
      const queued = admission.run("same", async () => { queuedInvocations += 1; }, { deadline: Date.now() + 2_000 });
      const expired = expect(queued).rejects.toMatchObject({ code: "admission_queue_deadline" });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(admission.stats()).toMatchObject({ active: 1, queued: 1, timers: 1 });
      expect(queuedInvocations).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await expired;
      expect(admission.stats()).toMatchObject({ active: 1, queued: 0, timers: 0 });
      expect(queuedInvocations).toBe(0);

      hold.resolve();
      await first;
    } finally {
      hold.resolve();
      admission.close();
      vi.useRealTimers();
    }
  });

  it("[CASE-B07] segments an explicitly selected deadline beyond the platform timer limit", async () => {
    vi.useFakeTimers();
    const admission = createUpstreamAdmission({ maxInFlight: 1, queueSize: 1, defaultQueueDeadlineMs: 2_147_483_648 });
    const hold = deferred<void>();
    let queuedInvocations = 0;
    try {
      const first = admission.run("same", async () => hold.promise);
      const queued = admission.run("same", async () => { queuedInvocations += 1; });
      const expired = expect(queued).rejects.toMatchObject({ code: "admission_queue_deadline" });

      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(admission.stats()).toMatchObject({ active: 1, queued: 1, timers: 1 });
      expect(queuedInvocations).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await expired;
      expect(admission.stats()).toMatchObject({ active: 1, queued: 0, timers: 0 });
      expect(queuedInvocations).toBe(0);

      hold.resolve();
      await first;
    } finally {
      hold.resolve();
      admission.close();
      vi.useRealTimers();
    }
  });

  it("[CASE-B08] rejects invalid explicit queue deadlines instead of substituting a default", async () => {
    for (const defaultQueueDeadlineMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createUpstreamAdmission({ defaultQueueDeadlineMs })).toThrow(RangeError);
    }

    vi.useFakeTimers();
    const admission = createUpstreamAdmission({ maxInFlight: 1, queueSize: 1, defaultQueueDeadlineMs: Number.MAX_SAFE_INTEGER });
    const hold = deferred<void>();
    try {
      const first = admission.run("same", async () => hold.promise);
      await expect(admission.run("same", async () => undefined)).rejects.toMatchObject({ code: "admission_queue_deadline_invalid" });
      expect(admission.stats()).toMatchObject({ active: 1, queued: 0, timers: 0 });

      for (const deadline of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE]) {
        await expect(admission.run("same", async () => undefined, { deadline })).rejects.toMatchObject({ code: "admission_queue_deadline_invalid" });
      }
      expect(admission.stats()).toMatchObject({ active: 1, queued: 0, timers: 0 });

      hold.resolve();
      await first;
    } finally {
      hold.resolve();
      admission.close();
      vi.useRealTimers();
    }
  });

  it("[CASE-B09] closes unbounded queued work without executing it", async () => {
    const admission = createUpstreamAdmission({ maxInFlight: 1, queueSize: 1 });
    const hold = deferred<void>();
    let queuedInvocations = 0;
    const first = admission.run("same", async () => hold.promise);
    const queued = admission.run("same", async () => { queuedInvocations += 1; });

    expect(admission.stats()).toMatchObject({ active: 1, queued: 1, timers: 0 });
    admission.close();
    await expect(queued).rejects.toMatchObject({ code: "gateway_closing" });
    expect(admission.stats()).toMatchObject({ active: 1, queued: 0, timers: 0 });

    hold.resolve();
    await first;
    expect(queuedInvocations).toBe(0);
    expect(admission.stats()).toMatchObject({ active: 0, queued: 0, timers: 0 });
  });
});
