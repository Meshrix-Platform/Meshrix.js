import type { CatalogDescriptor, CatalogPage, GatewayOutcome } from "@meshrix/contracts/gateway";
import { isEntryError } from "./errors.ts";
import type { EntryRelaySession } from "./entry-session.ts";

/**
 * Local MCP face.
 *
 * Speaks standard newline/HTTP JSON-RPC MCP on the local side and forwards
 * the negotiated work surface through the inner channel to the endpoint's
 * `dispatchInnerMessage` wire shape. The endpoint answers a
 * `GatewayOutcome | null`, which is projected faithfully into a JSON-RPC
 * result or error — including catalog paging, tool-result envelopes,
 * input-required continuations, and the closed failure vocabulary.
 *
 * `initialize`, `ping` and notifications are served locally; forwarded
 * methods never fabricate success when the endpoint is unreachable — they
 * answer with an explicit `endpoint_unreachable` error carrying
 * `effectOutcome: "not_started"`, and a dispatched-then-lost request answers
 * `operation_status_unknown` with `effectOutcome: "unknown"`.
 */

const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28"
]);
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

/** Local method → wire method when they differ. */
const FORWARDED_METHODS: Readonly<Record<string, string>> = Object.freeze({
  "tools/call": "tools/call",
  "resources/read": "resources/read",
  "prompts/get": "prompts/get",
  "prompts/complete": "prompts/complete",
  // Standard MCP completion method → the endpoint's prompts/complete mapping.
  "completion/complete": "prompts/complete",
  "tools/list": "tools/list",
  "resources/list": "resources/list",
  "prompts/list": "prompts/list"
});

const CATALOG_METHODS: Readonly<Record<string, { readonly kind: CatalogDescriptor["kind"]; readonly key: "tools" | "resources" | "prompts" }>> = Object.freeze({
  "tools/list": { kind: "tool", key: "tools" },
  "resources/list": { kind: "resource", key: "resources" },
  "prompts/list": { kind: "prompt", key: "prompts" }
});

export interface EntryMcpBridgeOptions {
  readonly session: Pick<EntryRelaySession, "acceptsNewWork" | "request">;
  readonly serverInfo?: Readonly<Record<string, unknown>>;
  readonly capabilities?: Readonly<Record<string, unknown>>;
}

export interface EntryMcpBridge {
  /** Handle one decoded JSON-RPC body; `undefined` means notification — no response. */
  handle(body: unknown): Promise<Record<string, unknown> | undefined>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
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

function isGatewayOutcome(value: unknown): value is GatewayOutcome {
  if (!isPlainRecord(value)) return false;
  if (value.kind === "complete") return Object.hasOwn(value, "value");
  if (value.kind === "input_required") return true;
  if (value.kind === "negotiated_extension") return typeof value.extension === "string";
  if (value.kind === "failure") {
    return typeof value.code === "string" && typeof value.message === "string"
      && typeof value.status === "number" && typeof value.effectOutcome === "string";
  }
  return false;
}

function projectCatalogItem(item: CatalogDescriptor, kind: CatalogDescriptor["kind"]): Record<string, unknown> {
  if (kind === "tool") {
    return {
      name: item.publicName,
      description: item.description,
      inputSchema: item.inputSchema,
      outputSchema: item.outputSchema,
      annotations: item.annotations,
      title: item.metadata?.title,
      _meta: item.metadata
    };
  }
  if (kind === "prompt") {
    return {
      name: item.publicName,
      description: item.description,
      arguments: item.metadata?.arguments,
      _meta: item.metadata
    };
  }
  return {
    uri: item.publicUri,
    name: item.publicName,
    description: item.description,
    _meta: item.metadata
  };
}

/**
 * `tools/call` is the one MCP method whose result is a tool-result envelope,
 * not a bare value — mirroring the platform adapter: a business value that is
 * already a tool result passes through; anything else is wrapped so standard
 * clients read `content`/`structuredContent`.
 */
function completeToolResult(result: Extract<GatewayOutcome, { readonly kind: "complete" }>): Record<string, unknown> {
  const value = result.value;
  const toolResult: Record<string, unknown> = isPlainRecord(value) && (Array.isArray(value.content) || Object.hasOwn(value, "structuredContent"))
    ? { ...value, ...(Array.isArray(value.content) ? {} : { content: [] }) }
    : {
        content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }],
        structuredContent: value
      };
  return {
    resultType: "complete",
    ...toolResult,
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result.requestState === undefined ? {} : { requestState: result.requestState }),
    // A result the kernel answered without executing tags how far the effect
    // got, so a peer never reads a pending approval as a completed one.
    ...(result.effectOutcome === undefined ? {} : { _meta: { ...(isPlainRecord(toolResult._meta) ? toolResult._meta : {}), "io.meshrix/effect-outcome": result.effectOutcome } })
  };
}

