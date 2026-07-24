import { runMigrations } from "@meshrix/foundation/storage/sqlite-migrations";

function createCurrentAgentWorkspaceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS aw_workspaces (
      workspace_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      parent_workspace_id TEXT,
      profile_json TEXT NOT NULL DEFAULT '{}',
      owned_source_ids_json TEXT NOT NULL DEFAULT '[]',
      accessible_workspace_ids_json TEXT NOT NULL DEFAULT '[]',
      current_generation INTEGER NOT NULL DEFAULT 1,
      owner_user_id TEXT NOT NULL DEFAULT '',
      fs_path TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_aw_workspaces_parent ON aw_workspaces(parent_workspace_id);
    CREATE INDEX IF NOT EXISTS idx_aw_workspaces_owner ON aw_workspaces(owner_user_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS aw_runs (
      run_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      run_type TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL DEFAULT '{}',
      steps_json TEXT NOT NULL DEFAULT '[]',
      coverage_json TEXT NOT NULL DEFAULT '{}',
      artifact_ids_json TEXT NOT NULL DEFAULT '[]',
      error TEXT NOT NULL DEFAULT '',
      degraded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_aw_runs_workspace ON aw_runs(workspace_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS aw_private_state (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      state_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, run_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS aw_submissions (
      submission_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      duplicate_key TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      gate_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_aw_submissions_workspace ON aw_submissions(workspace_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_aw_submissions_duplicate ON aw_submissions(workspace_id, type, duplicate_key);
    CREATE TABLE IF NOT EXISTS aw_artifacts (
      artifact_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      level TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      citations_json TEXT NOT NULL DEFAULT '[]',
      coverage_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_aw_artifacts_run ON aw_artifacts(run_id, level, updated_at DESC);
    CREATE TABLE IF NOT EXISTS aw_issues (
      issue_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_aw_issues_workspace ON aw_issues(workspace_id, status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS aw_decisions (
      decision_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS aw_locks (
      lock_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      owner_agent_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_aw_locks_target ON aw_locks(workspace_id, target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_aw_locks_expiry ON aw_locks(expires_at);
    CREATE TABLE IF NOT EXISTS aw_sessions (
      session_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      parent_session_id TEXT NOT NULL DEFAULT '',
      forked_from_event_id TEXT NOT NULL DEFAULT '',
      branch_index INTEGER NOT NULL DEFAULT 0,
      lineage_json TEXT NOT NULL DEFAULT '[]',
      context_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_event_id TEXT NOT NULL DEFAULT '',
      event_count INTEGER NOT NULL DEFAULT 0,
      append_only INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_aw_sessions_workspace ON aw_sessions(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_aw_sessions_parent ON aw_sessions(parent_session_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_aw_sessions_status ON aw_sessions(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS aw_session_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      parent_event_id TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      sequence INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_aw_session_events_sequence ON aw_session_events(session_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_aw_session_events_workspace ON aw_session_events(workspace_id, created_at DESC);
  `);
}

const AGENT_WORKSPACE_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    up: createCurrentAgentWorkspaceSchema
  })
]);

export function ensureAgentWorkspaceSchema(db) {
  runMigrations(db, AGENT_WORKSPACE_MIGRATIONS);
}

export function prepareAgentWorkspaceStatements(db) {
  const insertWorkspaceStmt = db.prepare(`
    INSERT OR REPLACE INTO aw_workspaces (
      workspace_id, title, objective, status, owner_user_id, metadata_json, created_at, updated_at, fs_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectWorkspaceStmt = db.prepare("SELECT * FROM aw_workspaces WHERE workspace_id = ?");
  const listWorkspacesStmt = db.prepare("SELECT * FROM aw_workspaces ORDER BY updated_at DESC LIMIT ?");
  const listWorkspacesByStatusStmt = db.prepare("SELECT * FROM aw_workspaces WHERE status = ? ORDER BY updated_at DESC LIMIT ?");
  const insertRunStmt = db.prepare(`
    INSERT OR REPLACE INTO aw_runs (
      run_id, workspace_id, run_type, status, input_json, steps_json, coverage_json,
      artifact_ids_json, error, degraded, created_at, updated_at, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRunStmt = db.prepare("SELECT * FROM aw_runs WHERE run_id = ?");
  const updateWorkspaceTimeStmt = db.prepare("UPDATE aw_workspaces SET updated_at = ? WHERE workspace_id = ?");
  const selectSubmissionStmt = db.prepare("SELECT * FROM aw_submissions WHERE submission_id = ?");
  const updateSubmissionStatusStmt = db.prepare("UPDATE aw_submissions SET status = ?, gate_json = ?, updated_at = ? WHERE submission_id = ?");
  const selectIssueStmt = db.prepare("SELECT * FROM aw_issues WHERE issue_id = ?");
  const updateIssueStatusStmt = db.prepare("UPDATE aw_issues SET status = ?, payload_json = ?, updated_at = ? WHERE issue_id = ?");
  const selectLockStmt = db.prepare("SELECT * FROM aw_locks WHERE lock_id = ?");
  const selectTargetLockStmt = db.prepare("SELECT * FROM aw_locks WHERE workspace_id = ? AND target_type = ? AND target_id = ?");
  const insertLockStmt = db.prepare(`
    INSERT INTO aw_locks (
      lock_id, workspace_id, target_type, target_id, owner_agent_id, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, target_type, target_id) DO UPDATE SET
      lock_id = excluded.lock_id,
      owner_agent_id = excluded.owner_agent_id,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at
  `);
  const deleteLockStmt = db.prepare("DELETE FROM aw_locks WHERE lock_id = ?");
  const deleteExpiredLocksStmt = db.prepare("DELETE FROM aw_locks WHERE expires_at <= ?");
  const selectDuplicateStmt = db.prepare(`
    SELECT * FROM aw_submissions
    WHERE workspace_id = ? AND type = ? AND duplicate_key = ? AND status != 'rejected'
    LIMIT 1
  `);
  const insertSubmissionStmt = db.prepare(`
    INSERT OR REPLACE INTO aw_submissions (
      submission_id, workspace_id, run_id, agent_id, type, status, confidence, duplicate_key,
      payload_json, evidence_refs_json, gate_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPrivateStmt = db.prepare(`
    INSERT INTO aw_private_state (
      id, workspace_id, run_id, agent_id, summary, state_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, run_id, agent_id) DO UPDATE SET
      summary = excluded.summary,
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `);
  const insertArtifactStmt = db.prepare(`
    INSERT OR REPLACE INTO aw_artifacts (
      artifact_id, workspace_id, run_id, level, title, content, citations_json,
      coverage_json, revision, status, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIssueStmt = db.prepare(`
    INSERT OR REPLACE INTO aw_issues (
      issue_id, workspace_id, run_id, type, status, severity, title,
      payload_json, evidence_refs_json, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDecisionStmt = db.prepare(`
    INSERT OR REPLACE INTO aw_decisions (
      decision_id, workspace_id, run_id, status, title, payload_json, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSessionStmt = db.prepare(`
    INSERT OR REPLACE INTO aw_sessions (
      session_id, workspace_id, title, objective, status, parent_session_id, forked_from_event_id,
      branch_index, lineage_json, context_json, metadata_json, created_by, created_at, updated_at,
      last_event_id, event_count, append_only
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectSessionStmt = db.prepare("SELECT * FROM aw_sessions WHERE session_id = ?");
  const listSessionsStmt = db.prepare("SELECT * FROM aw_sessions ORDER BY updated_at DESC LIMIT ?");
  const listSessionsByStatusStmt = db.prepare("SELECT * FROM aw_sessions WHERE status = ? ORDER BY updated_at DESC LIMIT ?");
  const listSessionsByWorkspaceStmt = db.prepare("SELECT * FROM aw_sessions WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ?");
  const listSessionsByWorkspaceStatusStmt = db.prepare(
    "SELECT * FROM aw_sessions WHERE workspace_id = ? AND status = ? ORDER BY updated_at DESC LIMIT ?"
  );
  const selectWorkspaceRootSessionStmt = db.prepare(
    "SELECT * FROM aw_sessions WHERE workspace_id = ? AND parent_session_id = '' ORDER BY created_at ASC LIMIT 1"
  );
  const countChildSessionsStmt = db.prepare(
    "SELECT COUNT(*) AS count FROM aw_sessions WHERE parent_session_id = ?"
  );
  const insertSessionEventStmt = db.prepare(`
    INSERT INTO aw_session_events (
      event_id, session_id, workspace_id, parent_event_id, event_type, title, summary,
      payload_json, created_by, created_at, sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectSessionEventStmt = db.prepare("SELECT * FROM aw_session_events WHERE event_id = ?");
  const selectSessionEventsStmt = db.prepare(
    "SELECT * FROM aw_session_events WHERE session_id = ? ORDER BY sequence ASC LIMIT ?"
  );
  const selectSessionEventsUntilStmt = db.prepare(
    "SELECT * FROM aw_session_events WHERE session_id = ? AND sequence <= ? ORDER BY sequence ASC"
  );
  const selectLastSessionEventStmt = db.prepare(
    "SELECT * FROM aw_session_events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1"
  );
  const selectMaxSessionSequenceStmt = db.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM aw_session_events WHERE session_id = ?"
  );
  const updateSessionStatsStmt = db.prepare(
    "UPDATE aw_sessions SET last_event_id = ?, event_count = ?, updated_at = ? WHERE session_id = ?"
  );
  const updateSessionStatusStmt = db.prepare(
    "UPDATE aw_sessions SET status = ?, updated_at = ? WHERE session_id = ?"
  );


  return {
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
  };
}
