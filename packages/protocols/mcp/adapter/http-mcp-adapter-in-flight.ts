import { createHash } from "node:crypto";

import {
  MCP_PROXY_SESSION_HEADER_LOWER,
  normalizeMcpProxySessionId
} from "#meshrix/contracts/mcp-catalog-delivery";
import { jsonRpcError } from "./http-mcp-adapter-response.ts";
import { mcpAuthorizationId } from "./http-mcp-adapter-session.ts";

const DEFAULT_MAX_IN_FLIGHT: any = 1_024;
const DEFAULT_MAX_IN_FLIGHT_PER_SCOPE: any = 64;
const MAX_SCOPE_PART_BYTES: any = 1_024;
const MAX_REQUEST_ID_BYTES: any = 256;

const registryByOwner: any = new WeakMap<object, any>();

export function isMcpCancellationNotification(message?: any) : any {
  return message?.method === "notifications/cancelled" &&
    !Object.prototype.hasOwnProperty.call(message || {}, "id");
}

export function isProtectedMcpMessage(message?: any) : any {
  const method: any = String(message?.method || "");
  return isMcpCancellationNotification(message) || (
    Boolean(method) &&
    !method.startsWith("notifications/") &&
    method !== "initialize" &&
    method !== "ping"
  );
}

function abortError(message?: any) : any {
  const error: any = new Error(message);
  error.name = "AbortError";
  return error;
}

function positiveInteger(value?: any, fallback?: any) : any {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function boundedString(value?: any, maxBytes?: any) : any {
  const normalized: any = String(value || "").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maxBytes) {
    return "";
  }
  return normalized;
}

function headerValue(request?: any, name?: any) : any {
  const headers: any = request?.headers || {};
  const lowerName: any = String(name || "").toLowerCase();
  const raw: any = headers[lowerName] ?? (Object.entries(headers) as [string, any][]).find(
    ([headerName]: any[]) : any => String(headerName || "").toLowerCase() === lowerName
  )?.[1];
  if (Array.isArray(raw)) {
    return raw.length === 1 ? raw[0] : "";
  }
  return raw;
}

function cancellationScopeFingerprint({ authenticatedGrant, request }: Record<string, any>) : any {
  const grantId: any = boundedString(mcpAuthorizationId(authenticatedGrant), MAX_SCOPE_PART_BYTES);
  if (!grantId) {
    return "";
  }
  const verifiedClient: any = request?.__meshrixProcessIdentity?.client ||
    request?.__meshrixProcessIdentity?.actor ||
    authenticatedGrant?.processIdentity?.client ||
    authenticatedGrant?.client ||
    {};
  const grantMetadata: any = authenticatedGrant?.grant?.metadata &&
    typeof authenticatedGrant.grant.metadata === "object" &&
    !Array.isArray(authenticatedGrant.grant.metadata)
    ? authenticatedGrant.grant.metadata
    : {};
  const clientId: any = boundedString(
    verifiedClient.clientId || verifiedClient.subjectId || grantMetadata.clientId,
    MAX_SCOPE_PART_BYTES
  );
  const packageId: any = boundedString(verifiedClient.packageId, MAX_SCOPE_PART_BYTES);
  const processKeyId: any = boundedString(verifiedClient.processKeyId, MAX_SCOPE_PART_BYTES);
  const rawSessionId: any = headerValue(request, "mcp-session-id");
  const hasSessionId: any = rawSessionId !== undefined && rawSessionId !== null && String(rawSessionId).trim() !== "";
  const sessionId: any = hasSessionId ? boundedString(rawSessionId, MAX_SCOPE_PART_BYTES) : "";
  if (hasSessionId && !sessionId) {
    return "";
  }
  const rawProxySessionId: any = headerValue(request, MCP_PROXY_SESSION_HEADER_LOWER);
  const hasProxySessionId: any = rawProxySessionId !== undefined &&
    rawProxySessionId !== null &&
    String(rawProxySessionId).trim() !== "";
  const proxySessionId: any = hasProxySessionId
    ? normalizeMcpProxySessionId(rawProxySessionId)
    : "";
  if (hasProxySessionId && !proxySessionId) {
    return "";
  }
  return createHash("sha256")
    .update(`${Buffer.byteLength(grantId, "utf8")}:${grantId}`)
    .update(`:${Buffer.byteLength(clientId, "utf8")}:${clientId}`)
    .update(`:${Buffer.byteLength(packageId, "utf8")}:${packageId}`)
    .update(`:${Buffer.byteLength(processKeyId, "utf8")}:${processKeyId}`)
    .update(`:${Buffer.byteLength(sessionId, "utf8")}:${sessionId}`)
    .update(`:${Buffer.byteLength(proxySessionId, "utf8")}:${proxySessionId}`)
    .digest("base64url");
}

function requestIdKey(requestId?: any) : any {
  if (typeof requestId === "number") {
    return Number.isSafeInteger(requestId) ? `n:${requestId}` : "";
  }
  if (typeof requestId !== "string" || Buffer.byteLength(requestId, "utf8") > MAX_REQUEST_ID_BYTES) {
    return "";
  }
  return `s:${requestId}`;
}

function hasAbortSignal(signal?: any) : any {
  return Boolean(
    signal &&
    typeof signal === "object" &&
    typeof signal.aborted === "boolean" &&
    typeof signal.addEventListener === "function" &&
    typeof signal.removeEventListener === "function"
  );
}

