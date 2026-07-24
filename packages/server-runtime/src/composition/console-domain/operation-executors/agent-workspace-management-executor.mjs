
import {
  actorFrom,
  hasInputKey,
  parseBooleanFlag,
  plainObject,
  protocolPayload,
  requireAgentWorkspaceMethod,
  result,
  workspaceAccessOptions,
  workspaceIdFrom
} from "./shared.mjs";
import { workspaceGovernanceRegistryFor } from "./registry-services.mjs";
import { workspaceAssetSubject } from "./workspace-asset-model.mjs";

export async function executeAgentWorkspaceManagementOperation({ operationId, input, context }) {
  const id = String(operationId || "");
  const handledOperations = new Set([
    "workspace.info",
    "agent_workspaces.create",
    "agent_workspaces.list",
    "agent_workspaces.get",
    "agent_workspaces.delete",
    "agent_sessions.list",
    "agent_sessions.get",
    "agent_sessions.context.get",
    "agent_sessions.events.append",
    "agent_sessions.fork",
    "agent_sessions.compare",
    "agent_sessions.merge_proposal",
    "agent_sessions.archive",
    "agent_workspaces.submissions.resolve",
    "agent_workspaces.issues.resolve",
    "agent_workspaces.locks.list",
    "agent_workspaces.locks.write",
    "agent_workspaces.context.get",
    "agent_workspaces.context_bundle.export",
    "agent_workspaces.context_bundle.restore",
    "agent_workspaces.chain.get",
    "agent_workspaces.parent.set",
    "agent_workspaces.profile.hotswap",
    "agent_workspaces.sources.set",
    "agent_workspaces.share",
    "agent_workspaces.unshare",
    "workspace.proposal.create",
    "workspace.proposal.apply"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }
  const agentWorkspace = context.agentWorkspace;
  const access = workspaceAccessOptions(context.authSession);
  const actorId = actorFrom(context.authSession, input);
  const workspaceId = workspaceIdFrom(input);
  const sessionId = String(input.sessionId || input["session-id"] || input.id || "").trim();

  if (id === "workspace.info") {
    const hasExplicitWorkspaceId = ["workspaceId", "workspace_id", "workspace-id", "workspace", "id"]
      .some((key) => hasInputKey(input, key));
    if (!hasExplicitWorkspaceId) {
      const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "listWorkspaces", "智能体工作空间不可用。");
      if (error) return error;
      return result(200, method({
        status: input.status || "",
        limit: Number(input.limit || 50),
        includeSummary: parseBooleanFlag(input.includeSummary ?? input["include-summary"], true),
        ...access
      }));
    }
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "getWorkspace", "智能体工作空间不可用。");
    if (error) return error;
    const operationResult = method({
      workspaceId,
      includePrivate: parseBooleanFlag(input.includePrivate ?? input["include-private"] ?? input.private, false),
      ...access
    });
    return operationResult
      ? result(200, operationResult)
      : result(404, { error: "智能体工作空间不存在。" });
  }

  if (id === "agent_workspaces.list") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "listWorkspaces", "智能体工作空间不可用。");
    if (error) return error;
    return result(200, method({
      status: input.status || "",
      limit: Number(input.limit || 50),
      includeSummary: parseBooleanFlag(input.includeSummary ?? input["include-summary"], true),
      ...access
    }));
  }
  if (id === "agent_workspaces.get") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "getWorkspace", "智能体工作空间不可用。");
    if (error) return error;
    const operationResult = method({
      workspaceId,
      includePrivate: parseBooleanFlag(input.includePrivate ?? input["include-private"] ?? input.private, false),
      ...access
    });
    return operationResult
      ? result(200, operationResult)
      : result(404, { error: "智能体工作空间不存在。" });
  }
  if (id === "agent_workspaces.create") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "createWorkspace", "智能体工作空间不可用。");
    if (error) return error;
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return result(400, { error: "请求体必须是 JSON 对象。" });
    }
    if (!input.title) {
      return result(400, { error: "title 不能为空" });
    }
    const operationResult = method({
      title: String(input.title || "").trim(),
      objective: String(input.objective || "").trim(),
      status: "active",
      ownerUserId: access.actorUserId || input.ownerUserId || "",
      metadata: input.metadata || {}
    });
    if (input.parentWorkspaceId && operationResult.workspace?.workspaceId) {
      const { method: setParent, error: parentError } = requireAgentWorkspaceMethod(
        agentWorkspace,
        "setWorkspaceParent",
        "工作空间继承接口不可用。"
      );
      if (parentError) return parentError;
      const parentResult = setParent(operationResult.workspace.workspaceId, input.parentWorkspaceId, access);
      if (!parentResult.ok) {
        return result(400, { error: parentResult.error });
      }
      operationResult.workspace = parentResult.workspace;
    }
    return result(201, operationResult);
  }
  if (id === "agent_workspaces.delete") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "deleteWorkspace", "智能体工作空间删除不可用。");
    if (error) return error;
    const operationResult = method(workspaceId, {
      ...access
    });
    return operationResult?.ok
      ? result(200, operationResult)
      : result(operationResult?.deleted ? 503 : 404, operationResult || { error: "工作空间不存在或无权限。" });
  }

  if (id === "agent_sessions.list") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "listSessions", "会话线程不可用。");
    if (error) return error;
    return result(200, method({
      status: input.status || "",
      workspaceId: input.workspaceId || input["workspace-id"] || "",
      limit: Number(input.limit || 100),
      includeLastEvent: parseBooleanFlag(input.includeLastEvent ?? input["include-last-event"], true),
      ...access
    }));
  }
  if (id === "agent_sessions.get") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "getSession", "会话线程不可用。");
    if (error) return error;
    const operationResult = method({
      sessionId,
      includeEvents: parseBooleanFlag(input.includeEvents ?? input["include-events"], true),
      eventLimit: Number(input.eventLimit || input["event-limit"] || input.limit || 200),
      ...access
    });
    return operationResult
      ? result(200, operationResult)
      : result(404, { error: "会话线程不存在。" });
  }
  if (id === "agent_sessions.context.get") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "getSessionContext", "会话线程上下文不可用。");
    if (error) return error;
    const operationResult = method(sessionId, access);
    return operationResult
      ? result(200, operationResult)
      : result(404, { error: "会话线程不存在。" });
  }
  if (id === "agent_sessions.events.append") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "appendSessionEvent", "会话线程不可用。");
    if (error) return error;
    const operationResult = method({
      sessionId,
      ...input,
      ...access
    });
    return operationResult
      ? result(201, operationResult)
      : result(404, { error: "会话线程不存在。" });
  }
  if (id === "agent_sessions.fork") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "forkSession", "会话线程不可用。");
    if (error) return error;
    const operationResult = method({
      sessionId,
      ...input,
      ...access
    });
    return operationResult?.ok
      ? result(201, operationResult)
      : result(operationResult?.error === "会话不存在" ? 404 : 400, operationResult || { ok: false, error: "会话分叉失败。" });
  }
  if (id === "agent_sessions.compare") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "compareSessions", "会话线程不可用。");
    if (error) return error;
    const operationResult = method({
      ...input,
      leftSessionId: sessionId || input.leftSessionId || input.sessionId,
      ...access
    });
    return operationResult?.ok
      ? result(200, operationResult)
      : result(operationResult?.error === "会话不存在" ? 404 : 400, operationResult || { ok: false, error: "会话比较失败。" });
  }
  if (id === "agent_sessions.merge_proposal") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "createSessionMergeProposal", "会话线程不可用。");
    if (error) return error;
    const operationResult = method({
      ...input,
      targetSessionId: sessionId || input.targetSessionId || input.sessionId,
      ...access
    });
    return operationResult?.ok
      ? result(201, operationResult)
      : result(operationResult?.error === "会话不存在" ? 404 : 400, operationResult || { ok: false, error: "会话合并提案失败。" });
  }
  if (id === "agent_sessions.archive") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "archiveSession", "会话线程不可用。");
    if (error) return error;
    const operationResult = method({
      sessionId,
      ...input,
      ...access
    });
    return operationResult?.ok
      ? result(200, operationResult)
      : result(operationResult?.error === "会话不存在" ? 404 : 400, operationResult || { ok: false, error: "会话归档失败。" });
  }

  if (id === "agent_workspaces.submissions.resolve") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "resolveSubmission", "智能体工作空间不可用。");
    if (error) return error;
    const operationResult = method({
      workspaceId,
      submissionId: input.submissionId || input["submission-id"] || input.id || "",
      ...input,
      ...access
    });
    return operationResult
      ? result(200, operationResult)
      : result(404, { error: "共享提交不存在。" });
  }
  if (id === "agent_workspaces.issues.resolve") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "updateIssue", "智能体工作空间不可用。");
    if (error) return error;
    const operationResult = method({
      workspaceId,
      issueId: input.issueId || input["issue-id"] || input.id || "",
      ...input,
      ...access
    });
    return operationResult
      ? result(200, operationResult)
      : result(404, { error: "共享空间 issue 不存在。" });
  }

  if (id === "agent_workspaces.locks.list") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "listLocks", "智能体工作空间不可用。");
    if (error) return error;
    return result(200, {
      protocolVersion: agentWorkspace.protocolVersion,
      locks: method({
        workspaceId,
        limit: Number(input.limit || 100),
        includeExpired: parseBooleanFlag(input.includeExpired ?? input["include-expired"], false),
        ...access
      })
    });
  }
  if (id === "agent_workspaces.locks.write") {
    const action = String(input.action || input.operation || "acquire").trim();
    const methodName = action === "release" ? "releaseLock" : "acquireLock";
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, methodName, "智能体工作空间不可用。");
    if (error) return error;
    const operationResult = method({
      workspaceId,
      ...input,
      ...access
    });
    return operationResult?.ok === false
      ? result(operationResult.error === "lock_held" ? 409 : 400, operationResult)
      : result(200, operationResult);
  }

  if (id === "workspace.proposal.create") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "submit", "workspace 提案接口不可用。");
    if (error) return error;
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return result(400, { error: "请求体必须是 JSON 对象。" });
    }
    const proposalPayload = plainObject(input.proposal || input.payload, {});
    const title = String(input.title || proposalPayload.title || proposalPayload.summary || "").trim();
    if (!workspaceId) {
      return result(400, { error: "workspaceId 不能为空。" });
    }
    if (!title) {
      return result(400, { error: "title 不能为空。" });
    }
    const operationResult = method({
      workspaceId,
      runId: input.runId || input["run-id"] || proposalPayload.runId || "",
      agentId: actorId || input.agentId || input["agent-id"] || "workspace-proposal",
      type: "decisionProposal",
      confidence: input.confidence ?? proposalPayload.confidence ?? 0.8,
      supportingRefs: input.supportingRefs || proposalPayload.supportingRefs || input.refs || proposalPayload.refs || [],
      writePolicy: input.writePolicy || {},
      payload: {
        ...proposalPayload,
        proposalId: input.proposalId || input["proposal-id"] || proposalPayload.proposalId || "",
        title,
        summary: String(input.summary || proposalPayload.summary || "").trim(),
        proposedAction: input.proposedAction || input["proposed-action"] || proposalPayload.proposedAction || ""
      }
    });
    return result(201, protocolPayload({
      protocolVersion: "v0.0.1:workspace:proposal-1",
      created: true,
      proposal: operationResult.submission,
      submission: operationResult.submission
    }));
  }

  if (id === "workspace.proposal.apply") {
    const resolveSubmission = requireAgentWorkspaceMethod(agentWorkspace, "resolveSubmission", "workspace 提案审核接口不可用。");
    if (resolveSubmission.error) return resolveSubmission.error;
    const createDecision = requireAgentWorkspaceMethod(agentWorkspace, "createDecision", "workspace decision 接口不可用。");
    if (createDecision.error) return createDecision.error;
    const proposalId = String(input.proposalId || input["proposal-id"] || input.submissionId || input["submission-id"] || input.id || "").trim();
    if (!workspaceId) {
      return result(400, { error: "workspaceId 不能为空。" });
    }
    if (!proposalId) {
      return result(400, { error: "proposalId 不能为空。" });
    }
    const resolutionResult = resolveSubmission.method({
      workspaceId,
      submissionId: proposalId,
      resolution: input.resolution || input.action || "accept",
      reviewerId: actorId || input.reviewerId || input["reviewer-id"] || "",
      note: input.note || input.reason || "",
      ...access
    });
    if (!resolutionResult?.submission) {
      return result(404, { error: "workspace 提案不存在。" });
    }
    const proposal = resolutionResult.submission;
    const accepted = proposal.status === "accepted";
    let decision = null;
    if (accepted) {
      const proposalPayload = plainObject(proposal.payload, {});
      const decisionPayload = {
        ...proposalPayload,
        ...plainObject(input.decision || input.decisionPayload || input["decision-payload"], {}),
        sourceProposalId: proposal.submissionId
      };
      const decisionResult = createDecision.method({
        workspaceId,
        runId: proposal.runId || input.runId || input["run-id"] || "",
        title: input.title || decisionPayload.title || decisionPayload.summary || "Workspace proposal decision",
        status: input.decisionStatus || input["decision-status"] || "accepted",
        payload: decisionPayload,
        createdBy: actorId || input.reviewerId || input["reviewer-id"] || ""
      });
      decision = decisionResult.decision;
    }
    return result(200, protocolPayload({
      protocolVersion: "v0.0.1:workspace:proposal-1",
      applied: accepted,
      status: proposal.status,
      proposal,
      submission: proposal,
      decision
    }));
  }

  if (id === "agent_workspaces.context.get") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "getWorkspaceContext", "智能体工作空间不可用。");
    if (error) return error;
    const operationResult = method(workspaceId, access);
    return operationResult
      ? result(200, operationResult)
      : result(404, { error: "工作空间不存在。" });
  }
  if (id === "agent_workspaces.context_bundle.export") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "exportWorkspaceContextBundle", "工作空间上下文打包不可用。");
    if (error) return error;
    const format = String(input.format || "").trim().toLowerCase();
    const compressedOnly =
      format === "compressed" ||
      parseBooleanFlag(input.compressedOnly ?? input["compressed-only"], false);
    const operationResult = method(workspaceId, {
      ...access,
      compress: !["0", "false", "none"].includes(String(input.compress ?? "true").toLowerCase()),
      includeBundle: !compressedOnly,
      includePrivate: parseBooleanFlag(input.includePrivate ?? input["include-private"] ?? input.private, false),
      maxItems: Number(input.maxItems || input["max-items"] || input.limit || 12),
      contentPreviewChars: Number(input.contentPreviewChars || input["content-preview-chars"] || 600)
    });
    return operationResult
      ? result(200, operationResult)
      : result(404, { error: "工作空间不存在。" });
  }
  if (id === "agent_workspaces.context_bundle.restore") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "restoreWorkspaceContextBundle", "工作空间上下文恢复不可用。");
    if (error) return error;
    const operationResult = method(workspaceId, input, access);
    return result(operationResult.ok ? 200 : 400, operationResult);
  }
  if (id === "agent_workspaces.chain.get") {
    const getWorkspace = requireAgentWorkspaceMethod(agentWorkspace, "getWorkspace", "智能体工作空间不可用。");
    if (getWorkspace.error) return getWorkspace.error;
    const resolveChain = requireAgentWorkspaceMethod(agentWorkspace, "resolveWorkspaceChain", "工作空间继承链接口不可用。");
    if (resolveChain.error) return resolveChain.error;
    const resolveSourceIds = requireAgentWorkspaceMethod(agentWorkspace, "resolveWorkspaceSourceIds", "工作空间继承链接口不可用。");
    if (resolveSourceIds.error) return resolveSourceIds.error;
    const resolveProfile = requireAgentWorkspaceMethod(agentWorkspace, "resolveWorkspaceProfile", "工作空间继承链接口不可用。");
    if (resolveProfile.error) return resolveProfile.error;
    try {
      if (!getWorkspace.method({ workspaceId, includeRuns: false, ...access })) {
        return result(404, { error: "工作空间不存在。" });
      }
      const chain = resolveChain.method(workspaceId);
      if (!chain.length) {
        return result(404, { error: "工作空间不存在。" });
      }
      return result(200, {
        chain,
        resolvedSourceIds: resolveSourceIds.method(workspaceId),
        resolvedProfile: resolveProfile.method(workspaceId)
      });
    } catch (error) {
      return result(400, { error: error instanceof Error ? error.message : "工作空间继承链读取失败。" });
    }
  }
  if (id === "agent_workspaces.parent.set") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "setWorkspaceParent", "智能体工作空间不可用。");
    if (error) return error;
    const operationResult = method(
      workspaceId,
      input.parentWorkspaceId || input["parent-workspace-id"] || null,
      access
    );
    return result(operationResult.ok ? 200 : 400, operationResult);
  }
  if (id === "agent_workspaces.profile.hotswap") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "hotSwapProfile", "智能体工作空间不可用。");
    if (error) return error;
    const operationResult = method(workspaceId, input, access);
    return result(operationResult.ok ? 200 : 400, operationResult);
  }
  if (id === "agent_workspaces.sources.set") {
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, "setOwnedSourceIds", "智能体工作空间不可用。");
    if (error) return error;
    const operationResult = method(workspaceId, input.sourceIds || [], access);
    return result(operationResult.ok ? 200 : 400, operationResult);
  }
  if (id === "agent_workspaces.share" || id === "agent_workspaces.unshare") {
    const methodName = id === "agent_workspaces.share" ? "shareWorkspace" : "unshareWorkspace";
    const { method, error } = requireAgentWorkspaceMethod(agentWorkspace, methodName, "智能体工作空间不可用。");
    if (error) return error;
    const target = input.targetWorkspaceId || input.targetWorkspace || input.target || "";
    if (!target) {
      return result(400, { error: "缺少 targetWorkspaceId" });
    }
    if (!String(context.userDataPath || "").trim()) {
      return result(503, {
        ok: false,
        error: "Workspace governance storage is unavailable."
      });
    }
    const governance = workspaceGovernanceRegistryFor(context);
    if (id === "agent_workspaces.share") {
      const authorization = context.operationAuthorization || {};
      const approved = authorization.approvedPendingOperation || {};
      const grantId = String(authorization.grant?.id || "").trim();
      const approvalActorId = String(approved.actorId || "").trim();
      const policyRevision = {
        grantPolicyRevision: Number(authorization.policy?.grantPolicyRevision || 0),
        governancePolicyRevision: Number(authorization.policy?.governancePolicyRevision?.revision || 0)
      };
      const approvalBinding = {
        actorId: approvalActorId,
        operationId: id,
        workspaceId,
        targetWorkspaceId: String(target),
        grantId,
        policyRevision
      };
      let grantResult;
      try {
        grantResult = await governance.createShareGrant({
          workspaceId,
          action: "share",
          targetWorkspaceId: target,
          targetProjectId: input.targetProjectId || input["target-project-id"] || "",
          granteeId: input.granteeId || input["grantee-id"] || target,
          actions: input.actions || ["read"],
          expiresAt: input.expiresAt || input["expires-at"] || "",
          subject: workspaceAssetSubject(context, input)
        }, {
          approvalFact: approved,
          approvalBinding
        });
      } catch {
        return result(503, {
          ok: false,
          error: "Workspace governance could not evaluate this share."
        });
      }
      if (grantResult.granted !== true || !grantResult.shareGrant?.shareGrantId) {
        return result(403, {
          ok: false,
          error: "Workspace governance policy denied this share.",
          governance: {
            granted: false,
            evaluation: grantResult.evaluation || null
          }
        });
      }
      let operationResult;
      try {
        operationResult = method(workspaceId, target, access);
      } catch {
        operationResult = { ok: false, error: "Workspace share mutation failed." };
      }
      if (!operationResult.ok) {
        let compensated = false;
        try {
          const revocation = await governance.revokeShareGrants({
            shareGrantId: grantResult.shareGrant.shareGrantId,
            actorId,
            reason: "workspace_share_mutation_failed"
          });
          compensated = revocation.revoked === true;
        } catch {
          compensated = false;
        }
        return result(compensated ? 400 : 500, {
          ...operationResult,
          governance: {
            granted: true,
            compensated
          }
        });
      }
      return result(200, {
        ...operationResult,
        governance: {
          granted: true,
          shareGrant: grantResult.shareGrant,
          audit: grantResult.audit
        }
      });
    }
    const granteeId = input.granteeId || input["grantee-id"] || target;
    const idempotencyKey = String(
      input.idempotencyKey || input["idempotency-key"] || `unshare:${workspaceId}:${target}:${granteeId}`
    ).trim();
    let incomplete = await governance.findIncompleteUnshare({ idempotencyKey });
    if (!incomplete) {
      try {
        const intent = await governance.recordIncompleteUnshare({
          workspaceId,
          targetWorkspaceId: target,
          granteeId,
          actorId,
          reason: input.reason || "workspace_unshared",
          idempotencyKey
        });
        incomplete = intent.record;
      } catch {
        return result(503, {
          ok: false,
          accessRemoved: false,
          error: "Workspace unshare intent could not be persisted. Access remains unchanged."
        });
      }
    }
    if (incomplete.stage === "intent_persisted") {
      try {
        incomplete = (await governance.markIncompleteUnshareStage({
          idempotencyKey,
          stage: "acl_removal_in_progress"
        })).record;
      } catch {
        return result(500, {
          ok: false,
          accessRemoved: false,
          error: "Workspace unshare remains pending before access removal.",
          governance: { incompleteUnshareRef: incomplete.recordId }
        });
      }
    }
    let operationResult = { ok: true, accessRemoved: true, accessAlreadyRemoved: true };
    if (incomplete.stage === "acl_removal_in_progress") {
      try {
        operationResult = method(workspaceId, target, { ...access, idempotencyKey });
      } catch {
        return result(500, {
          ok: false,
          accessRemoved: false,
          error: "Workspace access removal remains pending.",
          governance: { incompleteUnshareRef: incomplete.recordId }
        });
      }
      if (!operationResult.ok) {
        return result(400, {
          ...operationResult,
          governance: { incompleteUnshareRef: incomplete.recordId }
        });
      }
      try {
        incomplete = (await governance.markIncompleteUnshareStage({
          idempotencyKey,
          stage: "acl_removed_grant_pending"
        })).record;
      } catch {
        return result(500, {
          ...operationResult,
          ok: false,
          accessRemoved: true,
          error: "Workspace access is removed while governance reconciliation remains pending.",
          governance: { incompleteUnshareRef: incomplete.recordId }
        });
      }
    }
    try {
      const revocation = await governance.completeIncompleteUnshare({ idempotencyKey });
      return result(200, {
        ...operationResult,
        accessAlreadyRemoved: operationResult.accessAlreadyRemoved === true || incomplete.stage === "acl_removed_grant_pending",
        governance: { revocation, reconciled: true }
      });
    } catch {
      return result(500, {
        ...operationResult,
        ok: false,
        accessRemoved: true,
        error: "Workspace access is removed while governance reconciliation remains pending.",
        governance: { incompleteUnshareRef: incomplete.recordId }
      });
    }
  }
  return null;
}
