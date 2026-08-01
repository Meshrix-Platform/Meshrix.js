import { spawn } from "node:child_process";

export const MCP_STDIO_FRAMING_JSONL: any = "jsonl";
export const MCP_STDIO_FRAMING_CONTENT_LENGTH: any = "content-length";

function freezeProbeProfile(profile?: any) : any {
  return Object.freeze({
    ...profile,
    capabilities: Object.freeze({ ...(profile.capabilities || {}) }),
    clientInfo: Object.freeze({ ...(profile.clientInfo || {}) }),
    toolsListParams: profile.toolsListParams === undefined
      ? undefined
      : Object.freeze({ ...(profile.toolsListParams || {}) })
  });
}

export function mcpClientProbeProfile(target: any = "") : any {
  const normalizedTarget: any = String(target || "").trim();
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

function terminateProcess(child?: any, signal: any = "SIGTERM") : any {
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

export function encodeStdioJsonRpc(payload?: any, framing: any = MCP_STDIO_FRAMING_JSONL) : any {
  const body: any = Buffer.from(JSON.stringify(payload), "utf8");
  if (framing === MCP_STDIO_FRAMING_CONTENT_LENGTH) {
    return Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
      body
    ]);
  }
  return Buffer.concat([body, Buffer.from("\n", "utf8")]);
}

