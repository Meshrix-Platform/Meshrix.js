import crypto from "node:crypto";
import http from "node:http";

export const UPSTREAM_FIXTURE_SERVICE_NAME = "licomesh-upstream-fixture";
export const UPSTREAM_FIXTURE_SERVICE_VERSION = "0.0.1";
export const UPSTREAM_FIXTURE_TOKEN_ENV = "LICO_UPSTREAM_FIXTURE_TOKEN";
export const UPSTREAM_FIXTURE_CLI_PATH = "tools/server-scripts/upstream-fixture-service.mjs";
export const UPSTREAM_FIXTURE_MCP_PROTOCOL_VERSION = "2025-06-18";

export const UPSTREAM_FIXTURE_RECORDS = Object.freeze([
  Object.freeze({ recordId: "record-001", name: "alpha", category: "sample", revision: 3 }),
  Object.freeze({ recordId: "record-002", name: "beta", category: "sample", revision: 1 }),
  Object.freeze({ recordId: "record-003", name: "gamma", category: "reference", revision: 2 })
]);

export const UPSTREAM_FIXTURE_IDENTITY = Object.freeze({
  principal: "fixture-operator",
  accountId: "fixture-account-001"
});

export function fixtureTokenProof(token = "") {
  const raw = String(token || "").trim();
  return raw ? `sha256:${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16)}` : "";
}

function jsonSchema(properties = {}, required = []) {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false
  };
}

export function upstreamFixtureMcpTools({ includeCancellationTools = false } = {}) {
  const tools = [
    {
      name: "records.search",
      title: "Search fixture records",
      description: "Return deterministic fixture records whose name or category contains the query.",
      inputSchema: jsonSchema({
        query: { type: "string" },
        perPage: { type: "number" }
      }, ["query"]),
      annotations: { readOnlyHint: true }
    },
    {
      name: "records.get",
      title: "Get one fixture record",
      description: "Return one deterministic fixture record by record id.",
      inputSchema: jsonSchema({
        recordId: { type: "string" }
      }, ["recordId"]),
      annotations: { readOnlyHint: true }
    },
    {
      name: "session.identity",
      title: "Report fixture session identity",
      description: "Return the fixture principal and a hash proof of the credential the fixture process received.",
      inputSchema: jsonSchema({}),
      annotations: { readOnlyHint: true }
    },
    {
      name: "state.probe",
      title: "Probe fixture state",
      description: "Return the current fixture counter and call counts.",
      inputSchema: jsonSchema({}),
      annotations: { readOnlyHint: true }
    },
    {
      name: "state.increment",
      title: "Increment fixture counter",
      description: "Increment the in-memory fixture counter and return the new value.",
      inputSchema: jsonSchema({
        amount: { type: "number" }
      })
    },
    {
      name: "state.increment.delayed",
      title: "Increment fixture counter after a delay",
      description: "Wait for a bounded delay, then increment the in-memory fixture counter unless the MCP request is cancelled.",
      inputSchema: jsonSchema({
        amount: { type: "number" },
        delayMs: { type: "number" }
      })
    },
    {
      name: "state.peer.wait",
      title: "Wait as an independent peer request",
      description: "Keep an independent MCP request active for a bounded delay without changing the fixture counter.",
      inputSchema: jsonSchema({
        delayMs: { type: "number" }
      }),
      annotations: { readOnlyHint: true }
    },
    {
      name: "records.write",
      title: "Write fixture record note",
      description: "Attach a note to a fixture record in memory and return the stored note.",
      inputSchema: jsonSchema({
        recordId: { type: "string" },
        note: { type: "string" }
      }, ["recordId", "note"])
    },
    {
      name: "records.purge",
      title: "Purge fixture records",
      description: "Remove all in-memory fixture records until state.reset restores them.",
      inputSchema: jsonSchema({}),
      annotations: { destructiveHint: true }
    }
  ];
  return includeCancellationTools
    ? tools
    : tools.filter((tool) => !["state.increment.delayed", "state.peer.wait"].includes(tool.name));
}

