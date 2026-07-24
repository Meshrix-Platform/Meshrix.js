import {
  abortError,
  assertNegotiatedProtocolVersion,
  assertJsonRpcResponse,
  fatalSessionError,
  initializeParams,
  jsonRpcNotification,
  jsonRpcRequest,
  missingSessionError,
  normalizeTransportConfig,
  notifySafely,
  parseJson,
  positiveInt,
  protocolError,
  requestedProtocolVersion,
  resolveStringRecord,
  text,
  timeoutError
} from "./upstream-mcp-transport-common.mjs";

const MAX_RESPONSE_CHARS = 8 * 1024 * 1024;
const CANCELLATION_TIMEOUT_MS = 1000;
const CLOSE_TIMEOUT_MS = 1000;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
export const UPSTREAM_MCP_HTTP_NOTIFICATION_LIMITS = Object.freeze({
  queueLength: 64,
  queueCharacters: 1024 * 1024
});

function normalizedHeaders(record = {}, env = process.env) {
  return Object.fromEntries(
    Object.entries(resolveStringRecord(record, env))
      .map(([key, value]) => [key.toLowerCase(), value])
  );
}

function safeCancelReason(timedOut) {
  return timedOut
    ? "Upstream MCP request exceeded its time limit."
    : "Upstream MCP request was cancelled by the gateway.";
}

async function readBoundedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
      if (result.length > MAX_RESPONSE_CHARS) {
        throw protocolError("Upstream MCP response exceeded the transport limit.");
      }
    }
    result += decoder.decode();
    return result;
  } finally {
    reader.releaseLock();
  }
}

function eventPayload(eventText) {
  const data = String(eventText)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  const payload = parseJson(data);
  if (!payload) throw protocolError("Upstream MCP event stream emitted invalid JSON.");
  return payload;
}

function serverRequestResponse(message) {
  if (message.method === "ping") {
    return { jsonrpc: "2.0", id: message.id, result: {} };
  }
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Method not supported by this MCP client." }
  };
}

async function consumePayload(
  payload,
  requestId,
  onNotification,
  onServerRequest,
  enqueueNotification
) {
  const messages = Array.isArray(payload) ? payload : [payload];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.method) {
      if (message.jsonrpc !== "2.0") {
        throw protocolError("Upstream MCP notification used an unsupported JSON-RPC version.");
      }
      if (message.id !== undefined) {
        await onServerRequest(message);
      } else {
        enqueueNotification(onNotification, message);
      }
      continue;
    }
    if (message.id === requestId) return message;
  }
  return null;
}

async function readSseResponse(
  response,
  requestId,
  onNotification,
  onServerRequest,
  enqueueNotification
) {
  if (!response.body) {
    throw protocolError("Upstream MCP event stream did not include a response body.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalCharacters = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      totalCharacters += value?.byteLength || 0;
      if (buffer.length > MAX_RESPONSE_CHARS || totalCharacters > MAX_RESPONSE_CHARS) {
        throw protocolError("Upstream MCP event stream exceeded the transport limit.");
      }
      let match;
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        const boundary = match.index;
        const eventText = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + match[0].length);
        const payload = eventPayload(eventText);
        const responsePayload = await consumePayload(
          payload,
          requestId,
          onNotification,
          onServerRequest,
          enqueueNotification
        );
        if (responsePayload) {
          await reader.cancel().catch(() => undefined);
          return responsePayload;
        }
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const responsePayload = await consumePayload(
        eventPayload(buffer),
        requestId,
        onNotification,
        onServerRequest,
        enqueueNotification
      );
      if (responsePayload) return responsePayload;
    }
    throw protocolError("Upstream MCP event stream ended before the matching response.");
  } finally {
    reader.releaseLock();
  }
}

