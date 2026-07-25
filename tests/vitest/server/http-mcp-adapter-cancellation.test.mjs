import { describe, expect, it, vi } from "vitest";

import { createCapturedResponse } from "../../../packages/server-runtime/src/composition/dispatch-operation-captured-response.mjs";
import { handleLicoMcpHttpRequest } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter.mjs";
import { createMcpInFlightRequestRegistry } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-in-flight.mjs";
import { MCP_PROXY_SESSION_HEADER_LOWER } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/mcp-proxy-session.mjs";
import { createProxyRequestDispatcher } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/proxy-command.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function responsePayload(response) {
  const body = Buffer.concat(response.chunks).toString("utf8");
  return body ? JSON.parse(body) : null;
}

function requestBody(id, label) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "meshrix.discovery",
      arguments: {
        operation: "fixture.wait",
        input: { label }
      }
    }
  };
}

function cancellationBody(requestId) {
  return {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId, reason: "private client reason must not be forwarded" }
  };
}

function createFixtureProvider() {
  const peerGate = deferred();
  const starts = new Map();
  const executions = [];
  const sideEffects = [];
  const aborted = new Set();
  const abortReasons = new Map();
  const startSignal = (label) => {
    if (!starts.has(label)) {
      starts.set(label, deferred());
    }
    return starts.get(label);
  };
  const visibleTool = {
    id: "fixture.wait",
    operationId: "fixture.wait",
    label: "Wait fixture",
    inputSchema: { type: "object" },
    readOnly: false
  };
  const provider = {
    authorizeRequest: vi.fn(async ({ request }) => {
      const token = String(request?.headers?.authorization || "").replace(/^Bearer\s+/iu, "");
      if (!new Set(["fixture-a", "fixture-b"]).has(token)) {
        return { ok: false, status: 401, error: "Unauthorized fixture request." };
      }
      const clientId = String(request?.headers?.["x-fixture-client"] || `${token}-client`);
      request.__licoProcessIdentity = {
        ok: true,
        client: {
          clientId,
          packageId: `${clientId}-package`,
          processKeyId: `${clientId}-key`
        }
      };
      return {
        ok: true,
        grant: { id: token === "fixture-a" ? "grant-a" : "grant-b", subject: {} }
      };
    }),
    listVisibleTools: vi.fn(() => [visibleTool]),
    resolveMcpWorkspaceInput: vi.fn(async ({ input }) => ({ input })),
    publicMcpToolPayload: vi.fn(async ({ payload }) => payload),
    executeTool: vi.fn(async ({ input, signal }) => {
      const label = String(input?.label || "");
      executions.push(label);
      startSignal(label).resolve();
      if (label === "peer") {
        await peerGate.promise;
      } else {
        await new Promise((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", resolve, { once: true });
        });
      }
      if (signal.aborted) {
        aborted.add(label);
        abortReasons.set(label, String(signal.reason?.message || ""));
        return {
          ok: false,
          status: 499,
          payload: { error: { code: "tool_aborted", message: "Fixture execution was cancelled." } }
        };
      }
      sideEffects.push(label);
      return { ok: true, status: 200, payload: { label, completed: true } };
    })
  };
  return {
    provider,
    starts,
    executions,
    sideEffects,
    aborted,
    abortReasons,
    waitForStart: (label) => startSignal(label).promise,
    releasePeer: peerGate.resolve
  };
}

function startMcpRequest({
  provider,
  registry,
  body,
  credentialAlias = "fixture-a",
  client = "client-a",
  session = "session-a",
  proxySession = "",
  signal = null
}) {
  const response = createCapturedResponse();
  const requestBodyBuffer = Buffer.from(JSON.stringify(body), "utf8");
  const completion = handleLicoMcpHttpRequest({
    request: {
      headers: {
        authorization: `Bearer ${credentialAlias}`,
        "mcp-session-id": session,
        "x-fixture-client": client,
        ...(proxySession ? { [MCP_PROXY_SESSION_HEADER_LOWER]: proxySession } : {})
      },
      socket: {}
    },
    response,
    requestBody: requestBodyBuffer,
    method: "POST",
    url: new URL("http://127.0.0.1/mcp"),
    toolSkillManagementProvider: provider,
    inFlightRequestRegistry: registry,
    signal
  });
  return { completion, response };
}

