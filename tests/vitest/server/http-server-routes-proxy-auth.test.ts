import { describe, expect, it, vi } from "vitest";
import { authorizeProxyRegisteredApiRequest } from "../../../apps/server/runtime/http-server-routes.ts";

function proxyOperation(overrides: Record<string, any> = {}) : any {
  return {
    id: "unit.proxy.workspace",
    public: false,
    http: {
      method: "POST",
      path: "/api/workspaces/:workspaceId/proxy",
      query: [{ name: "serviceId" }]
    },
    inputSchema: { type: "object", properties: {} },
    ...overrides
  };
}

describe("HTTP server registered API proxy authorization", () : any => {
  it("passes path, query, and body input into proxy authorization before forwarding", async () : Promise<any> => {
    const authorizeOperation: any = vi.fn(async ({ input }: Record<string, any>) : Promise<any> => ({
      ok: input.workspaceId !== "workspace-denied",
      status: 403,
      error: "denied"
    }));
    const operation: any = proxyOperation();
    const requestBody: any = Buffer.from(JSON.stringify({
      secretBindingId: "secret-denied",
      payload: { value: "body" }
    }));
    const url: any = new URL("http://127.0.0.1/api/workspaces/workspace-denied/proxy?serviceId=service-denied");

    const result: any = await authorizeProxyRegisteredApiRequest({
      securityPermissions: { authorizeOperation },
      request: { headers: {} },
      operation,
      method: "POST",
      url,
      requestBody,
      pathParams: { workspaceId: "workspace-denied" }
    });

    expect(result.ok).toBe(false);
    expect(result.authorization.status).toBe(403);
    expect(authorizeOperation).toHaveBeenCalledTimes(1);
    expect(authorizeOperation).toHaveBeenCalledWith(expect.objectContaining({
      operation,
      method: "POST",
      input: expect.objectContaining({
        workspaceId: "workspace-denied",
        serviceId: "service-denied",
        secretBindingId: "secret-denied",
        payload: { value: "body" }
      })
    }));
  });
});
