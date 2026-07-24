import {
  abortError,
  asObject,
  assertNegotiatedProtocolVersion,
  assertJsonRpcResponse,
  fatalSessionError,
  initializeParams,
  jsonRpcNotification,
  jsonRpcRequest,
  normalizeTransportConfig,
  notifySafely,
  parseJson,
  positiveInt,
  protocolError,
  requestedProtocolVersion,
  text,
  timeoutError
} from "./upstream-mcp-transport-common.mjs";

const MAX_STDERR_CHARS = 4096;
const MAX_STDOUT_BUFFER_CHARS = 8 * 1024 * 1024;
const MAX_NOTIFICATION_QUEUE_CHARS = 1024 * 1024;
const MAX_NOTIFICATION_QUEUE_LENGTH = 64;
const CLOSE_GRACE_MS = 250;

function boundedAppend(current, next) {
  const combined = `${current}${next}`;
  return combined.length > MAX_STDERR_CHARS
    ? combined.slice(combined.length - MAX_STDERR_CHARS)
    : combined;
}

function progressToken(params = {}) {
  return asObject(params?._meta).progressToken ?? params?.progressToken;
}

function safeCancelReason(timedOut) {
  return timedOut
    ? "Upstream MCP request exceeded its time limit."
    : "Upstream MCP request was cancelled by the gateway.";
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

export async function createStdioMcpSession(config = {}, options = {}) {
  const normalized = normalizeTransportConfig(config);
  const command = text(normalized.command);
  if (!command) {
    throw new Error("Upstream MCP stdio transport requires command.");
  }
  if (!options.stdioLauncher || typeof options.stdioLauncher.launch !== "function") {
    throw new Error("Upstream MCP stdio process launcher is unavailable.");
  }
  const child = options.stdioLauncher.launch(normalized, {
    env: options.env || process.env
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let nextId = 1;
  let initialized = false;
  let initializedResult = {};
  let fatalError = null;
  let closed = false;
  let hasExited = false;
  let activeWrites = 0;
  let notificationQueueCharacters = 0;
  let notificationDispatching = false;
  const notificationQueue = [];
  const pending = new Map();
  let settleExit;
  const exited = new Promise((resolve) => {
    settleExit = resolve;
  });

  function setReferenced(referenced) {
    const method = referenced ? "ref" : "unref";
    child[method]?.();
    child.stdin?.[method]?.();
    child.stdout?.[method]?.();
    child.stderr?.[method]?.();
  }

  function updateReferences() {
    setReferenced(pending.size > 0 || activeWrites > 0 || closed);
  }

  function finishEntry(id, callback) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timeout);
    entry.signal?.removeEventListener("abort", entry.abortListener);
    callback(entry);
    updateReferences();
    return true;
  }

  function failPending(error) {
    for (const id of [...pending.keys()]) {
      finishEntry(id, (entry) => entry.reject(error));
    }
  }

  function markFatal(cause) {
    if (closed || fatalError) return;
    fatalError = cause?.mcpSessionFatal
      ? cause
      : fatalSessionError("Upstream MCP stdio session ended unexpectedly.", cause);
    notificationQueue.length = 0;
    notificationQueueCharacters = 0;
    failPending(fatalError);
  }

  async function dispatchNotification(payload) {
    const requestId = payload?.params?.requestId ?? payload?.params?.relatedRequestId;
    if (requestId !== undefined && pending.has(requestId)) {
      await notifySafely(pending.get(requestId).onNotification, payload);
      return;
    }
    const token = progressToken(payload?.params);
    if (token !== undefined) {
      const matches = [...pending.values()].filter((entry) => entry.progressToken === token);
      if (matches.length > 0) {
        await Promise.all(matches.map((entry) => notifySafely(entry.onNotification, payload)));
        return;
      }
    }
    const callbacks = [...new Set(
      [...pending.values()].map((entry) => entry.onNotification).filter(Boolean)
    )];
    await Promise.all(callbacks.map((callback) => notifySafely(callback, payload)));
  }

  function enqueueNotification(payload) {
    const characterCount = JSON.stringify(payload).length;
    if (
      notificationQueue.length >= MAX_NOTIFICATION_QUEUE_LENGTH ||
      notificationQueueCharacters + characterCount > MAX_NOTIFICATION_QUEUE_CHARS
    ) {
      markFatal(protocolError("Upstream MCP stdio notification queue exceeded the transport limit."));
      return;
    }
    notificationQueue.push({ payload, characterCount });
    notificationQueueCharacters += characterCount;
    if (notificationDispatching) return;
    notificationDispatching = true;
    void (async () => {
      while (notificationQueue.length > 0 && !fatalError && !closed) {
        const next = notificationQueue.shift();
        notificationQueueCharacters -= next.characterCount;
        await dispatchNotification(next.payload);
      }
      notificationDispatching = false;
    })();
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    if (stdoutBuffer.length > MAX_STDOUT_BUFFER_CHARS) {
      stdoutBuffer = "";
      markFatal(protocolError("Upstream MCP stdio response exceeded the transport limit."));
      return;
    }
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const payload = parseJson(line.trim());
      if (!payload) {
        if (line.trim()) {
          markFatal(protocolError("Upstream MCP stdio emitted an invalid JSON-RPC message."));
          return;
        }
        continue;
      }
      if (payload.method) {
        if (payload.jsonrpc !== "2.0") {
          markFatal(protocolError("Upstream MCP stdio notification used an unsupported JSON-RPC version."));
          return;
        }
        if (payload.id !== undefined) {
          void writePayload(serverRequestResponse(payload)).catch(markFatal);
        } else {
          enqueueNotification(payload);
        }
        continue;
      }
      if (payload.id === undefined) {
        markFatal(protocolError("Upstream MCP stdio emitted an invalid JSON-RPC message."));
        return;
      }
      const id = payload.id;
      finishEntry(id, (entry) => {
        try {
          if (entry.signal?.aborted) entry.reject(abortError());
          else entry.resolve(assertJsonRpcResponse(payload, id));
        } catch (error) {
          entry.reject(error);
        }
      });
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuffer = boundedAppend(stderrBuffer, chunk);
  });
  child.on("error", markFatal);
  child.on("exit", (code, signal) => {
    hasExited = true;
    settleExit({ code, signal });
    if (!closed) markFatal();
  });

  function writePayload(payload) {
    if (fatalError) return Promise.reject(fatalError);
    if (closed || !child.stdin?.writable) {
      return Promise.reject(fatalSessionError("Upstream MCP stdio session is closed."));
    }
    activeWrites += 1;
    updateReferences();
    return new Promise((resolve, reject) => {
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
          activeWrites = Math.max(0, activeWrites - 1);
          updateReferences();
          if (error) reject(fatalSessionError("Upstream MCP stdio request could not be sent.", error));
          else resolve();
        });
      } catch (error) {
        activeWrites = Math.max(0, activeWrites - 1);
        updateReferences();
        reject(fatalSessionError("Upstream MCP stdio request could not be sent.", error));
      }
    });
  }

  async function notify(method, params = {}) {
    await writePayload(jsonRpcNotification(method, params));
  }

  function sendCancellation(requestId, timedOut) {
    if (!initialized || closed || fatalError) return;
    void notify("notifications/cancelled", {
      requestId,
      reason: safeCancelReason(timedOut)
    }).catch(() => undefined);
  }

  function request(method, params = {}, requestOptions = {}) {
    if (requestOptions.signal?.aborted) {
      return Promise.reject(abortError());
    }
    if (fatalError) return Promise.reject(fatalError);
    if (closed) return Promise.reject(fatalSessionError("Upstream MCP stdio session is closed."));
    const id = nextId++;
    const timeoutMs = positiveInt(requestOptions.timeoutMs, normalized.timeoutMs);
    const cancelNotification = requestOptions.cancelNotification !== false;
    const payload = jsonRpcRequest(id, method, params);
    const promise = new Promise((resolve, reject) => {
      const abortListener = () => {
        if (cancelNotification) sendCancellation(id, false);
        finishEntry(id, (entry) => entry.reject(abortError()));
      };
      const timeout = setTimeout(() => {
        if (cancelNotification) sendCancellation(id, true);
        finishEntry(id, (entry) => entry.reject(timeoutError(method)));
      }, timeoutMs);
      timeout.unref?.();
      pending.set(id, {
        resolve,
        reject,
        timeout,
        signal: requestOptions.signal,
        abortListener,
        onNotification: requestOptions.onNotification,
        progressToken: progressToken(params)
      });
      requestOptions.signal?.addEventListener("abort", abortListener, { once: true });
      updateReferences();
    });
    void writePayload(payload).catch((error) => {
      finishEntry(id, (entry) => entry.reject(error));
    });
    return promise.then((result) => {
      if (requestOptions.signal?.aborted) {
        if (cancelNotification) sendCancellation(id, false);
        throw abortError();
      }
      return result;
    });
  }

  async function shutdownChild() {
    setReferenced(true);
    try {
      child.stdin?.end();
    } catch {
      // Ignore shutdown races.
    }
    let timer;
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(resolve, Math.floor(CLOSE_GRACE_MS / 2));
        timer.unref?.();
      })
    ]);
    clearTimeout(timer);
    if (!hasExited) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Continue to the bounded final shutdown attempt.
      }
    }
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(resolve, Math.ceil(CLOSE_GRACE_MS / 2));
        timer.unref?.();
      })
    ]);
    clearTimeout(timer);
    if (!hasExited) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process handle is already unavailable.
      }
      await Promise.race([
        exited,
        new Promise((resolve) => {
          timer = setTimeout(resolve, Math.ceil(CLOSE_GRACE_MS / 2));
          timer.unref?.();
        })
      ]);
      clearTimeout(timer);
    }
    setReferenced(false);
  }

  try {
    initializedResult = await request("initialize", initializeParams(normalized), {
      timeoutMs: normalized.timeoutMs,
      cancelNotification: false
    });
    assertNegotiatedProtocolVersion(initializedResult, requestedProtocolVersion(normalized));
    initialized = true;
    await notify("notifications/initialized", {});
    updateReferences();
  } catch (error) {
    closed = true;
    await shutdownChild();
    throw error;
  }

  return {
    transport: "stdio",
    initialized: initializedResult,
    get closed() {
      return closed;
    },
    get fatal() {
      return Boolean(fatalError);
    },
    request,
    notify,
    async close() {
      if (closed) return;
      closed = true;
      failPending(abortError("Upstream MCP session was closed."));
      notificationQueue.length = 0;
      notificationQueueCharacters = 0;
      await shutdownChild();
    },
    diagnostics() {
      return {
        transport: "stdio",
        state: fatalError ? "failed" : closed ? "closed" : "ready",
        pendingRequestCount: pending.size,
        queuedNotificationCount: notificationQueue.length,
        stderrCaptured: stderrBuffer.length > 0,
        stderrCharacterCount: stderrBuffer.length
      };
    }
  };
}