async function sendMcpRequest(input) {
  const pending = startMcpRequest(input);
  await pending.completion;
  return pending.response;
}

describe("HTTP MCP request cancellation correlation", () => {
  it("isolates the same request id across two real proxy dispatchers", async () => {
    const fixture = createFixtureProvider();
    const registry = createMcpInFlightRequestRegistry();
    const writes = { first: [], second: [] };
    const proxySessions = { first: new Set(), second: new Set() };

    function forwardThroughAdapter(proxyName) {
      return async ({ message, proxySessionId }) => {
        proxySessions[proxyName].add(proxySessionId);
        const pending = startMcpRequest({
          provider: fixture.provider,
          registry,
          body: message,
          proxySession: proxySessionId
        });
        await pending.completion;
        return responsePayload(pending.response);
      };
    }

    const firstProxy = createProxyRequestDispatcher({
      forwardMessage: forwardThroughAdapter("first"),
      writeMessage(payload) {
        writes.first.push(payload);
      }
    });
    const secondProxy = createProxyRequestDispatcher({
      forwardMessage: forwardThroughAdapter("second"),
      writeMessage(payload) {
        writes.second.push(payload);
      }
    });

    firstProxy.dispatch(requestBody("shared-id", "first-proxy"));
    secondProxy.dispatch(requestBody("shared-id", "second-proxy"));
    await Promise.all([
      fixture.waitForStart("first-proxy"),
      fixture.waitForStart("second-proxy")
    ]);
    expect(registry.snapshot()).toMatchObject({ inFlight: 2, activeScopes: 2 });

    firstProxy.dispatch(cancellationBody("shared-id"));
    await firstProxy.waitForIdle();
    expect(fixture.aborted).toContain("first-proxy");
    expect(fixture.aborted).not.toContain("second-proxy");
    expect(registry.snapshot()).toMatchObject({ inFlight: 1, activeScopes: 1 });
    expect(writes.first).toEqual([]);

    secondProxy.dispatch(cancellationBody("shared-id"));
    await secondProxy.waitForIdle();
    expect(fixture.aborted).toContain("second-proxy");
    expect(registry.snapshot()).toMatchObject({ inFlight: 0, activeScopes: 0 });
    expect(writes.second).toEqual([]);
    expect(proxySessions.first.size).toBe(1);
    expect(proxySessions.second.size).toBe(1);
    expect([...proxySessions.first][0]).not.toBe([...proxySessions.second][0]);
  });

  it("cancels only the authenticated matching request and leaves its peer active", async () => {
    const fixture = createFixtureProvider();
    const registry = createMcpInFlightRequestRegistry();
    const slow = startMcpRequest({
      provider: fixture.provider,
      registry,
      body: requestBody(17, "slow")
    });
    const peer = startMcpRequest({
      provider: fixture.provider,
      registry,
      body: requestBody(18, "peer")
    });
    await Promise.all([fixture.waitForStart("slow"), fixture.waitForStart("peer")]);
    expect(registry.snapshot()).toMatchObject({ inFlight: 2, activeScopes: 1 });

    const unauthorized = await sendMcpRequest({
      provider: fixture.provider,
      registry,
      body: cancellationBody(17),
      credentialAlias: "fixture-invalid"
    });
    const wrongClient = await sendMcpRequest({
      provider: fixture.provider,
      registry,
      body: cancellationBody(17),
      client: "client-b"
    });
    const wrongSession = await sendMcpRequest({
      provider: fixture.provider,
      registry,
      body: cancellationBody(17),
      session: "session-b"
    });
    const wrongGrant = await sendMcpRequest({
      provider: fixture.provider,
      registry,
      body: cancellationBody(17),
      credentialAlias: "fixture-b",
      client: "client-b"
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(responsePayload(unauthorized)).toBeNull();
    expect([wrongClient.statusCode, wrongSession.statusCode, wrongGrant.statusCode]).toEqual([202, 202, 202]);
    expect(fixture.aborted.has("slow")).toBe(false);
    expect(registry.snapshot().inFlight).toBe(2);

    const cancellation = await sendMcpRequest({
      provider: fixture.provider,
      registry,
      body: cancellationBody(17)
    });
    expect(cancellation.statusCode).toBe(202);
    expect(responsePayload(cancellation)).toBeNull();

    await slow.completion;
    expect(slow.response.statusCode).toBe(202);
    expect(responsePayload(slow.response)).toBeNull();
    expect(fixture.aborted).toContain("slow");
    expect(fixture.abortReasons.get("slow")).toBe("MCP request cancelled.");
    expect(fixture.abortReasons.get("slow")).not.toContain("private client reason");
    expect(fixture.sideEffects).not.toContain("slow");
    expect(fixture.aborted).not.toContain("peer");
    expect(registry.snapshot().inFlight).toBe(1);

    fixture.releasePeer();
    await peer.completion;
    expect(peer.response.statusCode).toBe(200);
    expect(responsePayload(peer.response)).toMatchObject({
      id: 18,
      result: { structuredContent: { payload: { label: "peer", completed: true } } }
    });
    expect(fixture.sideEffects).toEqual(["peer"]);
    expect(registry.snapshot()).toMatchObject({ inFlight: 0, activeScopes: 0 });

    const completedCancellation = await sendMcpRequest({
      provider: fixture.provider,
      registry,
      body: cancellationBody(18)
    });
    expect(completedCancellation.statusCode).toBe(202);
    expect(registry.snapshot().inFlight).toBe(0);
    expect(fixture.provider.authorizeRequest.mock.calls.every(
      ([input]) => input.recordUse === false
    )).toBe(true);
  });

  it("rejects a duplicate active id without replacing or aborting the original", async () => {
    const fixture = createFixtureProvider();
    const registry = createMcpInFlightRequestRegistry({ maxInFlight: 1, maxInFlightPerScope: 1 });
    const original = startMcpRequest({
      provider: fixture.provider,
      registry,
      body: requestBody("duplicate-id", "original")
    });
    await fixture.waitForStart("original");

    const duplicate = await sendMcpRequest({
      provider: fixture.provider,
      registry,
      body: requestBody("duplicate-id", "duplicate")
    });
    expect(duplicate.statusCode).toBe(200);
    expect(responsePayload(duplicate)).toMatchObject({
      id: "duplicate-id",
      error: {
        code: -32600,
        data: { code: "mcp_duplicate_or_invalid_request_id" }
      }
    });
    expect(fixture.executions).toEqual(["original"]);
    expect(fixture.aborted.has("original")).toBe(false);
    expect(registry.snapshot().inFlight).toBe(1);

    const overCapacity = await sendMcpRequest({
      provider: fixture.provider,
      registry,
      body: requestBody("another-id", "over-capacity")
    });
    expect(responsePayload(overCapacity)).toMatchObject({
      id: "another-id",
      error: {
        code: -32000,
        data: { code: "mcp_in_flight_capacity_exceeded" }
      }
    });
    expect(fixture.executions).toEqual(["original"]);

    await sendMcpRequest({
      provider: fixture.provider,
      registry,
      body: cancellationBody("duplicate-id")
    });
    await original.completion;
    expect(fixture.aborted).toContain("original");
    expect(registry.snapshot().inFlight).toBe(0);
  });
});
