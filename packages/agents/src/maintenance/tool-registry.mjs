import {
  createTraceContext,
  setTraceContextOnRequest
} from "@lico/foundation/observability/trace-context";
import {
  getRuntimeLogger,
  summarizeError
} from "@lico/foundation/observability/runtime-logger";
import { SERVER_API_OPERATIONS } from "@lico/contracts/operations/operation-registry";

function maintenanceTimeoutError(toolId) {
  const error = new Error(`维护工具执行超时：${toolId}`);
  error.code = "maintenance_tool_timeout";
  return error;
}

async function runWithAbortableTimeout(run, timeoutMs, toolId) {
  if (typeof run !== "function") {
    throw new TypeError("维护工具超时控制需要可执行函数。");
  }
  const abortController = new AbortController();
  let timeoutFailure = null;
  let timeoutId = null;
  try {
    timeoutId = setTimeout(() => {
      timeoutFailure = maintenanceTimeoutError(toolId);
      abortController.abort(timeoutFailure);
    }, Math.max(1, Number(timeoutMs || 30_000)));
    const result = await run(abortController.signal);
    if (timeoutFailure) throw timeoutFailure;
    return result;
  } catch (error) {
    if (timeoutFailure) throw timeoutFailure;
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function parseCapturedJson(captured) {
  const buffer = Buffer.concat(captured.chunks || []);
  if (buffer.length === 0) {
    return {};
  }
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return { text: buffer.toString("utf8") };
  }
}

function createCapturedResponse() {
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

function buildOperationRequest(operation, input = {}) {
  const params = {};
  const pathParamNames = [...String(operation.http?.path || "").matchAll(/:([A-Za-z0-9_]+)/g)]
    .map((match) => match[1]);
  for (const name of pathParamNames) {
    if (input[name] !== undefined && input[name] !== null) {
      params[name] = input[name];
    }
  }
  let pathname = operation.http?.path || "/";
  for (const name of pathParamNames) {
    pathname = pathname.replace(`:${name}`, encodeURIComponent(String(params[name] || "")));
  }
  const url = new URL(pathname, "http://127.0.0.1");
  for (const queryParam of operation.http?.query || []) {
    const value = input[queryParam.name];
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(queryParam.name, String(value));
    }
  }
  const method = String(operation.http?.method || "POST").toUpperCase();
  const requestBody = method === "GET" || method === "HEAD"
    ? Buffer.alloc(0)
    : Buffer.from(JSON.stringify(input && typeof input === "object" ? input : {}), "utf8");
  return {
    method,
    url,
    requestBody,
    params
  };
}

export function createMaintenanceToolRegistry({
  userDataPath,
  getControllers = () => null,
  operationDispatcher,
  operationAuditStore = null,
  operationConcurrencyScope = undefined,
  logger = getRuntimeLogger()
}) {
  if (typeof operationDispatcher !== "function") {
    throw new TypeError("Maintenance tool registry requires operationDispatcher.");
  }
  const tools = new Map();
  const operationsById = new Map(SERVER_API_OPERATIONS.map((operation) => [operation.id, operation]));

  function register(definition) {
    const operation = operationsById.get(definition.id);
    if (!operation) {
      throw new Error(`维护工具必须引用已注册 Operation：${definition.id}`);
    }
    tools.set(definition.id, {
      timeoutMs: 30000,
      redaction: "default",
      operationId: operation.id,
      ...definition,
      scopes: operation.requiredScopes || [],
      risk: operation.safety?.risk || operation.risk || "read_only",
      inputSchema: operation.inputSchema || {}
    });
  }

  const maintenanceOperations = [
    ["system.health", 5000],
    ["runtime.info", 30000],
    ["storage.summary", 5000],
    ["storage.doctor", 120000],
    ["storage.reconcile", 120000],
    ["jobs.list", 30000],
    ["jobs.failed_review", 30000],
    ["runtime.reload_mounts", 60000]
  ];

  for (const [id, timeoutMs] of maintenanceOperations) {
    register({ id, timeoutMs });
  }

  return {
    listTools() {
      return [...tools.values()].map((tool) => ({
        id: tool.id,
        risk: tool.risk,
        scopes: tool.scopes,
        timeoutMs: tool.timeoutMs,
        inputSchema: tool.inputSchema,
        redaction: tool.redaction
      }));
    },
    getTool(toolId) {
      return tools.get(toolId) || null;
    },
    hasTool(toolId) {
      return tools.has(toolId);
    },
    async runTool(toolId, input = {}, context = {}) {
      const tool = tools.get(toolId);
      if (!tool) {
        throw new Error(`维护工具不存在：${toolId}`);
      }
      const operation = operationsById.get(toolId);
      if (!operation) {
        throw new Error(`维护工具未绑定 Operation：${toolId}`);
      }
      const controllers = getControllers();
      if (!controllers) {
        throw new Error("维护工具无法取得 Operation controllers。");
      }
      const shouldConfirm = tool.risk === "repair_write" && context.approved === true;
      const operationInput = {
        ...(input && typeof input === "object" && !Array.isArray(input) ? input : {}),
        ...(shouldConfirm ? { confirm: true, safetyConfirm: true } : {})
      };
      const requestInfo = buildOperationRequest(operation, operationInput);
      const traceContext = createTraceContext({
        traceId: context.traceId,
        transport: "maintenance-agent",
        operationId: operation.id,
        actor: {
          type: "maintenance-agent",
          userId: context.run?.runId || "maintenance-agent",
          username: "maintenance-agent",
          roleId: "maintenance-agent",
          scopes: uniqueStrings([
            ...(operation.requiredScopes || []),
            ...(tool.scopes || []),
            "console:read",
            "jobs:read",
            "maintenance:read",
            "maintenance:run",
            "maintenance:approve",
            "runtime:admin"
          ])
        }
      });
      const request = {
        method: requestInfo.method,
        url: requestInfo.url.pathname,
        headers: shouldConfirm
          ? { "x-lico-safety-confirm": "true", "x-lico-confirm": "true" }
          : {},
        socket: { remoteAddress: "maintenance-agent" }
      };
      setTraceContextOnRequest(request, traceContext);
      const captured = createCapturedResponse();
      const actor = traceContext.actor;
      try {
        await runWithAbortableTimeout(
          (signal) => operationDispatcher({
            operation,
            controllers,
            request,
            response: captured,
            requestBody: requestInfo.requestBody,
            url: requestInfo.url,
            params: requestInfo.params,
            input: operationInput,
            transport: "maintenance-agent",
            method: requestInfo.method,
            authorizeOperation: null,
            operationAuditStore,
            concurrencyScope: operationConcurrencyScope,
            logger,
            authSession: { user: actor },
            actor,
            skipAuthorization: true,
            signal
          }),
          tool.timeoutMs,
          toolId
        );
      } catch (error) {
        logger?.error?.("maintenance.agent.tool.dispatch_failed", {
          toolId,
          operationId: operation.id,
          traceId: traceContext.traceId,
          error: summarizeError(error)
        });
        throw error;
      }
      const payload = parseCapturedJson(captured);
      if ((captured.statusCode || 200) >= 400) {
        throw new Error(payload?.error || payload?.message || `维护工具失败：${toolId}`);
      }
      return payload?.result !== undefined ? payload.result : payload;
    }
  };
}
