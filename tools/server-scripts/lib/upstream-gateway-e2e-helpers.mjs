import assert from "node:assert/strict";
import http from "node:http";

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

export function createUpstreamGatewayFixture({
  resolvedSecretToken,
  failPaths = []
} = {}) {
  const failingPathSet = new Set(failPaths);
  const holds = new Map();
  const state = {
    echoCount: 0,
    approvalCount: 0,
    jsonRpcCount: 0,
    concurrentCount: 0,
    failureCount: 0
  };

  function holdRecord(holdId) {
    const key = String(holdId || "");
    if (!key) return null;
    let record = holds.get(key);
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

  function markHoldStarted(holdId) {
    const record = holdRecord(holdId);
    if (!record || record.started) return;
    record.started = true;
    const waiters = record.startedWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  function releaseHold(holdId) {
    const record = holdRecord(holdId);
    if (!record || record.released) return;
    record.released = true;
    const waiters = record.releaseWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  function waitForHold(holdId, timeoutMs = 2000) {
    const record = holdRecord(holdId);
    if (!record) {
      return Promise.reject(new Error("holdId is required"));
    }
    if (record.started) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for upstream fixture hold: ${holdId}`));
      }, Math.max(1, Number(timeoutMs || 2000)));
      record.startedWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function waitForHoldRelease(holdId, timeoutMs = 5000) {
    const record = holdRecord(holdId);
    if (!record || record.released) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(1, Number(timeoutMs || 5000)));
      record.releaseWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    state,
    releaseHold,
    waitForHold,
    start() {
      return new Promise((resolve) => {
        const upstream = http.createServer(async (request, response) => {
          const url = new URL(request.url || "/", "http://127.0.0.1");
          const chunks = [];
          request.on("data", (chunk) => chunks.push(chunk));
          await new Promise((done) => request.on("end", done));
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
            const body = Buffer.concat(chunks).toString("utf8");
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
            const body = Buffer.concat(chunks).toString("utf8");
            const payload = body ? JSON.parse(body) : {};
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
            await new Promise((done) => setTimeout(done, 200));
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
            const holdId = url.searchParams.get("holdId") || "";
            if (holdId) {
              markHoldStarted(holdId);
              await waitForHoldRelease(holdId);
            }
            const waitMs = Math.max(0, Math.min(Number(url.searchParams.get("waitMs") || 0), 500));
            if (waitMs > 0) {
              await new Promise((done) => setTimeout(done, waitMs));
            }
            state.concurrentCount += 1;
            sendJson(response, 200, { ok: true, index: url.searchParams.get("i") || "" });
            return;
          }
          sendJson(response, 404, { ok: false, error: "not_found" });
        });
        upstream.listen(0, "127.0.0.1", () => {
          const address = upstream.address();
          resolve({
            server: upstream,
            url: `http://127.0.0.1:${address.port}`
          });
        });
      });
    },
    close(target) {
      return new Promise((resolve) => {
        if (!target?.close) {
          resolve();
          return;
        }
        target.close(() => resolve());
      });
    }
  };
}

export function structuredPayload(mcpPayload) {
  return mcpPayload?.result?.structuredContent?.payload || mcpPayload?.result?.structuredContent || {};
}

export async function waitForFixtureHoldBeforeRequestCompletion({
  fixture,
  holdId,
  request,
  timeoutMs = 30_000
} = {}) {
  const firstSignal = await Promise.race([
    fixture.waitForHold(holdId, timeoutMs).then(
      () => ({ type: "hold-started" }),
      (error) => ({ type: "hold-timeout", error })
    ),
    request.then((response) => ({ type: "first-completed", response }))
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
} = {}) {
  const preview = await api("POST", "/api/gateway/v1/policy/preview", {
    serviceId: concurrentLimitedServiceId,
    operationKey: "limited-concurrent"
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.payload.traffic.algorithm, "token_bucket_with_concurrency");
  assert.equal(preview.payload.traffic.maxConcurrent, 1);
  const holdId = "traffic-concurrency-slot";
  const firstRequest = api("POST", "/api/gateway/v1/forward", {
    serviceId: concurrentLimitedServiceId,
    operationKey: "limited-concurrent",
    query: { i: "first", holdId }
  }).catch((error) => ({ status: 0, payload: { error: error?.code || "request_failed" } }));
  try {
    await waitForFixtureHoldBeforeRequestCompletion({
      fixture: gatewayFixture,
      holdId,
      request: firstRequest
    });
    const rejected = await api("POST", "/api/gateway/v1/forward", {
      serviceId: concurrentLimitedServiceId,
      operationKey: "limited-concurrent",
      query: { i: "second" }
    }).catch((error) => ({ status: 0, payload: { error: error?.code || "request_failed" } }));
    gatewayFixture.releaseHold(holdId);
    const first = await firstRequest;
    const statuses = [first.status, rejected.status].sort((left, right) => left - right);
    assert.deepEqual(statuses, [200, 429], JSON.stringify({ first: first.payload, rejected: rejected.payload }, null, 2));
    const rejectedResponse = [first, rejected].find((item) => item.status === 429);
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

export function gatewayOperationNames(capabilities = {}) {
  return new Set(
    (capabilities.operations || [])
      .filter((operation) => /^gateway\.|^external_services\./.test(String(operation?._meta?.operationId || "")))
      .map((operation) => operation.name)
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
} = {}) {
  const services = [
    {
      serviceId,
      label: "Verifier upstream",
      baseUrl: fixtureUrl,
      healthPath: "/health",
      credentialRefs: [secretRef],
      trafficPolicy: { perMinute: 100, burst: 50 },
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
  return services.map((service) => ({
    ...service,
    operations: service.operations.map((operation) => ({
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
