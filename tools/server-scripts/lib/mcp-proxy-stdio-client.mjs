import { spawn } from "node:child_process";

export const MCP_STDIO_FRAMING_JSONL = "jsonl";
export const MCP_STDIO_FRAMING_CONTENT_LENGTH = "content-length";

function freezeProbeProfile(profile) {
  return Object.freeze({
    ...profile,
    capabilities: Object.freeze({ ...(profile.capabilities || {}) }),
    clientInfo: Object.freeze({ ...(profile.clientInfo || {}) }),
    toolsListParams: profile.toolsListParams === undefined
      ? undefined
      : Object.freeze({ ...(profile.toolsListParams || {}) })
  });
}

export function mcpClientProbeProfile(target = "") {
  const normalizedTarget = String(target || "").trim();
  if (!normalizedTarget) throw new Error("MCP target is required for the neutral protocol probe.");
  return freezeProbeProfile({
    target: normalizedTarget,
    framing: MCP_STDIO_FRAMING_JSONL,
    profileSource: "neutral-protocol-peer",
    observedClientVersion: "",
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "meshrix-neutral-mcp-peer", version: "1" },
    initializedParamsOmitted: true,
    toolsListParams: undefined
  });
}

function terminateProcess(child, signal = "SIGTERM") {
  if (!child?.pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process may have exited between timeout and termination.
    }
  }
}

export function encodeStdioJsonRpc(payload, framing = MCP_STDIO_FRAMING_JSONL) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (framing === MCP_STDIO_FRAMING_CONTENT_LENGTH) {
    return Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
      body
    ]);
  }
  return Buffer.concat([body, Buffer.from("\n", "utf8")]);
}

export function extractStdioJsonRpc(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd >= 0) {
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const lengthMatch = header.match(/content-length:\s*(\d+)/iu);
    if (!lengthMatch) {
      throw new Error("MCP stdio frame is missing Content-Length.");
    }
    const length = Number(lengthMatch[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) {
      return null;
    }
    return {
      framing: MCP_STDIO_FRAMING_CONTENT_LENGTH,
      message: JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8")),
      rest: buffer.subarray(bodyStart + length)
    };
  }
  const newline = buffer.indexOf("\n");
  if (newline < 0) return null;
  const line = buffer.subarray(0, newline).toString("utf8").trim();
  return {
    framing: MCP_STDIO_FRAMING_JSONL,
    message: line ? JSON.parse(line) : null,
    rest: buffer.subarray(newline + 1)
  };
}

