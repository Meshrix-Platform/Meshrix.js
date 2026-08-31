import crypto from "node:crypto";

const HOST_CONTEXT_SCHEMA = "v0.0.1:skill-hub:host-context-1";
const HOST_OWNED_INPUT_FIELDS = new Set(["actor", "actor-id", "actorId", "tenantRef"]);

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

function sha256Ref(namespace, value) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`Skill Hub ${namespace} is required.`);
  return `sha256:${crypto.createHash("sha256").update(`${namespace}\0${normalized}`).digest("hex")}`;
}

function sandboxOutcome(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new TypeError("Skill Hub sandbox outcome is required.");
  }
  return Object.freeze({
    runRef: sha256Ref("sandbox-run", receipt.runId),
    workloadKind: String(receipt.workloadKind || "").trim(),
    status: String(receipt.status || "").trim(),
    artifactDigest: String(receipt.artifactDigest || "").trim(),
    inputDigests: Object.freeze((Array.isArray(receipt.inputDigests) ? receipt.inputDigests : []).map(String)),
    policyDigest: String(receipt.policyDigest || "").trim(),
    cleanupState: String(receipt.cleanupState || "").trim(),
    outputDisposition: String(receipt.outputDisposition || "").trim(),
    reasonCode: String(receipt.reasonCode || "").trim(),
    failureStage: String(receipt.failureStage || "").trim(),
    createdAt: String(receipt.createdAt || "").trim()
  });
}

function permissionGrantOutcome(receipt) {
  if (receipt?.ok !== true) throw new TypeError("Skill Hub permission grant outcome is required.");
  return Object.freeze({
    recorded: true,
    receiptRef: sha256Ref("operation-permission-grant", receipt.receiptId)
  });
}

export function createSkillHubExternalServiceClient({ serviceRef, timeoutMs }) {
  let accepting = true;
  const active = new Set();

  async function request({
    operation,
    input = {},
    signal = null,
    host = {},
    phase = "execute",
    receipt = undefined,
    operationPermissionReceipt = undefined
  }) {
    if (!accepting || typeof host.externalService?.request !== "function") {
      return responseFailure("skill_hub_external_service_unavailable", 503);
    }
    const businessInput = Object.fromEntries(Object.entries(input).filter(([field]) =>
      field !== "meshrixContext" && !field.startsWith("__") && !HOST_OWNED_INPUT_FIELDS.has(field)
    ));
    const meshrixContext = Object.freeze({
      schemaVersion: HOST_CONTEXT_SCHEMA,
      phase,
      ...(receipt ? { sandboxOutcome: sandboxOutcome(receipt) } : {}),
      ...(operationPermissionReceipt
        ? { permissionGrantOutcome: permissionGrantOutcome(operationPermissionReceipt) }
        : {})
    });
    const requestInput = Object.freeze({ ...businessInput, meshrixContext });
    const idempotencyKey = `skill-hub:${crypto.createHash("sha256").update(canonicalJson({
      operationId: operation.id,
      phase,
      input: requestInput
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
