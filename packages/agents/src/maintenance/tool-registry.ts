import {
  createTraceContext,
  setTraceContextOnRequest
} from "@meshrix/foundation/observability/trace-context";
import {
  getRuntimeLogger,
  summarizeError
} from "@meshrix/foundation/observability/runtime-logger";
import { SERVER_API_OPERATIONS } from "@meshrix/contracts/operations/operation-registry";

function maintenanceTimeoutError(toolId?: any) : any {
  const error: Error & Record<string, any> = new Error(`维护工具执行超时：${toolId}`);
  error.code = "maintenance_tool_timeout";
  return error;
}

async function runWithAbortableTimeout(run?: any, timeoutMs?: any, toolId?: any) : Promise<any> {
  if (typeof run !== "function") {
    throw new TypeError("维护工具超时控制需要可执行函数。");
  }
  const abortController: any = new AbortController();
  let timeoutFailure: any = null;
  let timeoutId: any = null;
  try {
    timeoutId = setTimeout(() : any => {
      timeoutFailure = maintenanceTimeoutError(toolId);
      abortController.abort(timeoutFailure);
    }, Math.max(1, Number(timeoutMs || 30_000)));
    const result: any = await run(abortController.signal);
    if (timeoutFailure) throw timeoutFailure;
    return result;
  } catch (error: any) {
    if (timeoutFailure) throw timeoutFailure;
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

function parseCapturedJson(captured?: any) : any {
  const buffer: any = Buffer.concat(captured.chunks || []);
  if (buffer.length === 0) {
    return {};
  }
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return { text: buffer.toString("utf8") };
  }
}

function createCapturedResponse() : any {
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

function buildOperationRequest(operation?: any, input: Record<string, any> = {}) : any {
  const params: Record<string, any> = {};
  const pathParamNames: any = [...String(operation.http?.path || "").matchAll(/:([A-Za-z0-9_]+)/g)]
    .map((match?: any) : any => match[1]);
  for (const name of pathParamNames) {
    if (input[name] !== undefined && input[name] !== null) {
      params[name] = input[name];
    }
  }
  let pathname: any = operation.http?.path || "/";
  for (const name of pathParamNames) {
    pathname = pathname.replace(`:${name}`, encodeURIComponent(String(params[name] || "")));
  }
  const url: any = new URL(pathname, "http://127.0.0.1");
  for (const queryParam of operation.http?.query || []) {
    const value: any = input[queryParam.name];
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(queryParam.name, String(value));
    }
  }
  const method: any = String(operation.http?.method || "POST").toUpperCase();
  const requestBody: any = method === "GET" || method === "HEAD"
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
  getControllers = () : any => null,
  operationDispatcher,
  operationAuditStore = null,
  operationProofSubstrate = null,
  revalidateMaintenanceAuthorization = null,
  operationConcurrencyScope = undefined,
  logger = getRuntimeLogger()
}: Record<string, any>) : any {
  if (typeof operationDispatcher !== "function") {
    throw new TypeError("Maintenance tool registry requires operationDispatcher.");
  }
  const tools: any = new Map<any, any>();
  const operationsById: any = new Map<any, any>(SERVER_API_OPERATIONS.map((operation?: any) : any => [operation.id, operation]));

  function register(definition?: any) : any {
    const operation: any = operationsById.get(definition.id);
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

  const maintenanceOperations: any[] = [
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
    listTools() : any {
      return [...tools.values()].map((tool?: any) : any => ({
        id: tool.id,
        risk: tool.risk,
        scopes: tool.scopes,
        timeoutMs: tool.timeoutMs,
        inputSchema: tool.inputSchema,
        redaction: tool.redaction
      }));
    },
    getTool(toolId?: any) : any {
      return tools.get(toolId) || null;
    },
    hasTool(toolId?: any) : any {
      return tools.has(toolId);
    },
    async runTool(toolId?: any, input: Record<string, any> = {}, context: Record<string, any> = {}) : Promise<any> {
      const tool: any = tools.get(toolId);
      if (!tool) {
        throw new Error(`维护工具不存在：${toolId}`);
      }
      const operation: any = operationsById.get(toolId);
      if (!operation) {
        throw new Error(`维护工具未绑定 Operation：${toolId}`);
      }
      const controllers: any = getControllers();
      if (!controllers) {
        throw new Error("维护工具无法取得 Operation controllers。");
      }
      const shouldConfirm: any = tool.risk === "repair_write" && context.approved === true;
      const operationInput: Record<string, any> = {
        ...(input && typeof input === "object" && !Array.isArray(input) ? input : {}),
        ...(shouldConfirm ? { confirm: true, safetyConfirm: true } : {})
      };
      const requestInfo: any = buildOperationRequest(operation, operationInput);
      const maintenanceAuthorization: any = context.maintenanceAuthorization;
      if (
        maintenanceAuthorization?.ok !== true ||
        maintenanceAuthorization.workloadPrincipal?.subjectId !== "maintenance-agent"
      ) {
        const error: Error & Record<string, any> = new Error(
          "Maintenance tool execution requires current workload authorization."
        );
        error.code = "maintenance_workload_authorization_required";
        throw error;
      }
      const principal: any = maintenanceAuthorization.workloadPrincipal;
      const traceContext: any = createTraceContext({
        traceId: context.traceId,
        transport: "maintenance-agent",
        operationId: operation.id,
        actor: {
          type: principal.subjectType,
          subjectId: principal.subjectId,
          userId: principal.subjectId,
          username: principal.subjectId,
          roleId: principal.profileId,
          agentId: principal.agentId,
          profileId: principal.profileId,
          scopes: uniqueStrings(maintenanceAuthorization.grant?.scopes || [])
        }
      });
      const request: Record<string, any> = {
        method: requestInfo.method,
        url: requestInfo.url.pathname,
        headers: shouldConfirm
          ? { "x-meshrix-safety-confirm": "true", "x-meshrix-confirm": "true" }
          : {},
        socket: { remoteAddress: "maintenance-agent" }
      };
      request.__meshrixMaintenanceWorkloadAuthorization = Object.freeze({
        protocolVersion: maintenanceAuthorization.binding.protocolVersion,
        grantId: maintenanceAuthorization.binding.grant.grantId,
        grantPolicyRevision: maintenanceAuthorization.binding.grant.policyRevision,
        governancePolicyRevision: maintenanceAuthorization.binding.policy.governanceRevision,
        expiresAt: maintenanceAuthorization.binding.expiresAt
      });
      setTraceContextOnRequest(request, traceContext);
      const captured: any = createCapturedResponse();
      const actor: any = traceContext.actor;
      try {
        await runWithAbortableTimeout(
          (signal?: any) : any => operationDispatcher({
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
            revalidateAuthorization: async () : Promise<any> => {
              if (typeof revalidateMaintenanceAuthorization !== "function") {
                return {
                  ok: false,
                  status: 503,
                  reasonCode: "maintenance_execution_revalidator_missing"
                };
              }
              try {
                const current: any = await revalidateMaintenanceAuthorization(
                  maintenanceAuthorization.binding,
                  {
                    requiredScope: "maintenance:run",
                    planHash: maintenanceAuthorization.binding.planHash
                  }
                );
                return {
                  ok: current?.ok === true,
                  grantRef: current?.binding?.grant?.grantId || "",
                  grant: current?.grant || null,
                  policyRevision: current?.binding?.policy?.governanceRevision || 0,
                  authorizationDecision: {
                    allowed: current?.ok === true,
                    decisionId: current?.binding?.policy?.decisionId || "",
                    reasonCode: current?.ok === true
                      ? "maintenance_authorization_current"
                      : "maintenance_authorization_denied"
                  }
                };
              } catch (error: any) {
                return {
                  ok: false,
                  status: 403,
                  reasonCode: error?.code || "maintenance_authorization_denied"
                };
              }
            },
            operationAuditStore,
            operationProofSubstrate,
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
      } catch (error: any) {
        logger?.error?.("maintenance.agent.tool.dispatch_failed", {
          toolId,
          operationId: operation.id,
          traceId: traceContext.traceId,
          error: summarizeError(error)
        });
        throw error;
      }
      const payload: any = parseCapturedJson(captured);
      if ((captured.statusCode || 200) >= 400) {
        throw new Error(payload?.error || payload?.message || `维护工具失败：${toolId}`);
      }
      return payload?.result !== undefined ? payload.result : payload;
    }
  };
}
