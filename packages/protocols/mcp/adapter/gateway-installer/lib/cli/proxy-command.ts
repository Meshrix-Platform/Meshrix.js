import {
  createMcpProxySessionId,
  MCP_PROXY_SESSION_HEADER,
  normalizeMcpProxySessionId
} from "../mcp-proxy-session.ts";
import { createBoundedStdioOutput } from "./bounded-stdio-output.ts";
import { HTTP_TIMEOUT_MS } from "./constants.ts";
import { normalizeTarget, option } from "./basic-utils.ts";
import { fetchJson } from "./http-json-client.ts";
import { authHeaders, optionsWithDiscoveredBaseUrl, resolveApiKey } from "./discovery.ts";
import { installerOptions } from "./installer-options.ts";
import { redactSensitiveText } from "./installer-output-safety.ts";

export const MCP_STDIO_FRAMING_JSONL: any = "jsonl";
export const MCP_STDIO_FRAMING_CONTENT_LENGTH: any = "content-length";
export const MCP_STDIO_MAX_FRAME_BYTES: any = 8 * 1024 * 1024;
export const MCP_STDIO_MAX_BUFFER_BYTES: any = MCP_STDIO_MAX_FRAME_BYTES + (64 * 1024);
export const MCP_PROXY_MAX_ACTIVE_REQUESTS: any = 32;
export const MCP_PROXY_MAX_PENDING_DISPATCHES: any = 96;

function positiveInteger(value?: any, fallback?: any, name?: any) : any {
  const resolved: any = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function stdioFrameError(message?: any, framing?: any, { fatal = false, rest = Buffer.alloc(0) }: Record<string, any> = {}) : any {
  return {
    error: new Error(message),
    errorCode: -32700,
    fatal,
    framing,
    rest
  };
}

export function encodeStdioJsonRpc(payload?: any, framing: any = MCP_STDIO_FRAMING_JSONL) : any {
  const data: any = Buffer.from(JSON.stringify(payload), "utf8");
  if (framing === MCP_STDIO_FRAMING_CONTENT_LENGTH) {
    return Buffer.concat([
      Buffer.from(`Content-Length: ${data.length}\r\n\r\n`, "utf8"),
      data
    ]);
  }
  return Buffer.concat([data, Buffer.from("\n", "utf8")]);
}

export function extractStdioMessage(buffer?: any, {
  maxFrameBytes = MCP_STDIO_MAX_FRAME_BYTES
}: Record<string, any> = {}) : any {
  const frameLimit: any = positiveInteger(maxFrameBytes, MCP_STDIO_MAX_FRAME_BYTES, "maxFrameBytes");
  const contentLengthPrefix: any = "content-length:";
  const prefixProbe: any = buffer
    .subarray(0, Math.min(buffer.length, contentLengthPrefix.length))
    .toString("ascii")
    .toLowerCase();
  const couldBeContentLength: any = contentLengthPrefix.startsWith(prefixProbe);
  const isContentLength: any = prefixProbe === contentLengthPrefix;

  if (isContentLength || couldBeContentLength) {
    const headerEnd: any = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return null;
    }
    const headerText: any = buffer.subarray(0, headerEnd).toString("utf8");
    const lengthMatch: any = headerText.match(/^content-length:\s*(\d+)\s*$/im);
    if (!lengthMatch) {
      return stdioFrameError(
        "Invalid MCP Content-Length header.",
        MCP_STDIO_FRAMING_CONTENT_LENGTH,
        { fatal: true }
      );
    }
    const length: any = Number(lengthMatch[1]);
    if (!Number.isSafeInteger(length) || length > frameLimit) {
      return stdioFrameError(
        "MCP stdio frame limit exceeded.",
        MCP_STDIO_FRAMING_CONTENT_LENGTH,
        { fatal: true }
      );
    }
    const bodyStart: any = headerEnd + 4;
    if (buffer.length < bodyStart + length) {
      return null;
    }
    const rest: any = buffer.subarray(bodyStart + length);
    try {
      return {
        message: JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8")),
        framing: MCP_STDIO_FRAMING_CONTENT_LENGTH,
        rest
      };
    } catch {
      return stdioFrameError(
        "Invalid JSON-RPC frame.",
        MCP_STDIO_FRAMING_CONTENT_LENGTH,
        { rest }
      );
    }
  }
  const newline: any = buffer.indexOf("\n");
  if (newline >= 0) {
    const rest: any = buffer.subarray(newline + 1);
    if (newline > frameLimit) {
      return stdioFrameError(
        "MCP stdio frame limit exceeded.",
        MCP_STDIO_FRAMING_JSONL,
        { rest }
      );
    }
    const line: any = buffer.subarray(0, newline).toString("utf8").trim();
    try {
      return {
        message: line ? JSON.parse(line) : null,
        framing: MCP_STDIO_FRAMING_JSONL,
        rest
      };
    } catch {
      return stdioFrameError(
        "Invalid JSON-RPC frame.",
        MCP_STDIO_FRAMING_JSONL,
        { rest }
      );
    }
  }
  if (buffer.length > frameLimit) {
    return stdioFrameError(
      "MCP stdio frame limit exceeded.",
      MCP_STDIO_FRAMING_JSONL,
      { fatal: true }
    );
  }
  return null;
}

