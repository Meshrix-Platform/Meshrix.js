import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import { queueStateMutation } from "@meshrix/foundation/storage/state-coordinator";
import {
  assertPathWithinRootSync
} from "@meshrix/foundation/security/local-path-boundary";
import {
  AGENT_WORKSPACE_PROTOCOL_VERSION,
  asArray,
  asObject,
  assertWorkspaceFileContentPolicy,
  hydrateWorkspace,
  normalizeWorkspaceRelativePath,
  nowIso,
  stableHash,
  stableId,
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

type JsonRecord = Record<string, unknown>;
type FileReadOptions = NonNullable<Parameters<typeof createAgentWorkspaceFileReadApi>[0]>;
type MaterializationOptions = NonNullable<Parameters<typeof createAgentWorkspaceMaterializationPort>[0]>;
interface WorkspaceInput extends JsonRecord {
  metadata?: JsonRecord;
  state?: JsonRecord;
  payload?: JsonRecord;
  paths?: unknown[];
  leaseGuard?: () => void | Promise<void>;
  requireMissingPaths?: boolean;
}
interface CodedError extends Error { code: string; status: number }
interface PrivateDirectoryAuthority { ensure(candidatePath: string): string }
type WorkspaceRecord = NonNullable<ReturnType<typeof hydrateWorkspace>>;
interface AgentWorkspaceOptions {
  userDataPath: string;
  merkleState?: (
    NonNullable<Parameters<typeof createAgentWorkspaceFileStateApi>[0]["merkleState"]> &
    NonNullable<MaterializationOptions["merkleState"]> &
    SnapshotMerkleState
  ) | null;
  checkpointTreeApi?: (NonNullable<Parameters<typeof createAgentWorkspaceFileStateApi>[0]["checkpointTreeApi"]> & SnapshotCheckpointTree) | null;
  defaultCanAccessAll?: boolean;
  controlledLocalDirectoryHostEnabled?: boolean;
  materializationRootAuthority?: object | null;
}
interface SnapshotMerkleState {
  stateCommit: {
    begin(input: JsonRecord): Promise<JsonRecord>;
    commit(input: JsonRecord): Promise<JsonRecord>;
  };
  eventLog: { listEvents(scope: unknown, options?: JsonRecord): Promise<JsonRecord[]> };
  cas: { putBlock(content: Buffer, metadata?: JsonRecord): Promise<JsonRecord> };
}
interface SnapshotCheckpointTree {
  loadCheckpointTree(input: { treeId: string }): Promise<{ nodes?: Record<string, JsonRecord> } | null>;
}
type WorkspaceAccessResult =
  | { ok: false; status: number; code?: string; error: string; workspace?: undefined }
  | { ok: true; workspace: WorkspaceRecord; status?: undefined; code?: undefined; error?: undefined };

function errorCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
}

function withOwnedAgentWorkspaceDatabase<Result>(databasePath: string, construct: (db: Database.Database) => Result): Result {
  let db: Database.Database | null = null;
  try {
    db = openSqliteDatabase(databasePath);
    return construct(db);
  } catch (error: unknown) {
    try {
      db?.close?.();
    } catch {
      // Preserve the construction failure while still attempting local cleanup.
    }
    throw error;
  }
}

function privateDirectoryError(code: string, message: string): CodedError {
  return Object.assign(new Error(message), {
    code,
    status: 409
  });
}