export function createUpstreamFixtureState({ token = "", supportsDelayedCancellation = false } = {}) {
  const state = {
    token: String(token || "").trim(),
    records: UPSTREAM_FIXTURE_RECORDS.map((record) => ({ ...record })),
    notes: new Map(),
    counter: 0,
    callCount: 0,
    purged: false,
    supportsDelayedCancellation: supportsDelayedCancellation === true,
    delayedOperations: {
      incrementStarted: 0,
      incrementCompleted: 0,
      incrementCancelled: 0,
      peerStarted: 0,
      peerCompleted: 0,
      peerCancelled: 0,
      activeIncrement: 0,
      activePeer: 0,
      cancellationNotifications: 0,
      matchedCancellations: 0
    },
    startedAt: new Date().toISOString()
  };

  function requireRecord(recordId = "") {
    const record = state.records.find((item) => item.recordId === String(recordId || ""));
    if (!record) {
      const error = new Error(`Fixture record not found: ${String(recordId || "")}`);
      error.code = "fixture_record_not_found";
      throw error;
    }
    return record;
  }

  // Named authProof (not "credential") so the gateway's default sensitive-field
  // redaction leaves this deliberately public hash proof intact.
  function authProof(presentedToken = "") {
    const presented = String(presentedToken || "").trim();
    return {
      presented: Boolean(presented),
      accepted: Boolean(presented) && (!state.token || presented === state.token),
      tokenProof: fixtureTokenProof(presented)
    };
  }

  return {
    state,
    authProof,
    reset() {
      state.records = UPSTREAM_FIXTURE_RECORDS.map((record) => ({ ...record }));
      state.notes.clear();
      state.counter = 0;
      state.purged = false;
      return { ok: true, recordCount: state.records.length };
    },
    searchRecords({ query = "", perPage = 10 } = {}) {
      state.callCount += 1;
      const needle = String(query || "").toLowerCase();
      const limit = Math.max(1, Math.min(50, Number(perPage) || 10));
      const items = state.records
        .filter((record) => !needle ||
          record.name.toLowerCase().includes(needle) ||
          record.category.toLowerCase().includes(needle) ||
          record.recordId.toLowerCase().includes(needle))
        .slice(0, limit);
      return { ok: true, query: String(query || ""), count: items.length, items };
    },
    getRecord({ recordId = "" } = {}) {
      state.callCount += 1;
      const record = requireRecord(recordId);
      return { ok: true, record, note: state.notes.get(record.recordId) || "" };
    },
    sessionIdentity({ presentedToken = "" } = {}) {
      state.callCount += 1;
      return {
        ok: true,
        service: UPSTREAM_FIXTURE_SERVICE_NAME,
        principal: UPSTREAM_FIXTURE_IDENTITY.principal,
        accountId: UPSTREAM_FIXTURE_IDENTITY.accountId,
        authProof: authProof(presentedToken)
      };
    },
    probeState() {
      state.callCount += 1;
      return {
        ok: true,
        counter: state.counter,
        callCount: state.callCount,
        recordCount: state.records.length,
        purged: state.purged,
        delayedOperations: { ...state.delayedOperations },
        startedAt: state.startedAt
      };
    },
    incrementCounter({ amount = 1 } = {}) {
      state.callCount += 1;
      const step = Number.isFinite(Number(amount)) ? Math.trunc(Number(amount)) : 1;
      state.counter += step === 0 ? 1 : step;
      return { ok: true, counter: state.counter };
    },
    beginDelayedIncrement({ amount = 1, delayMs = 500 } = {}) {
      state.callCount += 1;
      state.delayedOperations.incrementStarted += 1;
      state.delayedOperations.activeIncrement += 1;
      const step = Number.isFinite(Number(amount)) ? Math.trunc(Number(amount)) : 1;
      const boundedDelayMs = Math.max(25, Math.min(Number(delayMs) || 500, 10_000));
      let active = true;
      return {
        delayMs: boundedDelayMs,
        complete() {
          if (!active) return null;
          active = false;
          state.delayedOperations.activeIncrement -= 1;
          state.delayedOperations.incrementCompleted += 1;
          state.counter += step === 0 ? 1 : step;
          return { ok: true, counter: state.counter, delayMs: boundedDelayMs };
        },
        cancel() {
          if (!active) return false;
          active = false;
          state.delayedOperations.activeIncrement -= 1;
          state.delayedOperations.incrementCancelled += 1;
          return true;
        }
      };
    },
    beginPeerWait({ delayMs = 1_000 } = {}) {
      state.callCount += 1;
      state.delayedOperations.peerStarted += 1;
      state.delayedOperations.activePeer += 1;
      const boundedDelayMs = Math.max(25, Math.min(Number(delayMs) || 1_000, 10_000));
      let active = true;
      return {
        delayMs: boundedDelayMs,
        complete() {
          if (!active) return null;
          active = false;
          state.delayedOperations.activePeer -= 1;
          state.delayedOperations.peerCompleted += 1;
          return { ok: true, peerCompleted: true, delayMs: boundedDelayMs };
        },
        cancel() {
          if (!active) return false;
          active = false;
          state.delayedOperations.activePeer -= 1;
          state.delayedOperations.peerCancelled += 1;
          return true;
        }
      };
    },
    noteCancellationNotification(matched = false) {
      state.delayedOperations.cancellationNotifications += 1;
      if (matched) state.delayedOperations.matchedCancellations += 1;
    },
    writeRecordNote({ recordId = "", note = "" } = {}) {
      state.callCount += 1;
      const record = requireRecord(recordId);
      state.notes.set(record.recordId, String(note || ""));
      return { ok: true, recordId: record.recordId, note: state.notes.get(record.recordId) };
    },
    purgeRecords() {
      state.callCount += 1;
      const purgedCount = state.records.length;
      state.records = [];
      state.notes.clear();
      state.purged = true;
      return { ok: true, purgedCount, restoreWith: "state.reset" };
    }
  };
}

