
import {
  actorFrom,
  objectOrNull,
  requireAgentWorkspaceMethod,
  result,
  workspaceAccessOptions
} from "./shared.ts";

export function workspaceFileSnapshotFromCheckpointPlan(plan: Record<string, any> = {}, input: Record<string, any> = {}) : any {
  const target: any = objectOrNull(plan.target) || {};
  const metadata: any = objectOrNull(target.metadata) || {};
  const workspaceMetadata: any = objectOrNull(metadata.workspace) || {};
  const snapshot: any =
    objectOrNull(input.workspaceFileSnapshot) ||
    objectOrNull(input.fileSnapshot) ||
    objectOrNull(input.snapshot) ||
    objectOrNull(metadata.workspaceFileSnapshot) ||
    objectOrNull(metadata.fileSnapshot) ||
    objectOrNull(workspaceMetadata.fileSnapshot) ||
    null;
  if (!snapshot) {
    return null;
  }
  const files: any = Array.isArray(snapshot.files)
    ? snapshot.files
    : Array.isArray(snapshot.entries)
      ? snapshot.entries
      : Array.isArray(input.files)
        ? input.files
        : [];
  const localDirectorySnapshots: any = Array.isArray(snapshot.localDirectorySnapshots)
    ? snapshot.localDirectorySnapshots
    : Array.isArray(snapshot.mountSnapshots)
      ? snapshot.mountSnapshots
      : [];
  if (
    files.length === 0 &&
    localDirectorySnapshots.length === 0 &&
    snapshot.deleteExtraneous !== true &&
    snapshot.incremental !== true
  ) {
    return null;
  }
  return {
    workspaceId: String(
      input.workspaceId ||
        input.workspace ||
        snapshot.workspaceId ||
        snapshot.workspace ||
        metadata.workspaceId ||
        workspaceMetadata.workspaceId ||
        ""
    ).trim(),
    snapshot: {
      ...snapshot,
      files,
      localDirectorySnapshots,
      basePath: snapshot.basePath || snapshot.rootPath || input.basePath || "",
      deleteExtraneous: snapshot.deleteExtraneous === true || input.deleteExtraneous === true
    }
  };
}

function publicWorkspaceFileRestoreError(status: number): string {
  if (status === 403) return "The workspace is not available for checkpoint restore.";
  if (status === 404) return "The checkpoint workspace could not be found.";
  if (status === 409) return "The workspace changed since this checkpoint. Refresh and try again.";
  if (status >= 500) return "Workspace file restore is temporarily unavailable.";
  return "The checkpoint does not contain a usable workspace file snapshot.";
}

export async function runCheckpointWorkspaceFileRestore({ plan, input = {}, context = {}, dryRun }: Record<string, any>) : Promise<any> {
  const restoreTarget: any = workspaceFileSnapshotFromCheckpointPlan(plan, input);
  if (!restoreTarget) {
    return null;
  }
  if (!restoreTarget.workspaceId) {
    return result(400, {
      ok: false,
      code: "workspace_checkpoint_snapshot_invalid",
      error: "The checkpoint does not identify a workspace."
    });
  }
  const { method, error } = requireAgentWorkspaceMethod(
    context.agentWorkspace,
    "restoreWorkspaceFiles",
    "工作空间文件恢复接口不可用。"
  );
  if (error) {
    return result(error.status || 503, {
      ok: false,
      code: "workspace_file_restore_unavailable",
      error: "Workspace file restore is temporarily unavailable."
    });
  }
  const operationResult: any = await method({
    ...input,
    workspaceId: restoreTarget.workspaceId,
    snapshot: restoreTarget.snapshot,
    dryRun,
    operationId: input.operationId || "workspace.checkpoint.restore",
    reason: input.reason || "",
    actor: actorFrom(context.authSession, input),
    ...workspaceAccessOptions(context.authSession)
  });
  if (operationResult?.ok !== true) {
    const requestedStatus = Number(operationResult?.status || 400);
    const status = Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599
      ? requestedStatus
      : 400;
    return result(status, {
      ok: false,
      code: "workspace_file_restore_failed",
      error: publicWorkspaceFileRestoreError(status)
    });
  }
  return result(200, operationResult);
}

export function applyWorkspaceRuntimeContext(payload: Record<string, any> = {}, agentWorkspace: any = null, options: Record<string, any> = {}) : any {
  const agentSessionId: any = String(
    payload.agentSessionId ||
      payload.agent_session_id ||
      payload.sessionThreadId ||
      payload.session_thread_id ||
      payload.workspaceSessionId ||
      payload.workspace_session_id ||
      ""
  ).trim();
  const workspaceId: any = String(
    payload.workspaceId ||
      payload.workspace_id ||
      payload.sessionWorkspaceId ||
      ""
  ).trim();
  if (agentSessionId && agentWorkspace && typeof agentWorkspace.getSessionContext === "function") {
    const sessionContext: any = agentWorkspace.getSessionContext(agentSessionId, options);
    if (!sessionContext) {
      return {
        input: payload,
        workspaceContext: null,
        workspaceError: {
          status: 404,
          error: "会话线程不存在或不可访问。"
        }
      };
    }
    const next: Record<string, any> = {
      ...payload,
      agentSessionId,
      workspaceId: sessionContext.workspaceId,
      workspaceContext: sessionContext,
      agentSessionContext: sessionContext
    };
    if (!next.contextProfileId && sessionContext.contextProfileId) {
      next.contextProfileId = sessionContext.contextProfileId;
    }
    if (!next.modelAlias && !next.alias && !next.model && sessionContext.modelAlias) {
      next.modelAlias = sessionContext.modelAlias;
      next.alias = sessionContext.modelAlias;
    }
    if (!next.toolGrantId && !next.grantId && sessionContext.toolGrantId) {
      next.toolGrantId = sessionContext.toolGrantId;
    }
    return {
      input: next,
      workspaceContext: sessionContext
    };
  }
  if (!workspaceId || !agentWorkspace || typeof agentWorkspace.getWorkspaceContext !== "function") {
    return {
      input: payload,
      workspaceContext: null,
      workspaceError: workspaceId
        ? {
            status: 503,
            error: "工作空间上下文不可用。"
          }
        : null
    };
  }

  const workspaceContext: any = agentWorkspace.getWorkspaceContext(workspaceId, options);
  if (!workspaceContext) {
    return {
      input: payload,
      workspaceContext: null,
      workspaceError: {
        status: 404,
        error: "工作空间不存在或不可访问。"
      }
    };
  }

  const next: Record<string, any> = {
    ...payload,
    workspaceId,
    workspaceContext
  };
  if (!next.contextProfileId && workspaceContext.contextProfileId) {
    next.contextProfileId = workspaceContext.contextProfileId;
  }
  if (!next.modelAlias && !next.alias && !next.model && workspaceContext.modelAlias) {
    next.modelAlias = workspaceContext.modelAlias;
    next.alias = workspaceContext.modelAlias;
  }
  if (!next.toolGrantId && !next.grantId && workspaceContext.toolGrantId) {
    next.toolGrantId = workspaceContext.toolGrantId;
  }

  return {
    input: next,
    workspaceContext
  };
}
