import { createHash } from "node:crypto";

import {
  MCP_PROXY_SESSION_HEADER_LOWER,
  normalizeMcpProxySessionId
} from "#meshrix/contracts/mcp-catalog-delivery";
import { jsonRpcError } from "./http-mcp-adapter-response.mjs";

const DEFAULT_MAX_IN_FLIGHT = 1_024;
const DEFAULT_MAX_IN_FLIGHT_PER_SCOPE = 64;
const MAX_SCOPE_PART_BYTES = 1_024;
const MAX_REQUEST_ID_BYTES = 256;

const registryByOwner = new WeakMap();

export function isMcpCancellationNotification(message) {
  return message?.method === "notifications/cancelled" &&
    !Object.prototype.hasOwnProperty.call(message || {}, "id");
}

export function isProtectedMcpMessage(message) {
  const method = String(message?.method || "");
  return isMcpCancellationNotification(message) || (
    Boolean(method) &&
    !method.startsWith("notifications/") &&
    method !== "initialize" &&
    method !== "ping"
  );
}

function abortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function boundedString(value, maxBytes) {
  const normalized = String(value || "").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maxBytes) {
    return "";
  }
  return normalized;
}

function headerValue(request, name) {
  const headers = request?.headers || {};
  const lowerName = String(name || "").toLowerCase();
  const raw = headers[lowerName] ?? Object.entries(headers).find(
    ([headerName]) => String(headerName || "").toLowerCase() === lowerName
  )?.[1];
  if (Array.isArray(raw)) {
    return raw.length === 1 ? raw[0] : "";
  }
  return raw;
}

