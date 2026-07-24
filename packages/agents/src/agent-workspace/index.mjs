import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import { getRuntimeLogger } from "@meshrix/foundation/observability/runtime-logger";
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
} from "./agent-workspace-support.mjs";
import { createAgentWorkspaceLocalDirectoryApi } from "./agent-workspace-local-directory.mjs";
import { ensureAgentWorkspaceSchema, prepareAgentWorkspaceStatements } from "./agent-workspace-db.mjs";
import { createAgentWorkspaceSessionApi } from "./agent-workspace-sessions.mjs";
import { createAgentWorkspaceContextApi } from "./agent-workspace-context-api.mjs";
import { createAgentWorkspaceRecordsApi } from "./agent-workspace-records.mjs";
import { createAgentWorkspaceFileStateApi } from "./agent-workspace-file-state.mjs";
import { createAgentWorkspaceFileReadApi } from "./agent-workspace-file-read-api.mjs";
import { createAgentWorkspaceFileWriteApi } from "./agent-workspace-file-write-api.mjs";
import { createAgentWorkspaceSyncApi } from "./agent-workspace-sync.mjs";

export {
  AGENT_WORKSPACE_PROTOCOL_VERSION,
  AGENT_WORKSPACE_CONTEXT_BUNDLE_VERSION,
  AGENT_SESSION_THREAD_VERSION
} from "./agent-workspace-support.mjs";

function withOwnedAgentWorkspaceDatabase(databasePath, construct) {
  let db = null;
  try {
    db = openSqliteDatabase(databasePath);
    return construct(db);
  } catch (error) {
    try {
      db?.close?.();
    } catch {
      // Preserve the construction failure while still attempting local cleanup.
    }
    throw error;
  }
}

