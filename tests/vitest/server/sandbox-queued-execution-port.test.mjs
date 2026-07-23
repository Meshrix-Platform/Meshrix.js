import { describe, expect, it, vi } from "vitest";

import {
  SANDBOX_EXECUTION_QUEUE_DEFINITION_ID,
  createQueuedSandboxExecutionPort
} from "../../../packages/server-runtime/src/execution-sandbox/queued-execution-port.mjs";

function queueApplicationFixture() {
  let registration;
  let queued;
  const facet = {
    enqueue: vi.fn(async (input) => {
      queued = input;
      return { accepted: true, workItem: { workItemId: input.workItemId } };
    }),
    async requestDispatch() {
      await registration.handler({
        workItem: { workItemId: queued.workItemId, payloadRef: queued.payloadRef }
      }, { signal: new AbortController().signal });
    },
    cancel: vi.fn(async () => ({ cancelled: true })),
    close: vi.fn(async () => ({ closed: true }))
  };
  return {
    async registerQueue(input) {
      registration = input;
      return facet;
    },
    get registration() { return registration; },
    facet
  };
}

function brokerFixture() {
  return {
    execute: vi.fn(async () => ({ status: "denied", runtimeState: "not_started", reasonCode: "sandbox_unconfigured" })),
    executeConfigured: vi.fn(),
    executeOpaque: vi.fn(),
    executeConfiguredOpaque: vi.fn(),
    cancel: vi.fn(async () => false),
    getStatus: vi.fn(),
    getReceipt: vi.fn(),
    resolveQuarantinedOutput: vi.fn(),
    disposeOutput: vi.fn(),
    recover: vi.fn(async () => ({ recovered: true })),
    close: vi.fn(async () => {}),
    configurationState: "unconfigured",
    publicAvailability: () => ({ sandboxAvailable: false }),
    administrativeAvailability: () => ({ state: "unconfigured" }),
    requiredBackendRestrictions: []
  };
}

describe("queued SandboxExecutionPort", () => {
  it("routes product execution through the canonical queue without persisting request content", async () => {
    const broker = brokerFixture();
    const queueApplicationPort = queueApplicationFixture();
    const port = await createQueuedSandboxExecutionPort({ broker, queueApplicationPort });
    const request = {
      schemaVersion: "fixture/1",
      idempotencyKey: "private-idempotency-value",
      deadlineAt: "2099-01-01T00:00:00.000Z",
      payload: { protected: "must-not-enter-queue" }
    };

    await expect(port.execute(request)).resolves.toMatchObject({ reasonCode: "sandbox_unconfigured" });
    expect(port.id).toBe("SandboxExecutionPort");
    expect(queueApplicationPort.registration).toMatchObject({
      queueDefinitionId: SANDBOX_EXECUTION_QUEUE_DEFINITION_ID,
      ownerCapability: "platform.controlled-execution"
    });
    expect(queueApplicationPort.facet.enqueue).toHaveBeenCalledTimes(1);
    const queued = queueApplicationPort.facet.enqueue.mock.calls[0][0];
    expect(queued.payloadRef).toEqual({
      kind: "execute",
      contextRef: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(JSON.stringify(queued)).not.toContain("must-not-enter-queue");
    expect(JSON.stringify(queued)).not.toContain("private-idempotency-value");
    expect(broker.execute).toHaveBeenCalledWith(request, expect.objectContaining({
      signal: expect.any(AbortSignal)
    }));
    await port.close();
    expect(queueApplicationPort.facet.close).toHaveBeenCalledTimes(1);
    expect(broker.close).toHaveBeenCalledTimes(1);
  });

  it("reschedules a completed idempotent replay so the broker can return its durable receipt", async () => {
    const broker = brokerFixture();
    const queueApplicationPort = queueApplicationFixture();
    const port = await createQueuedSandboxExecutionPort({ broker, queueApplicationPort });
    const request = {
      schemaVersion: "fixture/1",
      idempotencyKey: "replay-key",
      deadlineAt: "2099-01-01T00:00:00.000Z"
    };

    await port.execute(request);
    const firstQueueRecord = queueApplicationPort.facet.enqueue.mock.calls[0][0];
    await port.execute(request);
    const secondQueueRecord = queueApplicationPort.facet.enqueue.mock.calls[1][0];

    expect(broker.execute).toHaveBeenCalledTimes(2);
    expect(secondQueueRecord.payloadRef.contextRef).toBe(firstQueueRecord.payloadRef.contextRef);
    expect(secondQueueRecord.workItemId).not.toBe(firstQueueRecord.workItemId);
    expect(secondQueueRecord.dedupeKey).not.toBe(firstQueueRecord.dedupeKey);
    await port.close();
  });
});