export function extractStdioJsonRpc(buffer?: any) : any {
  const headerEnd: any = buffer.indexOf("\r\n\r\n");
  if (headerEnd >= 0) {
    const header: any = buffer.subarray(0, headerEnd).toString("utf8");
    const lengthMatch: any = header.match(/content-length:\s*(\d+)/iu);
    if (!lengthMatch) {
      throw new Error("MCP stdio frame is missing Content-Length.");
    }
    const length: any = Number(lengthMatch[1]);
    const bodyStart: any = headerEnd + 4;
    if (buffer.length < bodyStart + length) {
      return null;
    }
    return {
      framing: MCP_STDIO_FRAMING_CONTENT_LENGTH,
      message: JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8")),
      rest: buffer.subarray(bodyStart + length)
    };
  }
  const newline: any = buffer.indexOf("\n");
  if (newline < 0) return null;
  const line: any = buffer.subarray(0, newline).toString("utf8").trim();
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
  redactText = (value?: any) : any => String(value || "")
}: Record<string, any> = {}) : any {
  if (!connectorScript || !target || !baseUrl) {
    throw new Error("connectorScript, target, and baseUrl are required for MCP proxy stdio verification.");
  }
  const profile: any = mcpClientProbeProfile(target);
  const stdioFraming: any = framing || profile.framing;
  let requestCounter: any = -1;
  let closeStatus: any = null;
  let closeSignal: any = "";
  const child: any = spawn(process.execPath, [
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
  let stdout: any = Buffer.alloc(0);
  let stderr: any = "";
  let closed: any = false;
  const pending: any = new Map<any, any>();
  const notifications: any[] = [];
  const observedResponseCounts: any = new Map<any, any>();

  function requestError(message?: any) : any {
    const error: Error & Record<string, any> = new Error(redactText(message));
    error.stderr = redactText(stderr).slice(-1200);
    error.closeStatus = closeStatus;
    error.closeSignal = closeSignal;
    return error;
  }

  function settlePending(id?: any, result?: any) : any {
    const waiter: any = pending.get(String(id));
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

  function rejectAll(error?: any) : any {
    for (const [id] of pending) {
      settlePending(id, { ok: false, error });
    }
  }

  child.stdout.on("data", (chunk?: any) : any => {
    stdout = Buffer.concat([stdout, chunk]);
    while (true) {
      let extracted: any;
      try {
        extracted = extractStdioJsonRpc(stdout);
      } catch (error: any) {
        stdout = Buffer.alloc(0);
        rejectAll(requestError(error?.message || "Invalid MCP stdio frame."));
        return;
      }
      if (!extracted) {
        return;
      }
      stdout = extracted.rest;
      const message: any = extracted.message;
      if (!message) continue;
      if (extracted.framing !== stdioFraming) {
        rejectAll(requestError(`MCP proxy returned ${extracted.framing} framing while ${stdioFraming} was requested.`));
        continue;
      }
      if (message?.id === undefined || message?.id === null) {
        notifications.push(message);
        continue;
      }
      const responseKey: any = String(message.id);
      observedResponseCounts.set(responseKey, (observedResponseCounts.get(responseKey) || 0) + 1);
      settlePending(message.id, { ok: true, message });
    }
  });

  child.stderr.on("data", (chunk?: any) : any => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 8192) {
      stderr = stderr.slice(-8192);
    }
  });

  child.on("error", (error?: any) : any => {
    closed = true;
    rejectAll(requestError(error?.message || "MCP proxy process failed to start."));
  });

  child.on("close", (code?: any, signal?: any) : any => {
    closed = true;
    closeStatus = Number(code ?? 0);
    closeSignal = String(signal || "");
    if (pending.size > 0) {
      rejectAll(requestError(`MCP proxy exited before all responses arrived, status=${closeStatus} signal=${closeSignal}`));
    }
  });

  async function requestRaw(method?: any, params: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> {
    if (closed) {
      throw requestError("MCP proxy process is already closed.");
    }
    const id: any = typeof options === "object" && options !== null
      ? options.id ?? ++requestCounter
      : options;
    const requestTimeoutMs: any = typeof options === "object" && options !== null
      ? options.timeoutMs || timeoutMs
      : timeoutMs;
    const payload: Record<string, any> = { jsonrpc: "2.0", id, method };
    if (options?.omitParams !== true) {
      payload.params = params;
    }
    const response: any = await new Promise((resolve?: any, reject?: any) : any => {
      const timer: any = setTimeout(() : any => {
        pending.delete(String(id));
        reject(requestError(`Timed out waiting for MCP proxy response id=${id} method=${method}`));
      }, requestTimeoutMs);
      pending.set(String(id), { resolve, reject, timer });
      child.stdin.write(encodeStdioJsonRpc(payload, stdioFraming), (error?: any) : any => {
        if (error) {
          pending.delete(String(id));
          clearTimeout(timer);
          reject(requestError(error.message || `Failed to write MCP proxy request ${method}.`));
        }
      });
    });
    return response;
  }

  async function request(method?: any, params: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> {
    const response: any = await requestRaw(method, params, options);
    if (response?.error) {
      throw requestError(`MCP proxy returned JSON-RPC error for ${method}: ${response.error.message || response.error.code || "unknown"}`);
    }
    return response;
  }

  function abandonRequest(requestId?: any) : any {
    const id: any = String(requestId);
    const waiter: any = pending.get(id);
    if (!waiter) return false;
    pending.delete(id);
    clearTimeout(waiter.timer);
    waiter.reject(requestError("MCP proxy response observation ended."));
    return true;
  }

  async function notify(method?: any, params: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> {
    if (closed) {
      throw requestError("MCP proxy process is already closed.");
    }
    const payload: Record<string, any> = { jsonrpc: "2.0", method };
    if (options?.omitParams !== true) {
      payload.params = params;
    }
    await new Promise((resolve?: any, reject?: any) : any => {
      child.stdin.write(encodeStdioJsonRpc(payload, stdioFraming), (error?: any) : any => {
        if (error) {
          reject(requestError(error.message || `Failed to write MCP proxy notification ${method}.`));
          return;
        }
        resolve();
      });
    });
  }

  async function close() : Promise<any> {
    if (!closed) {
      child.stdin.end();
      await new Promise((resolve?: any) : any => {
        const terminateTimer: any = setTimeout(() : any => {
          terminateProcess(child, "SIGTERM");
        }, 1500);
        const killTimer: any = setTimeout(() : any => {
          terminateProcess(child, "SIGKILL");
          resolve();
        }, 4000);
        child.once("close", (code?: any, signal?: any) : any => {
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
    observedResponseCount(requestId?: any) : any {
      return observedResponseCounts.get(String(requestId)) || 0;
    },
    profile,
    request,
    requestRaw,
    diagnostics() : any {
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