export function createMcpProxyStdioClient({
  connectorScript,
  target,
  baseUrl,
  tokenEnvName = "MESHRIX_MCP_TOKEN",
  env = {},
  cwd = process.cwd(),
  timeoutMs = 10000,
  framing = "",
  redactText = (value) => String(value || "")
} = {}) {
  if (!connectorScript || !target || !baseUrl) {
    throw new Error("connectorScript, target, and baseUrl are required for MCP proxy stdio verification.");
  }
  const profile = mcpClientProbeProfile(target);
  const stdioFraming = framing || profile.framing;
  let requestCounter = -1;
  let closeStatus = null;
  let closeSignal = "";
  const child = spawn(process.execPath, [
    connectorScript,
    "proxy",
    "--target", target,
    "--url", baseUrl,
    "--token-env", tokenEnvName
  ], {
    cwd,
    env: { ...process.env, ...env },
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = Buffer.alloc(0);
  let stderr = "";
  let closed = false;
  const pending = new Map();
  const notifications = [];
  const observedResponseCounts = new Map();

  function requestError(message) {
    const error = new Error(redactText(message));
    error.stderr = redactText(stderr).slice(-1200);
    error.closeStatus = closeStatus;
    error.closeSignal = closeSignal;
    return error;
  }

  function settlePending(id, result) {
    const waiter = pending.get(String(id));
    if (!waiter) {
      return false;
    }
    pending.delete(String(id));
    clearTimeout(waiter.timer);
    if (result.ok) {
      waiter.resolve(result.message);
    } else {
      waiter.reject(result.error);
    }
    return true;
  }

  function rejectAll(error) {
    for (const [id] of pending) {
      settlePending(id, { ok: false, error });
    }
  }

  child.stdout.on("data", (chunk) => {
    stdout = Buffer.concat([stdout, chunk]);
    while (true) {
      let extracted;
      try {
        extracted = extractStdioJsonRpc(stdout);
      } catch (error) {
        stdout = Buffer.alloc(0);
        rejectAll(requestError(error?.message || "Invalid MCP stdio frame."));
        return;
      }
      if (!extracted) {
        return;
      }
      stdout = extracted.rest;
      const message = extracted.message;
      if (!message) continue;
      if (extracted.framing !== stdioFraming) {
        rejectAll(requestError(`MCP proxy returned ${extracted.framing} framing while ${stdioFraming} was requested.`));
        continue;
      }
      if (message?.id === undefined || message?.id === null) {
        notifications.push(message);
        continue;
      }
      const responseKey = String(message.id);
      observedResponseCounts.set(responseKey, (observedResponseCounts.get(responseKey) || 0) + 1);
      settlePending(message.id, { ok: true, message });
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 8192) {
      stderr = stderr.slice(-8192);
    }
  });

  child.on("error", (error) => {
    closed = true;
    rejectAll(requestError(error?.message || "MCP proxy process failed to start."));
  });

  child.on("close", (code, signal) => {
    closed = true;
    closeStatus = Number(code ?? 0);
    closeSignal = String(signal || "");
    if (pending.size > 0) {
      rejectAll(requestError(`MCP proxy exited before all responses arrived, status=${closeStatus} signal=${closeSignal}`));
    }
  });

  async function requestRaw(method, params = {}, options = {}) {
    if (closed) {
      throw requestError("MCP proxy process is already closed.");
    }
    const id = typeof options === "object" && options !== null
      ? options.id ?? ++requestCounter
      : options;
    const requestTimeoutMs = typeof options === "object" && options !== null
      ? options.timeoutMs || timeoutMs
      : timeoutMs;
    const payload = { jsonrpc: "2.0", id, method };
    if (options?.omitParams !== true) {
      payload.params = params;
    }
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(requestError(`Timed out waiting for MCP proxy response id=${id} method=${method}`));
      }, requestTimeoutMs);
      pending.set(String(id), { resolve, reject, timer });
      child.stdin.write(encodeStdioJsonRpc(payload, stdioFraming), (error) => {
        if (error) {
          pending.delete(String(id));
          clearTimeout(timer);
          reject(requestError(error.message || `Failed to write MCP proxy request ${method}.`));
        }
      });
    });
    return response;
  }

  async function request(method, params = {}, options = {}) {
    const response = await requestRaw(method, params, options);
    if (response?.error) {
      throw requestError(`MCP proxy returned JSON-RPC error for ${method}: ${response.error.message || response.error.code || "unknown"}`);
    }
    return response;
  }

  function abandonRequest(requestId) {
    const id = String(requestId);
    const waiter = pending.get(id);
    if (!waiter) return false;
    pending.delete(id);
    clearTimeout(waiter.timer);
    waiter.reject(requestError("MCP proxy response observation ended."));
    return true;
  }

  async function notify(method, params = {}, options = {}) {
    if (closed) {
      throw requestError("MCP proxy process is already closed.");
    }
    const payload = { jsonrpc: "2.0", method };
    if (options?.omitParams !== true) {
      payload.params = params;
    }
    await new Promise((resolve, reject) => {
      child.stdin.write(encodeStdioJsonRpc(payload, stdioFraming), (error) => {
        if (error) {
          reject(requestError(error.message || `Failed to write MCP proxy notification ${method}.`));
          return;
        }
        resolve();
      });
    });
  }

  async function close() {
    if (!closed) {
      child.stdin.end();
      await new Promise((resolve) => {
        const terminateTimer = setTimeout(() => {
          terminateProcess(child, "SIGTERM");
        }, 1500);
        const killTimer = setTimeout(() => {
          terminateProcess(child, "SIGKILL");
          resolve();
        }, 4000);
        child.once("close", (code, signal) => {
          closeStatus = Number(code ?? 0);
          closeSignal = String(signal || "");
          clearTimeout(terminateTimer);
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
    if (stderr.trim() && process.env.MESHRIX_VERIFY_VERBOSE) {
      process.stderr.write(redactText(stderr));
    }
    return {
      closed: true,
      notifications: notifications.length,
      status: closeStatus,
      signal: closeSignal
    };
  }

  return {
    child,
    abandonRequest,
    close,
    notify,
    observedResponseCount(requestId) {
      return observedResponseCounts.get(String(requestId)) || 0;
    },
    profile,
    request,
    requestRaw,
    diagnostics() {
      return {
        pidPresent: Boolean(child.pid),
        closed,
        status: closeStatus,
        signal: closeSignal,
        stderrBytes: Buffer.byteLength(stderr),
        stderrTail: redactText(stderr).slice(-600)
      };
    }
  };
}
