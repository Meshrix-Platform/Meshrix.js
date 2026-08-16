import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import { getRuntimeLogger } from "@meshrix/foundation/observability/runtime-logger";
import { queueStateMutation } from "@meshrix/foundation/storage/state-coordinator";
import {
  assertExistingLocalDirectoryWithinControlledRootsSync,
  assertPathWithinRootSync
} from "@meshrix/foundation/security/local-path-boundary";
import {
  AGENT_SESSION_THREAD_VERSION,
  AGENT_WORKSPACE_CONTEXT_BUNDLE_VERSION,
  AGENT_WORKSPACE_PROTOCOL_VERSION,
  applyReplacementHunks,
  applyUnifiedPatchText,
  asArray,
  asObject,
  assertWorkspaceFileContentPolicy,
  buildWorkspaceHandoffMarkdown,
  compactArtifact,
  compactDecision,
  compactIssue,
  compactPrivateState,
  compactRun,
  compactSessionEvent,
  compactSubmission,
  compactWorkspaceLayer,
  decodeWorkspaceContextBundle,
  fileMetadataFromStat,
  gateSubmission,
  hydrateArtifact,
  hydrateDecision,
  hydrateIssue,
  hydrateLock,
  hydratePrivateState,
  hydrateRun,
  hydrateSession,
  hydrateSessionEvent,
  hydrateSubmission,
  hydrateWorkspace,
  joinWorkspaceRelativePath,
  normalizeSha256,
  normalizeWorkspaceRelativePath,
  nowIso,
  optionalLimit,
  parseJson,
  sha256Buffer,
  stableHash,
  stableId,
  stableJson,
  stringifyJson,
  stripExecutableMode,
  truncateText,
  uniqueStrings
} from "./agent-workspace-support.ts";
import { createAgentWorkspaceLocalDirectoryApi } from "./agent-workspace-local-directory.ts";
import { ensureAgentWorkspaceSchema, prepareAgentWorkspaceStatements } from "./agent-workspace-db.ts";
import { createAgentWorkspaceSessionApi } from "./agent-workspace-sessions.ts";
import { createAgentWorkspaceContextApi } from "./agent-workspace-context-api.ts";
import { createAgentWorkspaceRecordsApi } from "./agent-workspace-records.ts";
import { createAgentWorkspaceFileStateApi } from "./agent-workspace-file-state.ts";
import { createAgentWorkspaceFileReadApi } from "./agent-workspace-file-read-api.ts";
import { createAgentWorkspaceFileWriteApi } from "./agent-workspace-file-write-api.ts";
import { createAgentWorkspaceSyncApi } from "./agent-workspace-sync.ts";
import {
  createAgentWorkspaceMaterializationPort
} from "./agent-workspace-materialization.ts";
import { createWorkspaceReferenceMigration } from "./workspace-reference-migration.ts";
import {
  assertAgentWorkspaceMaterializationRootAuthority,
  bindAgentWorkspaceMaterializationRootPort
} from "./agent-workspace-materialization-brand.ts";

export {
  AGENT_WORKSPACE_PROTOCOL_VERSION,
  AGENT_WORKSPACE_CONTEXT_BUNDLE_VERSION,
  AGENT_SESSION_THREAD_VERSION
} from "./agent-workspace-support.ts";
export {
  createWorkspaceReferenceMigration,
  WORKSPACE_REFERENCE_MIGRATION_OWNED_MODULE
} from "./workspace-reference-migration.ts";

function withOwnedAgentWorkspaceDatabase(databasePath?: any, construct?: any) : any {
  let db: any = null;
  try {
    db = openSqliteDatabase(databasePath);
    return construct(db);
  } catch (error: any) {
    try {
      db?.close?.();
    } catch {
      // Preserve the construction failure while still attempting local cleanup.
    }
    throw error;
  }
}

function privateDirectoryError(code?: any, message?: any) : any {
  return Object.assign(new Error(message), {
    code,
    status: 409
  });
}

function pathIsWithin(parentPath?: any, candidatePath?: any) : any {
  const relative: any = path.relative(
    path.resolve(parentPath),
    path.resolve(candidatePath)
  );
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function privateDirectoryOpenFlags() : any {
  for (const flag of ["O_DIRECTORY", "O_NOFOLLOW", "O_RDONLY"]) {
    if (!Number.isInteger((fs.constants as Record<string, any>)[flag])) {
      throw privateDirectoryError(
        "agent_workspace_platform_unsupported",
        "Agent workspace private directory flags are unavailable."
      );
    }
  }
  return (fs.constants as Record<string, any>).O_RDONLY |
    fs.constants.O_DIRECTORY |
    fs.constants.O_NOFOLLOW;
}

function assertPrivateDirectoryOwnership(stat?: any) : any {
  const expectedUid: any = process.geteuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (
      Number.isInteger(expectedUid) &&
      Number(stat.uid) !== expectedUid
    )
  ) {
    throw privateDirectoryError(
      "agent_workspace_private_directory_unsafe",
      "Agent workspace private directory authority is unsafe."
    );
  }
}

