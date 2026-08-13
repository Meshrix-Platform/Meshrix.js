import { runMigrations } from "@meshrix/foundation/storage/sqlite-migrations";

function hasColumn(db?: any, tableName?: any, columnName?: any) : any {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .some((column?: any) : any => column.name === columnName);
}

function addColumnIfMissing(db?: any, tableName?: any, columnName?: any, columnSql?: any) : any {
  if (hasColumn(db, tableName, columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql}`);
}

export function ensureSchema(db?: any) : any {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS tool_grants (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      type TEXT NOT NULL,
      parent_grant_id TEXT NOT NULL DEFAULT '',
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

    CREATE TABLE IF NOT EXISTS api_key_records (
      key_id TEXT PRIMARY KEY,
      display_prefix TEXT NOT NULL,
      credential_fingerprint TEXT NOT NULL UNIQUE,
      verifier_generation TEXT NOT NULL,
      verifier_digest BLOB NOT NULL UNIQUE,
      workload_principal_id TEXT NOT NULL UNIQUE,
      workload_display_name TEXT NOT NULL,
      organization_node_id TEXT NOT NULL,
      organization_lineage_digest TEXT NOT NULL,
      organization_revision_at_issue INTEGER NOT NULL CHECK(organization_revision_at_issue > 0),
      policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND json_type(policy_json) = 'object'),
      policy_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'revoked', 'expired', 'exhausted')),
      lifecycle_revision INTEGER NOT NULL CHECK(lifecycle_revision > 0),
      use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0),
      max_uses INTEGER NOT NULL CHECK(max_uses > 0),
      requests_per_window INTEGER NOT NULL CHECK(requests_per_window > 0),
      window_seconds INTEGER NOT NULL CHECK(window_seconds > 0),
      max_concurrent_effects INTEGER NOT NULL CHECK(max_concurrent_effects > 0),
      created_at TEXT NOT NULL,
      rotated_at TEXT,
      revoked_at TEXT,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_api_key_records_org_status_created
      ON api_key_records(organization_node_id, status, created_at, key_id);
    CREATE INDEX IF NOT EXISTS idx_api_key_records_active_generation
      ON api_key_records(verifier_generation, status);

    CREATE TABLE IF NOT EXISTS api_key_usage_windows (
      key_id TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      request_count INTEGER NOT NULL CHECK(request_count >= 0),
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (key_id, window_start),
      FOREIGN KEY (key_id) REFERENCES api_key_records(key_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_api_key_usage_windows_expiry ON api_key_usage_windows(expires_at);

    CREATE TABLE IF NOT EXISTS api_key_effect_leases (
      key_id TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      lifecycle_revision INTEGER NOT NULL,
      policy_fingerprint TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (key_id, lease_id),
      FOREIGN KEY (key_id) REFERENCES api_key_records(key_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_api_key_effect_leases_expiry ON api_key_effect_leases(expires_at);

    CREATE TABLE IF NOT EXISTS api_key_lifecycle_events (
      event_id TEXT PRIMARY KEY,
      key_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      lifecycle_revision INTEGER NOT NULL,
      policy_fingerprint TEXT NOT NULL,
      organization_revision INTEGER NOT NULL,
      use_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (key_id) REFERENCES api_key_records(key_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_api_key_lifecycle_events_key
      ON api_key_lifecycle_events(key_id, created_at);

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
      credential_authorization_json TEXT NOT NULL DEFAULT '{}',
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
    { version: 1, up: () : any => {} },
    // version 3: request metrics and byte-rate columns for traffic telemetry.
    {
      version: 3,
      up: (db?: any) : any => {
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
      up: (db?: any) : any => {
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
      up: (db?: any) : any => {
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
      up: (db?: any) : any => {
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
    // version 9: cross-reference permission audit rows to the proof-substrate ledger.
    {
      version: 9,
      up: (db?: any) : any => {
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
      up: (db?: any) : any => {
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
    },
    // version 11: direct, hierarchy-scoped mxak1 credentials and atomic lifecycle state.
    {
      version: 11,
      up: (db?: any) : any => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS api_key_records (
            key_id TEXT PRIMARY KEY,
            display_prefix TEXT NOT NULL,
            credential_fingerprint TEXT NOT NULL UNIQUE,
            verifier_generation TEXT NOT NULL,
            verifier_digest BLOB NOT NULL UNIQUE,
            workload_principal_id TEXT NOT NULL UNIQUE,
            workload_display_name TEXT NOT NULL,
            organization_node_id TEXT NOT NULL,
            organization_lineage_digest TEXT NOT NULL,
            organization_revision_at_issue INTEGER NOT NULL CHECK(organization_revision_at_issue > 0),
            policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND json_type(policy_json) = 'object'),
            policy_fingerprint TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active', 'revoked', 'expired', 'exhausted')),
            lifecycle_revision INTEGER NOT NULL CHECK(lifecycle_revision > 0),
            use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0),
            max_uses INTEGER NOT NULL CHECK(max_uses > 0),
            requests_per_window INTEGER NOT NULL CHECK(requests_per_window > 0),
            window_seconds INTEGER NOT NULL CHECK(window_seconds > 0),
            max_concurrent_effects INTEGER NOT NULL CHECK(max_concurrent_effects > 0),
            created_at TEXT NOT NULL,
            rotated_at TEXT,
            revoked_at TEXT,
            expires_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_api_key_records_org_status_created
            ON api_key_records(organization_node_id, status, created_at, key_id);
          CREATE INDEX IF NOT EXISTS idx_api_key_records_active_generation
            ON api_key_records(verifier_generation, status);
          CREATE TABLE IF NOT EXISTS api_key_usage_windows (
            key_id TEXT NOT NULL,
            window_start INTEGER NOT NULL,
            request_count INTEGER NOT NULL CHECK(request_count >= 0),
            expires_at INTEGER NOT NULL,
            PRIMARY KEY (key_id, window_start),
            FOREIGN KEY (key_id) REFERENCES api_key_records(key_id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_api_key_usage_windows_expiry ON api_key_usage_windows(expires_at);
          CREATE TABLE IF NOT EXISTS api_key_effect_leases (
            key_id TEXT NOT NULL,
            lease_id TEXT NOT NULL,
            lifecycle_revision INTEGER NOT NULL,
            policy_fingerprint TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (key_id, lease_id),
            FOREIGN KEY (key_id) REFERENCES api_key_records(key_id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_api_key_effect_leases_expiry ON api_key_effect_leases(expires_at);
          CREATE TABLE IF NOT EXISTS api_key_lifecycle_events (
            event_id TEXT PRIMARY KEY,
            key_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            reason_code TEXT NOT NULL,
            lifecycle_revision INTEGER NOT NULL,
            policy_fingerprint TEXT NOT NULL,
            organization_revision INTEGER NOT NULL,
            use_count INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (key_id) REFERENCES api_key_records(key_id) ON DELETE RESTRICT
          );
          CREATE INDEX IF NOT EXISTS idx_api_key_lifecycle_events_key
            ON api_key_lifecycle_events(key_id, created_at);
        `);
      }
    },
    // version 12: retain only the immutable API-key authorization facts needed to resume approval safely.
    {
      version: 12,
      up: (db?: any) : any => {
        addColumnIfMissing(
          db,
          "tool_pending_operations",
          "credential_authorization_json",
          "credential_authorization_json TEXT NOT NULL DEFAULT '{}'"
        );
      }
    },
    // version 13: remove retired MCP device authorization state.
    {
      version: 13,
      up: (db?: any) : any => {
        db.exec("DROP TABLE IF EXISTS mcp_authorization_requests;");
      }
    },
    // version 14: make the delegated-grant parent edge explicit and indexed.
    {
      version: 14,
      up: (db?: any) : any => {
        addColumnIfMissing(db, "tool_grants", "parent_grant_id", "parent_grant_id TEXT NOT NULL DEFAULT ''");
        db.exec(`
          UPDATE tool_grants
          SET parent_grant_id = CASE
            WHEN type = 'delegated-mcp-child'
              THEN trim(COALESCE(json_extract(metadata_json, '$.delegatedMcp.sourceGrantId'), ''))
            ELSE ''
          END;
        `);
        const invalid: any = db.prepare(`
          SELECT child.id
          FROM tool_grants AS child
          LEFT JOIN tool_grants AS parent ON parent.id = child.parent_grant_id
          WHERE (child.type = 'delegated-mcp-child' AND (child.parent_grant_id = '' OR parent.id IS NULL))
             OR (child.type <> 'delegated-mcp-child' AND child.parent_grant_id <> '')
          LIMIT 1
        `).get();
        if (invalid) throw new Error("operation_permission_delegated_parent_backfill_invalid");
        const cycle: any = db.prepare(`
          WITH RECURSIVE chain(origin_id, current_id) AS (
            SELECT id, parent_grant_id FROM tool_grants WHERE parent_grant_id <> ''
            UNION
            SELECT chain.origin_id, parent.parent_grant_id
            FROM chain
            JOIN tool_grants AS parent ON parent.id = chain.current_id
            WHERE parent.parent_grant_id <> ''
          )
          SELECT origin_id FROM chain WHERE origin_id = current_id LIMIT 1
        `).get();
        if (cycle) throw new Error("operation_permission_delegated_parent_cycle");
        db.exec(`
          CREATE INDEX idx_tool_grants_parent_type
            ON tool_grants(parent_grant_id, type, id);
        `);
      }
    }
  ]);
}
