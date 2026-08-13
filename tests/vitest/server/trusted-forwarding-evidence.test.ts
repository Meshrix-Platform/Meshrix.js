import { describe, expect, it, vi } from "vitest";
import { dispatchOperation } from "#meshrix/server-runtime/composition/dispatch-operation";

function response() : any {
  return {
    statusCode: 0,
    chunks: [],
    writeHead(statusCode?: any) : any { this.statusCode = statusCode; },
    end(chunk?: any) : any { if (chunk) this.chunks.push(Buffer.from(chunk)); }
  };
}

const operation: Record<string, any> = {
  id: "fixture.private-read",
  target: { controller: "fixture", method: "handle" },
  http: { method: "GET", path: "/fixture/private" },
  concurrency: { workloadClass: "parallel", maxParallel: 16, cost: 2 },
  readOnly: true,
  safety: { risk: "read_only" },
  audit: { enabled: false },
  log: { recordInput: false },
  inputSchema: { type: "object", properties: {} }
};

describe("trusted forwarding minimum evidence", () : any => {
  it("denies a private read before the handler when proof preparation is unavailable", async () : Promise<any> => {
    const handler: any = vi.fn();
    const result: any = await dispatchOperation({
      operation,
      controllers: { fixture: { handle: handler } },
      request: {},
      response: response(),
      input: {},
      url: new URL("http://127.0.0.1/fixture/private"),
      transport: "internal",
      skipAuthorization: true,
      revalidateAuthorization: vi.fn(async () : Promise<any> => ({ ok: true })),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    expect(result).toMatchObject({ ok: false, statusCode: 503 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("revalidates private reads after proof preparation and denies stale authority", async () : Promise<any> => {
    const handler: any = vi.fn();
    const revalidateAuthorization: any = vi.fn(async () : Promise<any> => ({
      ok: false,
      status: 403,
      reasonCode: "authorization_stale"
    }));
    const result: any = await dispatchOperation({
      operation,
      controllers: { fixture: { handle: handler } },
      request: {},
      response: response(),
      input: {},
      url: new URL("http://127.0.0.1/fixture/private"),
      transport: "internal",
      skipAuthorization: true,
      revalidateAuthorization,
      operationProofSubstrate: {
        beginLifecycle: vi.fn(async () : Promise<any> => ({ ledgerEventId: "proof-private-read" })),
        finishLifecycle: vi.fn(async () : Promise<any> => ({ ledgerEventId: "proof-private-read" })),
        recordReceipt: vi.fn(async () : Promise<any> => ({ ledgerEventId: "proof-private-read-denied" }))
      },
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    expect(result).toMatchObject({ ok: false, statusCode: 403 });
    expect(revalidateAuthorization).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("reports in_doubt and forbids blind retry after dispatch may have started", async () : Promise<any> => {
    const finishLifecycle: any = vi.fn(async (input?: any) : Promise<any> => ({ ledgerEventId: input.ledgerEventId }));
    await expect(dispatchOperation({
      operation,
      controllers: {
        fixture: {
          handle: vi.fn(async () : Promise<any> => {
            throw new Error("synthetic post-dispatch failure");
          })
        }
      },
      request: {},
      response: response(),
      input: {},
      url: new URL("http://127.0.0.1/fixture/private"),
      transport: "internal",
      skipAuthorization: true,
      revalidateAuthorization: vi.fn(async () : Promise<any> => ({ ok: true })),
      operationProofSubstrate: {
        beginLifecycle: vi.fn(async () : Promise<any> => ({ ledgerEventId: "proof-in-doubt" })),
        finishLifecycle,
        recordReceipt: vi.fn()
      },
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })).rejects.toMatchObject({
      code: "operation_outcome_in_doubt",
      retryable: false
    });
    expect(finishLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      status: "in_doubt",
      outcomeKind: "in_doubt",
      result: { reconciliationRequired: true }
    }));
  });
});