export function createAgentWorkspace({
  userDataPath,
  merkleState = null,
  checkpointTreeApi = null,
  defaultCanAccessAll = false,
  controlledLocalDirectoryHostEnabled = false
}) {
  if (typeof controlledLocalDirectoryHostEnabled !== "boolean") {
    throw new TypeError("Controlled local-directory Host enablement must be a boolean.");
  }
  const rootPath = path.join(userDataPath, "agent-workspaces");
  fs.mkdirSync(rootPath, { recursive: true });
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

  function workspaceSummary(workspaceId) {
    const runCount = db.prepare("SELECT COUNT(*) AS count FROM aw_runs WHERE workspace_id = ?").get(workspaceId)?.count || 0;
    const submissionRows = db.prepare("SELECT status, COUNT(*) AS count FROM aw_submissions WHERE workspace_id = ? GROUP BY status").all(workspaceId);
    const artifactCount = db.prepare("SELECT COUNT(*) AS count FROM aw_artifacts WHERE workspace_id = ?").get(workspaceId)?.count || 0;
    const openIssueCount = db.prepare("SELECT COUNT(*) AS count FROM aw_issues WHERE workspace_id = ? AND status != 'resolved'").get(workspaceId)?.count || 0;
    const activeLockCount = db.prepare("SELECT COUNT(*) AS count FROM aw_locks WHERE workspace_id = ? AND expires_at > ?").get(workspaceId, nowIso())?.count || 0;
    const sessionCount = db.prepare("SELECT COUNT(*) AS count FROM aw_sessions WHERE workspace_id = ?").get(workspaceId)?.count || 0;
    const submissionCounts = Object.fromEntries(submissionRows.map((row) => [row.status, Number(row.count || 0)]));
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

  function workspaceAccess(input = {}) {
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

  function canAccessWorkspace(workspace, input = {}) {
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

  function canAccessWorkspaceId(workspaceId, input = {}) {
    const workspace = hydrateWorkspace(selectWorkspaceStmt.get(String(workspaceId || "")));
    return canAccessWorkspace(workspace, input);
  }

  function workspaceFsRoot(workspace) {
    const fsPath = workspace?.fsPath || path.join(rootPath, "folders", String(workspace?.workspaceId || ""));
    const resolved = path.resolve(fsPath);
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }

  function resolveWorkspacePath(workspace, relativePath = "", options = {}) {
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

  function workspaceForStorage(input = {}) {
    const workspaceId = String(input.workspaceId || input.workspace_id || input.id || "").trim();
    const workspace = hydrateWorkspace(selectWorkspaceRawStmt.get(workspaceId));
    if (!workspace) {
      return { ok: false, status: 404, error: "工作空间不存在或不可访问。" };
    }
    if (!canAccessWorkspace(workspace, input)) {
      return { ok: false, status: 403, error: "工作空间不可访问。" };
    }
    return { ok: true, workspace };
  }

  function createAccessReceipt({ workspaceId = "", operationId = "", path: receiptPath = "", action = "read" } = {}) {
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
    getWorkspaceRow: (workspaceId) => selectWorkspaceRawStmt.get(String(workspaceId || ""))
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
    ensureRootSessionForWorkspace
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

  let readFileApi;
  const fileStateApi = createAgentWorkspaceFileStateApi({
    merkleState,
    checkpointTreeApi,
    resolveWorkspacePath,
    listWorkspaceFiles: (...args) => readFileApi.listWorkspaceFiles(...args)
  });
  readFileApi = createAgentWorkspaceFileReadApi({
    workspaceForStorage,
    resolveWorkspacePath,
    createAccessReceipt,
    updateWorkspaceTimeStmt,
    fileStateApi
  });
  const {
    createWorkspaceFolder,
    listWorkspaceFiles,
    workspaceFileMetadata,
    downloadWorkspaceFile
  } = readFileApi;

  const writeFileApi = createAgentWorkspaceFileWriteApi({
    workspaceForStorage,
    resolveWorkspacePath,
    updateWorkspaceTimeStmt,
    createArtifact,
    fileStateApi
  });
  const {
    uploadWorkspaceFile,
    writeWorkspaceFile,
    patchWorkspaceFile,
    deleteWorkspaceFile,
    moveWorkspaceFile
  } = writeFileApi;

  async function workspaceFileRevision(input = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) return access;
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
      state = { currentRoot: initialized.afterRoot };
    }
    return { ok: true, workspaceId: access.workspace.workspaceId, revision: String(state.currentRoot || "") };
  }

  async function captureWorkspaceFileSnapshot(input = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) return access;
    const requestedPaths = uniqueStrings(asArray(input.paths).map((entry) =>
      normalizeWorkspaceRelativePath(entry, { allowEmpty: false })
    ));
    let snapshot;
    if (requestedPaths.length > 0) {
      if (!merkleState?.cas?.putBlock) {
        return { ok: false, status: 503, error: "Workspace snapshot authority is unavailable." };
      }
      const files = [];
      const state = await merkleState.stateCommit.begin({ scope: fileStateApi.workspaceStateScope(access.workspace) });
      const latestEvents = await merkleState.eventLog?.listEvents?.(fileStateApi.workspaceStateScope(access.workspace), { limit: 1 }) || [];
      for (const relativePath of requestedPaths) {
        await input.leaseGuard?.();
        let resolved;
        try {
          resolved = resolveWorkspacePath(access.workspace, relativePath, { allowEmpty: false });
        } catch (error) {
          if (/symbolic link|符号链接/iu.test(String(error?.message || ""))) {
            return { ok: false, status: 409, error: "Workspace snapshot target must not be a symbolic link." };
          }
          throw error;
        }
        let handle;
        try {
          handle = await fsPromises.open(resolved.absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        } catch (error) {
          if (error?.code === "ELOOP") {
            return { ok: false, status: 409, error: "Workspace snapshot target must not be a symbolic link." };
          }
          if (error?.code !== "ENOENT") throw error;
          files.push({ relativePath, exists: false, contentCid: "", contentSha256: "", byteLength: 0, encoding: "base64" });
          await input.leaseGuard?.();
          continue;
        }
        let stat;
        let content;
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
      const finalEvents = await merkleState.eventLog?.listEvents?.(fileStateApi.workspaceStateScope(access.workspace), { limit: 1 }) || [];
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
        basePath: input.basePath || "",
        deleteExtraneous: input.deleteExtraneous !== false
      });
    }
    return snapshot
      ? { ok: true, workspaceId: access.workspace.workspaceId, snapshot }
      : { ok: false, status: 503, error: "Workspace snapshot authority is unavailable." };
  }

  let syncApi;
  const localDirectoryApi = controlledLocalDirectoryHostEnabled
    ? createAgentWorkspaceLocalDirectoryApi({
        userDataPath,
        localDirectoryMountConfigPath,
        workspaceForStorage,
        createAccessReceipt,
        localDirectorySyncPlan: (...args) => syncApi.localDirectorySyncPlan(...args),
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
    applyLocalDirectorySync,
    restoreWorkspaceFiles
  } = syncApi;

  async function getWorkspaceSandboxMutationReceipt(input = {}) {
    const access = workspaceForStorage(input);
    if (!access.ok) return access;
    const commitId = String(input.commitId || input.stateCommitId || "").trim();
    if (!commitId || !checkpointTreeApi?.loadCheckpointTree || !merkleState?.eventLog?.listEvents) {
      return { ok: false, status: commitId ? 503 : 400, error: "Workspace mutation receipt authority is unavailable." };
    }
    const treeId = fileStateApi.workspaceCheckpointTreeId(access.workspace);
    const tree = await checkpointTreeApi.loadCheckpointTree({ treeId });
    const checkpoint = tree?.nodes?.[`commit:${commitId}`] || null;
    const metadata = asObject(checkpoint?.metadata);
    const stateCommit = asObject(metadata.stateCommit);
    const mutationOrigin = asObject(metadata.mutationOrigin);
    const events = await merkleState.eventLog.listEvents(fileStateApi.workspaceStateScope(access.workspace), { limit: 10_000 });
    const event = events.find((candidate) =>
      (stateCommit.eventId && String(candidate.eventId || "") === String(stateCommit.eventId)) ||
      (stateCommit.eventHash && String(candidate.eventHash || "") === String(stateCommit.eventHash))
    );
    const eventOrigin = asObject(event?.payload?.mutationOrigin);
    const supersededByCompensation = events.some((candidate) =>
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
    const preimage = metadata.workspaceFilePreimageSnapshot || null;
    if (!preimage) {
      return { ok: false, status: 409, error: "Workspace mutation receipt preimage binding is missing." };
    }
    const receipt = {
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
    deleteWorkspace
  } = contextApi;

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
    getWorkspaceSandboxMutationReceipt,
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