export function callUpstreamFixtureTool(fixture, name = "", args = {}) {
  const toolArguments = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  switch (String(name || "")) {
    case "records.search":
      return fixture.searchRecords(toolArguments);
    case "records.get":
      return fixture.getRecord(toolArguments);
    case "session.identity":
      return fixture.sessionIdentity({ presentedToken: fixture.state.token ? fixture.state.token : "" });
    case "state.probe":
      return fixture.probeState();
    case "state.increment":
      return fixture.incrementCounter(toolArguments);
    case "records.write":
      return fixture.writeRecordNote(toolArguments);
    case "records.purge":
      return fixture.purgeRecords();
    default: {
      const error = new Error(`Fixture tool not found: ${String(name || "")}`);
      error.code = "fixture_tool_not_found";
      throw error;
    }
  }
}

function mcpToolCallResult(structured) {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: false
  };
}

export function handleUpstreamFixtureMcpMessage(fixture, message = {}) {
  if (!message || typeof message !== "object" || !message.method) return null;
  const { id, method, params = {} } = message;
  const isNotification = id === undefined || id === null;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: UPSTREAM_FIXTURE_MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: UPSTREAM_FIXTURE_SERVICE_NAME,
          version: UPSTREAM_FIXTURE_SERVICE_VERSION
        }
      }
    };
  }
  if (method.startsWith("notifications/")) {
    return null;
  }
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: upstreamFixtureMcpTools({
          includeCancellationTools: fixture.state.supportsDelayedCancellation
        })
      }
    };
  }
  if (method === "tools/call") {
    try {
      const structured = callUpstreamFixtureTool(fixture, params.name, params.arguments || {});
      return { jsonrpc: "2.0", id, result: mcpToolCallResult(structured) };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: error?.message || "Fixture tool call failed." }
      };
    }
  }
  if (isNotification) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

