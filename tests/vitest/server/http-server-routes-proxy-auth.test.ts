import { describe, expect, it, vi } from "vitest";

import { dispatchRegisteredHttpOperation } from "../../../packages/server-runtime/src/composition/dispatch-operation-http.ts";
import { createOperationRouteIndex } from "../../../packages/server-runtime/src/routing/operation-route-index.ts";

function proxyOperation() : any {
  return {
    id: "unit.proxy.workspace",
    public: false,
    readOnly: true,
    safety: { risk: "read_only" },
    concurrency: { workloadClass: "parallel", key: "unit.proxy", maxParallel: 16, cost: 1 },
    http: {
      method: "POST",
      path: "/api/workspaces/:workspaceId/proxy",
      query: [{ name: "serviceId" }]
    },
    inputSchema: { type: "object", additionalProperties: true, properties: {} },
    target: { controller: "unused", method: "unused" }
  };
}

function responseFixture() : any {
  return {
    statusCode: 200,
    writableEnded: false,
    headersSent: false,
    setHeader: vi.fn(),
    writeHead(status?: any) { this.statusCode = status; this.headersSent = true; },
    end() { this.writableEnded = true; }
  };
}

function proofFixture() : any {
  return {
    beginLifecycle: vi.fn(async () : Promise<any> => ({ ledgerEventId: "fixture-proof" })),
    finishLifecycle: vi.fn(async () : Promise<any> => ({ ledgerEventId: "fixture-proof" })),
    recordReceipt: vi.fn(async () : Promise<any> => ({ ledgerEventId: "fixture-proof" }))
  };
}

describe("HTTP server registered API proxy governance", () : any => {
  it("invokes forwarding only inside the canonical registered-operation dispatcher", async () : Promise<any> => {
    const authorizeOperation: any = vi.fn(async ({ input }: Record<string, any>) : Promise<any> => ({
      ok: input.workspaceId !== "workspace-denied",
      status: 403,
      error: "denied",
      session: { id: "fixture-session", scopes: [] },
      actor: { type: "console-user", subjectId: "fixture-user", scopes: [] },
      authorizationDecision: { allowed: true, decisionId: "fixture-decision" }
    }));
    const invokeOperation: any = vi.fn(async ({ response }: Record<string, any>) : Promise<any> => {
      response.writeHead(204);
      response.end();
    });
    const response: any = responseFixture();
    const operation: any = proxyOperation();
    const routeIndex: any = createOperationRouteIndex([operation]);
    const requestBody: any = Buffer.from(JSON.stringify({ secretBindingId: "fixture-secret" }));
    const url: any = new URL("http://127.0.0.1/api/workspaces/workspace-allowed/proxy?serviceId=fixture-service");

    await expect(dispatchRegisteredHttpOperation({
      operations: [operation],
      routeIndex,
      controllers: {},
      method: "POST",
      url,
      request: { headers: {} },
      response,
      requestBody,
      authorizeOperation,
      operationProofSubstrate: proofFixture(),
      invokeOperation,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })).resolves.toBe(true);

    expect(authorizeOperation).toHaveBeenCalledWith(expect.objectContaining({
      operation,
      input: expect.objectContaining({
        workspaceId: "workspace-allowed",
        serviceId: "fixture-service",
        secretBindingId: "fixture-secret"
      })
    }));
    expect(response.statusCode).toBe(204);
    expect(invokeOperation).toHaveBeenCalledTimes(1);
  });

  it("has zero forwarding effect after dispatcher authorization denial", async () : Promise<any> => {
    const invokeOperation: any = vi.fn();
    const response: any = responseFixture();
    await dispatchRegisteredHttpOperation({
      operations: [proxyOperation()],
      routeIndex: createOperationRouteIndex([proxyOperation()]),
      controllers: {},
      method: "POST",
      url: new URL("http://127.0.0.1/api/workspaces/workspace-denied/proxy"),
      request: { headers: {} },
      response,
      requestBody: Buffer.from("{}"),
      authorizeOperation: async () : Promise<any> => ({ ok: false, status: 403, error: "denied" }),
      operationProofSubstrate: proofFixture(),
      invokeOperation,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    expect(invokeOperation).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(403);
  });
});