function cancellationScopeFingerprint({ authenticatedGrant, request }) {
  const grantId = boundedString(authenticatedGrant?.grant?.id, MAX_SCOPE_PART_BYTES);
  if (!grantId) {
    return "";
  }
  const verifiedClient = request?.__licoProcessIdentity?.client ||
    request?.__licoProcessIdentity?.actor ||
    authenticatedGrant?.processIdentity?.client ||
    authenticatedGrant?.client ||
    {};
  const grantMetadata = authenticatedGrant?.grant?.metadata &&
    typeof authenticatedGrant.grant.metadata === "object" &&
    !Array.isArray(authenticatedGrant.grant.metadata)
    ? authenticatedGrant.grant.metadata
    : {};
  const clientId = boundedString(
    verifiedClient.clientId || verifiedClient.subjectId || grantMetadata.clientId,
    MAX_SCOPE_PART_BYTES
  );
  const packageId = boundedString(verifiedClient.packageId, MAX_SCOPE_PART_BYTES);
  const processKeyId = boundedString(verifiedClient.processKeyId, MAX_SCOPE_PART_BYTES);
  const rawSessionId = headerValue(request, "mcp-session-id");
  const hasSessionId = rawSessionId !== undefined && rawSessionId !== null && String(rawSessionId).trim() !== "";
  const sessionId = hasSessionId ? boundedString(rawSessionId, MAX_SCOPE_PART_BYTES) : "";
  if (hasSessionId && !sessionId) {
    return "";
  }
  const rawProxySessionId = headerValue(request, MCP_PROXY_SESSION_HEADER_LOWER);
  const hasProxySessionId = rawProxySessionId !== undefined &&
    rawProxySessionId !== null &&
    String(rawProxySessionId).trim() !== "";
  const proxySessionId = hasProxySessionId
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

function requestIdKey(requestId) {
  if (typeof requestId === "number") {
    return Number.isSafeInteger(requestId) ? `n:${requestId}` : "";
  }
  if (typeof requestId !== "string" || Buffer.byteLength(requestId, "utf8") > MAX_REQUEST_ID_BYTES) {
    return "";
  }
  return `s:${requestId}`;
}

function hasAbortSignal(signal) {
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
} = {}) {
  const entries = new Map();
  const scopeCounts = new Map();
  const totalLimit = positiveInteger(maxInFlight, DEFAULT_MAX_IN_FLIGHT);
  const scopeLimit = positiveInteger(maxInFlightPerScope, DEFAULT_MAX_IN_FLIGHT_PER_SCOPE);

  function begin({ authenticatedGrant, request, requestId, parentSignal = null } = {}) {
    const scopeKey = cancellationScopeFingerprint({ authenticatedGrant, request });
    const idKey = requestIdKey(requestId);
    if (!scopeKey || !idKey) {
      return { ok: false, reason: "invalid_scope_or_request_id" };
    }
    const key = `${scopeKey}:${idKey}`;
    if (entries.has(key)) {
      return { ok: false, reason: "duplicate_request_id" };
    }
    if (entries.size >= totalLimit || (scopeCounts.get(scopeKey) || 0) >= scopeLimit) {
      return { ok: false, reason: "capacity_exceeded" };
    }

    const controller = new AbortController();
    const entry = {
      controller,
      cancelled: false,
      completed: false,
      detachParent: null,
      key,
      scopeKey
    };
    if (hasAbortSignal(parentSignal)) {
      const abortFromParent = () => {
        if (!controller.signal.aborted) {
          controller.abort(abortError("MCP request ended."));
        }
      };
      if (parentSignal.aborted) {
        abortFromParent();
      } else {
        parentSignal.addEventListener("abort", abortFromParent, { once: true });
        entry.detachParent = () => parentSignal.removeEventListener("abort", abortFromParent);
      }
    }
    entries.set(key, entry);
    scopeCounts.set(scopeKey, (scopeCounts.get(scopeKey) || 0) + 1);

    return {
      ok: true,
      signal: controller.signal,
      wasCancelled: () => entry.cancelled,
      complete() {
        if (entry.completed) {
          return;
        }
        entry.completed = true;
        entry.detachParent?.();
        if (entries.get(key) === entry) {
          entries.delete(key);
          const remaining = (scopeCounts.get(scopeKey) || 1) - 1;
          if (remaining > 0) {
            scopeCounts.set(scopeKey, remaining);
          } else {
            scopeCounts.delete(scopeKey);
          }
        }
      }
    };
  }

  function cancel({ authenticatedGrant, request, requestId } = {}) {
    const scopeKey = cancellationScopeFingerprint({ authenticatedGrant, request });
    const idKey = requestIdKey(requestId);
    if (!scopeKey || !idKey) {
      return false;
    }
    const entry = entries.get(`${scopeKey}:${idKey}`);
    if (!entry || entry.completed) {
      return false;
    }
    entry.cancelled = true;
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(abortError("MCP request cancelled."));
    }
    return true;
  }

  function close() {
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
    snapshot: () => ({
      inFlight: entries.size,
      activeScopes: scopeCounts.size,
      maxInFlight: totalLimit,
      maxInFlightPerScope: scopeLimit
    })
  });
}

export function mcpInFlightRequestRegistryFor(owner) {
  if ((typeof owner !== "object" && typeof owner !== "function") || owner === null) {
    throw new TypeError("MCP in-flight registry owner must be an object.");
  }
  let registry = registryByOwner.get(owner);
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
} = {}) {
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

  let registration = null;
  if (authenticatedGrant?.ok && isProtectedMcpMessage(message)) {
    registration = registry.begin({
      authenticatedGrant,
      request,
      requestId: message?.id,
      parentSignal
    });
    if (!registration.ok) {
      const capacityExceeded = registration.reason === "capacity_exceeded";
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

  let result;
  let thrown = null;
  try {
    result = await execute(registration?.signal || parentSignal);
  } catch (error) {
    thrown = error;
  }
  const cancelled = registration?.wasCancelled() === true;
  registration?.complete();
  if (cancelled) {
    return null;
  }
  if (thrown) {
    throw thrown;
  }
  return result;
}
