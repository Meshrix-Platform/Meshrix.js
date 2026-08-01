import http from "node:http";
import { describe, expect, it } from "vitest";
import { digestGovernedExecutionRequest } from "#meshrix/foundation/security/governed-execution-permit-authority";
import { riskControlInputHash } from "#meshrix/server-runtime/composition/dispatch-operation-risk-control";
import { proxyApiRequest } from "../../../apps/server/runtime/http-server-proxy.ts";

describe("trusted forwarding content integrity", () : any => {
  it("does not collapse semantic input beyond former truncation limits", () : any => {
    const operation: Record<string, any> = { id: "fixture.forward" };
    const prefix: any = "x".repeat(600);
    const left: any = riskControlInputHash({
      operation,
      transport: "http",
      method: "POST",
      input: { body: `${prefix}a`, items: Array.from({ length: 60 }, (_?: any, index?: any) : any => index) }
    });
    const right: any = riskControlInputHash({
      operation,
      transport: "http",
      method: "POST",
      input: { body: `${prefix}b`, items: Array.from({ length: 60 }, (_?: any, index?: any) : any => index) }
    });
    expect(left).not.toBe(right);
  });

  it("binds canonical input and exact raw carrier bytes", () : any => {
    const base: Record<string, any> = {
      operationId: "fixture.forward",
      transport: "http",
      method: "POST",
      path: "/fixture",
      input: { value: "same" }
    };
    expect(digestGovernedExecutionRequest({
      ...base,
      requestBody: Buffer.from('{"value":"same"}')
    })).not.toBe(digestGovernedExecutionRequest({
      ...base,
      requestBody: Buffer.from('{ "value": "same" }')
    }));
    expect(digestGovernedExecutionRequest({
      ...base,
      input: { value: "changed" },
      requestBody: Buffer.from('{"value":"same"}')
    })).not.toBe(digestGovernedExecutionRequest({
      ...base,
      requestBody: Buffer.from('{"value":"same"}')
    }));
  });

  it("does not relay caller credentials or redirect authority through the forward proxy", async () : Promise<any> => {
    let receivedHeaders: any = null;
    const upstream: any = http.createServer((request?: any, response?: any) : any => {
      receivedHeaders = request.headers;
      response.writeHead(302, {
        location: "http://127.0.0.1/untrusted-target",
        "set-cookie": "fixture-cookie=changed",
        "content-type": "text/plain"
      });
      response.end("bounded");
    });
    await new Promise((resolve?: any) : any => upstream.listen(0, "127.0.0.1", resolve));
    const address: any = upstream.address();
    const captured: Record<string, any> = {
      status: 0,
      headers: {},
      body: Buffer.alloc(0),
      writeHead(status?: any, headers?: any) : any {
        this.status = status;
        this.headers = headers;
      },
      end(body?: any) : any {
        this.body = Buffer.from(body || "");
      }
    };
    try {
      await proxyApiRequest({
        request: {
          method: "GET",
          url: "/fixture",
          headers: {
            authorization: "fixture-credential",
            cookie: "fixture-cookie=original",
            accept: "text/plain"
          }
        },
        response: captured,
        requestBody: Buffer.alloc(0),
        targetBaseUrl: `http://127.0.0.1:${address.port}`
      });
    } finally {
      await new Promise((resolve?: any, reject?: any) : any => upstream.close((error?: any) : any => error ? reject(error) : resolve()));
    }
    expect(receivedHeaders).toMatchObject({ accept: "text/plain" });
    expect(receivedHeaders).not.toHaveProperty("authorization");
    expect(receivedHeaders).not.toHaveProperty("cookie");
    expect(captured.status).toBe(302);
    expect(captured.headers).not.toHaveProperty("location");
    expect(captured.headers).not.toHaveProperty("set-cookie");
  });
});
