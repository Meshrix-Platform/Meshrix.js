export function createCapturedResponse() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = {
        ...this.headers,
        ...headers
      };
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    getHeader(name) {
      const lowerName = String(name || "").toLowerCase();
      const entry = Object.entries(this.headers).find(
        ([headerName]) => headerName.toLowerCase() === lowerName
      );
      return entry?.[1];
    },
    write(chunk) {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    end(chunk) {
      this.write(chunk);
      this.ended = true;
    }
  };
}

export function capturedBuffer(captured) {
  return Buffer.concat(captured.chunks || []);
}

export function parseCapturedJson(captured) {
  const text = capturedBuffer(captured).toString("utf8").trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export function buildDirectOperationRequest({ operation, input = {} }) {
  const declaredProperties = operation.inputSchema?.properties &&
    typeof operation.inputSchema.properties === "object" &&
    !Array.isArray(operation.inputSchema.properties)
    ? operation.inputSchema.properties
    : {};
  const bodyIsDeclaredInputField = Object.prototype.hasOwnProperty.call(declaredProperties, "body");
  const explicitBody =
    input.body !== undefined &&
    input.body &&
    typeof input.body === "object" &&
    !Array.isArray(input.body) &&
    !bodyIsDeclaredInputField;
  const body = explicitBody ? input.body : input;
  const params = {
    ...(input.params && typeof input.params === "object" && !Array.isArray(input.params) ? input.params : {})
  };
  const pathParamNames = [...String(operation.http?.path || "").matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  for (const name of pathParamNames) {
    if (params[name] === undefined && input[name] !== undefined) {
      params[name] = input[name];
      continue;
    }
    const paramDefinition = [
      ...(operation.http?.params || []),
      ...(operation.rpc?.params || [])
    ].find((item) => item.name === name);
    const aliasValue = (paramDefinition?.aliases || []).map((alias) => input[alias]).find(
      (item) => item !== undefined && item !== null && item !== ""
    );
    if (params[name] === undefined && aliasValue !== undefined) {
      params[name] = aliasValue;
    }
  }
  let path = operation.http?.path || "/";
  for (const name of pathParamNames) {
    path = path.replace(`:${name}`, encodeURIComponent(String(params[name] || "")));
  }
  const url = new URL(path, "http://127.0.0.1");
  const query = input.query && typeof input.query === "object" && !Array.isArray(input.query)
    ? input.query
    : input;
  const queryInput = {};
  for (const queryParam of operation.http?.query || []) {
    const aliases = [queryParam.name, ...(queryParam.aliases || [])];
    const value = aliases.map((alias) => query[alias]).find(
      (item) => item !== undefined && item !== null && item !== ""
    );
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(queryParam.name, String(value));
      queryInput[queryParam.name] = value;
    }
  }
  const method = String(operation.http?.method || "POST").toUpperCase();
  const requestBody = method === "GET" || method === "HEAD"
    ? Buffer.alloc(0)
    : Buffer.from(JSON.stringify(body && typeof body === "object" ? body : {}), "utf8");
  const operationInput = {
    ...(method === "GET" || method === "HEAD"
      ? queryInput
      : (body && typeof body === "object" && !Array.isArray(body) ? body : {})),
    ...params
  };
  return { url, requestBody, params, input: operationInput };
}

function timeoutError(timeoutMs) {
  const error = new Error(`Tool execution timed out after ${timeoutMs}ms.`);
  error.code = "tool_timeout";
  return error;
}

function abortedError() {
  const error = new Error("Tool execution was cancelled.");
  error.code = "tool_aborted";
  return error;
}

/**
 * Abort a timed-out dispatch and wait for it to settle before reporting failure.
 * This prevents a queued operation from starting after its caller has returned.
 */
export async function runWithAbortableTimeout(run, timeoutMs, parentSignal = null) {
  if (typeof run !== "function") {
    throw new TypeError("Timed tool execution requires a run function.");
  }
  if (
    parentSignal !== null &&
    parentSignal !== undefined &&
    (
      typeof parentSignal.aborted !== "boolean" ||
      typeof parentSignal.addEventListener !== "function" ||
      typeof parentSignal.removeEventListener !== "function"
    )
  ) {
    throw new TypeError("Timed tool execution parent signal must be an AbortSignal.");
  }
  if (parentSignal?.aborted) throw abortedError();
  const normalizedTimeout = Math.max(1, Number(timeoutMs || 30_000));
  const abortController = new AbortController();
  let terminalFailure = null;
  let timer = null;
  const abortFromParent = () => {
    if (terminalFailure) return;
    terminalFailure = abortedError();
    abortController.abort(terminalFailure);
  };
  try {
    parentSignal?.addEventListener?.("abort", abortFromParent, { once: true });
    if (parentSignal?.aborted) abortFromParent();
    timer = setTimeout(() => {
      if (terminalFailure) return;
      terminalFailure = timeoutError(normalizedTimeout);
      abortController.abort(terminalFailure);
    }, normalizedTimeout);
    timer.unref?.();
    const result = await run(abortController.signal);
    if (terminalFailure) throw terminalFailure;
    return result;
  } catch (error) {
    if (terminalFailure) throw terminalFailure;
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    parentSignal?.removeEventListener?.("abort", abortFromParent);
  }
}