export async function createHttpMcpSession(config = {}, options = {}) {
  const normalized = normalizeTransportConfig(config);
  const url = text(normalized.url || normalized.endpoint || normalized.baseUrl);
  if (!url) throw new Error("Upstream MCP http transport requires url.");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Upstream MCP http transport requires fetch.");
  const fetchTransport = typeof options.fetchTransport === "function"
    ? options.fetchTransport
    : async (targetUrl, init) => ({ response: await fetchImpl(targetUrl, init) });
  const customHeaders = normalizedHeaders(normalized.headers, options.env || process.env);
  let nextId = 1;
  let sessionId = "";
  let protocolVersion = requestedProtocolVersion(normalized);
  let initialized = false;
  let initializedResult = {};
  let closed = false;
  let fatal = false;
  let sessionClosePromise = null;
  const activeRequests = new Map();
  const notificationQueue = [];
  let notificationQueueCharacters = 0;
  let notificationDispatching = false;

  function clearNotificationQueue() {
    notificationQueue.length = 0;
    notificationQueueCharacters = 0;
  }

  function enqueueNotification(callback, payload) {
    if (typeof callback !== "function") return;
    const characterCount = JSON.stringify(payload).length;
    if (
      notificationQueue.length >= UPSTREAM_MCP_HTTP_NOTIFICATION_LIMITS.queueLength ||
      notificationQueueCharacters + characterCount >
        UPSTREAM_MCP_HTTP_NOTIFICATION_LIMITS.queueCharacters
    ) {
      clearNotificationQueue();
      throw protocolError("Upstream MCP http notification queue exceeded the transport limit.");
    }
    notificationQueue.push({ callback, payload, characterCount });
    notificationQueueCharacters += characterCount;
    if (notificationDispatching) return;
    notificationDispatching = true;
    void (async () => {
      while (notificationQueue.length > 0 && !fatal && !closed) {
        const next = notificationQueue.shift();
        notificationQueueCharacters -= next.characterCount;
        await notifySafely(next.callback, next.payload);
      }
      notificationDispatching = false;
      if (fatal || closed) clearNotificationQueue();
    })();
  }

  async function openTransportFetch(init) {
    const result = await fetchTransport(url, init, { config: normalized });
    const response = result?.response || result;
    if (!response || typeof response !== "object") {
      throw new Error("Upstream MCP http transport did not return a response.");
    }
    return {
      response,
      close: typeof result?.close === "function" ? result.close : async () => {}
    };
  }

  async function closeTransportFetch(handle) {
    try {
      await handle?.close?.();
    } catch {
      // Request semantics remain authoritative after best-effort transport cleanup.
    }
  }

  function headers({ includeSession = initialized } = {}) {
    const result = {
      ...customHeaders,
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    };
    delete result["mcp-session-id"];
    delete result["mcp-protocol-version"];
    if (includeSession) {
      result["mcp-protocol-version"] = protocolVersion;
      if (sessionId) result["mcp-session-id"] = sessionId;
    }
    return result;
  }

  async function postOneWay(payload, method, timeoutMs = normalized.timeoutMs) {
    if (closed) throw fatalSessionError("Upstream MCP http session is closed.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), positiveInt(timeoutMs, normalized.timeoutMs));
    timeout.unref?.();
    let transportFetch = null;
    try {
      transportFetch = await openTransportFetch({
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const response = transportFetch.response;
      if (response.status === 404 && sessionId) {
        await response.body?.cancel().catch(() => undefined);
        throw missingSessionError();
      }
      const returnedSessionId = response.headers.get("mcp-session-id") || "";
      if (returnedSessionId && !VISIBLE_ASCII_PATTERN.test(returnedSessionId)) {
        await response.body?.cancel().catch(() => undefined);
        throw protocolError("Upstream MCP returned an invalid session identifier.");
      }
      if (returnedSessionId && sessionId && returnedSessionId !== sessionId) {
        await response.body?.cancel().catch(() => undefined);
        throw protocolError("Upstream MCP changed its session identifier unexpectedly.");
      }
      if (response.status !== 202) {
        await response.body?.cancel().catch(() => undefined);
        throw fatalSessionError("Upstream MCP notification was not accepted.");
      }
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (error?.mcpSessionFatal) throw error;
      if (controller.signal.aborted) throw timeoutError(method);
      throw fatalSessionError("Upstream MCP notification could not be sent.", error);
    } finally {
      await closeTransportFetch(transportFetch);
      clearTimeout(timeout);
    }
  }

  async function postNotification(method, params = {}, timeoutMs = normalized.timeoutMs) {
    return postOneWay(jsonRpcNotification(method, params), method, timeoutMs);
  }

  async function respondToServerRequest(message) {
    await postOneWay(serverRequestResponse(message), "server-request-response", CANCELLATION_TIMEOUT_MS);
  }

  async function sendCancellation(id, timedOut) {
    if (!initialized || closed || fatal) return;
    try {
      await postNotification("notifications/cancelled", {
        requestId: id,
        reason: safeCancelReason(timedOut)
      }, CANCELLATION_TIMEOUT_MS);
    } catch {
      // Cancellation is best effort; the original abort remains authoritative.
    }
  }

  async function request(method, params = {}, requestOptions = {}) {
    if (requestOptions.signal?.aborted) throw abortError();
    if (closed) throw fatalSessionError("Upstream MCP http session is closed.");
    if (fatal) throw fatalSessionError("Upstream MCP http session is unavailable.");
    const id = nextId++;
    const controller = new AbortController();
    let settleActiveRequest;
    const activeRequestSettled = new Promise((resolve) => {
      settleActiveRequest = resolve;
    });
    activeRequests.set(id, { controller, settled: activeRequestSettled });
    let timedOut = false;
    let callerAborted = false;
    const cancelNotification = requestOptions.cancelNotification !== false;
    const abortListener = () => {
      callerAborted = true;
      controller.abort();
    };
    requestOptions.signal?.addEventListener("abort", abortListener, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, positiveInt(requestOptions.timeoutMs, normalized.timeoutMs));
    timeout.unref?.();
    let transportFetch = null;
    try {
      transportFetch = await openTransportFetch({
        method: "POST",
        headers: headers({ includeSession: initialized }),
        body: JSON.stringify(jsonRpcRequest(id, method, params)),
        signal: controller.signal
      });
      const response = transportFetch.response;
      if (response.status === 404 && initialized && sessionId) {
        await response.body?.cancel().catch(() => undefined);
        throw missingSessionError();
      }
      const returnedSessionId = response.headers.get("mcp-session-id") || "";
      if (returnedSessionId && !VISIBLE_ASCII_PATTERN.test(returnedSessionId)) {
        await response.body?.cancel().catch(() => undefined);
        throw protocolError("Upstream MCP returned an invalid session identifier.");
      }
      if (initialized && returnedSessionId && sessionId && returnedSessionId !== sessionId) {
        await response.body?.cancel().catch(() => undefined);
        throw protocolError("Upstream MCP changed its session identifier unexpectedly.");
      }
      if (returnedSessionId) sessionId = returnedSessionId;
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw fatalSessionError(`Upstream MCP http request failed with status ${response.status}.`);
      }
      const contentType = response.headers.get("content-type") || "";
      const payload = /text\/event-stream/i.test(contentType)
        ? await readSseResponse(
          response,
          id,
          requestOptions.onNotification,
          respondToServerRequest,
          enqueueNotification
        )
        : parseJson(await readBoundedText(response));
      const result = assertJsonRpcResponse(payload, id);
      if (requestOptions.signal?.aborted || timedOut || callerAborted) throw abortError();
      return result;
    } catch (error) {
      if (error?.mcpSessionNotFound) throw error;
      if (timedOut || callerAborted || controller.signal.aborted) {
        if (cancelNotification) await sendCancellation(id, timedOut);
        throw timedOut ? timeoutError(method) : abortError();
      }
      if (error?.mcpJsonRpcError) throw error;
      if (error?.mcpSessionFatal) {
        fatal = true;
        clearNotificationQueue();
        throw error;
      }
      fatal = true;
      clearNotificationQueue();
      throw fatalSessionError("Upstream MCP http request failed.", error);
    } finally {
      await closeTransportFetch(transportFetch);
      clearTimeout(timeout);
      requestOptions.signal?.removeEventListener("abort", abortListener);
      activeRequests.delete(id);
      settleActiveRequest();
    }
  }

  async function deleteLogicalSession() {
    if (!sessionId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLOSE_TIMEOUT_MS);
    timeout.unref?.();
    let transportFetch = null;
    try {
      transportFetch = await openTransportFetch({
        method: "DELETE",
        headers: headers({ includeSession: true }),
        signal: controller.signal
      });
      const response = transportFetch.response;
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // Logical session shutdown is best effort.
    } finally {
      await closeTransportFetch(transportFetch);
      clearTimeout(timeout);
    }
  }

  try {
    initializedResult = await request("initialize", initializeParams(normalized), {
      timeoutMs: normalized.timeoutMs,
      cancelNotification: false
    });
    protocolVersion = assertNegotiatedProtocolVersion(initializedResult, protocolVersion);
    initialized = true;
    await postNotification("notifications/initialized", {});
  } catch (error) {
    await deleteLogicalSession();
    closed = true;
    throw error;
  }

  return {
    transport: "http",
    initialized: initializedResult,
    get closed() {
      return closed;
    },
    get fatal() {
      return fatal;
    },
    request,
    notify: postNotification,
    close() {
      if (sessionClosePromise) return sessionClosePromise;
      sessionClosePromise = (async () => {
        closed = true;
        clearNotificationQueue();
        const active = [...activeRequests.values()];
        for (const entry of active) entry.controller.abort();
        await Promise.allSettled(active.map((entry) => entry.settled));
        await deleteLogicalSession();
      })();
      return sessionClosePromise;
    },
    diagnostics() {
      return {
        transport: "http",
        state: fatal ? "failed" : closed ? "closed" : "ready",
        hasSessionId: Boolean(sessionId),
        protocolVersion,
        notificationQueueLength: notificationQueue.length,
        notificationQueueCharacters
      };
    }
  };
}
