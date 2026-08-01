export function createCapturedResponse() : any {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = {
        ...this.headers,
        ...headers
      };
    },
    setHeader(name?: any, value?: any) : any {
      this.headers[name] = value;
    },
    getHeader(name?: any) : any {
      const lowerName: any = String(name || "").toLowerCase();
      const entry: any = (Object.entries(this.headers) as [string, any][]).find(
        ([headerName]: any[]) : any => headerName.toLowerCase() === lowerName
      );
      return entry?.[1];
    },
    write(chunk?: any) : any {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    end(chunk?: any) : any {
      this.write(chunk);
      this.ended = true;
    }
  };
}

export function capturedBuffer(captured?: any) : any {
  return Buffer.concat(captured.chunks || []);
}

export function parseCapturedJson(captured?: any) : any {
  const text: any = capturedBuffer(captured).toString("utf8").trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export function buildDirectOperationRequest({ operation, input = {} }: Record<string, any>) : any {
  const declaredProperties: any = operation.inputSchema?.properties &&
    typeof operation.inputSchema.properties === "object" &&
    !Array.isArray(operation.inputSchema.properties)
    ? operation.inputSchema.properties
    : {};
  const bodyIsDeclaredInputField: any = Object.prototype.hasOwnProperty.call(declaredProperties, "body");
  const explicitBody: any =
    input.body !== undefined &&
    input.body &&
    typeof input.body === "object" &&
    !Array.isArray(input.body) &&
    !bodyIsDeclaredInputField;
  const body: any = explicitBody ? input.body : input;
  const params: Record<string, any> = {
    ...(input.params && typeof input.params === "object" && !Array.isArray(input.params) ? input.params : {})
  };
  const pathParamNames: any = [...String(operation.http?.path || "").matchAll(/:([A-Za-z0-9_]+)/g)].map((match?: any) : any => match[1]);
  for (const name of pathParamNames) {
    if (params[name] === undefined && input[name] !== undefined) {
      params[name] = input[name];
      continue;
    }
    const paramDefinition: any = [
      ...(operation.http?.params || []),
      ...(operation.rpc?.params || [])
    ].find((item?: any) : any => item.name === name);
    const aliasValue: any = (paramDefinition?.aliases || []).map((alias?: any) : any => input[alias]).find(
      (item?: any) : any => item !== undefined && item !== null && item !== ""
    );
    if (params[name] === undefined && aliasValue !== undefined) {
      params[name] = aliasValue;
    }
  }
  let path: any = operation.http?.path || "/";
  for (const name of pathParamNames) {
    path = path.replace(`:${name}`, encodeURIComponent(String(params[name] || "")));
  }
  const url: any = new URL(path, "http://127.0.0.1");
  const query: any = input.query && typeof input.query === "object" && !Array.isArray(input.query)
    ? input.query
    : input;
  const queryInput: Record<string, any> = {};
  for (const queryParam of operation.http?.query || []) {
    const aliases: any[] = [queryParam.name, ...(queryParam.aliases || [])];
    const value: any = aliases.map((alias?: any) : any => query[alias]).find(
      (item?: any) : any => item !== undefined && item !== null && item !== ""
    );
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(queryParam.name, String(value));
      queryInput[queryParam.name] = value;
    }
  }
  const method: any = String(operation.http?.method || "POST").toUpperCase();
  const requestBody: any = method === "GET" || method === "HEAD"
    ? Buffer.alloc(0)
    : Buffer.from(JSON.stringify(body && typeof body === "object" ? body : {}), "utf8");
  const operationInput: Record<string, any> = {
    ...(method === "GET" || method === "HEAD"
      ? queryInput
      : (body && typeof body === "object" && !Array.isArray(body) ? body : {})),
    ...params
  };
  return { url, requestBody, params, input: operationInput };
}

function timeoutError(timeoutMs?: any) : any {
  const error: Error & Record<string, any> = new Error(`Tool execution timed out after ${timeoutMs}ms.`);
  error.code = "tool_timeout";
  return error;
}

function abortedError() : any {
  const error: Error & Record<string, any> = new Error("Tool execution was cancelled.");
  error.code = "tool_aborted";
  return error;
}

/**
 * Abort a timed-out dispatch and wait for it to settle before reporting failure.
 * This prevents a queued operation from starting after its caller has returned.
 */
export async function runWithAbortableTimeout(run?: any, timeoutMs?: any, parentSignal: any = null) : Promise<any> {
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
  const normalizedTimeout: any = Math.max(1, Number(timeoutMs || 30_000));
  const abortController: any = new AbortController();
  let terminalFailure: any = null;
  let timer: any = null;
  const abortFromParent: any = () : any => {
    if (terminalFailure) return;
    terminalFailure = abortedError();
    abortController.abort(terminalFailure);
  };
  try {
    parentSignal?.addEventListener?.("abort", abortFromParent, { once: true });
    if (parentSignal?.aborted) abortFromParent();
    timer = setTimeout(() : any => {
      if (terminalFailure) return;
      terminalFailure = timeoutError(normalizedTimeout);
      abortController.abort(terminalFailure);
    }, normalizedTimeout);
    timer.unref?.();
    const result: any = await run(abortController.signal);
    if (terminalFailure) throw terminalFailure;
    return result;
  } catch (error: any) {
    if (terminalFailure) throw terminalFailure;
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    parentSignal?.removeEventListener?.("abort", abortFromParent);
  }
}