export async function forwardProxyMessage({
  baseUrl,
  token,
  target,
  message,
  signal,
  proxySessionId
}: Record<string, any>) : Promise<any> {
  const correlationSessionId: any = normalizeMcpProxySessionId(proxySessionId);
  if (!correlationSessionId) {
    throw new Error("MCP proxy session correlation is unavailable.");
  }
  const body: any = JSON.stringify(message);
  const response: any = await fetchJson(`${baseUrl}/mcp`, {
    method: "POST",
    timeoutMs: HTTP_TIMEOUT_MS,
    signal,
    headers: {
      ...authHeaders(token, target),
      [MCP_PROXY_SESSION_HEADER]: correlationSessionId
    },
    body
  });
  if (!response.ok) {
    const reason: any = response.payload?.error?.message || response.payload?.error || `Meshrix MCP proxy failed with HTTP ${response.status}`;
    return {
      jsonrpc: "2.0",
      id: message?.id ?? null,
      error: {
        code: -32001,
        message: redactSensitiveText(reason, [token])
      }
    };
  }
  return response.payload;
}

function hasJsonRpcRequestId(message?: any) : any {
  return message?.id !== undefined && message?.id !== null;
}

function isCancellationNotification(message?: any) : any {
  return !hasJsonRpcRequestId(message) && message?.method === "notifications/cancelled";
}

function requestCancellationError() : any {
  const error: Error & Record<string, any> = new Error("MCP request cancelled.");
  error.name = "AbortError";
  return error;
}

