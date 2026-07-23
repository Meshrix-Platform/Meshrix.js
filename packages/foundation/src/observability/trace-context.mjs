import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const traceStorage = new AsyncLocalStorage();

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeActor(actor = {}) {
  const user = actor?.user || actor;
  if (!actor && !user) {
    return { type: "system", userId: "", username: "", roleId: "", scopes: [] };
  }
  return {
    type: actor?.type || (user?.userId ? "console-user" : "system"),
    userId: String(user?.userId || actor?.userId || ""),
    username: String(user?.username || actor?.username || ""),
    roleId: String(user?.roleId || actor?.roleId || ""),
    scopes: Array.isArray(user?.scopes || actor?.scopes) ? [...(user?.scopes || actor?.scopes)] : []
  };
}

export function createTraceContext(input = {}) {
  const parent = input.parent || getTraceContext() || {};
  const traceId = String(input.traceId || parent.traceId || randomId("trace"));
  const parentSpanId = String(
    input.parentSpanId ||
      input.parent_span_id ||
      parent.spanId ||
      parent.parentSpanId ||
      ""
  );
  return {
    traceId,
    requestId: String(input.requestId || parent.requestId || ""),
    spanId: String(input.spanId || randomId("span")),
    parentSpanId,
    transport: String(input.transport || parent.transport || "internal"),
    operationId: String(input.operationId || parent.operationId || ""),
    actor: normalizeActor(input.actor || parent.actor || { type: "system" }),
    createdAt: input.createdAt || new Date().toISOString()
  };
}

export function childTraceContext(input = {}) {
  const parent = input.parent || getTraceContext() || {};
  return createTraceContext({
    ...input,
    traceId: input.traceId || parent.traceId,
    requestId: input.requestId || parent.requestId,
    parentSpanId: input.parentSpanId || parent.spanId,
    actor: input.actor || parent.actor,
    transport: input.transport || parent.transport
  });
}

export function getTraceContext() {
  return traceStorage.getStore() || null;
}

export function runWithTraceContext(traceContext, callback) {
  return traceStorage.run(traceContext || createTraceContext(), callback);
}

export function traceContextFromRequest(request) {
  return request?.__licoTraceContext || getTraceContext() || null;
}

export function setTraceContextOnRequest(request, traceContext) {
  if (request) {
    request.__licoTraceContext = traceContext;
    request.__licoRequestId = traceContext?.requestId || request.__licoRequestId || "";
  }
  return traceContext;
}

export function traceDetails(traceContext = getTraceContext()) {
  const trace = traceContext || {};
  return {
    traceId: trace.traceId || "",
    requestId: trace.requestId || "",
    spanId: trace.spanId || "",
    parentSpanId: trace.parentSpanId || "",
    transport: trace.transport || "",
    operationId: trace.operationId || ""
  };
}
