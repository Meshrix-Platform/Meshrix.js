import crypto from "node:crypto";

import {
  codingGithubError,
  plainObject,
  projectExternalServiceResponse
} from "./contracts.mjs";

const MAX_COMPLETED_IDEMPOTENCY = 128;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestDigest(operationId, idempotencyKey) {
  return crypto.createHash("sha256").update(`${operationId}\0${idempotencyKey}`).digest("hex");
}

function boundedRemember(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_COMPLETED_IDEMPOTENCY) cache.delete(cache.keys().next().value);
}

function safeHostFailure(error, signal) {
  if (error?.code?.startsWith?.("coding_github_")) return error;
  if (signal?.aborted) return codingGithubError("coding_github_external_service_cancelled", 499);
  if (error?.status === 504) return codingGithubError("coding_github_external_service_timeout", 504);
  if (error?.status === 499) return codingGithubError("coding_github_external_service_cancelled", 499);
  if (error?.status === 429) return codingGithubError("coding_github_external_service_rate_limited", 429);
  if (error?.status === 403) return codingGithubError("coding_github_external_service_denied", 403);
  if (error?.status === 503) return codingGithubError("coding_github_external_service_unavailable", 503);
  return codingGithubError("coding_github_external_service_failed", 502);
}

export function createExternalServiceClient({ serviceRefs, timeoutMs }) {
  if (!plainObject(serviceRefs) || !serviceRefs.rest || !serviceRefs.mcp) {
    throw new TypeError("Coding GitHub requires explicit external service references.");
  }
  if (!plainObject(timeoutMs) || !Number.isInteger(timeoutMs.rest) || !Number.isInteger(timeoutMs.mcp)) {
    throw new TypeError("Coding GitHub requires explicit external service timeouts.");
  }

  const activeTasks = new Set();
  const inFlightByIdempotency = new Map();
  const completedByIdempotency = new Map();
  let accepting = true;

  function serviceBindingFor(operationId) {
    return operationId.startsWith("github.mcp.")
      ? Object.freeze({ serviceRef: serviceRefs.mcp, timeoutMs: timeoutMs.mcp })
      : Object.freeze({ serviceRef: serviceRefs.rest, timeoutMs: timeoutMs.rest });
  }

  async function invokeHost({ operation, input, host, signal }) {
    if (!accepting) throw codingGithubError("coding_github_runtime_closed", 503);
    if (!host?.externalService || typeof host.externalService.request !== "function") {
      throw codingGithubError("coding_github_external_service_unavailable", 503);
    }

    const idempotencyKey = operation.readOnly ? "" : String(input.idempotencyKey || "");
    if (!operation.readOnly && !idempotencyKey) throw codingGithubError("coding_github_idempotency_required");
    const idempotencyDigest = idempotencyKey ? requestDigest(operation.id, idempotencyKey) : "";
    const binding = serviceBindingFor(operation.id);
    const callerInput = Object.fromEntries(
      Object.entries(input).filter(([field]) => field !== "idempotencyKey")
    );
    const requestInput = Object.freeze({
      ...callerInput,
      ...(operation.id === "github.mcp.tools.list" ? { protocolMethod: "tools/list" } : {}),
      ...(operation.id === "github.mcp.tools.call" ? { protocolMethod: "tools/call" } : {})
    });
    const inputDigest = stableExternalRequestDigest(requestInput);
    if (idempotencyDigest && completedByIdempotency.has(idempotencyDigest)) {
      const cached = completedByIdempotency.get(idempotencyDigest);
      if (cached.inputDigest !== inputDigest) throw codingGithubError("coding_github_idempotency_conflict", 409);
      boundedRemember(completedByIdempotency, idempotencyDigest, cached);
      return cached.response;
    }
    if (idempotencyDigest && inFlightByIdempotency.has(idempotencyDigest)) {
      const pending = inFlightByIdempotency.get(idempotencyDigest);
      if (pending.inputDigest !== inputDigest) throw codingGithubError("coding_github_idempotency_conflict", 409);
      return pending.promise;
    }
    const task = (async () => {
      try {
        const request = Object.freeze({
          serviceRef: binding.serviceRef,
          operationRef: operation.id,
          input: requestInput,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          timeoutMs: binding.timeoutMs
        });
        const response = await host.externalService.request(
          request,
          Object.freeze({ signal })
        );
        const projected = projectExternalServiceResponse(response);
        if (idempotencyDigest) boundedRemember(completedByIdempotency, idempotencyDigest, Object.freeze({
          inputDigest,
          response: projected
        }));
        return projected;
      } catch (error) {
        throw safeHostFailure(error, signal);
      }
    })();
    activeTasks.add(task);
    if (idempotencyDigest) inFlightByIdempotency.set(idempotencyDigest, Object.freeze({ inputDigest, promise: task }));
    task.finally(() => {
      activeTasks.delete(task);
      if (idempotencyDigest && inFlightByIdempotency.get(idempotencyDigest)?.promise === task) {
        inFlightByIdempotency.delete(idempotencyDigest);
      }
    }).catch(() => {});
    return task;
  }

  return Object.freeze({
    request: invokeHost,
    isAccepting() {
      return accepting;
    },
    stats() {
      return Object.freeze({
        active: activeTasks.size,
        idempotencyInFlight: inFlightByIdempotency.size,
        idempotencyCompleted: completedByIdempotency.size
      });
    },
    async close() {
      if (!accepting) return Object.freeze({ ok: true, alreadyClosed: true });
      accepting = false;
      await Promise.allSettled([...activeTasks]);
      inFlightByIdempotency.clear();
      completedByIdempotency.clear();
      return Object.freeze({ ok: true, alreadyClosed: false });
    }
  });
}

export function stableExternalRequestDigest(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}