export function createProxyRequestDispatcher({
  baseUrl,
  token,
  target,
  forwardMessage = forwardProxyMessage,
  writeMessage,
  writable = process.stdout,
  proxySessionId = createMcpProxySessionId(),
  maxOutputQueuedBytes,
  maxOutputQueuedMessages,
  outputDrainTimeoutMs,
  onOutputFailure = () : any => {},
  maxActiveRequests = MCP_PROXY_MAX_ACTIVE_REQUESTS,
  maxPendingDispatches = MCP_PROXY_MAX_PENDING_DISPATCHES
}: Record<string, any> = {}) : any {
  const activeRequestLimit: any = positiveInteger(
    maxActiveRequests,
    MCP_PROXY_MAX_ACTIVE_REQUESTS,
    "maxActiveRequests"
  );
  const pendingDispatchLimit: any = positiveInteger(
    maxPendingDispatches,
    MCP_PROXY_MAX_PENDING_DISPATCHES,
    "maxPendingDispatches"
  );
  const correlationSessionId: any = normalizeMcpProxySessionId(proxySessionId);
  if (!correlationSessionId) {
    throw new TypeError("MCP proxy session correlation identifier is invalid.");
  }
  const activeRequests: any = new Map<any, any>();
  const pendingDispatches: any = new Set<any>();
  let cancellationReservations: any = 0;
  let stopped: any = false;
  let outputFailure: any = null;
  let resolveOutputFailure: any;
  const failure: any = new Promise((resolve?: any) : any => {
    resolveOutputFailure = resolve;
  });

  function handleOutputFailure(error?: any) : any {
    if (outputFailure) {
      return;
    }
    outputFailure = error instanceof Error ? error : new Error("MCP proxy output failed.");
    resolveOutputFailure(outputFailure);
    stop();
    try {
      onOutputFailure(outputFailure);
    } catch {}
  }

  const boundedOutput: any = typeof writeMessage === "function"
    ? null
    : createBoundedStdioOutput({
        writable,
        maxQueuedBytes: maxOutputQueuedBytes,
        maxQueuedMessages: maxOutputQueuedMessages,
        drainTimeoutMs: outputDrainTimeoutMs,
        onFailure: handleOutputFailure
      });

  function emitMessage(payload?: any, framing: any = MCP_STDIO_FRAMING_JSONL) : any {
    if (outputFailure) {
      return false;
    }
    if (boundedOutput) {
      return boundedOutput.write(encodeStdioJsonRpc(payload, framing));
    }
    try {
      const accepted: any = writeMessage(payload, framing);
      if (accepted === false) {
        handleOutputFailure(new Error("MCP proxy output rejected a response."));
        return false;
      }
      return true;
    } catch (error: any) {
      handleOutputFailure(error);
      return false;
    }
  }

  function pendingWorkCount() : any {
    return pendingDispatches.size + cancellationReservations;
  }

  function hasPendingCapacity(requiredSlots: any = 1) : any {
    return pendingWorkCount() + requiredSlots <= pendingDispatchLimit;
  }

  function trackDispatch(promise?: any) : any {
    pendingDispatches.add(promise);
    promise.finally(() : any => pendingDispatches.delete(promise));
    return promise;
  }

  function forwardNotification(message?: any, { reserved = false }: Record<string, any> = {}) : any {
    if (!reserved && !hasPendingCapacity()) {
      return false;
    }
    return trackDispatch((async () : Promise<any> => {
      try {
        await forwardMessage({
          baseUrl,
          token,
          target,
          message,
          proxySessionId: correlationSessionId
        });
      } catch {
        // JSON-RPC notifications are best-effort and never produce responses.
      }
    })()) && true;
  }

  function writeCapacityError(requestId?: any, framing?: any) : any {
    emitMessage({
      jsonrpc: "2.0",
      id: requestId,
      error: { code: -32000, message: "MCP proxy request capacity exceeded." }
    }, framing);
  }

  function releaseCancellationReservation(entry?: any) : any {
    if (!entry.cancellationReserved) {
      return false;
    }
    entry.cancellationReserved = false;
    cancellationReservations -= 1;
    return true;
  }

  function dispatchRequest(message?: any, framing?: any) : any {
    const requestId: any = message.id;
    if (activeRequests.has(requestId)) {
      emitMessage({
        jsonrpc: "2.0",
        id: requestId,
        error: { code: -32600, message: "Duplicate in-flight JSON-RPC request id." }
      }, framing);
      return;
    }
    if (activeRequests.size >= activeRequestLimit || !hasPendingCapacity(2)) {
      writeCapacityError(requestId, framing);
      return;
    }

    const controller: any = new AbortController();
    const entry: Record<string, any> = { controller, cancellationReserved: true, cancelled: false };
    activeRequests.set(requestId, entry);
    cancellationReservations += 1;
    const promise: any = (async () : Promise<any> => {
      try {
        const forwarded: any = await forwardMessage({
          baseUrl,
          token,
          target,
          message,
          signal: controller.signal,
          proxySessionId: correlationSessionId
        });
        if (controller.signal.aborted) {
          return;
        }
        emitMessage(forwarded, framing);
      } catch (error: any) {
        if (controller.signal.aborted) {
          return;
        }
        emitMessage({
          jsonrpc: "2.0",
          id: requestId,
          error: { code: -32001, message: error.message || "Meshrix MCP proxy forwarding failed." }
        }, framing);
      } finally {
        releaseCancellationReservation(entry);
        if (activeRequests.get(requestId) === entry) {
          activeRequests.delete(requestId);
        }
      }
    })();
    trackDispatch(promise);
  }

  function dispatch(message?: any, framing: any = MCP_STDIO_FRAMING_JSONL) : any {
    if (stopped) {
      return;
    }
    if (isCancellationNotification(message)) {
      const activeRequest: any = activeRequests.get(message?.params?.requestId);
      if (!activeRequest) {
        return;
      }
      if (activeRequest.cancelled) {
        return;
      }
      const requestId: any = message.params.requestId;
      activeRequest.cancelled = true;
      activeRequest.controller.abort(requestCancellationError());
      const hadReservation: any = releaseCancellationReservation(activeRequest);
      forwardNotification({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId }
      }, { reserved: hadReservation });
      return;
    }
    if (!hasJsonRpcRequestId(message)) {
      forwardNotification(message);
      return;
    }
    dispatchRequest(message, framing);
  }

  function stop() : any {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const [requestId, activeRequest] of activeRequests) {
      if (activeRequest.cancelled) {
        continue;
      }
      activeRequest.cancelled = true;
      activeRequest.controller.abort(requestCancellationError());
      const hadReservation: any = releaseCancellationReservation(activeRequest);
      forwardNotification({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId }
      }, { reserved: hadReservation });
    }
  }

  async function waitForIdle() : Promise<any> {
    while (pendingDispatches.size > 0) {
      await Promise.allSettled([...pendingDispatches]);
    }
    await boundedOutput?.waitForIdle();
    if (outputFailure) {
      throw outputFailure;
    }
  }

  return {
    dispatch,
    stop,
    write: emitMessage,
    waitForIdle,
    failure,
    get activeRequestCount() : any {
      return activeRequests.size;
    },
    get pendingDispatchCount() : any {
      return pendingDispatches.size;
    },
    get pendingWorkCount() : any {
      return pendingWorkCount();
    },
    get outputSnapshot() : any {
      return boundedOutput?.snapshot() || Object.freeze({
        pendingBytes: 0,
        pendingMessages: 0,
        blocked: false,
        failed: Boolean(outputFailure),
        maxQueuedBytes: 0,
        maxQueuedMessages: 0
      });
    }
  };
}

