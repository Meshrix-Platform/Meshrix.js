import fs from "node:fs";
import path from "node:path";
import {
  AGENT_WORKSPACE_PROTOCOL_VERSION,
  asArray,
  asObject,
  gateSubmission,
  hydrateArtifact,
  hydrateDecision,
  hydrateIssue,
  hydrateLock,
  hydratePrivateState,
  hydrateRun,
  hydrateSubmission,
  hydrateWorkspace,
  projectWorkspace,
  normalizeEvidenceRefs,
  normalizeText,
  nowIso,
  optionalLimit,
  stableHash,
  stableId,
  stringifyJson,
  submissionSummary,
  uniqueStrings
} from "./agent-workspace-support.mjs";

export function createAgentWorkspaceRecordsApi({
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
} = {}) {
  let closed = false;
  function listWorkspaces(input = {}) {
    const limit = Math.max(1, Math.min(Number(input.limit || 50), 500));
    const status = String(input.status || "").trim();
    const includeSummary = input.includeSummary !== false;
    const rows = status
      ? listWorkspacesByStatusStmt.all(status, limit)
      : listWorkspacesStmt.all(limit);
    const access = workspaceAccess(input);
    const workspaces = rows.map(hydrateWorkspace).filter((workspace) => canAccessWorkspace(workspace, input));
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      sharingMode: access.sharingMode,
      workspaces: workspaces.map((workspace) => ({
        ...projectWorkspace(workspace),
        summary: includeSummary ? workspaceSummary(workspace.workspaceId) : undefined
      })),
      count: workspaces.length
    };
  }

  function createWorkspace(input = {}) {
    const timestamp = nowIso();
    const workspaceId =
      String(input.workspaceId || "").trim() ||
      stableId("workspace", input.title || "", input.objective || "", timestamp);
    const workspaceFolderId = stableId("workspace-folder", workspaceId);
    const fsPath = path.join(rootPath, "folders", workspaceFolderId);
    fs.mkdirSync(fsPath, { recursive: true });
    const ownerUserId = String(
      input.ownerUserId || input.owner_user_id || input.userId || input.actorUserId || input.subjectId || input.username || ""
    ).trim();
    const defaultAdminUserId = String(input.defaultAdminUserId || input.adminUserId || ownerUserId || "").trim();
    const inputMetadata = asObject(input.metadata);
    const workspace = {
      workspaceId,
      title: normalizeText(input.title || "Gateway Agent Workspace") || "Gateway Agent Workspace",
      objective: normalizeText(input.objective || input.query || ""),
      status: String(input.status || "active"),
      ownerUserId,
      metadata: {
        ...inputMetadata,
        defaultAdminUserId,
        adminUserIds: uniqueStrings([
          ...asArray(inputMetadata.adminUserIds),
          ...asArray(inputMetadata.administrators),
          defaultAdminUserId
        ])
      },
      createdAt: input.createdAt || timestamp,
      updatedAt: timestamp,
      fsPath
    };
    insertWorkspaceStmt.run(
      workspace.workspaceId,
      workspace.title,
      workspace.objective,
      workspace.status,
      workspace.ownerUserId,
      stringifyJson(workspace.metadata),
      workspace.createdAt,
      workspace.updatedAt,
      workspace.fsPath
    );
    // Re-read from DB to capture new columns (profile, ownedSourceIds, etc.)
    const persisted = hydrateWorkspace(selectWorkspaceStmt.get(workspace.workspaceId)) || workspace;
    ensureRootSessionForWorkspace(persisted);
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      workspace: projectWorkspace(persisted)
    };
  }

  function createRun(input = {}) {
    const timestamp = nowIso();
    const runId = String(input.runId || "").trim() || stableId("run", input.workspaceId || "", input.runType || "", timestamp);
    const run = {
      runId,
      workspaceId: String(input.workspaceId || ""),
      runType: String(input.runType || "multi_agent"),
      status: String(input.status || "queued"),
      input: asObject(input.input),
      steps: asArray(input.steps),
      coverage: asObject(input.coverage),
      artifactIds: asArray(input.artifactIds),
      error: String(input.error || ""),
      degraded: input.degraded === true,
      createdAt: input.createdAt || timestamp,
      updatedAt: timestamp,
      startedAt: input.startedAt || "",
      completedAt: input.completedAt || ""
    };
    insertRunStmt.run(
      run.runId,
      run.workspaceId,
      run.runType,
      run.status,
      stringifyJson(run.input),
      stringifyJson(run.steps, []),
      stringifyJson(run.coverage),
      stringifyJson(run.artifactIds, []),
      run.error,
      run.degraded ? 1 : 0,
      run.createdAt,
      run.updatedAt,
      run.startedAt,
      run.completedAt
    );
    updateWorkspaceTimeStmt.run(timestamp, run.workspaceId);
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      run
    };
  }

  function updateRun(runId, patch = {}) {
    const current = hydrateRun(selectRunStmt.get(String(runId || "")));
    if (!current) {
      return null;
    }
    const timestamp = nowIso();
    const next = {
      ...current,
      ...patch,
      input: patch.input === undefined ? current.input : patch.input,
      steps: patch.steps === undefined ? current.steps : patch.steps,
      coverage: patch.coverage === undefined ? current.coverage : patch.coverage,
      artifactIds: patch.artifactIds === undefined ? current.artifactIds : patch.artifactIds,
      degraded: patch.degraded === undefined ? current.degraded : patch.degraded === true,
      updatedAt: timestamp
    };
    insertRunStmt.run(
      next.runId,
      next.workspaceId,
      next.runType,
      next.status,
      stringifyJson(next.input),
      stringifyJson(next.steps, []),
      stringifyJson(next.coverage),
      stringifyJson(next.artifactIds, []),
      next.error || "",
      next.degraded ? 1 : 0,
      next.createdAt,
      next.updatedAt,
      next.startedAt || "",
      next.completedAt || ""
    );
    updateWorkspaceTimeStmt.run(timestamp, next.workspaceId);
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      run: next
    };
  }

  function getRun(runId) {
    return hydrateRun(selectRunStmt.get(String(runId || "")));
  }

  function savePrivateState(input = {}) {
    const timestamp = nowIso();
    const id = stableId(
      "private",
      input.workspaceId || "",
      input.runId || "",
      input.agentId || ""
    );
    insertPrivateStmt.run(
      id,
      String(input.workspaceId || ""),
      String(input.runId || ""),
      String(input.agentId || ""),
      normalizeText(input.summary || "").slice(0, 4000),
      stringifyJson(asObject(input.state)),
      timestamp
    );
    updateWorkspaceTimeStmt.run(timestamp, String(input.workspaceId || ""));
    return hydratePrivateState(db.prepare("SELECT * FROM aw_private_state WHERE id = ?").get(id));
  }

  function submit(input = {}) {
    const payload = asObject(input.payload);
    const type = String(input.type || payload.type || "").trim();
    const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs, payload);
    const duplicateKey = stableHash(
      type,
      submissionSummary(type, payload).toLowerCase(),
      evidenceRefs.join("|")
    );
    const existingDuplicate = selectDuplicateStmt.get(
      String(input.workspaceId || ""),
      type,
      duplicateKey
    );
    const gate = gateSubmission({
      existingDuplicate,
      submission: {
        type,
        payload,
        evidenceRefs,
        confidence: input.confidence ?? payload.confidence
      },
      writePolicy: asObject(input.writePolicy)
    });
    const timestamp = nowIso();
    const submissionId =
      String(input.submissionId || "").trim() ||
      stableId("submission", input.workspaceId || "", input.runId || "", input.agentId || "", type, duplicateKey, timestamp);
    insertSubmissionStmt.run(
      submissionId,
      String(input.workspaceId || ""),
      String(input.runId || ""),
      String(input.agentId || ""),
      type,
      gate.status,
      gate.confidence,
      duplicateKey,
      stringifyJson(payload),
      stringifyJson(gate.evidenceRefs, []),
      stringifyJson(gate),
      timestamp,
      timestamp
    );
    updateWorkspaceTimeStmt.run(timestamp, String(input.workspaceId || ""));
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      submission: hydrateSubmission(db.prepare("SELECT * FROM aw_submissions WHERE submission_id = ?").get(submissionId))
    };
  }

  function resolveSubmission(input = {}) {
    const submissionId = String(input.submissionId || "").trim();
    const current = hydrateSubmission(selectSubmissionStmt.get(submissionId));
    if (!current) {
      return null;
    }
    if (input.workspaceId && current.workspaceId !== String(input.workspaceId)) {
      return null;
    }
    if (!canAccessWorkspaceId(current.workspaceId, input)) {
      return null;
    }
    const allowed = new Set(["accepted", "rejected", "needs_review", "proposed"]);
    const rawStatus = String(input.status || input.action || "").trim();
    const rawResolution = String(input.resolution || "").trim();
    const normalizedDecision = (rawStatus || rawResolution).toLowerCase();
    const status = allowed.has(rawStatus)
      ? rawStatus
      : ["accept", "accepted", "approve", "approved"].includes(normalizedDecision)
        ? "accepted"
        : ["reject", "rejected", "deny", "denied"].includes(normalizedDecision)
          ? "rejected"
          : "needs_review";
    const timestamp = nowIso();
    const gate = {
      ...(current.gate || {}),
      reviewedRequired: status === "needs_review",
      resolvedBy: String(input.reviewerId || input.agentId || input.clientId || ""),
      resolvedAt: timestamp,
      resolutionNote: normalizeText(input.note || input.reason || "").slice(0, 1000),
      previousStatus: current.status
    };
    updateSubmissionStatusStmt.run(status, stringifyJson(gate), timestamp, submissionId);
    updateWorkspaceTimeStmt.run(timestamp, current.workspaceId);
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      submission: hydrateSubmission(selectSubmissionStmt.get(submissionId))
    };
  }

  function createArtifact(input = {}) {
    const timestamp = nowIso();
    const runId = String(input.runId || "");
    const artifactId =
      String(input.artifactId || "").trim() ||
      stableId("artifact", input.workspaceId || "", runId, input.level || "", input.title || "", timestamp);
    const current = db.prepare("SELECT * FROM aw_artifacts WHERE artifact_id = ?").get(artifactId);
    const revision = current ? Number(current.revision || 1) + 1 : Number(input.revision || 1);
    insertArtifactStmt.run(
      artifactId,
      String(input.workspaceId || ""),
      runId,
      String(input.level || "Artifact"),
      normalizeText(input.title || "Untitled Artifact") || "Untitled Artifact",
      String(input.content || ""),
      stringifyJson(asArray(input.citations), []),
      stringifyJson(asObject(input.coverageReport || input.coverage), {}),
      revision,
      String(input.status || "draft"),
      String(input.createdBy || input.agentId || ""),
      input.createdAt || timestamp,
      timestamp
    );
    const run = getRun(runId);
    if (run) {
      updateRun(runId, {
        artifactIds: [...new Set([...run.artifactIds, artifactId])]
      });
    }
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      artifact: hydrateArtifact(db.prepare("SELECT * FROM aw_artifacts WHERE artifact_id = ?").get(artifactId))
    };
  }

  function updateArtifactsStatus(runId, status) {
    const timestamp = nowIso();
    db.prepare("UPDATE aw_artifacts SET status = ?, updated_at = ? WHERE run_id = ?").run(
      String(status || "draft"),
      timestamp,
      String(runId || "")
    );
    return listRunArtifacts(runId);
  }

  function createIssue(input = {}) {
    const timestamp = nowIso();
    const issueId =
      String(input.issueId || "").trim() ||
      stableId("issue", input.workspaceId || "", input.runId || "", input.title || "", timestamp);
    insertIssueStmt.run(
      issueId,
      String(input.workspaceId || ""),
      String(input.runId || ""),
      String(input.type || "issue"),
      String(input.status || "open"),
      String(input.severity || "medium"),
      normalizeText(input.title || "Workspace issue") || "Workspace issue",
      stringifyJson(asObject(input.payload)),
      stringifyJson(normalizeEvidenceRefs(input.evidenceRefs, asObject(input.payload)), []),
      String(input.createdBy || input.agentId || ""),
      input.createdAt || timestamp,
      timestamp
    );
    updateWorkspaceTimeStmt.run(timestamp, String(input.workspaceId || ""));
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      issue: hydrateIssue(db.prepare("SELECT * FROM aw_issues WHERE issue_id = ?").get(issueId))
    };
  }

  function updateIssue(input = {}) {
    const issueId = String(input.issueId || "").trim();
    const current = hydrateIssue(selectIssueStmt.get(issueId));
    if (!current) {
      return null;
    }
    if (input.workspaceId && current.workspaceId !== String(input.workspaceId)) {
      return null;
    }
    if (!canAccessWorkspaceId(current.workspaceId, input)) {
      return null;
    }
    const rawStatus = String(input.status || input.action || "resolved").trim() || "resolved";
    const status = rawStatus === "resolve"
      ? "resolved"
      : rawStatus === "reject"
        ? "rejected"
        : rawStatus === "reopen"
          ? "open"
          : rawStatus;
    const timestamp = nowIso();
    const payload = {
      ...(current.payload || {}),
      resolution: {
        action: status,
        note: normalizeText(input.note || input.reason || "").slice(0, 1000),
        resolvedBy: String(input.reviewerId || input.agentId || input.clientId || ""),
        resolvedAt: timestamp
      }
    };
    updateIssueStatusStmt.run(status, stringifyJson(payload), timestamp, issueId);
    updateWorkspaceTimeStmt.run(timestamp, current.workspaceId);
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      issue: hydrateIssue(selectIssueStmt.get(issueId))
    };
  }

  function createDecision(input = {}) {
    const timestamp = nowIso();
    const decisionId =
      String(input.decisionId || "").trim() ||
      stableId("decision", input.workspaceId || "", input.runId || "", input.title || "", timestamp);
    insertDecisionStmt.run(
      decisionId,
      String(input.workspaceId || ""),
      String(input.runId || ""),
      String(input.status || "proposed"),
      normalizeText(input.title || "Decision proposal") || "Decision proposal",
      stringifyJson(asObject(input.payload)),
      String(input.createdBy || input.agentId || ""),
      input.createdAt || timestamp,
      timestamp
    );
    updateWorkspaceTimeStmt.run(timestamp, String(input.workspaceId || ""));
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      decision: hydrateDecision(db.prepare("SELECT * FROM aw_decisions WHERE decision_id = ?").get(decisionId))
    };
  }

  function listRunArtifacts(runId) {
    return db.prepare("SELECT * FROM aw_artifacts WHERE run_id = ? ORDER BY updated_at DESC").all(String(runId || "")).map(hydrateArtifact);
  }

  function cleanupExpiredLocks() {
    deleteExpiredLocksStmt.run(nowIso());
  }

  function acquireLock(input = {}) {
    cleanupExpiredLocks();
    const workspaceId = String(input.workspaceId || "");
    const targetType = String(input.targetType || input.type || "").trim();
    const targetId = String(input.targetId || input.id || "").trim();
    const ownerAgentId = String(input.ownerAgentId || input.agentId || "").trim();
    if (workspaceId && !canAccessWorkspaceId(workspaceId, input)) {
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: false,
        error: "workspace_forbidden"
      };
    }
    if (!workspaceId || !targetType || !targetId || !ownerAgentId) {
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: false,
        error: "missing_lock_fields"
      };
    }
    const existing = hydrateLock(selectTargetLockStmt.get(workspaceId, targetType, targetId));
    if (existing && existing.ownerAgentId !== ownerAgentId && existing.expiresAt > nowIso()) {
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: false,
        error: "lock_held",
        lock: existing
      };
    }
    const timestamp = nowIso();
    // M-6: cap lock TTL at 30 minutes to prevent agent lock starvation
    const ttlMs = Math.max(1000, Math.min(Number(input.ttlMs || 5 * 60 * 1000), 30 * 60 * 1000));
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const lockId =
      String(input.lockId || "").trim() ||
      existing?.lockId ||
      stableId("lock", workspaceId, targetType, targetId, ownerAgentId);
    insertLockStmt.run(lockId, workspaceId, targetType, targetId, ownerAgentId, expiresAt, timestamp);
    updateWorkspaceTimeStmt.run(timestamp, workspaceId);
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      lock: hydrateLock(selectLockStmt.get(lockId))
    };
  }

  function releaseLock(input = {}) {
    cleanupExpiredLocks();
    const workspaceId = String(input.workspaceId || "");
    const lockId = String(input.lockId || "").trim();
    const targetType = String(input.targetType || input.type || "").trim();
    const targetId = String(input.targetId || input.id || "").trim();
    const ownerAgentId = String(input.ownerAgentId || input.agentId || "").trim();
    const current = lockId
      ? hydrateLock(selectLockStmt.get(lockId))
      : hydrateLock(selectTargetLockStmt.get(workspaceId, targetType, targetId));
    if (!current) {
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: true,
        released: false
      };
    }
    if (!canAccessWorkspaceId(current.workspaceId, input)) {
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: false,
        released: false,
        error: "workspace_forbidden"
      };
    }
    // M-7: remove force bypass from public API — ownerAgentId is always enforced here.
    // Privileged force-release is only available via adminReleaseLock().
    if (ownerAgentId && current.ownerAgentId !== ownerAgentId) {
      return {
        protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
        ok: false,
        released: false,
        error: "lock_owner_mismatch",
        lock: current
      };
    }
    deleteLockStmt.run(current.lockId);
    updateWorkspaceTimeStmt.run(nowIso(), current.workspaceId);
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      ok: true,
      released: true,
      lock: current
    };
  }

  function listLocks(input = {}) {
    if (!input.includeExpired) {
      cleanupExpiredLocks();
    }
    const workspaceId = String(input.workspaceId || "");
    if (!canAccessWorkspaceId(workspaceId, input)) {
      return [];
    }
    const limit = Math.max(1, Math.min(Number(input.limit || 100), 500));
    const rows = input.includeExpired
      ? db.prepare("SELECT * FROM aw_locks WHERE workspace_id = ? ORDER BY expires_at ASC LIMIT ?").all(workspaceId, limit)
      : db.prepare("SELECT * FROM aw_locks WHERE workspace_id = ? AND expires_at > ? ORDER BY expires_at ASC LIMIT ?").all(workspaceId, nowIso(), limit);
    return rows.map(hydrateLock);
  }

  function getWorkspace(input = {}) {
    const options = typeof input === "string" ? { workspaceId: input } : input;
    const workspaceId = options.workspaceId;
    const workspace = hydrateWorkspace(selectWorkspaceStmt.get(String(workspaceId || "")));
    if (!workspace) {
      return null;
    }
    if (!canAccessWorkspace(workspace, options)) {
      return null;
    }
    const queryRows = (baseSql, params, limitValue) => {
      const limit = optionalLimit(limitValue);
      return limit
        ? db.prepare(`${baseSql} LIMIT ?`).all(...params, limit)
        : db.prepare(baseSql).all(...params);
    };
    const includeRuns = options.includeRuns !== false;
    const includeRunDetails = options.includeRunDetails !== false;
    const runSql = includeRunDetails
      ? "SELECT * FROM aw_runs WHERE workspace_id = ? ORDER BY updated_at DESC"
      : `
        SELECT
          run_id, workspace_id, run_type, status, input_json,
          '[]' AS steps_json, '{}' AS coverage_json, artifact_ids_json,
          error, degraded, created_at, updated_at, started_at, completed_at
        FROM aw_runs
        WHERE workspace_id = ?
        ORDER BY updated_at DESC
      `;
    const runs = includeRuns
      ? queryRows(runSql, [workspace.workspaceId], options.runLimit)
          .map((row) => hydrateRun(row, { includeDetails: includeRunDetails }))
      : [];
    const submissions = options.includeSubmissions === false
      ? []
      : queryRows(
          "SELECT * FROM aw_submissions WHERE workspace_id = ? ORDER BY updated_at DESC",
          [workspace.workspaceId],
          options.submissionLimit
        ).map(hydrateSubmission);
    const artifacts = options.includeArtifacts === false
      ? []
      : queryRows(
          "SELECT * FROM aw_artifacts WHERE workspace_id = ? ORDER BY updated_at DESC",
          [workspace.workspaceId],
          options.artifactLimit
        ).map(hydrateArtifact);
    const issues = options.includeIssues === false
      ? []
      : queryRows(
          "SELECT * FROM aw_issues WHERE workspace_id = ? ORDER BY updated_at DESC",
          [workspace.workspaceId],
          options.issueLimit
        ).map(hydrateIssue);
    const decisions = options.includeDecisions === false
      ? []
      : queryRows(
          "SELECT * FROM aw_decisions WHERE workspace_id = ? ORDER BY updated_at DESC",
          [workspace.workspaceId],
          options.decisionLimit
        ).map(hydrateDecision);
    const locks = options.includeLocks === false ? [] : listLocks({
      workspaceId: workspace.workspaceId,
      includeExpired: Boolean(options.includeExpiredLocks),
      limit: 100,
      actorUserId: options.actorUserId,
      canAccessAll: options.canAccessAll
    });
    const privateStates = options.includePrivate
      ? queryRows(
          "SELECT * FROM aw_private_state WHERE workspace_id = ? ORDER BY updated_at DESC",
          [workspace.workspaceId],
          options.privateStateLimit
        ).map(hydratePrivateState)
      : [];
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      workspace: projectWorkspace(workspace),
      runs,
      submissions,
      artifacts,
      issues,
      decisions,
      locks,
      privateStates,
      summary: workspaceSummary(workspace.workspaceId)
    };
  }

  function close() {
    if (closed || db.open === false) return;
    db.close();
    closed = true;
  }

  /**
   * M-7: Force-release a lock regardless of owner, for use by privileged
   * administrative handlers only.  Never expose input.force from request body.
   */
  function adminReleaseLock(input = {}) {
    cleanupExpiredLocks();
    const workspaceId = String(input.workspaceId || "");
    const lockId = String(input.lockId || "").trim();
    const targetType = String(input.targetType || input.type || "").trim();
    const targetId = String(input.targetId || input.id || "").trim();
    const current = lockId
      ? hydrateLock(selectLockStmt.get(lockId))
      : hydrateLock(selectTargetLockStmt.get(workspaceId, targetType, targetId));
    if (!current) {
      return { protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION, ok: true, released: false };
    }
    deleteLockStmt.run(current.lockId);
    updateWorkspaceTimeStmt.run(nowIso(), current.workspaceId);
    return { protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION, ok: true, released: true, lock: current };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Workspace inheritance, profile & gateway-scope system
  // ═══════════════════════════════════════════════════════════════════════════


  return {
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
  };
}