function ensureConfiguredDataRoot(candidatePath?: any) : any {
  const candidate: any = path.resolve(candidatePath);
  const missing: any[] = [];
  let current: any = candidate;
  while (true) {
    try {
      const existing: any = fs.lstatSync(current, { bigint: true });
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw privateDirectoryError(
          "agent_workspace_data_root_unsafe",
          "Agent workspace data root is unsafe."
        );
      }
      break;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      missing.push(path.basename(current));
      const parent: any = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  for (const segment of missing.reverse()) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
    const created: any = fs.lstatSync(current, { bigint: true });
    assertPrivateDirectoryOwnership(created);
    if (process.platform !== "win32") {
      const descriptor: any = fs.openSync(
        current,
        privateDirectoryOpenFlags()
      );
      try {
        const opened: any = fs.fstatSync(descriptor, { bigint: true });
        assertPrivateDirectoryOwnership(opened);
        if (
          opened.dev !== created.dev ||
          opened.ino !== created.ino
        ) {
          throw privateDirectoryError(
            "agent_workspace_data_root_stale",
            "Agent workspace data root identity changed."
          );
        }
        fs.fchmodSync(descriptor, 0o700);
      } finally {
        fs.closeSync(descriptor);
      }
    }
  }
  return candidate;
}

function createPrivateDirectoryAuthority(trustedRootPath?: any) : any {
  const trustedRoot: any = path.resolve(trustedRootPath);
  const trustedStat: any = fs.lstatSync(trustedRoot, { bigint: true });
  assertPrivateDirectoryOwnership(trustedStat);
  if (
    process.platform !== "win32" &&
    (Number(trustedStat.mode & 0o777n) & 0o022) !== 0
  ) {
    throw privateDirectoryError(
      "agent_workspace_data_root_unsafe",
      "Agent workspace data root must not be group- or world-writable."
    );
  }
  const trustedRealPath: any = fs.realpathSync(trustedRoot);

  const sealExistingDirectory: any = (candidatePath?: any) : any => {
    const candidate: any = path.resolve(candidatePath);
    const before: any = fs.lstatSync(candidate, { bigint: true });
    assertPrivateDirectoryOwnership(before);
    if (process.platform !== "win32") {
      const descriptor: any = fs.openSync(
        candidate,
        privateDirectoryOpenFlags()
      );
      try {
        const opened: any = fs.fstatSync(descriptor, { bigint: true });
        assertPrivateDirectoryOwnership(opened);
        if (
          opened.dev !== before.dev ||
          opened.ino !== before.ino
        ) {
          throw privateDirectoryError(
            "agent_workspace_private_directory_stale",
            "Agent workspace private directory identity changed."
          );
        }
        fs.fchmodSync(descriptor, 0o700);
        const sealed: any = fs.fstatSync(descriptor, { bigint: true });
        if (Number(sealed.mode & 0o777n) !== 0o700) {
          throw privateDirectoryError(
            "agent_workspace_private_directory_mode",
            "Agent workspace private directory mode is unsafe."
          );
        }
      } finally {
        fs.closeSync(descriptor);
      }
    }
    const candidateRealPath: any = fs.realpathSync(candidate);
    if (
      candidateRealPath === trustedRealPath ||
      !pathIsWithin(trustedRealPath, candidateRealPath)
    ) {
      throw privateDirectoryError(
        "agent_workspace_private_directory_escape",
        "Agent workspace private directory escaped its data root."
      );
    }
    return candidate;
  };

  return Object.freeze({
    ensure(candidatePath?: any) : any {
      const candidate: any = path.resolve(candidatePath);
      if (
        candidate === trustedRoot ||
        !pathIsWithin(trustedRoot, candidate)
      ) {
        throw privateDirectoryError(
          "agent_workspace_private_directory_escape",
          "Agent workspace private directory escaped its data root."
        );
      }
      const relative: any = path.relative(trustedRoot, candidate);
      let current: any = trustedRoot;
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        try {
          fs.mkdirSync(current, { mode: 0o700 });
        } catch (error: any) {
          if (error?.code !== "EEXIST") throw error;
        }
        sealExistingDirectory(current);
      }
      return candidate;
    }
  });
}

