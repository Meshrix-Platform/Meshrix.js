import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SERVER_API_OPERATIONS } from "#meshrix/operation-registry";
import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.mjs";
import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import { authHeaders, installAuthenticatedFetch } from "./test-auth-helper.mjs";

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const payload = text.trim() ? JSON.parse(text) : {};
  assert.equal(response.ok, true, JSON.stringify(payload, null, 2));
  return payload;
}

async function rpc(server, auth, method, params = {}, id = method) {
  const payload = await fetchJson(`${server.url}/api/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(auth, { method: "POST" })
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    })
  });
  assert.equal(payload.error, undefined, JSON.stringify(payload.error || {}, null, 2));
  return payload.result;
}

const operationsById = new Map(SERVER_API_OPERATIONS.map((operation) => [operation.id, operation]));
for (const operationId of ["workspace.proposal.create", "workspace.proposal.apply"]) {
  assert.ok(operationsById.has(operationId), `${operationId} must be registered`);
}

const catalog = createToolCatalog({ operations: SERVER_API_OPERATIONS });
for (const operationId of ["workspace.proposal.create", "workspace.proposal.apply"]) {
  assert.ok(catalog.tools.some((tool) => tool.operationId === operationId), `${operationId} must be exposed as a tool`);
}

const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-workspace-proposal-protocol-"));
const server = await startHttpServer({
  userDataPath,
  distPath: "",
  port: 0,
  runtimeOptions: {
    profile: "minimal"
  }
});

try {
  const auth = await installAuthenticatedFetch(server);
  const createdWorkspace = await rpc(server, auth, "agent_workspaces.create", {
    title: "Workspace proposal protocol verification",
    objective: "Verify proposal create/apply through protocol facade"
  });
  const workspaceId = createdWorkspace.workspace.workspaceId;

  const createdProposal = await rpc(server, auth, "workspace.proposal.create", {
    workspaceId,
    runId: "verify-run",
    title: "Publish verified decision",
    summary: "Proposal must stay review-gated before becoming a decision.",
    evidenceRefs: ["evidence://proposal/1"],
    proposal: {
      proposedAction: "publish_decision",
      decisionPayload: {
        releaseGate: "verified"
      }
    }
  });
  assert.equal(createdProposal.ok, true);
  assert.equal(createdProposal.created, true);
  assert.equal(createdProposal.proposal.type, "decisionProposal");
  assert.equal(createdProposal.proposal.status, "proposed");
  assert.equal(createdProposal.proposal.payload.title, "Publish verified decision");

  const appliedProposal = await rpc(server, auth, "workspace.proposal.apply", {
    workspaceId,
    proposalId: createdProposal.proposal.submissionId,
    resolution: "accept",
    note: "verified proposal flow"
  });
  assert.equal(appliedProposal.ok, true);
  assert.equal(appliedProposal.applied, true);
  assert.equal(appliedProposal.proposal.status, "accepted");
  assert.equal(appliedProposal.decision.status, "accepted");
  assert.equal(appliedProposal.decision.payload.sourceProposalId, createdProposal.proposal.submissionId);

  const workspace = await rpc(server, auth, "agent_workspaces.get", { workspaceId });
  assert.ok(workspace.decisions.some((item) => item.decisionId === appliedProposal.decision.decisionId));

  console.log("workspace proposal protocol verification passed");
} finally {
  await server.close();
  await fs.rm(userDataPath, { recursive: true, force: true });
}