function projectOutcomeResult(outcome: Exclude<GatewayOutcome, { readonly kind: "failure" }>, method: string): Record<string, unknown> {
  const catalog = CATALOG_METHODS[method];
  if (catalog && outcome.kind === "complete" && isPlainRecord(outcome.value) && Array.isArray((outcome.value as unknown as CatalogPage).items)) {
    const page = outcome.value as unknown as CatalogPage;
    return {
      resultType: "complete",
      [catalog.key]: page.items.filter((item) => item.kind === catalog.kind).map((item) => projectCatalogItem(item, catalog.kind)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
    };
  }
  if (outcome.kind === "complete" && method === "resources/read" && isPlainRecord(outcome.value) && Array.isArray(outcome.value.contents)) {
    return { resultType: "complete", ...outcome.value };
  }
  if (outcome.kind === "complete" && method === "prompts/get" && isPlainRecord(outcome.value) && Array.isArray(outcome.value.messages)) {
    return { resultType: "complete", ...outcome.value };
  }
  if (outcome.kind === "complete" && method === "tools/call") return completeToolResult(outcome);
  if (outcome.kind === "complete") {
    return isPlainRecord(outcome.value)
      ? { resultType: "complete", ...outcome.value }
      : { resultType: "complete", value: outcome.value };
  }
  if (outcome.kind === "input_required") {
    return {
      resultType: "input_required",
      ...(outcome.inputRequests === undefined ? {} : { inputRequests: outcome.inputRequests }),
      ...(outcome.requestState === undefined ? {} : { requestState: outcome.requestState })
    };
  }
  return {
    resultType: outcome.extension,
    value: outcome.value,
    ...(outcome.requestState === undefined ? {} : { requestState: outcome.requestState })
  };
}

function projectOutcomeFailure(id: unknown, outcome: Extract<GatewayOutcome, { readonly kind: "failure" }>): Record<string, unknown> {
  const code = outcome.status === 401 ? -32001 : outcome.status === 403 ? -32003 : outcome.status === 404 ? -32004 : -32000;
  const peerCode = outcome.origin === "peer" && outcome.code === "upstream_jsonrpc_error" && typeof outcome.details?.errorCode === "number" && Number.isSafeInteger(outcome.details.errorCode)
    ? outcome.details.errorCode : code;
  return rpcError(id, peerCode, outcome.message, {
    code: outcome.code,
    effectOutcome: outcome.effectOutcome,
    ...(typeof outcome.details?.receiptId === "string" ? { receiptId: outcome.details.receiptId } : {})
  });
}

function operationIdFor(body: Record<string, unknown>): string {
  const params = isPlainRecord(body.params) ? body.params : {};
  return typeof params.operationKey === "string" ? params.operationKey : String(body.id);
}

/** Map a thrown channel/transport failure onto honest effect evidence. */
function projectDispatchError(id: unknown, error: unknown, operationId: string): Record<string, unknown> {
  if (isEntryError(error)) {
    if (error.effectOutcome === "not_started") {
      return rpcError(id, -32000, "The private endpoint is unreachable; the request was not dispatched.", {
        code: "endpoint_unreachable",
        cause: error.code,
        effectOutcome: "not_started",
        operationId
      });
    }
    // Dispatched (or indeterminate) then lost — honest doubt, never a retried
    // duplicate and never a fabricated success.
    return rpcError(id, -32000, "The request outcome is unknown; query the operation status before retrying.", {
      code: "operation_status_unknown",
      cause: error.code,
      effectOutcome: "unknown",
      operationId
    });
  }
  return rpcError(id, -32603, "The entry transport failed before the request settled.", {
    code: "entry_internal",
    effectOutcome: "unknown",
    operationId
  });
}

export function createEntryMcpBridge(options: EntryMcpBridgeOptions): EntryMcpBridge {
  const serverInfo = Object.freeze({ name: "meshrix-entry", version: "0.1.0", ...(options.serverInfo ?? {}) });
  const capabilities = Object.freeze({ tools: {}, resources: {}, prompts: {}, completions: {}, ...(options.capabilities ?? {}) });

  return {
    async handle(body: unknown): Promise<Record<string, unknown> | undefined> {
      if (Array.isArray(body)) {
        return rpcError(null, -32600, "Batch JSON-RPC requests are not supported on this endpoint.");
      }
      if (!isPlainRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
        return rpcError(null, -32600, "Invalid JSON-RPC request.");
      }
      const method = body.method;
      // Notifications (no id) are acknowledged silently — they carry no
      // response and never execute the forwarded work surface.
      if (body.id === undefined) return undefined;
      const id = body.id;

      if (method === "initialize") {
        const params = isPlainRecord(body.params) ? body.params : {};
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const negotiated = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
        return rpcResult(id, { protocolVersion: negotiated, capabilities, serverInfo });
      }
      if (method === "ping") return rpcResult(id, {});

      const wireMethod = FORWARDED_METHODS[method];
      if (wireMethod === undefined) {
        return rpcError(id, -32601, `Method not found: ${method}`);
      }
      if (!options.session.acceptsNewWork) {
        return rpcError(id, -32000, "The private endpoint is unreachable; new work is not queued.", {
          code: "endpoint_unreachable",
          effectOutcome: "not_started",
          operationId: operationIdFor(body)
        });
      }
      let outcome: unknown;
      try {
        // The client JSON-RPC request is forwarded verbatim except for the
        // canonical wire method name.
        outcome = await options.session.request({ ...body, method: wireMethod });
      } catch (error) {
        return projectDispatchError(id, error, operationIdFor(body));
      }
      if (outcome === null || outcome === undefined) {
        return rpcError(id, -32601, `Method not found at the endpoint: ${method}`);
      }
      if (!isGatewayOutcome(outcome)) {
        return rpcError(id, -32000, "The endpoint returned an unparseable outcome; the operation status is unknown.", {
          code: "operation_status_unknown",
          effectOutcome: "unknown",
          operationId: operationIdFor(body)
        });
      }
      if (outcome.kind === "failure") return projectOutcomeFailure(id, outcome);
      return rpcResult(id, projectOutcomeResult(outcome, method));
    }
  };
}