export function createAgentWorkspace({
  userDataPath,
  merkleState = null,
  checkpointTreeApi = null,
  defaultCanAccessAll = false,
  controlledLocalDirectoryHostEnabled = false,
  materializationRootAuthority = null
}: Record<string, any>) : any {
  if (typeof controlledLocalDirectoryHostEnabled !== "boolean") {
    throw new TypeError("Controlled local-directory Host enablement must be a boolean.");
  }
  if (materializationRootAuthority) {
    assertAgentWorkspaceMaterializationRootAuthority(
      materializationRootAuthority
    );
  }
  const dataRootPath: any = ensureConfiguredDataRoot(userDataPath);
  const privateDirectoryAuthority: any =
    createPrivateDirectoryAuthority(dataRootPath);
  const rootPath: any = path.join(dataRootPath, "agent-workspaces");
  const foldersRootPath: any = path.join(rootPath, "folders");
  privateDirectoryAuthority.ensure(rootPath);
  privateDirectoryAuthority.ensure(foldersRootPath);
  const ensurePrivateWorkspaceDirectory: any = (candidatePath?: any) : any => {
    const candidate: any = path.resolve(candidatePath);
    if (
      candidate === path.resolve(foldersRootPath) ||
      !pathIsWithin(foldersRootPath, candidate)
    ) {
      throw privateDirectoryError(
        "agent_workspace_private_directory_escape",
        "Workspace directory escaped its private root."
      );
    }
    return privateDirectoryAuthority.ensure(candidate);
  };
  const localDirectoryMountConfigPath: any = path.join(rootPath, "local-directory-mounts.json");
  return withOwnedAgentWorkspaceDatabase(path.join(rootPath, "agent-workspace.sqlite"), (db?: any) : any => {
  db.pragma("journal_mode = WAL");
  ensureAgentWorkspaceSchema(db);
  const {
    insertWorkspaceStmt,
    selectWorkspaceStmt,
    listWorkspacesStmt,
    listWorkspacesByStatusStmt,
    insertRunStmt,
    selectRunStmt,
    updateWorkspaceTimeStmt,
    selectSubmissionStmt,
    updateSubmissionStatusStmt,
    selectIssueStmt,
    updateIssueStatusStmt,
    selectLockStmt,
    selectTargetLockStmt,
    insertLockStmt,
    deleteLockStmt,
    deleteExpiredLocksStmt,
    selectDuplicateStmt,
    insertSubmissionStmt,
    insertPrivateStmt,
    insertArtifactStmt,
    insertIssueStmt,
    insertDecisionStmt,
    insertSessionStmt,
    selectSessionStmt,
    listSessionsStmt,
    listSessionsByStatusStmt,
    listSessionsByWorkspaceStmt,
    listSessionsByWorkspaceStatusStmt,
    selectWorkspaceRootSessionStmt,
    countChildSessionsStmt,
    insertSessionEventStmt,
    selectSessionEventStmt,
    selectSessionEventsStmt,
    selectSessionEventsUntilStmt,
    selectLastSessionEventStmt,
    selectMaxSessionSequenceStmt,
    updateSessionStatsStmt,
    updateSessionStatusStmt
  } = prepareAgentWorkspaceStatements(db);
  const selectWorkspaceRawStmt: any = db.prepare("SELECT * FROM aw_workspaces WHERE workspace_id = ?");

  function workspaceSummary(workspaceId?: any) : any {
    const runCount: any = db.prepare("SELECT COUNT(*) AS count FROM aw_runs WHERE workspace_id = ?").get(workspaceId)?.count || 0;
    const submissionRows: any = db.prepare("SELECT status, COUNT(*) AS count FROM aw_submissions WHERE workspace_id = ? GROUP BY status").all(workspaceId);
    const artifactCount: any = db.prepare("SELECT COUNT(*) AS count FROM aw_artifacts WHERE workspace_id = ?").get(workspaceId)?.count || 0;
    const openIssueCount: any = db.prepare("SELECT COUNT(*) AS count FROM aw_issues WHERE workspace_id = ? AND status != 'resolved'").get(workspaceId)?.count || 0;
    const activeLockCount: any = db.prepare("SELECT COUNT(*) AS count FROM aw_locks WHERE workspace_id = ? AND expires_at > ?").get(workspaceId, nowIso())?.count || 0;
    const sessionCount: any = db.prepare("SELECT COUNT(*) AS count FROM aw_sessions WHERE workspace_id = ?").get(workspaceId)?.count || 0;
    const submissionCounts: any = Object.fromEntries(submissionRows.map((row?: any) : any => [row.status, Number(row.count || 0)]));
    return {
      runCount: Number(runCount),
      submissionCount: (Object.values(submissionCounts) as any[]).reduce((sum?: any, count?: any) : any => sum + count, 0),
      acceptedSubmissionCount: submissionCounts.accepted || 0,
      reviewSubmissionCount: submissionCounts.needs_review || 0,
      artifactCount: Number(artifactCount),
      openIssueCount: Number(openIssueCount),
      activeLockCount: Number(activeLockCount),
      sessionCount: Number(sessionCount)
    };
  }

  function workspaceAccess(input: Record<string, any> = {}) : any {
    const metadata: any = asObject(input.metadata);
    const actorIds: any = uniqueStrings([
      input.actorUserId,
      input.userId,
      input.subjectId,
      input.username,
      metadata.actorUserId,
      metadata.userId,
      metadata.subjectId,
      metadata.username
    ]);
    const allowedWorkspaceIds: any = new Set<any>(uniqueStrings([
      ...asArray(input.allowedWorkspaceIds)
    ]));
    const canAccessAll: any = input.canAccessAll === true || (defaultCanAccessAll === true && input.canAccessAll !== false);
    return {
      actorUserId: actorIds[0] || "",
      actorIds,
      allowedWorkspaceIds,
      canAccessAll,
      sharingMode: String(input.sharingMode || (canAccessAll ? "admin" : "owner-bound")).trim()
    };
  }

  function canAccessWorkspace(workspace?: any, input: Record<string, any> = {}) : any {
    if (!workspace) {
      return false;
    }
    const access: any = workspaceAccess(input);
    if (access.canAccessAll) {
      return true;
    }
    const workspaceId: any = String(workspace.workspaceId || "").trim();
    if (workspaceId && access.allowedWorkspaceIds.has(workspaceId)) {
      return true;
    }
    const metadata: any = asObject(workspace.metadata);
    const ownerUserId: any = String(workspace.ownerUserId || metadata.ownerUserId || "").trim();
    const allowedUserIds: any = uniqueStrings([
      ownerUserId,
      metadata.defaultAdminUserId,
      ...asArray(metadata.adminUserIds),
      ...asArray(metadata.administrators),
      ...asArray(metadata.allowedUserIds),
      ...asArray(metadata.allowedUsers),
      ...asArray(metadata.sharedUserIds),
      ...asArray(metadata.members)
    ]);
    if (allowedUserIds.length === 0) {
      return false;
    }
    return access.actorIds.some((actorId?: any) : any => allowedUserIds.includes(actorId));
  }

  function canAccessWorkspaceId(workspaceId?: any, input: Record<string, any> = {}) : any {
    const workspace: any = hydrateWorkspace(selectWorkspaceStmt.get(String(workspaceId || "")));
    return canAccessWorkspace(workspace, input);
  }

  function workspaceFsRoot(workspace?: any) : any {
    const fsPath: any = workspace?.fsPath || path.join(rootPath, "folders", String(workspace?.workspaceId || ""));
    const resolved: any = path.resolve(fsPath);
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }

  function workspaceFsRootForMaterialization(workspace?: any) : any {
    const fsPath: any = workspace?.fsPath ||
      path.join(rootPath, "folders", String(workspace?.workspaceId || ""));
    const resolved: any = path.resolve(fsPath);
    const foldersRoot: any = path.resolve(foldersRootPath);
    if (
      resolved === foldersRoot ||
      !resolved.startsWith(`${foldersRoot}${path.sep}`)
    ) {
      throw Object.assign(
        new Error("Workspace materialization root is outside its private authority."),
        {
          code: "materialization_workspace_root_invalid",
          status: 409
        }
      );
    }
    for (const candidate of [path.resolve(rootPath), foldersRoot, resolved]) {
      let stat: any;
      try {
        stat = fs.lstatSync(candidate, { bigint: true });
      } catch (error: any) {
        if (error?.code === "ENOENT") {
          throw Object.assign(
            new Error("Workspace materialization root must already exist."),
            {
              code: "materialization_workspace_root_missing",
              status: 409
            }
          );
        }
        throw error;
      }
      const mode: any = Number(stat.mode & 0o7777n);
      const expectedUid: any = process.geteuid?.();
      const expectedGid: any = process.getegid?.();
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        mode !== 0o700 ||
        (
          Number.isInteger(expectedUid) &&
          Number(stat.uid) !== expectedUid
        ) ||
        (
          Number.isInteger(expectedGid) &&
          Number(stat.gid) !== expectedGid
        )
      ) {
        throw Object.assign(
          new Error("Workspace materialization root is not a private directory."),
          {
            code: "materialization_workspace_root_unsafe",
            status: 409
          }
        );
      }
    }
    const realFoldersRoot: any = fs.realpathSync(foldersRoot);
    const realWorkspaceRoot: any = fs.realpathSync(resolved);
    if (
      realWorkspaceRoot === realFoldersRoot ||
      !realWorkspaceRoot.startsWith(`${realFoldersRoot}${path.sep}`)
    ) {
      throw Object.assign(
        new Error("Workspace materialization root escaped its private authority."),
        {
          code: "materialization_workspace_root_invalid",
          status: 409
        }
      );
    }
    return resolved;
  }

  function withWorkspaceMutation(workspaceId?: any, task?: any) : any {
    const normalizedWorkspaceId: any = String(workspaceId || "").trim();
    if (!normalizedWorkspaceId || typeof task !== "function") {
      throw new TypeError("Workspace mutation identity and task are required.");
    }
    return queueStateMutation(
      `agent-workspace-files:${path.resolve(rootPath)}:${normalizedWorkspaceId}`,
      task
    );
  }

  function resolveWorkspacePath(workspace?: any, relativePath: any = "", options: Record<string, any> = {}) : any {
    const root: any = workspaceFsRoot(workspace);
    const normalized: any = normalizeWorkspaceRelativePath(relativePath, { allowEmpty: options.allowEmpty === true });
    const target: any = normalized ? path.resolve(root, ...normalized.split("/")) : root;
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error("路径不能跳出工作空间。");
    }
    assertPathWithinRootSync(root, target, {
      label: "工作空间路径",
      allowMissing: options.allowMissing !== false,
      requireExisting: options.requireExisting === true,
      allowDirectory: options.allowDirectory !== false,
      allowFile: options.allowFile !== false,
      allowSpecial: false
    });
    return {
      root,
      relativePath: normalized,
      absolutePath: target
    };
  }

  function workspaceForStorage(input: Record<string, any> = {}) : any {
    const workspaceId: any = String(input.workspaceId || input.workspace_id || input.id || "").trim();
    const workspace: any = hydrateWorkspace(selectWorkspaceRawStmt.get(workspaceId));
    if (!workspace) {
      return { ok: false, status: 404, error: "工作空间不存在或不可访问。" };
    }
    if (!canAccessWorkspace(workspace, input)) {
      return { ok: false, status: 403, error: "工作空间不可访问。" };
    }
    return { ok: true, workspace };
  }

  function workspaceForMaterialization(input: Record<string, any> = {}) : any {
    const rawWorkspaceId: any = typeof input.workspaceId === "string"
      ? input.workspaceId
      : "";
    const workspaceId: any = rawWorkspaceId.trim();
    if (!workspaceId || workspaceId !== rawWorkspaceId) {
      return {
        ok: false,
        status: 400,
        code: "materialization_workspace_required",
        error: "Workspace materialization requires one workspace identity."
      };
    }
    const workspace: any = hydrateWorkspace(selectWorkspaceRawStmt.get(workspaceId));
    if (!workspace) {
      return {
        ok: false,
        status: 404,
        code: "materialization_workspace_missing",
        error: "The materialization workspace is unavailable."
      };
    }
    return { ok: true, workspace };
  }

  function createAccessReceipt({ workspaceId = "", operationId = "", path: receiptPath = "", action = "read" }: Record<string, any> = {}) : any {
    const createdAt: any = nowIso();
    const eventHash: any = stableHash("access-receipt", workspaceId, operationId, receiptPath, action, createdAt);
    return {
      protocolVersion: "v0.0.1:agent-workspace:access-receipt-1",
      receiptId: stableId("access_receipt", workspaceId, operationId, receiptPath, action, createdAt),
      operationId,
      workspaceId,
      path: receiptPath,
      action,
      state: "cached",
      eventHash,
      createdAt
    };
  }

  const sessionApi: any = createAgentWorkspaceSessionApi({
    db,
    selectSessionStmt,
    selectSessionEventStmt,
    selectMaxSessionSequenceStmt,
    insertSessionEventStmt,
    updateSessionStatsStmt,
    updateWorkspaceTimeStmt,
    insertSessionStmt,
    selectWorkspaceRootSessionStmt,
    listSessionsStmt,
    listSessionsByStatusStmt,
    listSessionsByWorkspaceStmt,
    listSessionsByWorkspaceStatusStmt,
    selectSessionEventsStmt,
    selectSessionEventsUntilStmt,
    selectLastSessionEventStmt,
    countChildSessionsStmt,
    updateSessionStatusStmt,
    canAccessWorkspaceId,
    canAccessWorkspace,
    getWorkspaceRow: (workspaceId?: any) : any => selectWorkspaceRawStmt.get(String(workspaceId || ""))
  });
  const {
    appendSessionEvent,
    createSession,
    ensureRootSessionForWorkspace,
    listSessions,
    getSession,
    forkSession,
    compareSessions,
    createSessionMergeProposal,
    archiveSession
  } = sessionApi;

  const recordsApi: any = createAgentWorkspaceRecordsApi({
    db,
    rootPath,
    insertWorkspaceStmt,
    selectWorkspaceStmt,
    listWorkspacesStmt,
    listWorkspacesByStatusStmt,
    insertRunStmt,
    selectRunStmt,
    updateWorkspaceTimeStmt,
    selectSubmissionStmt,
    updateSubmissionStatusStmt,
    selectIssueStmt,
    updateIssueStatusStmt,
    selectLockStmt,
    selectTargetLockStmt,
    insertLockStmt,
    deleteLockStmt,
    deleteExpiredLocksStmt,
    selectDuplicateStmt,
    insertSubmissionStmt,
    insertPrivateStmt,
    insertArtifactStmt,
    insertIssueStmt,
    insertDecisionStmt,
    workspaceSummary,
    workspaceAccess,
    canAccessWorkspace,
    canAccessWorkspaceId,
    ensureRootSessionForWorkspace,
    ensurePrivateWorkspaceDirectory
  });
  const {
    listWorkspaces,
    createWorkspace,
    createRun,
    updateRun,
    getRun,
    savePrivateState,
    submit,
    resolveSubmission,
    createArtifact,
    updateArtifactsStatus,
    createIssue,
    updateIssue,
    createDecision,
    listRunArtifacts,
    cleanupExpiredLocks,
    acquireLock,
    releaseLock,
    listLocks,
    getWorkspace,
    adminReleaseLock,
    close
  } = recordsApi;

  let readFileApi: any;
  const fileStateApi: any = createAgentWorkspaceFileStateApi({
    merkleState,
    checkpointTreeApi,
    resolveWorkspacePath,
    listWorkspaceFiles: (...args: any[]) : any => readFileApi.listWorkspaceFiles(...args)
  });
  readFileApi = createAgentWorkspaceFileReadApi({
    workspaceForStorage,
    resolveWorkspacePath,
    createAccessReceipt,
    updateWorkspaceTimeStmt,
    fileStateApi,
    ensurePrivateWorkspaceDirectory
  });
  const {
    createWorkspaceFolder: createWorkspaceFolderUnlocked,
    listWorkspaceFiles,
    workspaceFileMetadata,
    downloadWorkspaceFile,
    openWorkspaceFileReadStream
  } = readFileApi;

  const writeFileApi: any = createAgentWorkspaceFileWriteApi({
    workspaceForStorage,
    resolveWorkspacePath,
    updateWorkspaceTimeStmt,
    createArtifact,
    fileStateApi
  });
  const {
    uploadWorkspaceFile: uploadWorkspaceFileUnlocked,
    writeWorkspaceFile: writeWorkspaceFileUnlocked,
    patchWorkspaceFile: patchWorkspaceFileUnlocked,
    deleteWorkspaceFile: deleteWorkspaceFileUnlocked,
    moveWorkspaceFile: moveWorkspaceFileUnlocked
  } = writeFileApi;
  const serializeWorkspaceMutation: any = (method?: any) : any => (input: Record<string, any> = {}) : any =>
    withWorkspaceMutation(
      String(input.workspaceId || input.workspace_id || input.id || ""),
      () : any => method(input)
    );
  const createWorkspaceFolder: any = serializeWorkspaceMutation(
    createWorkspaceFolderUnlocked
  );
  const uploadWorkspaceFile: any = serializeWorkspaceMutation(
    uploadWorkspaceFileUnlocked
  );
  const writeWorkspaceFile: any = serializeWorkspaceMutation(
    writeWorkspaceFileUnlocked
  );
  const patchWorkspaceFile: any = serializeWorkspaceMutation(
    patchWorkspaceFileUnlocked
  );
  const deleteWorkspaceFile: any = serializeWorkspaceMutation(
    deleteWorkspaceFileUnlocked
  );
  const moveWorkspaceFile: any = serializeWorkspaceMutation(
    moveWorkspaceFileUnlocked
  );

  async function workspaceRevisionForAccess(access?: any) : Promise<any> {
    if (!merkleState?.stateCommit?.begin || !merkleState?.stateCommit?.commit) {
      return { ok: false, status: 503, error: "Workspace revision authority is unavailable." };
    }
    const scope: any = fileStateApi.workspaceStateScope(access.workspace);
    let state: any = await merkleState.stateCommit.begin({ scope });
    if (!String(state.currentRoot || "")) {
      const initialized: any = await merkleState.stateCommit.commit({
        scope,
        operationId: "workspace.revision.initialize",
        mutations: [],
        payload: { action: "revision.initialize", workspaceId: access.workspace.workspaceId }
      });
      state = { currentRoot: initialized.afterRoot };
    }
    return { ok: true, workspaceId: access.workspace.workspaceId, revision: String(state.currentRoot || "") };
  }

  async function workspaceFileRevision(input: Record<string, any> = {}) : Promise<any> {
    const access: any = workspaceForStorage(input);
    if (!access.ok) return access;
    return workspaceRevisionForAccess(access);
  }

  async function workspaceMaterializationRevision(input: Record<string, any> = {}) : Promise<any> {
    const access: any = workspaceForMaterialization(input);
    if (!access.ok) return access;
    if (!merkleState?.stateCommit?.begin) {
      return {
        ok: false,
        status: 503,
        code: "materialization_revision_unavailable",
        error: "Workspace revision authority is unavailable."
      };
    }
    const state: any = await merkleState.stateCommit.begin({
      scope: fileStateApi.workspaceStateScope(access.workspace)
    });
    const revision: any = String(state?.currentRoot || "");
    if (!revision) {
      return {
        ok: false,
        status: 409,
        code: "materialization_revision_uninitialized",
        error: "Workspace materialization revision is uninitialized."
      };
    }
    return {
      ok: true,
      workspaceId: access.workspace.workspaceId,
      revision
    };
  }

  async function captureWorkspaceFileSnapshotForAccess(access?: any, input: Record<string, any> = {}) : Promise<any> {
    const requestedPaths: any = uniqueStrings(asArray(input.paths).map((entry?: any) : any =>
      normalizeWorkspaceRelativePath(entry, { allowEmpty: false })
    ));
    let snapshot: any;
    if (requestedPaths.length > 0) {
      if (!merkleState?.cas?.putBlock) {
        return { ok: false, status: 503, error: "Workspace snapshot authority is unavailable." };
      }
      const files: any[] = [];
      const state: any = await merkleState.stateCommit.begin({ scope: fileStateApi.workspaceStateScope(access.workspace) });
      const latestEvents: any = await merkleState.eventLog?.listEvents?.(fileStateApi.workspaceStateScope(access.workspace), { limit: 1 }) || [];
      for (const relativePath of requestedPaths) {
        await input.leaseGuard?.();
        let resolved: any;
        try {
          resolved = resolveWorkspacePath(access.workspace, relativePath, { allowEmpty: false });
        } catch (error: any) {
          if (/symbolic link|符号链接/iu.test(String(error?.message || ""))) {
            return { ok: false, status: 409, error: "Workspace snapshot target must not be a symbolic link." };
          }
          throw error;
        }
        let handle: any;
        try {
          handle = await fsPromises.open(resolved.absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        } catch (error: any) {
          if (error?.code === "ELOOP") {
            return { ok: false, status: 409, error: "Workspace snapshot target must not be a symbolic link." };
          }
          if (error?.code !== "ENOENT") throw error;
          files.push({ relativePath, exists: false, contentCid: "", contentSha256: "", byteLength: 0, encoding: "base64" });
          await input.leaseGuard?.();
          continue;
        }
        if (input.requireMissingPaths === true) {
          await handle.close();
          return {
            ok: false,
            status: 409,
            code: "materialization_target_not_missing",
            error: "The workspace materialization target must be missing."
          };
        }
        let stat: any;
        let content: any;
        try {
          stat = await handle.stat();
          if (!stat.isFile()) {
            return { ok: false, status: 409, error: "Workspace snapshot target must be a regular file or missing path." };
          }
          content = await handle.readFile();
        } finally {
          await handle.close();
        }
        assertWorkspaceFileContentPolicy({ relativePath, contentBuffer: content, sizeBytes: stat.size });
        const block: any = await merkleState.cas.putBlock(content, {
          codec: "raw",
          metadata: { workspaceId: access.workspace.workspaceId, relativePath, snapshot: true }
        });
        files.push({ relativePath, exists: true, contentCid: block.cid, contentSha256: block.payloadHash, byteLength: block.byteLength, encoding: "base64" });
        await input.leaseGuard?.();
      }
      const finalState: any = await merkleState.stateCommit.begin({ scope: fileStateApi.workspaceStateScope(access.workspace) });
      const finalEvents: any = await merkleState.eventLog?.listEvents?.(fileStateApi.workspaceStateScope(access.workspace), { limit: 1 }) || [];
      const firstEvent: any = latestEvents[0] || null;
      const finalEvent: any = finalEvents[0] || null;
      if (
        String(finalState.currentRoot || "") !== String(state.currentRoot || "") ||
        Number(finalEvent?.offset ?? -1) !== Number(firstEvent?.offset ?? -1) ||
        String(finalEvent?.eventHash || "") !== String(firstEvent?.eventHash || "") ||
        (firstEvent && firstEvent.afterRoot !== state.currentRoot)
      ) {
        return { ok: false, status: 409, code: "workspace_snapshot_conflict", error: "Workspace changed while its snapshot was captured." };
      }
      snapshot = {
        schemaVersion: "v0.0.1:workspace:file-restore-snapshot-1",
        workspaceId: access.workspace.workspaceId,
        stateRoot: String(state.currentRoot || ""),
        stateEventAnchor: latestEvents[0] ? { offset: latestEvents[0].offset, eventHash: latestEvents[0].eventHash } : null,
        basePath: "",
        deleteExtraneous: false,
        files,
        localDirectorySnapshots: []
      };
    } else {
      snapshot = await fileStateApi.buildWorkspaceFileSnapshot(access.workspace, {
        basePath: input.basePath || "",
        deleteExtraneous: input.deleteExtraneous !== false
      });
    }
    return snapshot
      ? { ok: true, workspaceId: access.workspace.workspaceId, snapshot }
      : { ok: false, status: 503, error: "Workspace snapshot authority is unavailable." };
  }

  async function captureWorkspaceFileSnapshot(input: Record<string, any> = {}) : Promise<any> {
    const access: any = workspaceForStorage(input);
    if (!access.ok) return access;
    return captureWorkspaceFileSnapshotForAccess(access, input);
  }

  async function captureWorkspaceMaterializationSnapshot(input: Record<string, any> = {}) : Promise<any> {
    const access: any = workspaceForMaterialization(input);
    if (!access.ok) return access;
    const logicalTarget: any = normalizeWorkspaceRelativePath(
      input.logicalTarget,
      { allowEmpty: false }
    );
    const revision: any = await workspaceMaterializationRevision({
      workspaceId: access.workspace.workspaceId
    });
    if (!revision.ok) return revision;
    const events: any = await merkleState?.eventLog?.listEvents?.(
      fileStateApi.workspaceStateScope(access.workspace),
      { limit: 1 }
    ) || [];
    const anchor: any = events[0] || null;
    if (
      !anchor ||
      String(anchor.afterRoot || "") !== revision.revision ||
      !Number.isSafeInteger(Number(anchor.offset)) ||
      !String(anchor.eventHash || "")
    ) {
      return {
        ok: false,
        status: 409,
        code: "materialization_preimage_incomplete",
        error: "Workspace materialization state anchor is incomplete."
      };
    }
    return {
      ok: true,
      workspaceId: access.workspace.workspaceId,
      snapshot: {
        schemaVersion: "v0.0.1:workspace:file-restore-snapshot-1",
        workspaceId: access.workspace.workspaceId,
        stateRoot: revision.revision,
        stateEventAnchor: {
          offset: Number(anchor.offset),
          eventHash: String(anchor.eventHash)
        },
        basePath: "",
        deleteExtraneous: false,
        files: [{
          relativePath: logicalTarget,
          exists: false,
          contentCid: "",
          contentSha256: "",
          byteLength: 0,
          encoding: "base64"
        }],
        localDirectorySnapshots: []
      }
    };
  }

  if (materializationRootAuthority) {
    bindAgentWorkspaceMaterializationRootPort(
      materializationRootAuthority,
      () : any => createAgentWorkspaceMaterializationPort({
        workspaceForMaterialization,
        workspaceFsRoot: workspaceFsRootForMaterialization,
        workspaceFileRevision: workspaceMaterializationRevision,
        captureWorkspaceMaterializationSnapshot,
        withWorkspaceMutation,
        fileStateApi,
        merkleState,
        updateWorkspaceTimeStmt
      })
    );
  }

  let syncApi: any;
  const localDirectoryApi: any = controlledLocalDirectoryHostEnabled
    ? createAgentWorkspaceLocalDirectoryApi({
        userDataPath,
        localDirectoryMountConfigPath,
        workspaceForStorage,
        createAccessReceipt,
        localDirectorySyncPlan: (...args: any[]) : any => syncApi.localDirectorySyncPlan(...args),
        decodeWorkspaceFileContent: fileStateApi.decodeWorkspaceFileContent,
        updateWorkspaceTimeStmt,
        merkleState,
        fileStateApi
      })
    : null;

  syncApi = createAgentWorkspaceSyncApi({
    merkleState,
    workspaceForStorage,
    resolveWorkspacePath,
    resolveLocalDirectorySource: localDirectoryApi?.resolveLocalDirectorySource,
    listWorkspaceFiles,
    updateWorkspaceTimeStmt,
    fileStateApi,
    restoreLocalDirectoryPreimage: localDirectoryApi?.restoreLocalDirectoryPreimage,
    rollbackLocalDirectoryMutation: localDirectoryApi?.rollbackLocalDirectoryMutation
  });
  const {
    localDirectorySyncPlan,
    applyLocalDirectorySync: applyLocalDirectorySyncUnlocked,
    restoreWorkspaceFiles: restoreWorkspaceFilesUnlocked
  } = syncApi;
  const applyLocalDirectorySync: any = serializeWorkspaceMutation(
    applyLocalDirectorySyncUnlocked
  );
  const restoreWorkspaceFiles: any = serializeWorkspaceMutation(
    restoreWorkspaceFilesUnlocked
  );

  async function getWorkspaceSandboxMutationReceipt(input: Record<string, any> = {}) : Promise<any> {
    const access: any = workspaceForStorage(input);
    if (!access.ok) return access;
    const commitId: any = String(input.commitId || input.stateCommitId || "").trim();
    if (!commitId || !checkpointTreeApi?.loadCheckpointTree || !merkleState?.eventLog?.listEvents) {
      return { ok: false, status: commitId ? 503 : 400, error: "Workspace mutation receipt authority is unavailable." };
    }
    const treeId: any = fileStateApi.workspaceCheckpointTreeId(access.workspace);
    const tree: any = await checkpointTreeApi.loadCheckpointTree({ treeId });
    const checkpoint: any = tree?.nodes?.[`commit:${commitId}`] || null;
    const metadata: any = asObject(checkpoint?.metadata);
    const stateCommit: any = asObject(metadata.stateCommit);
    const mutationOrigin: any = asObject(metadata.mutationOrigin);
    const events: any = await merkleState.eventLog.listEvents(fileStateApi.workspaceStateScope(access.workspace), { limit: 10_000 });
    const event: any = events.find((candidate?: any) : any =>
      (stateCommit.eventId && String(candidate.eventId || "") === String(stateCommit.eventId)) ||
      (stateCommit.eventHash && String(candidate.eventHash || "") === String(stateCommit.eventHash))
    );
    const eventOrigin: any = asObject(event?.payload?.mutationOrigin);
    const supersededByCompensation: any = events.some((candidate?: any) : any =>
      String(candidate?.payload?.failedCommitId || "") === commitId
    );
    if (
      checkpoint?.status !== "completed" ||
      stateCommit.commitId !== commitId ||
      !mutationOrigin.sandboxReceiptDigest ||
      JSON.stringify(eventOrigin) !== JSON.stringify(mutationOrigin) ||
      supersededByCompensation
    ) {
      return { ok: false, status: 409, error: "Workspace mutation receipt history binding is incomplete." };
    }
    const preimage: any = metadata.workspaceFilePreimageSnapshot || null;
    if (!preimage) {
      return { ok: false, status: 409, error: "Workspace mutation receipt preimage binding is missing." };
    }
    const receipt: Record<string, any> = {
      schemaVersion: "v0.0.1:workspace:sandbox-mutation-receipt-1",
      sandboxReceiptDigest: mutationOrigin.sandboxReceiptDigest,
      previewDigest: mutationOrigin.previewDigest || "",
      approvalBindingDigest: mutationOrigin.approvalBindingDigest || "",
      preimageDigest: crypto.createHash("sha256").update(JSON.stringify(preimage)).digest("hex"),
      stateCommitId: commitId,
      stateCommitDigest: crypto.createHash("sha256").update(JSON.stringify(stateCommit)).digest("hex"),
      checkpointNodeId: String(checkpoint.nodeId || `commit:${commitId}`),
      checkpointDigest: crypto.createHash("sha256").update(JSON.stringify(metadata)).digest("hex")
    };
    return {
      ok: true,
      workspaceId: access.workspace.workspaceId,
      mutationReceipt: {
        ...receipt,
        receiptDigest: crypto.createHash("sha256").update(JSON.stringify(receipt)).digest("hex")
      }
    };
  }

  /**
   * Walk the parent chain upward and return an ordered array [root, ..., target].
   * Throws if a cycle is detected.
   */
  const contextApi: any = createAgentWorkspaceContextApi({
    db,
    rootPath,
    selectWorkspaceRawStmt,
    selectSessionStmt,
    canAccessWorkspace,
    canAccessWorkspaceId,
    workspaceAccess,
    getWorkspace,
    createRun,
    createArtifact
  });
  const {
    resolveWorkspaceChain,
    resolveWorkspaceProfile,
    resolveWorkspaceSourceIds,
    getWorkspaceContext,
    getSessionContext,
    exportWorkspaceContextBundle,
    restoreWorkspaceContextBundle,
    setWorkspaceParent,
    hotSwapProfile,
    setOwnedSourceIds,
    shareWorkspace,
    unshareWorkspace,
    deleteWorkspace: deleteWorkspaceUnlocked
  } = contextApi;
  const deleteWorkspace: any = deleteWorkspaceUnlocked;

  return {
    protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
    createWorkspace,
    deleteWorkspace,
    listWorkspaces,
    getWorkspace,
    createSession,
    listSessions,
    getSession,
    getSessionContext,
    appendSessionEvent,
    forkSession,
    compareSessions,
    createSessionMergeProposal,
    archiveSession,
    createRun,
    updateRun,
    getRun,
    savePrivateState,
    submit,
    resolveSubmission,
    createArtifact,
    createWorkspaceFolder,
    listWorkspaceFiles,
    workspaceFileMetadata,
    uploadWorkspaceFile,
    workspaceFileRevision,
    captureWorkspaceFileSnapshot,
    writeWorkspaceFile,
    patchWorkspaceFile,
    downloadWorkspaceFile,
    openWorkspaceFileReadStream,
    deleteWorkspaceFile,
    moveWorkspaceFile,
    ...(controlledLocalDirectoryHostEnabled ? {
      createLocalDirectoryMountSelection: localDirectoryApi.createLocalDirectoryMountSelection,
      connectLocalDirectory: localDirectoryApi.connectLocalDirectory,
      listLocalDirectoryMounts: localDirectoryApi.listLocalDirectoryMounts,
      listLocalDirectoryItems: localDirectoryApi.listLocalDirectoryItems,
      localDirectoryItemMetadata: localDirectoryApi.localDirectoryItemMetadata,
      readLocalDirectoryFile: localDirectoryApi.readLocalDirectoryFile,
      writeLocalDirectoryFile: localDirectoryApi.writeLocalDirectoryFile,
      createLocalDirectoryFolder: localDirectoryApi.createLocalDirectoryFolder,
      deleteLocalDirectoryItem: localDirectoryApi.deleteLocalDirectoryItem,
      moveLocalDirectoryItem: localDirectoryApi.moveLocalDirectoryItem,
      localDirectorySyncPlan,
      applyLocalDirectorySync
    } : {}),
    restoreWorkspaceFiles,
    openWorkspaceCollaboration: (input: Record<string, any> = {}) : any =>
      createWorkspaceReferenceMigration(input),
    getWorkspaceSandboxMutationReceipt,
    getWorkspaceRefactorInstrumentation: () : any =>
      fileStateApi.getRefactorInstrumentation
        ? fileStateApi.getRefactorInstrumentation()
        : null,
    updateArtifactsStatus,
    createIssue,
    updateIssue,
    createDecision,
    listRunArtifacts,
    acquireLock,
    releaseLock,
    adminReleaseLock,
    listLocks,
    resolveWorkspaceChain,
    resolveWorkspaceProfile,
    resolveWorkspaceSourceIds,
    getWorkspaceContext,
    exportWorkspaceContextBundle,
    restoreWorkspaceContextBundle,
    setWorkspaceParent,
    hotSwapProfile,
    setOwnedSourceIds,
    shareWorkspace,
    unshareWorkspace,
    close
  };
  });
}

export default createAgentWorkspace;
