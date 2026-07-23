import { runMigrations } from "@lico/foundation/storage/sqlite-migrations";

function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .some((column) => column.name === columnName);
}

function addColumnIfMissing(db, tableName, columnName, columnSql) {
  if (hasColumn(db, tableName, columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql}`);
}

export function ensureSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS tool_grants (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      toolsets_json TEXT NOT NULL DEFAULT '[]',
      tool_allow_json TEXT NOT NULL DEFAULT '[]',
      tool_deny_json TEXT NOT NULL DEFAULT '[]',
      scopes_json TEXT NOT NULL DEFAULT '[]',
      expires_at TEXT NOT NULL DEFAULT '',
      max_uses INTEGER NOT NULL DEFAULT 0,
      rate_limit_json TEXT NOT NULL DEFAULT '{}',
      allowed_origins_json TEXT NOT NULL DEFAULT '[]',
      allowed_cidrs_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      reason TEXT NOT NULL DEFAULT '',
      token_hash TEXT NOT NULL DEFAULT '',
      token_prefix TEXT NOT NULL DEFAULT '',
      token_family_id TEXT NOT NULL DEFAULT '',
      use_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT NOT NULL DEFAULT '',
      last_used_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS tool_grant_events (
      event_id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_policy_decisions (
      decision_id TEXT PRIMARY KEY,
      tool_execution_id TEXT NOT NULL DEFAULT '',
      trace_id TEXT NOT NULL DEFAULT '',
      tool_id TEXT NOT NULL,
      grant_id TEXT NOT NULL DEFAULT '',
      effect TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      missing_scopes_json TEXT NOT NULL DEFAULT '[]',
      missing_toolsets_json TEXT NOT NULL DEFAULT '[]',
      evaluated_layers_json TEXT NOT NULL DEFAULT '[]',
      ledger_event_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_executions (
      tool_execution_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      tool_version TEXT NOT NULL DEFAULT '',
      toolset_ids_json TEXT NOT NULL DEFAULT '[]',
      subject_type TEXT NOT NULL DEFAULT '',
      subject_id TEXT NOT NULL DEFAULT '',
      grant_id TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL DEFAULT '',
      profile_id TEXT NOT NULL DEFAULT '',
      operation_id TEXT NOT NULL DEFAULT '',
      risk TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL DEFAULT '',
      input_hash TEXT NOT NULL DEFAULT '',
      redacted_input_json TEXT NOT NULL DEFAULT '{}',
      result_summary_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      policy_decision_id TEXT NOT NULL DEFAULT '',
      approval_id TEXT NOT NULL DEFAULT '',
      source_ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      ledger_event_id TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );


    CREATE TABLE IF NOT EXISTS tool_metric_events (
      metric_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL DEFAULT '',
      tool_id TEXT NOT NULL,
      grant_id TEXT NOT NULL DEFAULT '',
      profile_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      risk TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      input_bytes INTEGER NOT NULL DEFAULT 0,
      result_bytes INTEGER NOT NULL DEFAULT 0,
      transfer_bytes INTEGER NOT NULL DEFAULT 0,
      bytes_per_second REAL NOT NULL DEFAULT 0,
      reason_code TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS http_request_metric_events (
      metric_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL DEFAULT '',
      request_id TEXT NOT NULL DEFAULT '',
      transport TEXT NOT NULL DEFAULT 'http',
      method TEXT NOT NULL DEFAULT '',
      route TEXT NOT NULL DEFAULT '',
      status_code INTEGER NOT NULL DEFAULT 0,
      completion_status TEXT NOT NULL DEFAULT 'completed',
      request_bytes INTEGER NOT NULL DEFAULT 0,
      response_bytes INTEGER NOT NULL DEFAULT 0,
      transfer_bytes INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      bytes_per_second REAL NOT NULL DEFAULT 0,
      user_agent TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_catalog_snapshots (
      fingerprint TEXT PRIMARY KEY,
      catalog_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tool_grants_enabled ON tool_grants(enabled);

    CREATE TABLE IF NOT EXISTS tool_grant_owners (
      grant_id TEXT NOT NULL,
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('core', 'plugin')),
      owner_id TEXT NOT NULL,
      owner_generation TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (grant_id, owner_kind, owner_id, owner_generation),
      FOREIGN KEY (grant_id) REFERENCES tool_grants(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_grant_owners_owner
      ON tool_grant_owners(owner_kind, owner_id, grant_id);

    CREATE TABLE IF NOT EXISTS tool_grant_owner_authorities (
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('core', 'plugin')),
      owner_id TEXT NOT NULL,
      owner_generation TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active', 'retiring', 'retired')),
      first_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      retired_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (owner_kind, owner_id, owner_generation)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_grant_owner_authorities_current
      ON tool_grant_owner_authorities(owner_kind, owner_id)
      WHERE state IN ('active', 'retiring');

    CREATE TABLE IF NOT EXISTS tool_grant_owner_revocations (
      idempotency_key TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL,
      owner_generation TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'complete')),
      owner_cursor_grant_id TEXT NOT NULL DEFAULT '',
      cursor_token TEXT NOT NULL DEFAULT '',
      processed_count INTEGER NOT NULL DEFAULT 0,
      revoked_count INTEGER NOT NULL DEFAULT 0,
      already_revoked_count INTEGER NOT NULL DEFAULT 0,
      receipt_digest TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_tool_grant_owner_revocations_plugin
      ON tool_grant_owner_revocations(plugin_id, status);

    CREATE TABLE IF NOT EXISTS tool_grant_owner_revocation_targets (
      idempotency_key TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      capability_invalidated INTEGER NOT NULL DEFAULT 0,
      binding_invalidated INTEGER NOT NULL DEFAULT 0,
      newly_revoked INTEGER NOT NULL DEFAULT 0,
      accounted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (idempotency_key, grant_id),
      FOREIGN KEY (idempotency_key) REFERENCES tool_grant_owner_revocations(idempotency_key) ON DELETE RESTRICT,
      FOREIGN KEY (grant_id) REFERENCES tool_grants(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_grant_owner_revocation_targets_pending
      ON tool_grant_owner_revocation_targets(idempotency_key, capability_invalidated, binding_invalidated, grant_id);

    CREATE TRIGGER IF NOT EXISTS validate_tool_grants_json_insert
    BEFORE INSERT ON tool_grants
    WHEN CASE
      WHEN json_valid(NEW.toolsets_json) = 0 THEN 1
      WHEN json_type(NEW.toolsets_json) <> 'array' THEN 1
      WHEN json_valid(NEW.tool_allow_json) = 0 THEN 1
      WHEN json_type(NEW.tool_allow_json) <> 'array' THEN 1
      WHEN json_valid(NEW.tool_deny_json) = 0 THEN 1
      WHEN json_type(NEW.tool_deny_json) <> 'array' THEN 1
      WHEN json_valid(NEW.scopes_json) = 0 THEN 1
      WHEN json_type(NEW.scopes_json) <> 'array' THEN 1
      WHEN json_valid(NEW.rate_limit_json) = 0 THEN 1
      WHEN json_type(NEW.rate_limit_json) <> 'object' THEN 1
      WHEN json_valid(NEW.allowed_origins_json) = 0 THEN 1
      WHEN json_type(NEW.allowed_origins_json) <> 'array' THEN 1
      WHEN json_valid(NEW.allowed_cidrs_json) = 0 THEN 1
      WHEN json_type(NEW.allowed_cidrs_json) <> 'array' THEN 1
      WHEN json_valid(NEW.metadata_json) = 0 THEN 1
      WHEN json_type(NEW.metadata_json) <> 'object' THEN 1
      ELSE 0
    END
    BEGIN
      SELECT RAISE(ABORT, 'tool_grant_policy_json_invalid');
    END;

    CREATE TRIGGER IF NOT EXISTS validate_tool_grants_json_update
    BEFORE UPDATE ON tool_grants
    WHEN CASE
      WHEN json_valid(NEW.toolsets_json) = 0 THEN 1
      WHEN json_type(NEW.toolsets_json) <> 'array' THEN 1
      WHEN json_valid(NEW.tool_allow_json) = 0 THEN 1
      WHEN json_type(NEW.tool_allow_json) <> 'array' THEN 1
      WHEN json_valid(NEW.tool_deny_json) = 0 THEN 1
      WHEN json_type(NEW.tool_deny_json) <> 'array' THEN 1
      WHEN json_valid(NEW.scopes_json) = 0 THEN 1
      WHEN json_type(NEW.scopes_json) <> 'array' THEN 1
      WHEN json_valid(NEW.rate_limit_json) = 0 THEN 1
      WHEN json_type(NEW.rate_limit_json) <> 'object' THEN 1
      WHEN json_valid(NEW.allowed_origins_json) = 0 THEN 1
      WHEN json_type(NEW.allowed_origins_json) <> 'array' THEN 1
      WHEN json_valid(NEW.allowed_cidrs_json) = 0 THEN 1
      WHEN json_type(NEW.allowed_cidrs_json) <> 'array' THEN 1
      WHEN json_valid(NEW.metadata_json) = 0 THEN 1
      WHEN json_type(NEW.metadata_json) <> 'object' THEN 1
      ELSE 0
    END
    BEGIN
      SELECT RAISE(ABORT, 'tool_grant_policy_json_invalid');
    END;

    CREATE INDEX IF NOT EXISTS idx_tool_executions_created ON tool_executions(started_at);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_tool ON tool_executions(tool_id);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_status ON tool_executions(status);
    CREATE INDEX IF NOT EXISTS idx_tool_metric_events_created ON tool_metric_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_tool_metric_events_tool ON tool_metric_events(tool_id);
    CREATE INDEX IF NOT EXISTS idx_http_request_metric_events_created ON http_request_metric_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_http_request_metric_events_route ON http_request_metric_events(route);

    CREATE TABLE IF NOT EXISTS mcp_authorization_requests (
      request_id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL DEFAULT '',
      requested_scopes_json TEXT NOT NULL DEFAULT '[]',
      requested_tools_json TEXT NOT NULL DEFAULT '[]',
      reason TEXT NOT NULL DEFAULT '',
      request_kind TEXT NOT NULL DEFAULT 'generic',
      request_payload_json TEXT NOT NULL DEFAULT '{}',
      claim_token_hash TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      source_ip TEXT NOT NULL DEFAULT '',
      grant_id TEXT NOT NULL DEFAULT '',
      grant_ids_json TEXT NOT NULL DEFAULT '[]',
      expires_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      resolved_at TEXT NOT NULL DEFAULT '',
      resolved_by TEXT NOT NULL DEFAULT '',
      issuing_at TEXT NOT NULL DEFAULT '',
      consumed_at TEXT NOT NULL DEFAULT '',
      replay_envelope_json TEXT NOT NULL DEFAULT '',
      replay_expires_at TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_auth_req_status ON mcp_authorization_requests(status);

    CREATE TABLE IF NOT EXISTS tool_pending_operations (
      pending_operation_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL DEFAULT '',
      tool_execution_id TEXT NOT NULL DEFAULT '',
      tool_id TEXT NOT NULL,
      tool_version TEXT NOT NULL DEFAULT '',
      toolset_ids_json TEXT NOT NULL DEFAULT '[]',
      operation_id TEXT NOT NULL DEFAULT '',
      risk TEXT NOT NULL DEFAULT '',
      approval_scope TEXT NOT NULL DEFAULT '',
      approval_requirements_json TEXT NOT NULL DEFAULT '{}',
      approval_layers_json TEXT NOT NULL DEFAULT '[]',
      grant_id TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL DEFAULT '',
      profile_id TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT NOT NULL DEFAULT '',
      reason_code TEXT NOT NULL DEFAULT '',
      risk_reason TEXT NOT NULL DEFAULT '',
      original_input_json TEXT NOT NULL DEFAULT '{}',
      resume_input_json TEXT NOT NULL DEFAULT '{}',
      redacted_input_json TEXT NOT NULL DEFAULT '{}',
      context_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      result_summary_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT NOT NULL DEFAULT '',
      resolved_by TEXT NOT NULL DEFAULT '',
      resolution_reason TEXT NOT NULL DEFAULT '',
      resumed_tool_execution_id TEXT NOT NULL DEFAULT '',
      source_ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      resolved_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_tool_pending_operations_status ON tool_pending_operations(status);
    CREATE INDEX IF NOT EXISTS idx_tool_pending_operations_trace ON tool_pending_operations(trace_id);
    CREATE INDEX IF NOT EXISTS idx_tool_pending_operations_tool ON tool_pending_operations(tool_id);
  `);

  // Version-controlled migrations — add new steps here as the schema evolves.
  runMigrations(db, [
    // version 1: baseline — all tables above were created by the initial db.exec.
    // Reserve this slot so existing databases get user_version = 1 applied.
    { version: 1, up: () => {} },
    // version 2: add mcp_authorization_requests
    {
      version: 2,
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS mcp_authorization_requests (
            request_id TEXT PRIMARY KEY,
            client_name TEXT NOT NULL DEFAULT '',
            requested_scopes_json TEXT NOT NULL DEFAULT '[]',
            requested_tools_json TEXT NOT NULL DEFAULT '[]',
            reason TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            source_ip TEXT NOT NULL DEFAULT '',
            grant_id TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            resolved_at TEXT NOT NULL DEFAULT ''
          );
          CREATE INDEX IF NOT EXISTS idx_mcp_auth_req_status ON mcp_authorization_requests(status);
        `);
      }
    },
    // version 3: request metrics and byte-rate columns for traffic telemetry.
    {
      version: 3,
      up: (db) => {
        addColumnIfMissing(db, "tool_metric_events", "input_bytes", "input_bytes INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db, "tool_metric_events", "transfer_bytes", "transfer_bytes INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db, "tool_metric_events", "bytes_per_second", "bytes_per_second REAL NOT NULL DEFAULT 0");
        db.exec(`
          CREATE TABLE IF NOT EXISTS http_request_metric_events (
            metric_id TEXT PRIMARY KEY,
            trace_id TEXT NOT NULL DEFAULT '',
            request_id TEXT NOT NULL DEFAULT '',
            transport TEXT NOT NULL DEFAULT 'http',
            method TEXT NOT NULL DEFAULT '',
            route TEXT NOT NULL DEFAULT '',
            status_code INTEGER NOT NULL DEFAULT 0,
            completion_status TEXT NOT NULL DEFAULT 'completed',
            request_bytes INTEGER NOT NULL DEFAULT 0,
            response_bytes INTEGER NOT NULL DEFAULT 0,
            transfer_bytes INTEGER NOT NULL DEFAULT 0,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            bytes_per_second REAL NOT NULL DEFAULT 0,
            user_agent TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_tool_metric_events_tool ON tool_metric_events(tool_id);
          CREATE INDEX IF NOT EXISTS idx_http_request_metric_events_created ON http_request_metric_events(created_at);
          CREATE INDEX IF NOT EXISTS idx_http_request_metric_events_route ON http_request_metric_events(route);
        `);
      }
    },
    // version 4: high-risk MCP/tool pending operation state machine.
    {
      version: 4,
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS tool_pending_operations (
            pending_operation_id TEXT PRIMARY KEY,
            trace_id TEXT NOT NULL DEFAULT '',
            tool_execution_id TEXT NOT NULL DEFAULT '',
            tool_id TEXT NOT NULL,
            tool_version TEXT NOT NULL DEFAULT '',
            toolset_ids_json TEXT NOT NULL DEFAULT '[]',
            operation_id TEXT NOT NULL DEFAULT '',
            risk TEXT NOT NULL DEFAULT '',
            approval_scope TEXT NOT NULL DEFAULT '',
            approval_requirements_json TEXT NOT NULL DEFAULT '{}',
            approval_layers_json TEXT NOT NULL DEFAULT '[]',
            grant_id TEXT NOT NULL DEFAULT '',
            agent_id TEXT NOT NULL DEFAULT '',
            profile_id TEXT NOT NULL DEFAULT '',
            idempotency_key TEXT NOT NULL DEFAULT '',
            reason_code TEXT NOT NULL DEFAULT '',
            risk_reason TEXT NOT NULL DEFAULT '',
            original_input_json TEXT NOT NULL DEFAULT '{}',
            resume_input_json TEXT NOT NULL DEFAULT '{}',
            redacted_input_json TEXT NOT NULL DEFAULT '{}',
            context_json TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'pending',
            result_summary_json TEXT NOT NULL DEFAULT '{}',
            error_code TEXT NOT NULL DEFAULT '',
            resolved_by TEXT NOT NULL DEFAULT '',
            resolution_reason TEXT NOT NULL DEFAULT '',
            resumed_tool_execution_id TEXT NOT NULL DEFAULT '',
            source_ip TEXT NOT NULL DEFAULT '',
            user_agent TEXT NOT NULL DEFAULT '',
            expires_at TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            resolved_at TEXT NOT NULL DEFAULT '',
            completed_at TEXT NOT NULL DEFAULT ''
          );
          CREATE INDEX IF NOT EXISTS idx_tool_pending_operations_status ON tool_pending_operations(status);
          CREATE INDEX IF NOT EXISTS idx_tool_pending_operations_trace ON tool_pending_operations(trace_id);
          CREATE INDEX IF NOT EXISTS idx_tool_pending_operations_tool ON tool_pending_operations(tool_id);
        `);
      }
    },
    // version 5: keep pending approval resume input private and separate from public audit input.
    {
      version: 5,
      up: (db) => {
        addColumnIfMissing(
          db,
          "tool_pending_operations",
          "resume_input_json",
          "resume_input_json TEXT NOT NULL DEFAULT '{}'"
        );
      }
    },
    // version 6: persist governance approval layers on pending operations.
    {
      version: 6,
      up: (db) => {
        addColumnIfMissing(
          db,
          "tool_pending_operations",
          "approval_requirements_json",
          "approval_requirements_json TEXT NOT NULL DEFAULT '{}'"
        );
        addColumnIfMissing(
          db,
          "tool_pending_operations",
          "approval_layers_json",
          "approval_layers_json TEXT NOT NULL DEFAULT '[]'"
        );
      }
    },
    // version 7: bind native MCP installation approvals to immutable, expiring requests.
    {
      version: 7,
      up: (db) => {
        addColumnIfMissing(db, "mcp_authorization_requests", "request_kind", "request_kind TEXT NOT NULL DEFAULT 'generic'");
        addColumnIfMissing(db, "mcp_authorization_requests", "request_payload_json", "request_payload_json TEXT NOT NULL DEFAULT '{}'");
        addColumnIfMissing(db, "mcp_authorization_requests", "claim_token_hash", "claim_token_hash TEXT NOT NULL DEFAULT ''");
        addColumnIfMissing(db, "mcp_authorization_requests", "grant_ids_json", "grant_ids_json TEXT NOT NULL DEFAULT '[]'");
        addColumnIfMissing(db, "mcp_authorization_requests", "expires_at", "expires_at TEXT NOT NULL DEFAULT ''");
        addColumnIfMissing(db, "mcp_authorization_requests", "resolved_by", "resolved_by TEXT NOT NULL DEFAULT ''");
        addColumnIfMissing(db, "mcp_authorization_requests", "issuing_at", "issuing_at TEXT NOT NULL DEFAULT ''");
        addColumnIfMissing(db, "mcp_authorization_requests", "consumed_at", "consumed_at TEXT NOT NULL DEFAULT ''");
        addColumnIfMissing(db, "mcp_authorization_requests", "error_code", "error_code TEXT NOT NULL DEFAULT ''");
      }
    },
    // version 8: retain a short-lived claim-encrypted response for retry-safe device authorization.
    {
      version: 8,
      up: (db) => {
        addColumnIfMissing(
          db,
          "mcp_authorization_requests",
          "replay_envelope_json",
          "replay_envelope_json TEXT NOT NULL DEFAULT ''"
        );
        addColumnIfMissing(
          db,
          "mcp_authorization_requests",
          "replay_expires_at",
          "replay_expires_at TEXT NOT NULL DEFAULT ''"
        );
      }
    },
    // version 9: cross-reference permission audit rows to the proof-substrate ledger.
    {
      version: 9,
      up: (db) => {
        addColumnIfMissing(
          db,
          "tool_policy_decisions",
          "ledger_event_id",
          "ledger_event_id TEXT NOT NULL DEFAULT ''"
        );
        addColumnIfMissing(
          db,
          "tool_executions",
          "ledger_event_id",
          "ledger_event_id TEXT NOT NULL DEFAULT ''"
        );
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_tool_executions_ledger ON tool_executions(ledger_event_id);
          CREATE INDEX IF NOT EXISTS idx_tool_policy_decisions_ledger ON tool_policy_decisions(ledger_event_id);
        `);
      }
    },
    // version 10: bind grants to closed catalog owners and persist plugin-owner revocation recovery.
    {
      version: 10,
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS tool_grant_owners (
            grant_id TEXT NOT NULL,
            owner_kind TEXT NOT NULL CHECK(owner_kind IN ('core', 'plugin')),
            owner_id TEXT NOT NULL,
            owner_generation TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (grant_id, owner_kind, owner_id, owner_generation),
            FOREIGN KEY (grant_id) REFERENCES tool_grants(id) ON DELETE RESTRICT
          );
          CREATE INDEX IF NOT EXISTS idx_tool_grant_owners_owner
            ON tool_grant_owners(owner_kind, owner_id, grant_id);
          CREATE TABLE IF NOT EXISTS tool_grant_owner_authorities (
            owner_kind TEXT NOT NULL CHECK(owner_kind IN ('core', 'plugin')),
            owner_id TEXT NOT NULL,
            owner_generation TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('active', 'retiring', 'retired')),
            first_seen_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            retired_at TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (owner_kind, owner_id, owner_generation)
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_grant_owner_authorities_current
            ON tool_grant_owner_authorities(owner_kind, owner_id)
            WHERE state IN ('active', 'retiring');
          CREATE TABLE IF NOT EXISTS tool_grant_owner_revocations (
            idempotency_key TEXT PRIMARY KEY,
            plugin_id TEXT NOT NULL,
            owner_generation TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending', 'complete')),
            owner_cursor_grant_id TEXT NOT NULL DEFAULT '',
            cursor_token TEXT NOT NULL DEFAULT '',
            processed_count INTEGER NOT NULL DEFAULT 0,
            revoked_count INTEGER NOT NULL DEFAULT 0,
            already_revoked_count INTEGER NOT NULL DEFAULT 0,
            receipt_digest TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT NOT NULL DEFAULT ''
          );
          CREATE INDEX IF NOT EXISTS idx_tool_grant_owner_revocations_plugin
            ON tool_grant_owner_revocations(plugin_id, status);
          CREATE TABLE IF NOT EXISTS tool_grant_owner_revocation_targets (
            idempotency_key TEXT NOT NULL,
            grant_id TEXT NOT NULL,
            capability_invalidated INTEGER NOT NULL DEFAULT 0,
            binding_invalidated INTEGER NOT NULL DEFAULT 0,
            newly_revoked INTEGER NOT NULL DEFAULT 0,
            accounted INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (idempotency_key, grant_id),
            FOREIGN KEY (idempotency_key) REFERENCES tool_grant_owner_revocations(idempotency_key) ON DELETE RESTRICT,
            FOREIGN KEY (grant_id) REFERENCES tool_grants(id) ON DELETE RESTRICT
          );
          CREATE INDEX IF NOT EXISTS idx_tool_grant_owner_revocation_targets_pending
            ON tool_grant_owner_revocation_targets(idempotency_key, capability_invalidated, binding_invalidated, grant_id);
        `);
      }
    }
  ]);
}