export function createMcpInFlightRequestRegistry({
  maxInFlight = DEFAULT_MAX_IN_FLIGHT,
  maxInFlightPerScope = DEFAULT_MAX_IN_FLIGHT_PER_SCOPE
}: Record<string, any> = {}) : any {
  const entries: any = new Map<any, any>();
  const scopeCounts: any = new Map<any, any>();
  const totalLimit: any = positiveInteger(maxInFlight, DEFAULT_MAX_IN_FLIGHT);
  const scopeLimit: any = positiveInteger(maxInFlightPerScope, DEFAULT_MAX_IN_FLIGHT_PER_SCOPE);

  function begin({ authenticatedGrant, request, requestId, parentSignal = null }: Record<string, any> = {}) : any {
    const scopeKey: any = cancellationScopeFingerprint({ authenticatedGrant, request });
    const idKey: any = requestIdKey(requestId);
    if (!scopeKey || !idKey) {
      return { ok: false, reason: "invalid_scope_or_request_id" };
    }
    const key: any = `${scopeKey}:${idKey}`;
    if (entries.has(key)) {
      return { ok: false, reason: "duplicate_request_id" };
    }
    if (entries.size >= totalLimit || (scopeCounts.get(scopeKey) || 0) >= scopeLimit) {
      return { ok: false, reason: "capacity_exceeded" };
    }

    const controller: any = new AbortController();
    const entry: Record<string, any> = {
      controller,
      cancelled: false,
      completed: false,
      detachParent: null,
      key,
      scopeKey
    };
    if (hasAbortSignal(parentSignal)) {
      const abortFromParent: any = () : any => {
        if (!controller.signal.aborted) {
          controller.abort(abortError("MCP request ended."));
        }
      };
      if (parentSignal.aborted) {
        abortFromParent();
      } else {
        parentSignal.addEventListener("abort", abortFromParent, { once: true });
        entry.detachParent = () : any => parentSignal.removeEventListener("abort", abortFromParent);
      }
    }
    entries.set(key, entry);
    scopeCounts.set(scopeKey, (scopeCounts.get(scopeKey) || 0) + 1);

    return {
      ok: true,
      signal: controller.signal,
      wasCancelled: () : any => entry.cancelled,
      complete() : any {
        if (entry.completed) {
          return;
        }
        entry.completed = true;
        entry.detachParent?.();
        if (entries.get(key) === entry) {
          entries.delete(key);
          const remaining: any = (scopeCounts.get(scopeKey) || 1) - 1;
          if (remaining > 0) {
            scopeCounts.set(scopeKey, remaining);
          } else {
            scopeCounts.delete(scopeKey);
          }
        }
      }
    };
  }

  function cancel({ authenticatedGrant, request, requestId }: Record<string, any> = {}) : any {
    const scopeKey: any = cancellationScopeFingerprint({ authenticatedGrant, request });
    const idKey: any = requestIdKey(requestId);
    if (!scopeKey || !idKey) {
      return false;
    }
    const entry: any = entries.get(`${scopeKey}:${idKey}`);
    if (!entry || entry.completed) {
      return false;
    }
    entry.cancelled = true;
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(abortError("MCP request cancelled."));
    }
    return true;
  }

  function close() : any {
    for (const entry of entries.values()) {
      entry.detachParent?.();
      entry.completed = true;
      if (!entry.controller.signal.aborted) {
        entry.controller.abort(abortError("MCP transport closed."));
      }
    }
    entries.clear();
    scopeCounts.clear();
  }

  return Object.freeze({
    begin,
    cancel,
    close,
    snapshot: () : any => ({
      inFlight: entries.size,
      activeScopes: scopeCounts.size,
      maxInFlight: totalLimit,
      maxInFlightPerScope: scopeLimit
    })
  });
}

export function mcpInFlightRequestRegistryFor(owner?: any) : any {
  if ((typeof owner !== "object" && typeof owner !== "function") || owner === null) {
    throw new TypeError("MCP in-flight registry owner must be an object.");
  }
  let registry: any = registryByOwner.get(owner);
  if (!registry) {
    registry = createMcpInFlightRequestRegistry();
    registryByOwner.set(owner, registry);
  }
  return registry;
}

export async function dispatchMcpMessageWithCancellation({
  message,
  request,
  authenticatedGrant,
  registry,
  parentSignal = null,
  execute
}: Record<string, any> = {}) : Promise<any> {
  if (isMcpCancellationNotification(message)) {
    if (authenticatedGrant?.ok) {
      registry.cancel({
        authenticatedGrant,
        request,
        requestId: message?.params?.requestId
      });
    }
    return null;
  }

  let registration: any = null;
  if (authenticatedGrant?.ok && isProtectedMcpMessage(message)) {
    registration = registry.begin({
      authenticatedGrant,
      request,
      requestId: message?.id,
      parentSignal
    });
    if (!registration.ok) {
      const capacityExceeded: any = registration.reason === "capacity_exceeded";
      return jsonRpcError(
        message?.id,
        capacityExceeded ? -32000 : -32600,
        capacityExceeded
          ? "MCP in-flight request capacity is exhausted."
          : "MCP request id is already active or cannot be correlated safely.",
        {
          code: capacityExceeded
            ? "mcp_in_flight_capacity_exceeded"
            : "mcp_duplicate_or_invalid_request_id"
        }
      );
    }
  }

  let result: any;
  let thrown: any = null;
  try {
    result = await execute(registration?.signal || parentSignal);
  } catch (error: any) {
    thrown = error;
  }
  const cancelled: any = registration?.wasCancelled() === true;
  registration?.complete();
  if (cancelled) {
    return null;
  }
  if (thrown) {
    throw thrown;
  }
  return result;
}