export function createProxyStdioTransport(options: Record<string, any> = {}) : any {
  let buffer: any = Buffer.alloc(0);
  let inputFailed: any = false;
  const callerOutputFailure: any = options.onOutputFailure;
  const dispatcher: any = createProxyRequestDispatcher({
    ...options,
    onOutputFailure(error?: any) : any {
      inputFailed = true;
      buffer = Buffer.alloc(0);
      callerOutputFailure?.(error);
    }
  });
  const maxFrameBytes: any = positiveInteger(
    options.maxFrameBytes,
    MCP_STDIO_MAX_FRAME_BYTES,
    "maxFrameBytes"
  );
  const maxBufferBytes: any = positiveInteger(
    options.maxBufferBytes,
    MCP_STDIO_MAX_BUFFER_BYTES,
    "maxBufferBytes"
  );

  function writeInputError(error?: any, framing: any = MCP_STDIO_FRAMING_JSONL) : any {
    dispatcher.write({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: error?.errorCode || -32700,
        message: error?.message || "Invalid JSON-RPC frame."
      }
    }, framing);
  }

  function drainBuffer() : any {
    let consumed: any = false;
    while (true) {
      const beforeLength: any = buffer.length;
      const extracted: any = extractStdioMessage(buffer, { maxFrameBytes });
      if (!extracted) {
        return consumed;
      }
      buffer = extracted.rest;
      consumed ||= buffer.length < beforeLength;
      if (extracted.error) {
        writeInputError(extracted.error, extracted.framing || MCP_STDIO_FRAMING_JSONL);
        if (extracted.fatal) {
          inputFailed = true;
          buffer = Buffer.alloc(0);
          return true;
        }
        continue;
      }
      if (extracted.message) {
        dispatcher.dispatch(
          extracted.message,
          extracted.framing || MCP_STDIO_FRAMING_JSONL
        );
      }
    }
  }

  function push(chunk?: any) : any {
    if (inputFailed) {
      return;
    }
    let incoming: any = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (incoming.length > 0 && !inputFailed) {
      const available: any = maxBufferBytes - buffer.length;
      if (available <= 0) {
        const drained: any = drainBuffer();
        if (!drained && buffer.length >= maxBufferBytes) {
          writeInputError(new Error("MCP stdio input buffer limit exceeded."));
          inputFailed = true;
          buffer = Buffer.alloc(0);
        }
        continue;
      }
      const acceptedBytes: any = Math.min(available, incoming.length);
      buffer = Buffer.concat([buffer, incoming.subarray(0, acceptedBytes)]);
      incoming = incoming.subarray(acceptedBytes);
      drainBuffer();
    }
  }

  return {
    push,
    close: dispatcher.waitForIdle,
    failure: dispatcher.failure,
    get activeRequestCount() : any {
      return dispatcher.activeRequestCount;
    },
    get pendingDispatchCount() : any {
      return dispatcher.pendingDispatchCount;
    },
    get pendingWorkCount() : any {
      return dispatcher.pendingWorkCount;
    },
    get inputFailed() : any {
      return inputFailed;
    },
    get outputSnapshot() : any {
      return dispatcher.outputSnapshot;
    }
  };
}

export async function resolveProxyCredentials(options: Record<string, any> = {}) : Promise<any> {
  const target: any = normalizeTarget(option(options, "target", "opencode")) || "opencode";
  const token: any = await resolveApiKey(options, { required: true });
  return {
    target,
    token,
    tokenSource: "provided"
  };
}

export async function proxyCommand(options: Record<string, any> = {}) : Promise<any> {
  const credentials: any = await resolveProxyCredentials(options);
  const resolved: any = await optionsWithDiscoveredBaseUrl(options);
  const settings: any = installerOptions(resolved);
  const { target, token } = credentials;
  const transport: any = createProxyStdioTransport({
    baseUrl: settings.baseUrl,
    token,
    target
  });

  const onData: any = (chunk?: any) : any => {
    transport.push(chunk);
  };
  let onEnd: any;
  const inputEnded: any = new Promise((resolve?: any) : any => {
    onEnd = () : any => resolve(null);
    process.stdin.once("end", onEnd);
  });
  process.stdin.on("data", onData);
  const outputFailure: any = await Promise.race([inputEnded, transport.failure]);
  if (outputFailure) {
    process.stdin.removeListener("data", onData);
    process.stdin.removeListener("end", onEnd);
    process.stdin.pause();
  }
  await transport.close();
  return { ok: true, proxy: "closed" };
}