function fixtureRequestKey(requestId) {
  return `${typeof requestId}:${String(requestId)}`;
}

function scheduledFixtureOperation(fixture, name = "", args = {}) {
  if (name === "state.increment.delayed") {
    return fixture.beginDelayedIncrement(args);
  }
  if (name === "state.peer.wait") {
    return fixture.beginPeerWait(args);
  }
  return null;
}

function scheduleUpstreamFixtureMcpCall({ fixture, message, output, pending }) {
  if (message?.method !== "tools/call") return false;
  const operation = scheduledFixtureOperation(
    fixture,
    message.params?.name,
    message.params?.arguments || {}
  );
  if (!operation) return false;
  const key = fixtureRequestKey(message.id);
  const entry = { operation, timer: null };
  entry.timer = setTimeout(() => {
    if (pending.get(key) !== entry) return;
    pending.delete(key);
    const structured = operation.complete();
    if (!structured) return;
    output.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: mcpToolCallResult(structured)
    })}\n`);
  }, operation.delayMs);
  pending.set(key, entry);
  return true;
}

export function runUpstreamFixtureMcpStdio({
  token = "",
  input = process.stdin,
  output = process.stdout
} = {}) {
  const fixture = createUpstreamFixtureState({ token, supportsDelayedCancellation: true });
  const pending = new Map();
  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message = null;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message?.method === "notifications/cancelled") {
        const key = fixtureRequestKey(message.params?.requestId);
        const entry = pending.get(key);
        fixture.noteCancellationNotification(Boolean(entry));
        if (entry) {
          pending.delete(key);
          clearTimeout(entry.timer);
          entry.operation.cancel();
        }
        continue;
      }
      if (scheduleUpstreamFixtureMcpCall({ fixture, message, output, pending })) {
        continue;
      }
      const response = handleUpstreamFixtureMcpMessage(fixture, message);
      if (response) {
        output.write(`${JSON.stringify(response)}\n`);
      }
    }
  });
  input.on("close", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.operation.cancel();
    }
    pending.clear();
  });
  return fixture;
}

export function upstreamFixtureOpenApiDocument() {
  const record = jsonSchema({
    recordId: { type: "string" },
    name: { type: "string" },
    category: { type: "string" },
    revision: { type: "number" }
  }, ["recordId", "name", "category", "revision"]);
  return {
    openapi: "3.1.0",
    info: {
      title: "LicoMesh upstream fixture service",
      version: UPSTREAM_FIXTURE_SERVICE_VERSION,
      description: "Deterministic upstream service fixture used by LicoMesh gateway verifiers."
    },
    paths: {
      "/health": { get: { operationId: "health", responses: { 200: { description: "Service health" } } } },
      "/api/records": {
        get: {
          operationId: "records-list",
          parameters: [{ name: "query", in: "query", schema: { type: "string" } }],
          responses: { 200: { description: "Deterministic record list", content: { "application/json": { schema: jsonSchema({ ok: { type: "boolean" }, count: { type: "number" }, items: { type: "array", items: record } }, ["ok", "count", "items"]) } } } }
        }
      },
      "/api/records/detail": {
        get: {
          operationId: "record-detail",
          parameters: [{ name: "recordId", in: "query", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "One record" }, 404: { description: "Unknown record id" } }
        }
      },
      "/api/echo": { post: { operationId: "echo", responses: { 200: { description: "Echo of the request body" } } } },
      "/api/session/identity": { get: { operationId: "session-identity", responses: { 200: { description: "Principal and credential proof" }, 401: { description: "Missing or wrong bearer token" } } } },
      "/api/state": { get: { operationId: "state-probe", responses: { 200: { description: "Fixture state" } } } },
      "/api/state/increment": { post: { operationId: "state-increment", responses: { 200: { description: "New counter value" } } } },
      "/api/state/reset": { post: { operationId: "state-reset", responses: { 200: { description: "Restore the deterministic dataset" } } } },
      "/api/records/purge": { post: { operationId: "records-purge", responses: { 200: { description: "Purge all records" } } } },
      "/api/fault": { post: { operationId: "fault", responses: { 503: { description: "Deterministic upstream failure" } } } },
      "/mcp": { post: { operationId: "mcp-json-rpc", responses: { 200: { description: "MCP JSON-RPC response" } } } }
    }
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function bearerToken(request) {
  const header = String(request.headers.authorization || "");
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : "";
}

export function createUpstreamFixtureHttpService({ token = "" } = {}) {
  const fixture = createUpstreamFixtureState({ token });
  const openPaths = new Set(["/health", "/openapi.json"]);

  async function handleRequest(request, response) {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    await new Promise((done) => request.on("end", done));
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body = {};
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        sendJson(response, 400, { ok: false, error: "invalid_json_body" });
        return;
      }
    }
    const presentedToken = bearerToken(request);
    if (fixture.state.token && !openPaths.has(url.pathname) && presentedToken !== fixture.state.token) {
      sendJson(response, 401, { ok: false, error: "missing_or_invalid_bearer_token" });
      return;
    }
    const route = `${request.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /health":
          sendJson(response, 200, { ok: true, service: UPSTREAM_FIXTURE_SERVICE_NAME, startedAt: fixture.state.startedAt });
          return;
        case "GET /openapi.json":
          sendJson(response, 200, upstreamFixtureOpenApiDocument());
          return;
        case "GET /api/records":
          sendJson(response, 200, fixture.searchRecords({
            query: url.searchParams.get("query") || "",
            perPage: url.searchParams.get("perPage") || 10
          }));
          return;
        case "GET /api/records/detail":
          sendJson(response, 200, fixture.getRecord({ recordId: url.searchParams.get("recordId") || "" }));
          return;
        case "POST /api/echo":
          fixture.state.callCount += 1;
          sendJson(response, 200, {
            ok: true,
            method: request.method,
            echoed: body,
            authProof: fixture.authProof(presentedToken)
          });
          return;
        case "GET /api/session/identity":
          sendJson(response, 200, fixture.sessionIdentity({ presentedToken }));
          return;
        case "GET /api/state":
          sendJson(response, 200, fixture.probeState());
          return;
        case "POST /api/state/increment":
          sendJson(response, 200, fixture.incrementCounter(body));
          return;
        case "POST /api/state/reset":
          sendJson(response, 200, fixture.reset());
          return;
        case "POST /api/records/purge":
          sendJson(response, 200, fixture.purgeRecords());
          return;
        case "POST /api/fault":
          fixture.state.callCount += 1;
          sendJson(response, 503, { ok: false, retryable: true, error: "deterministic_fixture_fault" });
          return;
        case "POST /mcp": {
          const reply = handleUpstreamFixtureMcpMessage(fixture, body);
          if (!reply) {
            sendJson(response, 202, {});
            return;
          }
          sendJson(response, 200, reply);
          return;
        }
        default:
          sendJson(response, 404, { ok: false, error: "not_found" });
      }
    } catch (error) {
      const status = error?.code === "fixture_record_not_found" ? 404 : 500;
      sendJson(response, status, { ok: false, error: error?.code || "fixture_internal_error" });
    }
  }

  return {
    fixture,
    start({ host = "127.0.0.1", port = 0 } = {}) {
      return new Promise((resolve, reject) => {
        const server = http.createServer((request, response) => {
          handleRequest(request, response).catch(() => {
            try {
              sendJson(response, 500, { ok: false, error: "fixture_internal_error" });
            } catch {
              // The response stream is already closed.
            }
          });
        });
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolve({
            server,
            url: `http://${host}:${address.port}`,
            close: () => new Promise((done) => server.close(() => done()))
          });
        });
      });
    }
  };
}