function pathIsWithin(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(
    path.resolve(parentPath),
    path.resolve(candidatePath)
  );
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function privateDirectoryOpenFlags(): number {
  for (const flag of ["O_DIRECTORY", "O_NOFOLLOW", "O_RDONLY"]) {
    if (!Number.isInteger((fs.constants as Record<string, number>)[flag])) {
      throw privateDirectoryError(
        "agent_workspace_platform_unsupported",
        "Agent workspace private directory flags are unavailable."
      );
    }
  }
  return (fs.constants as Record<string, number>).O_RDONLY |
    fs.constants.O_DIRECTORY |
    fs.constants.O_NOFOLLOW;
}

function assertPrivateDirectoryOwnership(stat: fs.BigIntStats): void {
  const expectedUid = process.geteuid?.();
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

function ensureConfiguredDataRoot(candidatePath: string): string {
  const candidate = path.resolve(candidatePath);
  const missing: string[] = [];
  let current = candidate;
  while (true) {
    try {
      const existing = fs.lstatSync(current, { bigint: true });
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw privateDirectoryError(
          "agent_workspace_data_root_unsafe",
          "Agent workspace data root is unsafe."
        );
      }
      break;
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
      missing.push(path.basename(current));
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  for (const segment of missing.reverse()) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const created = fs.lstatSync(current, { bigint: true });
    assertPrivateDirectoryOwnership(created);
    if (process.platform !== "win32") {
      const descriptor = fs.openSync(
        current,
        privateDirectoryOpenFlags()
      );
      try {
        const opened = fs.fstatSync(descriptor, { bigint: true });
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

function createPrivateDirectoryAuthority(trustedRootPath: string): PrivateDirectoryAuthority {
  const trustedRoot = path.resolve(trustedRootPath);
  const trustedStat = fs.lstatSync(trustedRoot, { bigint: true });
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
  const trustedRealPath = fs.realpathSync(trustedRoot);

  const sealExistingDirectory = (candidatePath: string): string => {
    const candidate = path.resolve(candidatePath);
    const before = fs.lstatSync(candidate, { bigint: true });
    assertPrivateDirectoryOwnership(before);
    if (process.platform !== "win32") {
      const descriptor = fs.openSync(
        candidate,
        privateDirectoryOpenFlags()
      );
      try {
        const opened = fs.fstatSync(descriptor, { bigint: true });
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
        const sealed = fs.fstatSync(descriptor, { bigint: true });
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
    const candidateRealPath = fs.realpathSync(candidate);
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
    ensure(candidatePath: string): string {
      const candidate = path.resolve(candidatePath);
      if (
        candidate === trustedRoot ||
        !pathIsWithin(trustedRoot, candidate)
      ) {
        throw privateDirectoryError(
          "agent_workspace_private_directory_escape",
          "Agent workspace private directory escaped its data root."
        );
      }
      const relative = path.relative(trustedRoot, candidate);
      let current = trustedRoot;
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        try {
          fs.mkdirSync(current, { mode: 0o700 });
        } catch (error: unknown) {
          if (errorCode(error) !== "EEXIST") throw error;
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
}: AgentWorkspaceOptions) {
  if (typeof controlledLocalDirectoryHostEnabled !== "boolean") {
    throw new TypeError("Controlled local-directory Host enablement must be a boolean.");
  }
  if (materializationRootAuthority) {
    assertAgentWorkspaceMaterializationRootAuthority(
      materializationRootAuthority
    );
  }
  const dataRootPath = ensureConfiguredDataRoot(userDataPath);
  const privateDirectoryAuthority =
    createPrivateDirectoryAuthority(dataRootPath);
  const rootPath = path.join(dataRootPath, "agent-workspaces");
  const foldersRootPath = path.join(rootPath, "folders");
  privateDirectoryAuthority.ensure(rootPath);
  privateDirectoryAuthority.ensure(foldersRootPath);
  const ensurePrivateWorkspaceDirectory = (candidatePath: string): string => {
    const candidate = path.resolve(candidatePath);
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
  const localDirectoryMountConfigPath = path.join(rootPath, "local-directory-mounts.json");
  return withOwnedAgentWorkspaceDatabase(path.join(rootPath, "agent-workspace.sqlite"), (db) => {
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
  const selectWorkspaceRawStmt = db.prepare("SELECT * FROM aw_workspaces WHERE workspace_id = ?");

  function workspaceSummary(workspaceId: string) {
    const runCount = (db.prepare<[{ workspaceId: string }], { count: number }>("SELECT COUNT(*) AS count FROM aw_runs WHERE workspace_id = @workspaceId").get({ workspaceId })?.count || 0);
    const submissionRows = db.prepare<[string], { status: string; count: number }>("SELECT status, COUNT(*) AS count FROM aw_submissions WHERE workspace_id = ? GROUP BY status").all(workspaceId);
    const artifactCount = db.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM aw_artifacts WHERE workspace_id = ?").get(workspaceId)?.count || 0;
    const openIssueCount = db.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM aw_issues WHERE workspace_id = ? AND status != 'resolved'").get(workspaceId)?.count || 0;
    const activeLockCount = db.prepare<[string, string], { count: number }>("SELECT COUNT(*) AS count FROM aw_locks WHERE workspace_id = ? AND expires_at > ?").get(workspaceId, nowIso())?.count || 0;
    const sessionCount = db.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM aw_sessions WHERE workspace_id = ?").get(workspaceId)?.count || 0;
    const submissionCounts: Record<string, number> = Object.fromEntries(submissionRows.map((row) => [row.status, Number(row.count || 0)]));
    return {
      runCount: Number(runCount),
      submissionCount: Object.values(submissionCounts).reduce((sum, count) => sum + count, 0),
      acceptedSubmissionCount: submissionCounts.accepted || 0,
      reviewSubmissionCount: submissionCounts.needs_review || 0,
      artifactCount: Number(artifactCount),
      openIssueCount: Number(openIssueCount),
      activeLockCount: Number(activeLockCount),
      sessionCount: Number(sessionCount)
    };
  }

  function workspaceAccess(input: WorkspaceInput = {}) {
    const metadata = asObject(input.metadata);
    const actorIds = uniqueStrings([
      input.actorUserId,
      input.userId,
      input.subjectId,
      input.username,
      metadata.actorUserId,
      metadata.userId,
      metadata.subjectId,
      metadata.username
    ]);
    const allowedWorkspaceIds = new Set(uniqueStrings([
      ...asArray(input.allowedWorkspaceIds)
    ]));
    const canAccessAll = input.canAccessAll === true || (defaultCanAccessAll === true && input.canAccessAll !== false);
    return {
      actorUserId: actorIds[0] || "",
      actorIds,
      allowedWorkspaceIds,
      canAccessAll,
      sharingMode: String(input.sharingMode || (canAccessAll ? "admin" : "owner-bound")).trim()
    };
  }

  function canAccessWorkspace(workspace: WorkspaceRecord | null, input: WorkspaceInput = {}): boolean {
    if (!workspace) {
      return false;
    }
    const access = workspaceAccess(input);
    if (access.canAccessAll) {
      return true;
    }
    const workspaceId = String(workspace.workspaceId || "").trim();
    if (workspaceId && access.allowedWorkspaceIds.has(workspaceId)) {
      return true;
    }
    const metadata = asObject(workspace.metadata);
    const ownerUserId = String(workspace.ownerUserId || metadata.ownerUserId || "").trim();
    const allowedUserIds = uniqueStrings([
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
    return access.actorIds.some((actorId) => allowedUserIds.includes(actorId));
  }

  function canAccessWorkspaceId(workspaceId: unknown, input: WorkspaceInput = {}): boolean {
    const workspace = hydrateWorkspace(
      selectWorkspaceStmt.get(String(workspaceId || "")) as Parameters<typeof hydrateWorkspace>[0]
    );
    return canAccessWorkspace(workspace, input);
  }

  function workspaceFsRoot(workspace: WorkspaceRecord): string {
    const fsPath = workspace?.fsPath || path.join(rootPath, "folders", String(workspace?.workspaceId || ""));
    const resolved = path.resolve(fsPath);
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }

  function workspaceFsRootForMaterialization(workspace: WorkspaceRecord): string {
    const fsPath = workspace?.fsPath ||
      path.join(rootPath, "folders", String(workspace?.workspaceId || ""));
    const resolved = path.resolve(fsPath);
    const foldersRoot = path.resolve(foldersRootPath);
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
      let stat: fs.BigIntStats;
      try {
        stat = fs.lstatSync(candidate, { bigint: true });
      } catch (error: unknown) {
        if (errorCode(error) === "ENOENT") {
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
      const mode = Number(stat.mode & 0o7777n);
      const expectedUid = process.geteuid?.();
      const expectedGid = process.getegid?.();
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
    const realFoldersRoot = fs.realpathSync(foldersRoot);
    const realWorkspaceRoot = fs.realpathSync(resolved);
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

  async function withWorkspaceMutation<Result>(workspaceId: unknown, task: () => Result | Promise<Result>): Promise<Result> {
    const normalizedWorkspaceId = String(workspaceId || "").trim();
    if (!normalizedWorkspaceId || typeof task !== "function") {
      throw new TypeError("Workspace mutation identity and task are required.");
    }
    return queueStateMutation(
      `agent-workspace-files:${path.resolve(rootPath)}:${normalizedWorkspaceId}`,
      task
    );
  }

  function resolveWorkspacePath(workspace: WorkspaceRecord, relativePath: unknown = "", options: { allowEmpty?: boolean; allowMissing?: boolean; requireExisting?: boolean; allowDirectory?: boolean; allowFile?: boolean } = {}) {
    const root = workspaceFsRoot(workspace);
    const normalized = normalizeWorkspaceRelativePath(relativePath, { allowEmpty: options.allowEmpty === true });
    const target = normalized ? path.resolve(root, ...normalized.split("/")) : root;
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

  function workspaceForStorage(input: WorkspaceInput = {}): WorkspaceAccessResult {
    const workspaceId = String(input.workspaceId || input.workspace_id || input.id || "").trim();
    const workspace = hydrateWorkspace(selectWorkspaceRawStmt.get(workspaceId) as Parameters<typeof hydrateWorkspace>[0]);
    if (!workspace) {
      return { ok: false, status: 404, error: "工作空间不存在或不可访问。" };
    }
    if (!canAccessWorkspace(workspace, input)) {
      return { ok: false, status: 403, error: "工作空间不可访问。" };
    }
    return { ok: true, workspace };
  }

  function workspaceForMaterialization(input: WorkspaceInput = {}): WorkspaceAccessResult {
    const rawWorkspaceId = typeof input.workspaceId === "string"
      ? input.workspaceId
      : "";
    const workspaceId = rawWorkspaceId.trim();
    if (!workspaceId || workspaceId !== rawWorkspaceId) {
      return {
        ok: false,
        status: 400,
        code: "materialization_workspace_required",
        error: "Workspace materialization requires one workspace identity."
      };
    }
    const workspace = hydrateWorkspace(selectWorkspaceRawStmt.get(workspaceId) as Parameters<typeof hydrateWorkspace>[0]);
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

  function createAccessReceipt(input: WorkspaceInput = {}) {
    const workspaceId = String(input.workspaceId || "");
    const operationId = String(input.operationId || "");
    const receiptPath = String(input.path || "");
    const action = String(input.action || "read");
    const createdAt = nowIso();
    const eventHash = stableHash("access-receipt", workspaceId, operationId, receiptPath, action, createdAt);
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

  const sessionApi = createAgentWorkspaceSessionApi({
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
    getWorkspaceRow: (workspaceId?: unknown) => selectWorkspaceRawStmt.get(String(workspaceId || ""))
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

  const recordsApi = createAgentWorkspaceRecordsApi({
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
  } as Parameters<typeof createAgentWorkspaceRecordsApi>[0]);
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
    acquireLock,
    releaseLock,
    listLocks,
    getWorkspace,
    adminReleaseLock,
    close
  } = recordsApi;

  let readFileApi!: ReturnType<typeof createAgentWorkspaceFileReadApi>;
  const readFileResolveWorkspacePath: NonNullable<FileReadOptions["resolveWorkspacePath"]> =
    (workspace, relativePath, options) => resolveWorkspacePath(
      workspace as WorkspaceRecord,
      relativePath,
      options
    );
  const fileStateApi = createAgentWorkspaceFileStateApi({
    merkleState,
    checkpointTreeApi,
    resolveWorkspacePath,
    listWorkspaceFiles: (...args: Parameters<typeof readFileApi.listWorkspaceFiles>) => readFileApi.listWorkspaceFiles(...args)
  } as Parameters<typeof createAgentWorkspaceFileStateApi>[0]);
  readFileApi = createAgentWorkspaceFileReadApi({
    workspaceForStorage,
    resolveWorkspacePath: readFileResolveWorkspacePath,
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

  const writeFileApi = createAgentWorkspaceFileWriteApi({
    workspaceForStorage,
    resolveWorkspacePath,
    updateWorkspaceTimeStmt,
    createArtifact,
    fileStateApi
  } as Parameters<typeof createAgentWorkspaceFileWriteApi>[0]);
  const {
    uploadWorkspaceFile: uploadWorkspaceFileUnlocked,
    writeWorkspaceFile: writeWorkspaceFileUnlocked,
    patchWorkspaceFile: patchWorkspaceFileUnlocked,
    deleteWorkspaceFile: deleteWorkspaceFileUnlocked,
    moveWorkspaceFile: moveWorkspaceFileUnlocked
  } = writeFileApi;
  const serializeWorkspaceMutation = <Result>(method: (input: WorkspaceInput) => Result) => (input: WorkspaceInput = {}) =>
    withWorkspaceMutation(
      String(input.workspaceId || input.workspace_id || input.id || ""),
      () => method(input)
    );
  const createWorkspaceFolder = serializeWorkspaceMutation(
    createWorkspaceFolderUnlocked
  );
  const uploadWorkspaceFile = serializeWorkspaceMutation(
    uploadWorkspaceFileUnlocked
  );
  const writeWorkspaceFile = serializeWorkspaceMutation(
    writeWorkspaceFileUnlocked
  );
  const patchWorkspaceFile = serializeWorkspaceMutation(
    patchWorkspaceFileUnlocked
  );
  const deleteWorkspaceFile = serializeWorkspaceMutation(
    deleteWorkspaceFileUnlocked
  );
  const moveWorkspaceFile = serializeWorkspaceMutation(
    moveWorkspaceFileUnlocked
  );

  async function workspaceRevisionForAccess(access: Extract<WorkspaceAccessResult, { ok: true }>) {
    if (!merkleState?.stateCommit?.begin || !merkleState?.stateCommit?.commit) {
      return { ok: false, status: 503, error: "Workspace revision authority is unavailable." };
    }
    const scope = fileStateApi.workspaceStateScope(access.workspace);
    let state = await merkleState.stateCommit.begin({ scope });
    if (!String(state.currentRoot || "")) {
      const initialized = await merkleState.stateCommit.commit({
        scope,
        operationId: "workspace.revision.initialize",
        mutations: [],
        payload: { action: "revision.initialize", workspaceId: access.workspace.workspaceId }
      });
      state = { currentRoot: asObject(initialized).afterRoot };
    }
    return { ok: true, workspaceId: access.workspace.workspaceId, revision: String(state.currentRoot || "") };
  }

  async function workspaceFileRevision(input: WorkspaceInput = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) return access;
    return workspaceRevisionForAccess(access);
  }

  async function workspaceMaterializationRevision(input: WorkspaceInput = {}) {
    const access = workspaceForMaterialization(input);
    if (!access.ok) return access;
    if (!merkleState?.stateCommit?.begin) {
      return {
        ok: false,
        status: 503,
        code: "materialization_revision_unavailable",
        error: "Workspace revision authority is unavailable."
      };
    }
    const state = await merkleState.stateCommit.begin({
      scope: fileStateApi.workspaceStateScope(access.workspace)
    });
    const revision = String(state?.currentRoot || "");
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

  async function captureWorkspaceFileSnapshotForAccess(access: Extract<WorkspaceAccessResult, { ok: true }>, input: WorkspaceInput = {}) {
    const requestedPaths = uniqueStrings(asArray(input.paths).map((entry) =>
      normalizeWorkspaceRelativePath(entry, { allowEmpty: false })
    ));
    let snapshot: JsonRecord | Awaited<ReturnType<typeof fileStateApi.buildWorkspaceFileSnapshot>>;
    if (requestedPaths.length > 0) {
      if (!merkleState?.cas?.putBlock) {
        return { ok: false, status: 503, error: "Workspace snapshot authority is unavailable." };
      }
      const files: JsonRecord[] = [];
      const state = await merkleState.stateCommit.begin({ scope: fileStateApi.workspaceStateScope(access.workspace) });
      const latestEvents = await merkleState.eventLog?.listEvents(fileStateApi.workspaceStateScope(access.workspace), { limit: 1 }) || [];
      for (const relativePath of requestedPaths) {
        await input.leaseGuard?.();
        let resolved: ReturnType<typeof resolveWorkspacePath>;
        try {
          resolved = resolveWorkspacePath(access.workspace, relativePath, { allowEmpty: false });
        } catch (error: unknown) {
          if (/symbolic link|符号链接/iu.test(error instanceof Error ? error.message : "")) {
            return { ok: false, status: 409, error: "Workspace snapshot target must not be a symbolic link." };
          }
          throw error;
        }
        let handle: fsPromises.FileHandle;
        try {
          handle = await fsPromises.open(resolved.absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        } catch (error: unknown) {
          if (errorCode(error) === "ELOOP") {
            return { ok: false, status: 409, error: "Workspace snapshot target must not be a symbolic link." };
          }
          if (errorCode(error) !== "ENOENT") throw error;
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
        let stat: fs.Stats;
        let content: Buffer;
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
        const block = await merkleState.cas.putBlock(content, {
          codec: "raw",
          metadata: { workspaceId: access.workspace.workspaceId, relativePath, snapshot: true }
        });
        files.push({ relativePath, exists: true, contentCid: block.cid, contentSha256: block.payloadHash, byteLength: block.byteLength, encoding: "base64" });
        await input.leaseGuard?.();
      }
      const finalState = await merkleState.stateCommit.begin({ scope: fileStateApi.workspaceStateScope(access.workspace) });
      const finalEvents = await merkleState.eventLog?.listEvents(fileStateApi.workspaceStateScope(access.workspace), { limit: 1 }) || [];
      const firstEvent = latestEvents[0] || null;
      const finalEvent = finalEvents[0] || null;
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
        basePath: String(input.basePath || ""),
        deleteExtraneous: input.deleteExtraneous !== false
      });
    }
    return snapshot
      ? { ok: true, workspaceId: access.workspace.workspaceId, snapshot }
      : { ok: false, status: 503, error: "Workspace snapshot authority is unavailable." };
  }

  async function captureWorkspaceFileSnapshot(input: WorkspaceInput = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) return access;
    return captureWorkspaceFileSnapshotForAccess(access, input);
  }

  async function captureWorkspaceMaterializationSnapshot(input: WorkspaceInput = {}) {
    const access = workspaceForMaterialization(input);
    if (!access.ok) return access;
    const logicalTarget = normalizeWorkspaceRelativePath(
      input.logicalTarget,
      { allowEmpty: false }
    );
    const revision = await workspaceMaterializationRevision({
      workspaceId: access.workspace.workspaceId
    });
    if (!revision.ok) return revision;
    const events = await merkleState?.eventLog?.listEvents(
      fileStateApi.workspaceStateScope(access.workspace),
      { limit: 1 }
    ) || [];
    const anchor = events[0] || null;
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
    const materializationWorkspaceForStorage = (input: { workspaceId: string }) =>
      workspaceForMaterialization(input) as WorkspaceAccessResult & { workspace: WorkspaceRecord };
    const materializationMerkleState: MaterializationOptions["merkleState"] = merkleState || undefined;
    bindAgentWorkspaceMaterializationRootPort(
      materializationRootAuthority,
      () => createAgentWorkspaceMaterializationPort({
        workspaceForMaterialization: materializationWorkspaceForStorage,
        workspaceFsRoot: workspaceFsRootForMaterialization,
        workspaceFileRevision: workspaceMaterializationRevision,
        captureWorkspaceMaterializationSnapshot,
        withWorkspaceMutation,
        fileStateApi,
        merkleState: materializationMerkleState,
        updateWorkspaceTimeStmt
      } as Parameters<typeof createAgentWorkspaceMaterializationPort>[0])
    );
  }

  let syncApi!: ReturnType<typeof createAgentWorkspaceSyncApi>;
  const localDirectoryApi = controlledLocalDirectoryHostEnabled
    ? createAgentWorkspaceLocalDirectoryApi({
        userDataPath,
        localDirectoryMountConfigPath,
        workspaceForStorage,
        createAccessReceipt,
        localDirectorySyncPlan: (...args: Parameters<typeof syncApi.localDirectorySyncPlan>) => syncApi.localDirectorySyncPlan(...args),
        decodeWorkspaceFileContent: fileStateApi.decodeWorkspaceFileContent,
        updateWorkspaceTimeStmt,
        merkleState,
        fileStateApi
      } as Parameters<typeof createAgentWorkspaceLocalDirectoryApi>[0])
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
  } as Parameters<typeof createAgentWorkspaceSyncApi>[0]);
  const {
    localDirectorySyncPlan,
    applyLocalDirectorySync: applyLocalDirectorySyncUnlocked,
    restoreWorkspaceFiles: restoreWorkspaceFilesUnlocked
  } = syncApi;
  const applyLocalDirectorySync = serializeWorkspaceMutation(
    applyLocalDirectorySyncUnlocked
  );
  const restoreWorkspaceFiles = serializeWorkspaceMutation(
    restoreWorkspaceFilesUnlocked
  );

  async function getWorkspaceSandboxMutationReceipt(input: WorkspaceInput = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) return access;
    const commitId = String(input.commitId || input.stateCommitId || "").trim();
    if (!commitId || !checkpointTreeApi?.loadCheckpointTree || !merkleState?.eventLog?.listEvents) {
      return { ok: false, status: commitId ? 503 : 400, error: "Workspace mutation receipt authority is unavailable." };
    }
    const treeId = fileStateApi.workspaceCheckpointTreeId(access.workspace);
    const tree = asObject(await checkpointTreeApi.loadCheckpointTree({ treeId }));
    const checkpoint = asObject(asObject(tree.nodes)[`commit:${commitId}`]);
    const metadata = asObject(checkpoint.metadata);
    const stateCommit = asObject(metadata.stateCommit);
    const mutationOrigin = asObject(metadata.mutationOrigin);
    const events = await merkleState.eventLog.listEvents(fileStateApi.workspaceStateScope(access.workspace), { limit: 10_000 });
    const event = events.find((candidate) => {
      const eventRecord = asObject(candidate);
      return (stateCommit.eventId && String(eventRecord.eventId || "") === String(stateCommit.eventId)) ||
        (stateCommit.eventHash && String(eventRecord.eventHash || "") === String(stateCommit.eventHash));
    });
    const eventOrigin = asObject(asObject(event?.payload).mutationOrigin);
    const supersededByCompensation = events.some((candidate) =>
      String(asObject(candidate.payload).failedCommitId || "") === commitId
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
    const preimage = metadata.workspaceFilePreimageSnapshot || null;
    if (!preimage) {
      return { ok: false, status: 409, error: "Workspace mutation receipt preimage binding is missing." };
    }
    const receipt: JsonRecord = {
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
  const contextApi = createAgentWorkspaceContextApi({
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
  const deleteWorkspace = deleteWorkspaceUnlocked;

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
    ...(localDirectoryApi ? {
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
    openWorkspaceCollaboration: (input: WorkspaceInput = {}) =>
      createWorkspaceReferenceMigration(input),
    getWorkspaceSandboxMutationReceipt,
    getWorkspaceRefactorInstrumentation: () =>
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
