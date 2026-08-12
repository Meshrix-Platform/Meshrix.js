import crypto from "node:crypto";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function responseFailure(code, statusCode = 502) {
  return Object.freeze({
    statusCode,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: Object.freeze({ ok: false, error: Object.freeze({ code }) })
  });
}

function applicationResponse(response) {
  if (response?.ok !== true || !response.data || typeof response.data !== "object") {
    return responseFailure("skill_hub_external_service_failed", Number(response?.status || 502));
  }
  const statusCode = Number(response.data.statusCode);
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599 ||
      !response.data.body || typeof response.data.body !== "object") {
    return responseFailure("skill_hub_external_service_response_invalid");
  }
  return Object.freeze({
    statusCode,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: Object.freeze(response.data.body)
  });
}

export function createSkillHubExternalServiceClient({ serviceRef, timeoutMs }) {
  let accepting = true;
  const active = new Set();

  async function request({
    operation,
    input = {},
    call = {},
    signal = null,
    host = {},
    phase = "execute",
    receipt = undefined,
    operationPermissionReceipt = undefined
  }) {
    if (!accepting || typeof host.externalService?.request !== "function") {
      return responseFailure("skill_hub_external_service_unavailable", 503);
    }
    const metadata = Object.freeze({
      actorId: String(call.auth?.subjectRef || "anonymous"),
      actorKind: String(call.auth?.actorType || "plugin-operation"),
      tenantRef: String(call.auth?.tenantRef || input.workspaceId || input.workspace || "default"),
      authorized: call.governance?.authorized === true,
      current: call.governance?.current === true,
      phase,
      ...(receipt ? { receipt } : {}),
      ...(operationPermissionReceipt ? { operationPermissionReceipt } : {})
    });
    const requestInput = Object.freeze({ ...input, __meshrix: metadata });
    const idempotencyKey = `skill-hub:${crypto.createHash("sha256").update(canonicalJson({
      operationId: operation.id,
      phase,
      actorId: metadata.actorId,
      input
    })).digest("hex")}`;
    const task = (async () => {
      try {
        const response = await host.externalService.request({
          serviceRef,
          operationRef: operation.id,
          input: requestInput,
          idempotencyKey,
          timeoutMs
        }, { signal });
        return applicationResponse(response);
      } catch (error) {
        const status = signal?.aborted ? 499 : Number(error?.status || 502);
        const code = status === 499
          ? "skill_hub_external_service_cancelled"
          : status === 504
            ? "skill_hub_external_service_timeout"
            : status === 403
              ? "skill_hub_external_service_denied"
              : status === 429
                ? "skill_hub_external_service_rate_limited"
                : status === 503
                  ? "skill_hub_external_service_unavailable"
                  : "skill_hub_external_service_failed";
        return responseFailure(code, status >= 400 && status <= 599 ? status : 502);
      }
    })();
    active.add(task);
    task.finally(() => active.delete(task)).catch(() => {});
    return task;
  }

  return Object.freeze({
    request,
    isAccepting: () => accepting,
    async close() {
      if (!accepting) return Object.freeze({ ok: true, alreadyClosed: true });
      accepting = false;
      await Promise.allSettled([...active]);
      return Object.freeze({ ok: true, alreadyClosed: false });
    }
  });
}
