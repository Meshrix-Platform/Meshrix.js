import { MAX_RESPONSE_BYTES } from "./constants.mjs";

async function readBoundedJson(response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("response_too_large");
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response_too_large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map((entry) => Buffer.from(entry)), total).toString("utf8"));
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
  const payload = await readBoundedJson(response);
  if (!response.ok) throw Object.assign(new Error("external_request_rejected"), { status: response.status });
  return payload;
}

export class DirectModelGatewayClient {
  constructor({ endpoint, credentialStore, credentialRef, fetchImpl = fetch }) {
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
    if (typeof content !== "string" || content.length > MAX_RESPONSE_BYTES) throw new Error("model_proposal_invalid");
    return JSON.parse(content);
  }
}

export class GovernedMeshrixOperationClient {
  constructor({ endpoint, credentialStore, credentialRef, fetchImpl = fetch }) {
    this.endpoint = endpoint;
    this.credentialStore = credentialStore;
    this.credentialRef = credentialRef;
    this.fetchImpl = fetchImpl;
  }

  async execute(proposal, runId, signal) {
    const credential = await this.credentialStore.resolve(this.credentialRef);
    return postJson(this.fetchImpl, this.endpoint, credential, "/api/operation-permission/v1/execute", {
      schemaVersion: "v0.0.1:schema:definition-1",
      toolId: proposal.operationId,
      input: proposal.input,
      context: {
        resourceRef: proposal.resourceRef,
        workspaceId: proposal.workspaceId,
        idempotencyKey: `${runId}:${proposal.operationId}`
      }
    }, signal, `${runId}:${proposal.operationId}`);
  }
}
