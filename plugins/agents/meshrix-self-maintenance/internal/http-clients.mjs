import { MAX_RESPONSE_BYTES } from "./constants.mjs";

const CLIENT_ERROR = Symbol("self-maintenance-client-error");

function clientError(code, details = {}) {
  return Object.assign(new Error(code), { code, [CLIENT_ERROR]: true }, details);
}

async function cancelBody(body) {
  try {
    await body?.cancel();
  } catch {
    // The request owner is already disposing of this response.
  }
}

async function readBoundedJson(response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES) {
    await cancelBody(response.body);
    throw clientError("response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw clientError("response_too_large");
      chunks.push(value);
    }
    const text = Buffer.concat(chunks.map((entry) => Buffer.from(entry)), total).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      throw clientError("external_response_invalid");
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error?.[CLIENT_ERROR]) throw error;
    throw clientError("external_response_invalid");
  } finally {
    reader.releaseLock();
  }
}

async function postJson(fetchImpl, endpoint, credential, pathname, body, signal, idempotencyKey) {
  const response = await fetchImpl(`${endpoint}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential.token}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal
  });
  if (!response.ok) {
    await cancelBody(response.body);
    throw clientError("external_request_rejected", { status: response.status });
  }
  return readBoundedJson(response);
}

export class DirectModelGatewayClient {
  constructor({ endpoint, credentialStore, credentialRef, fetchImpl }) {
    if (typeof fetchImpl !== "function") throw new TypeError("http_client_fetch_required");
    this.endpoint = endpoint;
    this.credentialStore = credentialStore;
    this.credentialRef = credentialRef;
    this.fetchImpl = fetchImpl;
  }

  async propose(request, signal) {
    const credential = await this.credentialStore.resolve(this.credentialRef);
    const payload = await postJson(this.fetchImpl, this.endpoint, credential, "/v1/chat/completions", {
      model: request.strategyKind,
      messages: [{ role: "user", content: JSON.stringify({
        targetRef: request.targetRef,
        runbookId: request.runbookId,
        operationIds: request.operationIds
      }) }],
      stream: false
    }, signal, request.runId);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length > MAX_RESPONSE_BYTES) {
      throw clientError("model_proposal_invalid");
    }
    try {
      return JSON.parse(content);
    } catch {
      throw clientError("model_proposal_invalid");
    }
  }
}

export class GovernedMeshrixOperationClient {
  constructor({ endpoint, credentialStore, credentialRef, fetchImpl }) {
    if (typeof fetchImpl !== "function") throw new TypeError("http_client_fetch_required");
    this.endpoint = endpoint;
    this.credentialStore = credentialStore;
    this.credentialRef = credentialRef;
    this.fetchImpl = fetchImpl;
  }

  async execute(proposal, runId, operationIndex = 0, signal) {
    const credential = await this.credentialStore.resolve(this.credentialRef);
    const idempotencyKey = `${runId}:${operationIndex}`;
    return postJson(this.fetchImpl, this.endpoint, credential, "/api/operation-permission/v1/execute", {
      schemaVersion: "v0.0.1:schema:definition-1",
      toolId: proposal.operationId,
      input: proposal.input,
      context: {
        resourceRef: proposal.resourceRef,
        workspaceId: proposal.workspaceId,
        idempotencyKey
      }
    }, signal, idempotencyKey);
  }
}
