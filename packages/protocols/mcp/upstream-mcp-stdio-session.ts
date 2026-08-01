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
} from "./upstream-mcp-transport-common.ts";

const MAX_STDERR_CHARS: any = 4096;
const MAX_STDOUT_BUFFER_CHARS: any = 8 * 1024 * 1024;
const MAX_NOTIFICATION_QUEUE_CHARS: any = 1024 * 1024;
const MAX_NOTIFICATION_QUEUE_LENGTH: any = 64;
const CLOSE_GRACE_MS: any = 250;

function boundedAppend(current?: any, next?: any) : any {
  const combined: any = `${current}${next}`;
  return combined.length > MAX_STDERR_CHARS
    ? combined.slice(combined.length - MAX_STDERR_CHARS)
    : combined;
}

function progressToken(params: Record<string, any> = {}) : any {
  return asObject(params?._meta).progressToken ?? params?.progressToken;
}

function safeCancelReason(timedOut?: any) : any {
  return timedOut
    ? "Upstream MCP request exceeded its time limit."
    : "Upstream MCP request was cancelled by the gateway.";
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

export async function createStdioMcpSession(config: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> {
  const normalized: any = normalizeTransportConfig(config);
  const command: any = text(normalized.command);
  if (!command) {
    throw new Error("Upstream MCP stdio transport requires command.");
  }
  if (!options.stdioLauncher || typeof options.stdioLauncher.launch !== "function") {
    throw new Error("Upstream MCP stdio process launcher is unavailable.");
  }
  const child: any = options.stdioLauncher.launch(normalized, {
    env: options.env || process.env
  });

  let stdoutBuffer: any = "";
  let stderrBuffer: any = "";
  let nextId: any = 1;
  let initialized: any = false;
  let initializedResult: Record<string, any> = {};
  let fatalError: any = null;
  let closed: any = false;
  let hasExited: any = false;
  let activeWrites: any = 0;
  let notificationQueueCharacters: any = 0;
  let notificationDispatching: any = false;
  const notificationQueue: any[] = [];
  const pending: any = new Map<any, any>();
  let settleExit: any;
  const exited: any = new Promise((resolve?: any) : any => {
    settleExit = resolve;
  });

  function setReferenced(referenced?: any) : any {
    const method: any = referenced ? "ref" : "unref";
    child[method]?.();
    child.stdin?.[method]?.();
    child.stdout?.[method]?.();
    child.stderr?.[method]?.();
  }

  function updateReferences() : any {
    setReferenced(pending.size > 0 || activeWrites > 0 || closed);
  }

  function finishEntry(id?: any, callback?: any) : any {
    const entry: any = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timeout);
    entry.signal?.removeEventListener("abort", entry.abortListener);
    callback(entry);
    updateReferences();
    return true;
  }

  function failPending(error?: any) : any {
    for (const id of [...pending.keys()]) {
      finishEntry(id, (entry?: any) : any => entry.reject(error));
    }
  }

  function markFatal(cause?: any) : any {
    if (closed || fatalError) return;
    fatalError = cause?.mcpSessionFatal
      ? cause
      : fatalSessionError("Upstream MCP stdio session ended unexpectedly.", cause);
    notificationQueue.length = 0;
    notificationQueueCharacters = 0;
    failPending(fatalError);
  }

  async function dispatchNotification(payload?: any) : Promise<any> {
    const requestId: any = payload?.params?.requestId ?? payload?.params?.relatedRequestId;
    if (requestId !== undefined && pending.has(requestId)) {
      await notifySafely(pending.get(requestId).onNotification, payload);
      return;
    }
    const token: any = progressToken(payload?.params);
    if (token !== undefined) {
      const matches: any = [...pending.values()].filter((entry?: any) : any => entry.progressToken === token);
      if (matches.length > 0) {
        await Promise.all(matches.map((entry?: any) : any => notifySafely(entry.onNotification, payload)));
        return;
      }
    }
    const callbacks: any[] = [...new Set<any>(
      [...pending.values()].map((entry?: any) : any => entry.onNotification).filter(Boolean)
    )];
    await Promise.all(callbacks.map((callback?: any) : any => notifySafely(callback, payload)));
  }

  function enqueueNotification(payload?: any) : any {
    const characterCount: any = JSON.stringify(payload).length;
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
    void (async () : Promise<any> => {
      while (notificationQueue.length > 0 && !fatalError && !closed) {
        const next: any = notificationQueue.shift();
        notificationQueueCharacters -= next.characterCount;
        await dispatchNotification(next.payload);
      }
      notificationDispatching = false;
    })();
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk?: any) : any => {
    stdoutBuffer += chunk;
    if (stdoutBuffer.length > MAX_STDOUT_BUFFER_CHARS) {
      stdoutBuffer = "";
      markFatal(protocolError("Upstream MCP stdio response exceeded the transport limit."));
      return;
    }
    const lines: any = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const payload: any = parseJson(line.trim());
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
      const id: any = payload.id;
      finishEntry(id, (entry?: any) : any => {
        try {
          if (entry.signal?.aborted) entry.reject(abortError());
          else entry.resolve(assertJsonRpcResponse(payload, id));
        } catch (error: any) {
          entry.reject(error);
        }
      });
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk?: any) : any => {
    stderrBuffer = boundedAppend(stderrBuffer, chunk);
  });
  child.on("error", markFatal);
  child.on("exit", (code?: any, signal?: any) : any => {
    hasExited = true;
    settleExit({ code, signal });
    if (!closed) markFatal();
  });

  function writePayload(payload?: any) : any {
    if (fatalError) return Promise.reject(fatalError);
    if (closed || !child.stdin?.writable) {
      return Promise.reject(fatalSessionError("Upstream MCP stdio session is closed."));
    }
    activeWrites += 1;
    updateReferences();
    return new Promise((resolve?: any, reject?: any) : any => {
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error?: any) : any => {
          activeWrites = Math.max(0, activeWrites - 1);
          updateReferences();
          if (error) reject(fatalSessionError("Upstream MCP stdio request could not be sent.", error));
          else resolve();
        });
      } catch (error: any) {
        activeWrites = Math.max(0, activeWrites - 1);
        updateReferences();
        reject(fatalSessionError("Upstream MCP stdio request could not be sent.", error));
      }
    });
  }

  async function notify(method?: any, params: Record<string, any> = {}) : Promise<any> {
    await writePayload(jsonRpcNotification(method, params));
  }

  function sendCancellation(requestId?: any, timedOut?: any) : any {
    if (!initialized || closed || fatalError) return;
    void notify("notifications/cancelled", {
      requestId,
      reason: safeCancelReason(timedOut)
    }).catch(() : any => undefined);
  }

  function request(method?: any, params: Record<string, any> = {}, requestOptions: Record<string, any> = {}) : any {
    if (requestOptions.signal?.aborted) {
      return Promise.reject(abortError());
    }
    if (fatalError) return Promise.reject(fatalError);
    if (closed) return Promise.reject(fatalSessionError("Upstream MCP stdio session is closed."));
    const id: any = nextId++;
    const timeoutMs: any = positiveInt(requestOptions.timeoutMs, normalized.timeoutMs);
    const cancelNotification: any = requestOptions.cancelNotification !== false;
    const payload: any = jsonRpcRequest(id, method, params);
    const promise: any = new Promise((resolve?: any, reject?: any) : any => {
      const abortListener: any = () : any => {
        if (cancelNotification) sendCancellation(id, false);
        finishEntry(id, (entry?: any) : any => entry.reject(abortError()));
      };
      const timeout: any = setTimeout(() : any => {
        if (cancelNotification) sendCancellation(id, true);
        finishEntry(id, (entry?: any) : any => entry.reject(timeoutError(method)));
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
    void writePayload(payload).catch((error?: any) : any => {
      finishEntry(id, (entry?: any) : any => entry.reject(error));
    });
    return promise.then((result?: any) : any => {
      if (requestOptions.signal?.aborted) {
        if (cancelNotification) sendCancellation(id, false);
        throw abortError();
      }
      return result;
    });
  }

  async function shutdownChild() : Promise<any> {
    setReferenced(true);
    try {
      child.stdin?.end();
    } catch {
      // Ignore shutdown races.
    }
    let timer: any;
    await Promise.race([
      exited,
      new Promise((resolve?: any) : any => {
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
      new Promise((resolve?: any) : any => {
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
        new Promise((resolve?: any) : any => {
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
  } catch (error: any) {
    closed = true;
    await shutdownChild();
    throw error;
  }

  return {
    transport: "stdio",
    initialized: initializedResult,
    get closed() : any {
      return closed;
    },
    get fatal() : any {
      return Boolean(fatalError);
    },
    request,
    notify,
    async close() : Promise<any> {
      if (closed) return;
      closed = true;
      failPending(abortError("Upstream MCP session was closed."));
      notificationQueue.length = 0;
      notificationQueueCharacters = 0;
      await shutdownChild();
    },
    diagnostics() : any {
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
