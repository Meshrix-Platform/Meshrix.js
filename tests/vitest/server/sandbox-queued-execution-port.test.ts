import { describe, expect, it, vi } from "vitest";

import {
  SANDBOX_EXECUTION_QUEUE_DEFINITION_ID,
  createQueuedSandboxExecutionPort
} from "../../../packages/server-runtime/src/execution-sandbox/queued-execution-port.ts";

function queueApplicationFixture() : any {
  let registration: any;
  let queued: any;
  const facet: Record<string, any> = {
    enqueue: vi.fn(async (input?: any) : Promise<any> => {
      queued = input;
      return { accepted: true, workItem: { workItemId: input.workItemId } };
    }),
    async requestDispatch() : Promise<any> {
      await registration.handler({
        workItem: { workItemId: queued.workItemId, payloadRef: queued.payloadRef }
      }, { signal: new AbortController().signal });
    },
    cancel: vi.fn(async () : Promise<any> => ({ cancelled: true })),
    close: vi.fn(async () : Promise<any> => ({ closed: true }))
  };
  return {
    async registerQueue(input?: any) : Promise<any> {
      registration = input;
      return facet;
    },
    get registration() : any { return registration; },
    facet
  };
}

function brokerFixture() : any {
  return {
    execute: vi.fn(async () : Promise<any> => ({ status: "denied", runtimeState: "not_started", reasonCode: "sandbox_unconfigured" })),
    executeConfigured: vi.fn(),
    executeOpaque: vi.fn(),
    executeConfiguredOpaque: vi.fn(),
    cancel: vi.fn(async () : Promise<any> => false),
    getStatus: vi.fn(),
    getReceipt: vi.fn(),
    resolveQuarantinedOutput: vi.fn(),
    disposeOutput: vi.fn(),
    recover: vi.fn(async () : Promise<any> => ({ recovered: true })),
    close: vi.fn(async () : Promise<any> => {}),
    configurationState: "unconfigured",
    publicAvailability: () : any => ({ sandboxAvailable: false }),
    administrativeAvailability: () : any => ({ state: "unconfigured" }),
    requiredBackendRestrictions: []
  };
}

describe("queued SandboxExecutionPort", () : any => {
  it("routes product execution through the canonical queue without persisting request content", async () : Promise<any> => {
    const broker: any = brokerFixture();
    const queueApplicationPort: any = queueApplicationFixture();
    const port: any = await createQueuedSandboxExecutionPort({ broker, queueApplicationPort });
    const request: Record<string, any> = {
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
    const queued: any = queueApplicationPort.facet.enqueue.mock.calls[0][0];
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

  it("reschedules a completed idempotent replay so the broker can return its durable receipt", async () : Promise<any> => {
    const broker: any = brokerFixture();
    const queueApplicationPort: any = queueApplicationFixture();
    const port: any = await createQueuedSandboxExecutionPort({ broker, queueApplicationPort });
    const request: Record<string, any> = {
      schemaVersion: "fixture/1",
      idempotencyKey: "replay-key",
      deadlineAt: "2099-01-01T00:00:00.000Z"
    };

    await port.execute(request);
    const firstQueueRecord: any = queueApplicationPort.facet.enqueue.mock.calls[0][0];
    await port.execute(request);
    const secondQueueRecord: any = queueApplicationPort.facet.enqueue.mock.calls[1][0];

    expect(broker.execute).toHaveBeenCalledTimes(2);
    expect(secondQueueRecord.payloadRef.contextRef).toBe(firstQueueRecord.payloadRef.contextRef);
    expect(secondQueueRecord.workItemId).not.toBe(firstQueueRecord.workItemId);
    expect(secondQueueRecord.dedupeKey).not.toBe(firstQueueRecord.dedupeKey);
    await port.close();
  });
});
