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
} from "./upstream-mcp-transport-common.ts";

const MAX_RESPONSE_CHARS: any = 8 * 1024 * 1024;
const CANCELLATION_TIMEOUT_MS: any = 1000;
const CLOSE_TIMEOUT_MS: any = 1000;
const VISIBLE_ASCII_PATTERN: any = /^[\x21-\x7e]+$/;
export const UPSTREAM_MCP_HTTP_NOTIFICATION_LIMITS: Readonly<Record<string, any>> = Object.freeze({
  queueLength: 64,
  queueCharacters: 1024 * 1024
});

function normalizedHeaders(record: Record<string, any> = {}, env: any = process.env) : any {
  return Object.fromEntries(
    (Object.entries(resolveStringRecord(record, env)) as [string, any][])
      .map(([key, value]: any[]) : any => [key.toLowerCase(), value])
  );
}

function safeCancelReason(timedOut?: any) : any {
  return timedOut
    ? "Upstream MCP request exceeded its time limit."
    : "Upstream MCP request was cancelled by the gateway.";
}

async function readBoundedText(response?: any) : Promise<any> {
  if (!response.body) return "";
  const reader: any = response.body.getReader();
  const decoder: any = new TextDecoder();
  let result: any = "";
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

function eventPayload(eventText?: any) : any {
  const data: any = String(eventText)
    .split(/\r?\n/)
    .filter((line?: any) : any => line.startsWith("data:"))
    .map((line?: any) : any => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  const payload: any = parseJson(data);
  if (!payload) throw protocolError("Upstream MCP event stream emitted invalid JSON.");
  return payload;
}

function serverRequestResponse(message?: any) : any {
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
  payload?: any,
  requestId?: any,
  onNotification?: any,
  onServerRequest?: any,
  enqueueNotification?: any
) : Promise<any> {
  const messages: any = Array.isArray(payload) ? payload : [payload];
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
  response?: any,
  requestId?: any,
  onNotification?: any,
  onServerRequest?: any,
  enqueueNotification?: any
) : Promise<any> {
  if (!response.body) {
    throw protocolError("Upstream MCP event stream did not include a response body.");
  }
  const reader: any = response.body.getReader();
  const decoder: any = new TextDecoder();
  let buffer: any = "";
  let totalCharacters: any = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      totalCharacters += value?.byteLength || 0;
      if (buffer.length > MAX_RESPONSE_CHARS || totalCharacters > MAX_RESPONSE_CHARS) {
        throw protocolError("Upstream MCP event stream exceeded the transport limit.");
      }
      let match: any;
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        const boundary: any = match.index;
        const eventText: any = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + match[0].length);
        const payload: any = eventPayload(eventText);
        const responsePayload: any = await consumePayload(
          payload,
          requestId,
          onNotification,
          onServerRequest,
          enqueueNotification
        );
        if (responsePayload) {
          await reader.cancel().catch(() : any => undefined);
          return responsePayload;
        }
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const responsePayload: any = await consumePayload(
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

export async function createHttpMcpSession(config: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> {
  const normalized: any = normalizeTransportConfig(config);
  const url: any = text(normalized.url || normalized.endpoint || normalized.baseUrl);
  if (!url) throw new Error("Upstream MCP http transport requires url.");
  const fetchImpl: any = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Upstream MCP http transport requires fetch.");
  const fetchTransport: any = typeof options.fetchTransport === "function"
    ? options.fetchTransport
    : async (targetUrl?: any, init?: any) : Promise<any> => ({ response: await fetchImpl(targetUrl, init) });
  const customHeaders: any = normalizedHeaders(normalized.headers, options.env || process.env);
  let nextId: any = 1;
  let sessionId: any = "";
  let protocolVersion: any = requestedProtocolVersion(normalized);
  let initialized: any = false;
  let initializedResult: Record<string, any> = {};
  let closed: any = false;
  let fatal: any = false;
  let sessionClosePromise: any = null;
  const activeRequests: any = new Map<any, any>();
  const notificationQueue: any[] = [];
  let notificationQueueCharacters: any = 0;
  let notificationDispatching: any = false;

  function clearNotificationQueue() : any {
    notificationQueue.length = 0;
    notificationQueueCharacters = 0;
  }

  function enqueueNotification(callback?: any, payload?: any) : any {
    if (typeof callback !== "function") return;
    const characterCount: any = JSON.stringify(payload).length;
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
    void (async () : Promise<any> => {
      while (notificationQueue.length > 0 && !fatal && !closed) {
        const next: any = notificationQueue.shift();
        notificationQueueCharacters -= next.characterCount;
        await notifySafely(next.callback, next.payload);
      }
      notificationDispatching = false;
      if (fatal || closed) clearNotificationQueue();
    })();
  }

  async function openTransportFetch(init?: any) : Promise<any> {
    const result: any = await fetchTransport(url, init, { config: normalized });
    const response: any = result?.response || result;
    if (!response || typeof response !== "object") {
      throw new Error("Upstream MCP http transport did not return a response.");
    }
    return {
      response,
      close: typeof result?.close === "function" ? result.close : async () : Promise<any> => {}
    };
  }

  async function closeTransportFetch(handle?: any) : Promise<any> {
    try {
      await handle?.close?.();
    } catch {
      // Request semantics remain authoritative after best-effort transport cleanup.
    }
  }

  function headers({ includeSession = initialized }: Record<string, any> = {}) : any {
    const result: Record<string, any> = {
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

  async function postOneWay(payload?: any, method?: any, timeoutMs: any = normalized.timeoutMs) : Promise<any> {
    if (closed) throw fatalSessionError("Upstream MCP http session is closed.");
    const controller: any = new AbortController();
    const timeout: any = setTimeout(() : any => controller.abort(), positiveInt(timeoutMs, normalized.timeoutMs));
    timeout.unref?.();
    let transportFetch: any = null;
    try {
      transportFetch = await openTransportFetch({
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const response: any = transportFetch.response;
      if (response.status === 404 && sessionId) {
        await response.body?.cancel().catch(() : any => undefined);
        throw missingSessionError();
      }
      const returnedSessionId: any = response.headers.get("mcp-session-id") || "";
      if (returnedSessionId && !VISIBLE_ASCII_PATTERN.test(returnedSessionId)) {
        await response.body?.cancel().catch(() : any => undefined);
        throw protocolError("Upstream MCP returned an invalid session identifier.");
      }
      if (returnedSessionId && sessionId && returnedSessionId !== sessionId) {
        await response.body?.cancel().catch(() : any => undefined);
        throw protocolError("Upstream MCP changed its session identifier unexpectedly.");
      }
      if (response.status !== 202) {
        await response.body?.cancel().catch(() : any => undefined);
        throw fatalSessionError("Upstream MCP notification was not accepted.");
      }
      await response.body?.cancel().catch(() : any => undefined);
    } catch (error: any) {
      if (error?.mcpSessionFatal) throw error;
      if (controller.signal.aborted) throw timeoutError(method);
      throw fatalSessionError("Upstream MCP notification could not be sent.", error);
    } finally {
      await closeTransportFetch(transportFetch);
      clearTimeout(timeout);
    }
  }

  async function postNotification(method?: any, params: Record<string, any> = {}, timeoutMs: any = normalized.timeoutMs) : Promise<any> {
    return postOneWay(jsonRpcNotification(method, params), method, timeoutMs);
  }

  async function respondToServerRequest(message?: any) : Promise<any> {
    await postOneWay(serverRequestResponse(message), "server-request-response", CANCELLATION_TIMEOUT_MS);
  }

  async function sendCancellation(id?: any, timedOut?: any) : Promise<any> {
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

  async function request(method?: any, params: Record<string, any> = {}, requestOptions: Record<string, any> = {}) : Promise<any> {
    if (requestOptions.signal?.aborted) throw abortError();
    if (closed) throw fatalSessionError("Upstream MCP http session is closed.");
    if (fatal) throw fatalSessionError("Upstream MCP http session is unavailable.");
    const id: any = nextId++;
    const controller: any = new AbortController();
    let settleActiveRequest: any;
    const activeRequestSettled: any = new Promise((resolve?: any) : any => {
      settleActiveRequest = resolve;
    });
    activeRequests.set(id, { controller, settled: activeRequestSettled });
    let timedOut: any = false;
    let callerAborted: any = false;
    const cancelNotification: any = requestOptions.cancelNotification !== false;
    const abortListener: any = () : any => {
      callerAborted = true;
      controller.abort();
    };
    requestOptions.signal?.addEventListener("abort", abortListener, { once: true });
    const timeout: any = setTimeout(() : any => {
      timedOut = true;
      controller.abort();
    }, positiveInt(requestOptions.timeoutMs, normalized.timeoutMs));
    timeout.unref?.();
    let transportFetch: any = null;
    try {
      transportFetch = await openTransportFetch({
        method: "POST",
        headers: headers({ includeSession: initialized }),
        body: JSON.stringify(jsonRpcRequest(id, method, params)),
        signal: controller.signal
      });
      const response: any = transportFetch.response;
      if (response.status === 404 && initialized && sessionId) {
        await response.body?.cancel().catch(() : any => undefined);
        throw missingSessionError();
      }
      const returnedSessionId: any = response.headers.get("mcp-session-id") || "";
      if (returnedSessionId && !VISIBLE_ASCII_PATTERN.test(returnedSessionId)) {
        await response.body?.cancel().catch(() : any => undefined);
        throw protocolError("Upstream MCP returned an invalid session identifier.");
      }
      if (initialized && returnedSessionId && sessionId && returnedSessionId !== sessionId) {
        await response.body?.cancel().catch(() : any => undefined);
        throw protocolError("Upstream MCP changed its session identifier unexpectedly.");
      }
      if (returnedSessionId) sessionId = returnedSessionId;
      if (!response.ok) {
        await response.body?.cancel().catch(() : any => undefined);
        throw fatalSessionError(`Upstream MCP http request failed with status ${response.status}.`);
      }
      const contentType: any = response.headers.get("content-type") || "";
      const payload: any = /text\/event-stream/i.test(contentType)
        ? await readSseResponse(
          response,
          id,
          requestOptions.onNotification,
          respondToServerRequest,
          enqueueNotification
        )
        : parseJson(await readBoundedText(response));
      const result: any = assertJsonRpcResponse(payload, id);
      if (requestOptions.signal?.aborted || timedOut || callerAborted) throw abortError();
      return result;
    } catch (error: any) {
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

  async function deleteLogicalSession() : Promise<any> {
    if (!sessionId) return;
    const controller: any = new AbortController();
    const timeout: any = setTimeout(() : any => controller.abort(), CLOSE_TIMEOUT_MS);
    timeout.unref?.();
    let transportFetch: any = null;
    try {
      transportFetch = await openTransportFetch({
        method: "DELETE",
        headers: headers({ includeSession: true }),
        signal: controller.signal
      });
      const response: any = transportFetch.response;
      await response.body?.cancel().catch(() : any => undefined);
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
  } catch (error: any) {
    await deleteLogicalSession();
    closed = true;
    throw error;
  }

  return {
    transport: "http",
    initialized: initializedResult,
    get closed() : any {
      return closed;
    },
    get fatal() : any {
      return fatal;
    },
    request,
    notify: postNotification,
    close() : any {
      if (sessionClosePromise) return sessionClosePromise;
      sessionClosePromise = (async () : Promise<any> => {
        closed = true;
        clearNotificationQueue();
        const active: any[] = [...activeRequests.values()];
        for (const entry of active) entry.controller.abort();
        await Promise.allSettled(active.map((entry?: any) : any => entry.settled));
        await deleteLogicalSession();
      })();
      return sessionClosePromise;
    },
    diagnostics() : any {
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
