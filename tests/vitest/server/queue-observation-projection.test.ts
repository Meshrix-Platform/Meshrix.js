import { describe, expect, it, vi } from "vitest";

import {
  createWorkQueueObservationProjection,
  projectQueueObservation
} from "../../../packages/server-runtime/src/composition/queue-observation-projection.ts";

describe("work queue observation projection", () : any => {
  it("projects canonical work items without owner, payload, lease, or journal data", () : any => {
    const result: any = projectQueueObservation({
      stateCounts: [
        { state: "queued", count: 2 },
        { state: "failed", count: 1 }
      ],
      items: [{
        workItemId: "work-public-ref",
        queueDefinitionId: "queue.jobs.import-parse",
        queueDefinitionVersion: 1,
        state: "failed",
        priorityClass: "normal",
        attempt: 2,
        maxAttempts: 3,
        createdAtMs: Date.parse("2026-06-04T08:00:00.000Z"),
        updatedAtMs: Date.parse("2026-06-04T08:01:00.000Z"),
        expiresAtMs: Date.parse("2026-06-04T09:00:00.000Z"),
        lastError: {
          code: "worker_failed",
          message: "sensitive failure detail"
        },
        ownerRef: { subjectId: "private-owner" },
        payloadRef: { path: "private-input-path" },
        lease: { leaseId: "private-lease" },
        journal: [{ actor: "private-actor" }]
      }]
    });

    expect(result.summary).toEqual({
      totalCount: 3,
      stateCounts: { failed: 1, queued: 2 }
    });
    expect(result.items).toEqual([expect.objectContaining({
      workItemId: "work-public-ref",
      queueDefinitionId: "queue.jobs.import-parse",
      observationStatus: "interrupted",
      state: "failed",
      expiresAtMs: Date.parse("2026-06-04T09:00:00.000Z")
    })]);
    const serialized: any = JSON.stringify(result);
    expect(serialized).not.toContain("sensitive failure detail");
    expect(serialized).not.toContain("private-owner");
    expect(serialized).not.toContain("private-input-path");
    expect(serialized).not.toContain("private-lease");
    expect(serialized).not.toContain("private-actor");
  });

  it("reads through the workflow provider without exposing mutation methods", async () : Promise<any> => {
    const inspectWorkQueue: any = vi.fn(async () : Promise<any> => ({
      stateCounts: [{ state: "running", count: 1 }],
      items: [{ workItemId: "work-running", queueDefinitionId: "queue.jobs.import-parse", state: "running" }]
    }));
    const projection: any = createWorkQueueObservationProjection({
      getJobWorkflowProvider: () : any => ({ inspectWorkQueue })
    });

    await expect(projection.inspect({ limit: 25 })).resolves.toMatchObject({
      summary: { totalCount: 1, stateCounts: { running: 1 } },
      items: [{ workItemId: "work-running", observationStatus: "running", state: "running" }]
    });
    expect(inspectWorkQueue).toHaveBeenCalledWith({ limit: 25 });
    expect(Object.keys(projection)).toEqual(["inspect"]);
  });

  it("returns an empty read model until the workflow provider is available", async () : Promise<any> => {
    const projection: any = createWorkQueueObservationProjection();
    await expect(projection.inspect()).resolves.toMatchObject({
      summary: { totalCount: 0, stateCounts: {} },
      items: []
    });
  });
});
