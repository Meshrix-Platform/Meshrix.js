import assert from "node:assert/strict";
import http from "node:http";

function sendJson(response?: any, status?: any, payload?: any) : any {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

export function createUpstreamGatewayFixture({
  resolvedSecretToken,
  failPaths = []
}: Record<string, any> = {}) : any {
  const failingPathSet: any = new Set<any>(failPaths);
  const holds: any = new Map<any, any>();
  const state: Record<string, any> = {
    echoCount: 0,
    approvalCount: 0,
    jsonRpcCount: 0,
    concurrentCount: 0,
    failureCount: 0
  };

  function holdRecord(holdId?: any) : any {
    const key: any = String(holdId || "");
    if (!key) return null;
    let record: any = holds.get(key);
    if (!record) {
      record = {
        started: false,
        released: false,
        startedWaiters: [],
        releaseWaiters: []
      };
      holds.set(key, record);
    }
    return record;
  }

  function markHoldStarted(holdId?: any) : any {
    const record: any = holdRecord(holdId);
    if (!record || record.started) return;
    record.started = true;
    const waiters: any = record.startedWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  function releaseHold(holdId?: any) : any {
    const record: any = holdRecord(holdId);
    if (!record || record.released) return;
    record.released = true;
    const waiters: any = record.releaseWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  function waitForHold(holdId?: any, timeoutMs: any = 2000) : any {
    const record: any = holdRecord(holdId);
    if (!record) {
      return Promise.reject(new Error("holdId is required"));
    }
    if (record.started) return Promise.resolve();
    return new Promise((resolve?: any, reject?: any) : any => {
      const timer: any = setTimeout(() : any => {
        reject(new Error(`Timed out waiting for upstream fixture hold: ${holdId}`));
      }, Math.max(1, Number(timeoutMs || 2000)));
      record.startedWaiters.push(() : any => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function waitForHoldRelease(holdId?: any, timeoutMs: any = 5000) : any {
    const record: any = holdRecord(holdId);
    if (!record || record.released) return Promise.resolve();
    return new Promise((resolve?: any) : any => {
      const timer: any = setTimeout(resolve, Math.max(1, Number(timeoutMs || 5000)));
      record.releaseWaiters.push(() : any => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    state,
    releaseHold,
    waitForHold,
    start() : any {
      return new Promise((resolve?: any) : any => {
        const upstream: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
          const url: any = new URL(request.url || "/", "http://127.0.0.1");
          const chunks: any[] = [];
          request.on("data", (chunk?: any) : any => chunks.push(chunk));
          await new Promise((done?: any) : any => request.on("end", done));
          if (url.pathname === "/health") {
            sendJson(response, 200, { ok: true });
            return;
          }
          if (failingPathSet.has(url.pathname)) {
            state.failureCount += 1;
            sendJson(response, 503, { ok: false, retryable: true });
            return;
          }
          if (url.pathname === "/echo") {
            state.echoCount += 1;
            const body: any = Buffer.concat(chunks).toString("utf8");
            sendJson(response, 200, {
              ok: true,
              method: request.method,
              path: url.pathname,
              bodyLength: body.length,
              credentialOk: request.headers.authorization === `Bearer ${resolvedSecretToken}`,
              echoed: body ? JSON.parse(body) : {}
            });
            return;
          }
          if (url.pathname === "/approval") {
            state.approvalCount += 1;
            sendJson(response, 200, { ok: true, approvedPathHit: true });
            return;
          }
          if (url.pathname === "/jsonrpc") {
            state.jsonRpcCount += 1;
            const body: any = Buffer.concat(chunks).toString("utf8");
            const payload: any = body ? JSON.parse(body) : {};
            if (payload.jsonrpc !== "2.0" || payload.method !== "fixture.echo") {
              sendJson(response, 200, {
                jsonrpc: "2.0",
                id: payload.id ?? null,
                error: { code: -32601, message: "method not found" }
              });
              return;
            }
            sendJson(response, 200, {
              jsonrpc: "2.0",
              id: payload.id ?? null,
              result: {
                ok: true,
                echoed: payload.params || {}
              }
            });
            return;
          }
          if (url.pathname === "/schema-mismatch") {
            sendJson(response, 200, { ok: "not-a-boolean", unexpected: true });
            return;
          }
          if (url.pathname === "/slow") {
            await new Promise((done?: any) : any => setTimeout(done, 200));
            sendJson(response, 200, { ok: true, slow: true });
            return;
          }
          if (url.pathname === "/non-json") {
            response.writeHead(200, {
              "Content-Type": "text/plain",
              "Cache-Control": "no-store"
            });
            response.end("plain fixture response");
            return;
          }
          if (url.pathname === "/large") {
            sendJson(response, 200, { data: "x".repeat(4096) });
            return;
          }
          if (url.pathname === "/concurrent") {
            const holdId: any = url.searchParams.get("holdId") || "";
            if (holdId) {
              markHoldStarted(holdId);
              await waitForHoldRelease(holdId);
            }
            const waitMs: any = Math.max(0, Math.min(Number(url.searchParams.get("waitMs") || 0), 500));
            if (waitMs > 0) {
              await new Promise((done?: any) : any => setTimeout(done, waitMs));
            }
            state.concurrentCount += 1;
            sendJson(response, 200, { ok: true, index: url.searchParams.get("i") || "" });
            return;
          }
          sendJson(response, 404, { ok: false, error: "not_found" });
        });
        upstream.listen(0, "127.0.0.1", () : any => {
          const address: any = upstream.address();
          resolve({
            server: upstream,
            url: `http://127.0.0.1:${address.port}`
          });
        });
      });
    },
    close(target?: any) : any {
      return new Promise((resolve?: any) : any => {
        if (!target?.close) {
          resolve();
          return;
        }
        target.close(() : any => resolve());
      });
    }
  };
}

export function structuredPayload(mcpPayload?: any) : any {
  return mcpPayload?.result?.structuredContent?.payload || mcpPayload?.result?.structuredContent || {};
}

export async function waitForFixtureHoldBeforeRequestCompletion({
  fixture,
  holdId,
  request,
  timeoutMs = 30_000
}: Record<string, any> = {}) : Promise<any> {
  const firstSignal: any = await Promise.race([
    fixture.waitForHold(holdId, timeoutMs).then(
      () : any => ({ type: "hold-started" }),
      (error?: any) : any => ({ type: "hold-timeout", error })
    ),
    request.then((response?: any) : any => ({ type: "first-completed", response }))
  ]);
  if (firstSignal.type === "hold-timeout") {
    throw firstSignal.error;
  }
  if (firstSignal.type === "first-completed") {
    throw new Error(`First concurrency probe completed before the fixture hold: ${JSON.stringify(firstSignal.response?.payload || {}, null, 2)}`);
  }
}

export async function runConcurrentTrafficSlotWorkflow({
  api,
  gatewayFixture,
  concurrentLimitedServiceId,
  assertNoLeak
}: Record<string, any> = {}) : Promise<any> {
  const preview: any = await api("POST", "/api/gateway/v1/policy/preview", {
    serviceId: concurrentLimitedServiceId,
    operationKey: "limited-concurrent"
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.payload.traffic.algorithm, "token_bucket_with_concurrency");
  assert.equal(preview.payload.traffic.maxConcurrent, 1);
  const holdId: any = "traffic-concurrency-slot";
  const firstRequest: any = api("POST", "/api/gateway/v1/forward", {
    serviceId: concurrentLimitedServiceId,
    operationKey: "limited-concurrent",
    query: { i: "first", holdId }
  }).catch((error?: any) : any => ({ status: 0, payload: { error: error?.code || "request_failed" } }));
  try {
    await waitForFixtureHoldBeforeRequestCompletion({
      fixture: gatewayFixture,
      holdId,
      request: firstRequest
    });
    const rejected: any = await api("POST", "/api/gateway/v1/forward", {
      serviceId: concurrentLimitedServiceId,
      operationKey: "limited-concurrent",
      query: { i: "second" }
    }).catch((error?: any) : any => ({ status: 0, payload: { error: error?.code || "request_failed" } }));
    gatewayFixture.releaseHold(holdId);
    const first: any = await firstRequest;
    const statuses: any = [first.status, rejected.status].sort((left?: any, right?: any) : any => left - right);
    assert.deepEqual(statuses, [200, 429], JSON.stringify({ first: first.payload, rejected: rejected.payload }, null, 2));
    const rejectedResponse: any = [first, rejected].find((item?: any) : any => item.status === 429);
    assert.equal(rejectedResponse?.payload?.details?.traffic?.deniedReason, "concurrency_limit_exceeded");
    assertNoLeak(rejectedResponse?.payload || {}, "concurrency rejection response");
    return {
      algorithm: preview.payload.traffic.algorithm,
      maxConcurrent: preview.payload.traffic.maxConcurrent,
      statuses,
      deniedReason: rejectedResponse?.payload?.details?.traffic?.deniedReason
    };
  } finally {
    gatewayFixture.releaseHold(holdId);
  }
}

export function gatewayOperationNames(capabilities: Record<string, any> = {}) : any {
  return new Set<any>(
    (capabilities.operations || [])
      .filter((operation?: any) : any => /^gateway\.|^external_services\./.test(String(operation?._meta?.operationId || "")))
      .map((operation?: any) : any => operation.name)
  );
}

export function createUpstreamGatewayE2eServices({
  fixtureUrl,
  secretRef,
  serviceId,
  limitedServiceId,
  concurrentLimitedServiceId,
  aggregateLimitedServiceId,
  disabledServiceId,
  loadBalancedServiceId,
  failingFixtureUrl
}: Record<string, any> = {}) : any {
  const services: any[] = [
    {
      serviceId,
      label: "Verifier upstream",
      baseUrl: fixtureUrl,
      healthPath: "/health",
      credentialRefs: [secretRef],
      trafficPolicy: { perMinute: 1_000, burst: 128 },
      operations: [
        { operationKey: "echo", method: "POST", path: "/echo", risk: "safe_write", requiredScopes: ["gateway:write"] },
        {
          operationKey: "approval",
          method: "POST",
          path: "/approval",
          risk: "repair_write",
          requiredScopes: ["gateway:maintain"],
          requiresApproval: true,
          requiredApproval: { approvalLayers: ["user"] }
        },
        { operationKey: "slow", method: "POST", path: "/slow", risk: "safe_write", requiredScopes: ["gateway:write"], timeoutMs: 50 },
        { operationKey: "non-json", method: "GET", path: "/non-json", risk: "read_only", requiredScopes: ["gateway:read"] },
        { operationKey: "large", method: "GET", path: "/large", risk: "read_only", requiredScopes: ["gateway:read"] },
        {
          operationKey: "json-rpc-echo",
          protocol: "json-rpc",
          method: "POST",
          path: "/jsonrpc",
          rpcMethod: "fixture.echo",
          risk: "safe_write",
          requiredScopes: ["gateway:write"],
          sensitiveBodyFields: ["params.password", "result.echoed.password"],
          publicResponseFields: ["jsonrpc", "id", "result.echoed.message"],
          responseSchema: {
            type: "object",
            required: ["jsonrpc", "result"],
            properties: {
              jsonrpc: { const: "2.0" },
              id: {},
              result: {
                type: "object",
                required: ["echoed"],
                properties: {
                  ok: { type: "boolean" },
                  echoed: {
                    type: "object",
                    required: ["message"],
                    properties: {
                      message: { type: "string" },
                      password: { type: "string" }
                    },
                    additionalProperties: true
                  }
                },
                additionalProperties: true
              }
            },
            additionalProperties: false
          }
        },
        {
          operationKey: "schema-mismatch",
          method: "GET",
          path: "/schema-mismatch",
          risk: "read_only",
          requiredScopes: ["gateway:read"],
          publicResponseFields: ["ok"],
          responseSchema: {
            type: "object",
            required: ["ok"],
            properties: {
              ok: { const: true }
            },
            additionalProperties: true
          }
        },
        { operationKey: "concurrent", method: "GET", path: "/concurrent", risk: "read_only", requiredScopes: ["gateway:read"] }
      ]
    },
    {
      serviceId: limitedServiceId,
      label: "Verifier limited upstream",
      baseUrl: fixtureUrl,
      healthPath: "/health",
      trafficPolicy: { perMinute: 1, burst: 1 },
      operations: [
        { operationKey: "limited", method: "GET", path: "/concurrent", risk: "read_only", requiredScopes: ["gateway:read"] }
      ]
    },
    {
      serviceId: concurrentLimitedServiceId,
      label: "Verifier concurrent limited upstream",
      baseUrl: fixtureUrl,
      healthPath: "/health",
      trafficPolicy: { perMinute: 120, burst: 120, maxConcurrent: 1 },
      operations: [
        { operationKey: "limited-concurrent", method: "GET", path: "/concurrent", risk: "read_only", requiredScopes: ["gateway:read"] }
      ]
    },
    {
      serviceId: aggregateLimitedServiceId,
      label: "Verifier aggregate limited endpoint pool upstream",
      baseUrl: fixtureUrl,
      endpoints: [
        {
          endpointId: "healthy-a",
          baseUrl: fixtureUrl,
          weight: 1
        },
        {
          endpointId: "healthy-b",
          baseUrl: fixtureUrl,
          weight: 1
        }
      ],
      healthPath: "/health",
      trafficPolicy: { perMinute: 1, burst: 1, maxConcurrent: 10 },
      operations: [
        { operationKey: "aggregate-limited", method: "GET", path: "/concurrent", risk: "read_only", requiredScopes: ["gateway:read"] }
      ]
    },
    {
      serviceId: loadBalancedServiceId,
      label: "Verifier endpoint pool upstream",
      baseUrl: fixtureUrl,
      circuitBreaker: { failureThreshold: 1, cooldownMs: 30000 },
      endpoints: [
        {
          endpointId: "failing",
          baseUrl: failingFixtureUrl,
          weight: 1
        },
        {
          endpointId: "healthy",
          baseUrl: fixtureUrl,
          weight: 1
        }
      ],
      healthPath: "/health",
      trafficPolicy: { perMinute: 100, burst: 50, maxConcurrent: 10 },
      operations: [
        { operationKey: "pooled-echo", method: "POST", path: "/echo", risk: "safe_write", requiredScopes: ["gateway:write"] }
      ]
    },
    {
      serviceId: disabledServiceId,
      label: "Verifier disabled upstream",
      baseUrl: fixtureUrl,
      healthPath: "/health",
      disabled: true,
      operations: [
        { operationKey: "echo", method: "POST", path: "/echo", risk: "safe_write", requiredScopes: ["gateway:write"] }
      ]
    }
  ];
  return services.map((service?: any) : any => ({
    ...service,
    operations: service.operations.map((operation?: any) : any => ({
      ...operation,
      payloadTransport: {
        request: {
          mode: "structured_json",
          maxBytes: 1024 * 1024,
          mediaTypes: ["application/json"]
        },
        response: {
          mode: "structured_json",
          maxBytes: operation.operationKey === "large" ? 256 : 1024 * 1024,
          mediaTypes: ["application/json"]
        }
      }
    }))
  }));
}
