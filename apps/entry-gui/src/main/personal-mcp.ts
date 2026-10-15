import type { GuiLoopbackClient } from "../shared/loopback-client.ts";
import type { GuiIpcResult } from "../shared/ipc-contract.ts";

interface PersonalMcpOptions {
  readonly client: GuiLoopbackClient;
}

const TOOLS = Object.freeze([
  {
    name: "meshrix_list_destinations",
    description: "List paired Meshrix devices that can receive an Agent task. Use the returned destination handle exactly as provided.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "meshrix_discover_agents",
    description: "Discover the enrolled Agents available on one paired device.",
    inputSchema: {
      type: "object",
      properties: {
        destinationHandle: { type: "string", minLength: 1 },
        requestId: { type: "string", minLength: 2, maxLength: 128, description: "Optional stable identifier for retrying the same discovery request." }
      },
      required: ["destinationHandle"],
      additionalProperties: false
    }
  },
  {
    name: "meshrix_send_task",
    description: "Send a task to an enrolled Agent on a paired device. Generate one operationId for each new task; reuse that same value to retry an unknown response, then query task status before attempting another call. A disconnected route rejects new work without accepting it.",
    inputSchema: {
      type: "object",
      properties: {
        operationId: { type: "string", minLength: 8, maxLength: 128, description: "Stable caller-generated idempotency key for this task." },
        destinationHandle: { type: "string", minLength: 1 },
        targetAgentId: { type: "string", minLength: 1 },
        prompt: { type: "string", minLength: 1 }
      },
      required: ["operationId", "destinationHandle", "targetAgentId", "prompt"],
      additionalProperties: false
    }
  },
  {
    name: "meshrix_list_tasks",
    description: "List durable local Meshrix Agent task history, including the current transport and execution state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "meshrix_get_task",
      description: "Read one durable Meshrix task by its operationId. Completed results are returned from this profile's protected local application journal.",
    inputSchema: {
      type: "object",
      properties: { operationId: { type: "string", minLength: 1 } },
      required: ["operationId"],
      additionalProperties: false
    }
  },
  {
    name: "meshrix_cancel_task",
    description: "Request cancellation of a Meshrix Agent task. Cancellation may be pending if the remote device is unreachable; check task status for the final outcome.",
    inputSchema: {
      type: "object",
      properties: { operationId: { type: "string", minLength: 1 } },
      required: ["operationId"],
      additionalProperties: false
    }
  }
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function rpcResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = JSON.stringify(value ?? null, null, 2);
  const structuredContent = isRecord(value)
    ? value
    : Array.isArray(value)
      ? { items: value }
      : value === null || value === undefined
        ? { found: false }
        : { value };
  return {
    content: [{ type: "text", text }],
    structuredContent,
    ...(isError ? { isError: true } : {})
  };
}

function argsOf(body: Record<string, unknown>): Record<string, unknown> {
  const params = isRecord(body.params) ? body.params : {};
  return isRecord(params.arguments) ? params.arguments : {};
}

function operationIdOf(args: Record<string, unknown>): string {
  return typeof args.operationId === "string" ? args.operationId : "";
}

function unknownSubmission(operationId: string, cause: string): Record<string, unknown> {
  return {
    code: "operation_status_unknown",
    effectOutcome: "unknown",
    operationId,
    cause,
    instruction: "Query meshrix_get_task with this same operationId. Do not create a new operationId or submit another task until the recorded status is known."
  };
}

async function invoke<T>(client: GuiLoopbackClient, op: Parameters<GuiLoopbackClient["invoke"]>[0], args?: unknown): Promise<GuiIpcResult<T>> {
  return client.invoke<T>(op, args);
}

export function createPersonalApplicationMcpBridge(options: PersonalMcpOptions): {
  handle(body: unknown): Promise<Record<string, unknown> | undefined>;
} {
  return {
    async handle(body: unknown): Promise<Record<string, unknown> | undefined> {
      if (Array.isArray(body) || !isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
        return rpcError(isRecord(body) ? body.id : null, -32600, "Invalid JSON-RPC request.");
      }
      if (body.id === undefined) return undefined;
      const id = body.id;
      if (body.method === "initialize") {
        return rpcResult(id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "meshrix-personal-agent", version: "0.1.0" }
        });
      }
      if (body.method === "ping") return rpcResult(id, {});
      if (body.method === "tools/list") return rpcResult(id, { tools: TOOLS });
      if (body.method !== "tools/call") return rpcError(id, -32601, `Method not found: ${body.method}`);

      const params = isRecord(body.params) ? body.params : {};
      const name = typeof params.name === "string" ? params.name : "";
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return rpcError(id, -32602, "Unknown Meshrix tool.");
      const args = argsOf(body);

      if (name === "meshrix_send_task") {
        const operationId = operationIdOf(args);
        // A local owner check happens before the mutating request. If this fails, no task was sent.
        const owner = await invoke(options.client, "state.get");
        if (!owner.ok) return rpcError(id, -32000, "The Meshrix desktop owner is unavailable; no task was submitted. Reopen Meshrix, then retry with the same operationId.", {
          code: "meshrix_owner_unavailable",
          effectOutcome: "not_started",
          operationId
        });
        const submitted = await invoke(options.client, "application.submit", args);
        if (submitted.ok) return rpcResult(id, toolResult(submitted.value));
        if (submitted.error.effectOutcome === "not_started") {
          return rpcError(id, -32000, submitted.error.message, {
            code: submitted.error.code,
            effectOutcome: "not_started",
            operationId
          });
        }
        return rpcError(id, -32000, "The task submission reply was lost; its outcome is unknown.", unknownSubmission(operationId, submitted.error.code));
      }

      const map = {
        meshrix_list_destinations: ["application.destinations", undefined],
        meshrix_discover_agents: ["application.discover", {
          destinationHandle: args.destinationHandle,
          ...(typeof args.requestId === "string" ? { requestId: args.requestId } : {})
        }],
        meshrix_list_tasks: ["application.list", undefined],
        meshrix_get_task: ["application.get", { operationId: args.operationId }],
        meshrix_cancel_task: ["application.cancel", { operationId: args.operationId }]
      } as const;
      const [op, payload] = map[name as keyof typeof map];
      const result = await invoke(options.client, op, payload);
      if (!result.ok) {
        return rpcError(id, -32000, result.error.message, {
          code: result.error.code,
          ...(result.error.effectOutcome ? { effectOutcome: result.error.effectOutcome } : {}),
          ...(typeof args.operationId === "string" ? { operationId: args.operationId } : {})
        });
      }
      return rpcResult(id, toolResult(result.value));
    }
  };
}
