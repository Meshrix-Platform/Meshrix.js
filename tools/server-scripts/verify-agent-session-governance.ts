#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AGENT_SESSION_THREAD_VERSION,
  createAgentWorkspace
} from "../../packages/agents/src/agent-workspace/index.ts";
import { SERVER_API_OPERATIONS } from "#meshrix/operation-registry";
import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.ts";

const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-session-governance-"));
const actor: Record<string, any> = { actorUserId: "session-governance-admin" };

try {
  const workspaceRuntime: any = createAgentWorkspace({ userDataPath });
  try {
    const workspace: any = workspaceRuntime.createWorkspace({
      ...actor,
      ownerUserId: actor.actorUserId,
      workspaceId: "session-governance-ws",
      title: "Session Governance",
      objective: "Verify compare, merge proposal and archive"
    }).workspace;
    const root: any = workspaceRuntime.createSession({
      ...actor,
      sessionId: "session-root",
      workspaceId: workspace.workspaceId,
      title: "Root Session",
      objective: "Root path"
    }).session;
    const shared: any = workspaceRuntime.appendSessionEvent({
      ...actor,
      sessionId: root.sessionId,
      type: "artifact_update",
      title: "Shared baseline",
      summary: "Baseline artifact",
      payload: {
        artifactId: "artifact-1",
        value: "baseline"
      }
    });
    assert.equal(shared.sessionProtocolVersion, AGENT_SESSION_THREAD_VERSION);

    const forked: any = workspaceRuntime.forkSession({
      ...actor,
      sessionId: root.sessionId,
      newSessionId: "session-branch",
      title: "Branch Session"
    });
    assert.equal(forked.ok, true);
    assert.equal(forked.session.parentSessionId, root.sessionId);

    workspaceRuntime.appendSessionEvent({
      ...actor,
      sessionId: root.sessionId,
      type: "artifact_update",
      title: "Root revision",
      summary: "Root changed artifact",
      payload: {
        artifactId: "artifact-1",
        value: "root-revision"
      }
    });
    workspaceRuntime.appendSessionEvent({
      ...actor,
      sessionId: forked.session.sessionId,
      type: "artifact_update",
      title: "Branch revision",
      summary: "Branch changed artifact",
      payload: {
        artifactId: "artifact-1",
        value: "branch-revision"
      }
    });

    const comparison: any = workspaceRuntime.compareSessions({
      ...actor,
      leftSessionId: root.sessionId,
      rightSessionId: forked.session.sessionId
    });
    assert.equal(comparison.ok, true);
    assert.equal(comparison.appendOnly, true);
    assert.equal(comparison.summary.conflictCount, 1);
    assert.ok(comparison.summary.commonEventCount >= 2);
    assert.equal(comparison.conflicts[0].targetId, "artifact-1");

    const proposal: any = workspaceRuntime.createSessionMergeProposal({
      ...actor,
      targetSessionId: root.sessionId,
      sourceSessionId: forked.session.sessionId,
      resolutionHints: {
        artifactId: "artifact-1",
        decision: "needs_human_review"
      }
    });
    assert.equal(proposal.ok, true);
    assert.equal(proposal.proposal.autoMergeApplied, false);
    assert.equal(proposal.proposal.requiresDecision, true);
    assert.equal(proposal.event.type, "session_merge_proposal");

    const archived: any = workspaceRuntime.archiveSession({
      ...actor,
      sessionId: forked.session.sessionId,
      reason: "branch merged into review queue"
    });
    assert.equal(archived.ok, true);
    assert.equal(archived.session.status, "archived");
    assert.equal(archived.event.type, "session_archived");

    const archivedSession: any = workspaceRuntime.getSession({
      ...actor,
      sessionId: forked.session.sessionId,
      includeEvents: true,
      eventLimit: 20
    });
    assert.equal(archivedSession.session.status, "archived");
    assert.ok(archivedSession.events.some((event?: any) : any => event.type === "session_archived"));

    const operations: any = SERVER_API_OPERATIONS;
    for (const operationId of [
      "agent_sessions.compare",
      "agent_sessions.merge_proposal",
      "agent_sessions.archive"
    ]) {
      assert.ok(operations.some((operation?: any) : any => operation.id === operationId), `missing operation ${operationId}`);
    }

    const toolCatalog: any = createToolCatalog({ operations });
    for (const toolId of [
      "meshrix.agentSession.compare",
      "meshrix.agentSession.mergeProposal",
      "meshrix.agentSession.archive"
    ]) {
      assert.ok(toolCatalog.tools.some((tool?: any) : any => tool.id === toolId), `missing tool ${toolId}`);
    }

    console.log("[agent-session-governance] ok");
  } finally {
    workspaceRuntime.close();
  }
} finally {
  if (process.env.MESHRIX_KEEP_TEST_DATA !== "1") {
    await fs.rm(userDataPath, { recursive: true, force: true });
  } else {
    console.log(`kept test data: ${userDataPath}`);
  }
}
