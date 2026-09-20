import { describe, expect, it } from "vitest";
import { createUpstreamAdmission } from "@meshrix/gateway";

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
});

