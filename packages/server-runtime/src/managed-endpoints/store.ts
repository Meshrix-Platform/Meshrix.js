import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { ensurePrivateSqliteLocation, withPrivateFileCreationMask } from "@meshrix/foundation/storage/private-sqlite";

// Durable registry for organization-managed endpoints. Queue records remain
// the task lifecycle authority; this store owns endpoint identity, credential
// hashes, enrollment tokens, requestId idempotence, result persistence and
// pending organization permission prompts only.

export const MANAGED_ENDPOINT_DB_FILENAME = "managed-endpoints.db";

function hashSecret(value: string): string {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function mintManagedSecret(prefix: "met_" | "mdc_"): string {
  return `${prefix}${randomBytes(24).toString("base64url")}`;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function parseJson(value: unknown, fallback: unknown = {}): unknown {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    throw Object.assign(new Error("Managed endpoint storage is corrupt."), { code: "managed_storage_corrupt" });
  }
}

function endpointFromRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    endpointId: row.endpoint_id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    label: row.label,
    kind: row.kind,
    state: row.state,
    generation: Number(row.generation || 0),
    allowedCapabilityIds: parseJson(row.allowed_capability_ids_json, []),
    publishedCapabilities: parseJson(row.published_capabilities_json, []),
    publishedWorkspaces: parseJson(row.workspaces_json, [])
  };
}

function taskFromRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    taskId: row.task_id,
    requestId: row.request_id,
    requestDigest: row.request_digest,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    endpointId: row.endpoint_id,
    capabilityId: row.capability_id,
    capabilityRevision: Number(row.capability_revision || 0),
    workspaceId: text(row.workspace_id),
    input: parseJson(row.input_json, null),
    requester: parseJson(row.requester_json, {}),
    queueDefinitionId: row.queue_definition_id,
    workItemId: row.work_item_id,
    admissionState: row.admission_state,
    authority: parseJson(row.authority_json, null),
    governance: parseJson(row.governance_json, {}),
    outcomeState: row.outcome_state,
    settlementPending: row.settlement_pending === 1,
    startAuthorized: row.start_authorized === 1,
    startReceipt: parseJson(row.start_receipt_json, null),
    deliveryPending: row.delivery_pending === 1,
    controlPending: row.control_pending === 1,
    cancelRequested: Number(row.cancel_requested || 0) === 1,
    result: parseJson(row.result_json, null),
    errorCode: text(row.error_code),
    resultLeaseId: text(row.result_lease_id),
    resultLeaseSeq: Number(row.result_lease_seq || 0),
    createdAtMs: Number(row.created_at_ms || 0),
    updatedAtMs: Number(row.updated_at_ms || 0),
    terminalAtMs: Number(row.terminal_at_ms || 0)
  };
}

export function openManagedEndpointStore({ userDataPath = "", databasePath = "" }: Record<string, string> = {}) {
  const requestedPath = databasePath || path.join(userDataPath, "state", MANAGED_ENDPOINT_DB_FILENAME);
  const resolvedPath = requestedPath === ":memory:" ? requestedPath : ensurePrivateSqliteLocation(requestedPath);
  const db = withPrivateFileCreationMask(() => openSqliteDatabase(resolvedPath));
  try {
    return initializeManagedEndpointStore(db, resolvedPath);
  } catch (error) {
    try { db.close(); } catch { /* Preserve the initialization failure. */ }
    throw error;
  }
}

function initializeManagedEndpointStore(db: ReturnType<typeof openSqliteDatabase>, resolvedPath: string) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS managed_endpoints (
      endpoint_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      allowed_capability_ids_json TEXT NOT NULL DEFAULT '[]',
      published_capabilities_json TEXT NOT NULL DEFAULT '[]',
      workspaces_json TEXT NOT NULL DEFAULT '[]',
      last_contact_at_ms INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_managed_endpoints_org
      ON managed_endpoints(tenant_id, organization_id, state);

    CREATE TABLE IF NOT EXISTS managed_enrollment_tokens (
      token_hash TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      bound_credential_hash TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      consumed_at_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS managed_endpoint_credentials (
      credential_hash TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_managed_endpoint_credentials_endpoint
      ON managed_endpoint_credentials(endpoint_id);

    CREATE TABLE IF NOT EXISTS managed_tasks (
      task_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      capability_revision INTEGER NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT '',
      input_json TEXT NOT NULL,
      requester_json TEXT NOT NULL,
      queue_definition_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      admission_state TEXT NOT NULL DEFAULT 'pending',
      authority_json TEXT NOT NULL,
      governance_json TEXT NOT NULL DEFAULT '{}',
      outcome_state TEXT NOT NULL DEFAULT '',
      settlement_pending INTEGER NOT NULL DEFAULT 0,
      start_authorized INTEGER NOT NULL DEFAULT 0,
      start_receipt_json TEXT,
      delivery_pending INTEGER NOT NULL DEFAULT 0,
      control_pending INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      error_code TEXT NOT NULL DEFAULT '',
      result_lease_id TEXT NOT NULL DEFAULT '',
      result_lease_seq INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      terminal_at_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_tasks_request
      ON managed_tasks(tenant_id, organization_id, request_id);
    CREATE INDEX IF NOT EXISTS idx_managed_tasks_org
      ON managed_tasks(tenant_id, organization_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_managed_tasks_endpoint
      ON managed_tasks(endpoint_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_managed_tasks_admission
      ON managed_tasks(admission_state, task_id);
    CREATE INDEX IF NOT EXISTS idx_managed_tasks_settlement
      ON managed_tasks(settlement_pending, task_id);
    CREATE INDEX IF NOT EXISTS idx_managed_tasks_device_admission
      ON managed_tasks(endpoint_id, admission_state, task_id);
    CREATE INDEX IF NOT EXISTS idx_managed_tasks_delivery
      ON managed_tasks(endpoint_id, delivery_pending, task_id);
    CREATE INDEX IF NOT EXISTS idx_managed_tasks_control
      ON managed_tasks(endpoint_id, control_pending, task_id);

    CREATE TABLE IF NOT EXISTS managed_permissions (
      permission_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      lease_seq INTEGER NOT NULL,
      prompt_json TEXT NOT NULL,
      state TEXT NOT NULL,
      selected_option_id TEXT NOT NULL DEFAULT '',
      resolved_by_json TEXT,
      created_at_ms INTEGER NOT NULL,
      resolved_at_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_managed_permissions_org
      ON managed_permissions(tenant_id, organization_id, state);
    CREATE INDEX IF NOT EXISTS idx_managed_permissions_task
      ON managed_permissions(task_id);
    CREATE INDEX IF NOT EXISTS idx_managed_permissions_device
      ON managed_permissions(endpoint_id, state, permission_id);

    CREATE TABLE IF NOT EXISTS managed_task_events (
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (task_id, seq)
    );
  `);

  const ensureColumn = (table: string, column: string, definition: string) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
    if (!columns.some((entry) => entry.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };
  ensureColumn("managed_endpoints", "workspaces_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("managed_tasks", "workspace_id", "TEXT NOT NULL DEFAULT ''");

  const statements = {
    insertEndpoint: db.prepare(`
      INSERT INTO managed_endpoints (
        endpoint_id, tenant_id, organization_id, label, kind, state, generation,
        allowed_capability_ids_json, published_capabilities_json, workspaces_json, created_at_ms, updated_at_ms
      ) VALUES (
        @endpoint_id, @tenant_id, @organization_id, @label, @kind, @state, @generation,
        @allowed_capability_ids_json, @published_capabilities_json, @workspaces_json, @created_at_ms, @updated_at_ms
      )
    `),
    getEndpoint: db.prepare(`SELECT * FROM managed_endpoints WHERE endpoint_id = ?`),
    listEndpoints: db.prepare(`
      SELECT * FROM managed_endpoints
      WHERE tenant_id = ? AND organization_id = ?
      ORDER BY created_at_ms ASC
    `),
    updateEndpoint: db.prepare(`
      UPDATE managed_endpoints SET
        label = @label,
        state = @state,
        generation = @generation,
        allowed_capability_ids_json = @allowed_capability_ids_json,
        published_capabilities_json = @published_capabilities_json,
        workspaces_json = @workspaces_json,
        updated_at_ms = @updated_at_ms
      WHERE endpoint_id = @endpoint_id
    `),
    updateEndpointPolicy: db.prepare(`
      UPDATE managed_endpoints SET label = COALESCE(@label, label),
        allowed_capability_ids_json = COALESCE(@allowed, allowed_capability_ids_json),
        updated_at_ms = @now
      WHERE endpoint_id = @endpoint_id AND tenant_id = @tenant_id AND organization_id = @organization_id
        AND generation = @generation AND state != 'revoked'
    `),
    updateCatalog: db.prepare(`
      UPDATE managed_endpoints SET published_capabilities_json = @capabilities,
        workspaces_json = @workspaces, updated_at_ms = @now
      WHERE endpoint_id = @endpoint_id AND tenant_id = @tenant_id AND organization_id = @organization_id
        AND generation = @generation AND state = 'active' AND published_capabilities_json = @previous
        AND workspaces_json = @previousWorkspaces
    `),
    insertTaskEvent: db.prepare(`
      INSERT INTO managed_task_events (task_id, seq, kind, at_ms, payload_json)
      VALUES (@task_id, @seq, @kind, @at_ms, @payload_json)
    `),
    lastTaskEventSeq: db.prepare(`SELECT MAX(seq) AS seq FROM managed_task_events WHERE task_id = ?`),
    countTaskEvents: db.prepare(`SELECT COUNT(*) AS count FROM managed_task_events WHERE task_id = ?`),
    listTaskEvents: db.prepare(`
      SELECT seq, kind, at_ms, payload_json FROM managed_task_events
      WHERE task_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `),
    contact: db.prepare(`
      UPDATE managed_endpoints SET last_contact_at_ms = MAX(last_contact_at_ms, @now)
      WHERE endpoint_id = @endpoint_id AND tenant_id = @tenant_id AND organization_id = @organization_id
        AND generation = @generation AND state = 'active'
    `),
    observations: db.prepare(`
      SELECT endpoint_id, last_contact_at_ms FROM managed_endpoints WHERE tenant_id = ? AND organization_id = ?
    `),
    insertEnrollment: db.prepare(`
      INSERT INTO managed_enrollment_tokens (
        token_hash, endpoint_id, tenant_id, organization_id,
        bound_credential_hash, created_at_ms, expires_at_ms, consumed_at_ms
      ) VALUES (
        @token_hash, @endpoint_id, @tenant_id, @organization_id,
        '', @created_at_ms, @expires_at_ms, 0
      )
    `),
    getEnrollment: db.prepare(`SELECT * FROM managed_enrollment_tokens WHERE token_hash = ?`),
    bindEnrollment: db.prepare(`
      UPDATE managed_enrollment_tokens
      SET bound_credential_hash = @credential_hash, consumed_at_ms = @consumed_at_ms
      WHERE token_hash = @token_hash
    `),
    insertCredential: db.prepare(`
      INSERT INTO managed_endpoint_credentials (
        credential_hash, endpoint_id, tenant_id, organization_id, generation, created_at_ms, revoked_at_ms
      ) VALUES (
        @credential_hash, @endpoint_id, @tenant_id, @organization_id, @generation, @created_at_ms, 0
      )
    `),
    getCredential: db.prepare(`SELECT * FROM managed_endpoint_credentials WHERE credential_hash = ?`),
    revokeEndpointCredentials: db.prepare(`
      UPDATE managed_endpoint_credentials SET revoked_at_ms = ?
      WHERE endpoint_id = ? AND revoked_at_ms = 0
    `),
    countEndpoints: db.prepare(`
      SELECT COUNT(*) AS count FROM managed_endpoints
      WHERE tenant_id = ? AND organization_id = ? AND state != 'revoked'
    `),
    insertTask: db.prepare(`
      INSERT INTO managed_tasks (
        task_id, request_id, request_digest, tenant_id, organization_id, endpoint_id,
        capability_id, capability_revision, workspace_id, input_json, requester_json,
        queue_definition_id, work_item_id, authority_json, governance_json, created_at_ms, updated_at_ms
      ) VALUES (
        @task_id, @request_id, @request_digest, @tenant_id, @organization_id, @endpoint_id,
        @capability_id, @capability_revision, @workspace_id, @input_json, @requester_json,
        @queue_definition_id, @work_item_id, @authority_json, @governance_json, @created_at_ms, @updated_at_ms
      )
    `),
    getTask: db.prepare(`SELECT * FROM managed_tasks WHERE task_id = ?`),
    getTaskByRequest: db.prepare(`
      SELECT * FROM managed_tasks WHERE tenant_id = ? AND organization_id = ? AND request_id = ?
    `),
    listTasks: db.prepare(`
      SELECT * FROM managed_tasks
      WHERE tenant_id = ? AND organization_id = ?
      ORDER BY created_at_ms DESC
      LIMIT ?
    `),
    updateTask: db.prepare(`
      UPDATE managed_tasks SET
        admission_state = @admission_state,
        authority_json = @authority_json,
        outcome_state = @outcome_state,
        settlement_pending = @settlement_pending,
        start_authorized = @start_authorized,
        start_receipt_json = @start_receipt_json,
        delivery_pending = @delivery_pending,
        control_pending = @control_pending,
        cancel_requested = @cancel_requested,
        result_json = @result_json,
        error_code = @error_code,
        result_lease_id = @result_lease_id,
        result_lease_seq = @result_lease_seq,
        updated_at_ms = @updated_at_ms,
        terminal_at_ms = @terminal_at_ms
      WHERE task_id = @task_id
    `),
    insertPermission: db.prepare(`
      INSERT INTO managed_permissions (
        permission_id, task_id, tenant_id, organization_id, endpoint_id,
        lease_id, lease_seq, prompt_json, state, created_at_ms
      ) VALUES (
        @permission_id, @task_id, @tenant_id, @organization_id, @endpoint_id,
        @lease_id, @lease_seq, @prompt_json, 'pending', @created_at_ms
      )
    `),
    getPermission: db.prepare(`SELECT * FROM managed_permissions WHERE permission_id = ?`),
    getPendingPermissionForTask: db.prepare(`
      SELECT * FROM managed_permissions
      WHERE task_id = ? AND lease_id = ? AND state = 'pending'
      ORDER BY created_at_ms DESC
      LIMIT 1
    `),
    listPendingPermissionsForDevice: db.prepare(`
      SELECT * FROM managed_permissions
      WHERE endpoint_id = ? AND state = 'resolved' AND permission_id > ?
      ORDER BY permission_id ASC
      LIMIT 128
    `),
    listOrgPermissions: db.prepare(`
      SELECT * FROM managed_permissions
      WHERE tenant_id = ? AND organization_id = ? AND state = 'pending'
      ORDER BY created_at_ms ASC
    `),
    resolvePermission: db.prepare(`
      UPDATE managed_permissions SET
        state = 'resolved',
        selected_option_id = @selected_option_id,
        resolved_by_json = @resolved_by_json,
        resolved_at_ms = @resolved_at_ms
      WHERE permission_id = @permission_id AND state = 'pending'
    `),
    ackResolvedPermission: db.prepare(`
      UPDATE managed_permissions SET state = 'delivered'
      WHERE permission_id = ? AND state = 'resolved'
    `),
    invalidateTaskPermissions: db.prepare(`
      UPDATE managed_permissions SET state = 'obsolete'
      WHERE task_id = ? AND state IN ('pending', 'resolved')
    `)
  };

  return {
    databasePath: resolvedPath,
    transaction<T>(operation: () => T): T {
      return db.transaction(operation)();
    },
    createEndpoint(endpoint: Record<string, unknown>, nowMs: number): Record<string, unknown> {
      statements.insertEndpoint.run({
        endpoint_id: text(endpoint.endpointId),
        tenant_id: text(endpoint.tenantId),
        organization_id: text(endpoint.organizationId),
        label: text(endpoint.label),
        kind: text(endpoint.kind),
        state: text(endpoint.state) || "pending",
        generation: Number(endpoint.generation || 0),
        allowed_capability_ids_json: JSON.stringify(endpoint.allowedCapabilityIds || []),
        published_capabilities_json: JSON.stringify(endpoint.publishedCapabilities || []),
        workspaces_json: JSON.stringify(endpoint.publishedWorkspaces || []),
        created_at_ms: nowMs,
        updated_at_ms: nowMs
      });
      return this.getEndpoint(text(endpoint.endpointId)) as Record<string, unknown>;
    },
    getEndpoint(endpointId: string): Record<string, unknown> | null {
      const row = statements.getEndpoint.get(endpointId) as Record<string, unknown> | undefined;
      return row ? endpointFromRow(row) : null;
    },
    listEndpoints(tenantId: string, organizationId: string): Record<string, unknown>[] {
      return (statements.listEndpoints.all(tenantId, organizationId) as Record<string, unknown>[])
        .map(endpointFromRow);
    },
    updateEndpoint(endpoint: Record<string, unknown>, nowMs: number): Record<string, unknown> | null {
      statements.updateEndpoint.run({
        endpoint_id: text(endpoint.endpointId),
        label: text(endpoint.label),
        state: text(endpoint.state),
        generation: Number(endpoint.generation || 0),
        allowed_capability_ids_json: JSON.stringify(endpoint.allowedCapabilityIds || []),
        published_capabilities_json: JSON.stringify(endpoint.publishedCapabilities || []),
        workspaces_json: JSON.stringify(endpoint.publishedWorkspaces || []),
        updated_at_ms: nowMs
      });
      return this.getEndpoint(text(endpoint.endpointId));
    },
    updateEndpointPolicy(endpoint: Record<string, any>, patch: Record<string, any>, now: number) {
      const changed = statements.updateEndpointPolicy.run({
        endpoint_id: endpoint.endpointId, tenant_id: endpoint.tenantId, organization_id: endpoint.organizationId,
        generation: endpoint.generation, label: patch.label ?? null,
        allowed: patch.allowedCapabilityIds === undefined ? null : JSON.stringify(patch.allowedCapabilityIds), now
      });
      return changed.changes ? this.getEndpoint(endpoint.endpointId) : null;
    },
    updateCatalog(endpoint: Record<string, any>, capabilities: unknown, workspaces: unknown, now: number) {
      const changed = statements.updateCatalog.run({
        endpoint_id: endpoint.endpointId, tenant_id: endpoint.tenantId, organization_id: endpoint.organizationId,
        generation: endpoint.generation, previous: JSON.stringify(endpoint.publishedCapabilities),
        previousWorkspaces: JSON.stringify(endpoint.publishedWorkspaces || []),
        capabilities: JSON.stringify(capabilities), workspaces: JSON.stringify(workspaces ?? []), now
      });
      return changed.changes ? this.getEndpoint(endpoint.endpointId) : null;
    },
    lastTaskEventSeq(taskId: string): number {
      const row = statements.lastTaskEventSeq.get(taskId) as { seq: number | null } | undefined;
      return Number(row?.seq || 0);
    },
    countTaskEvents(taskId: string): number {
      const row = statements.countTaskEvents.get(taskId) as { count: number } | undefined;
      return Number(row?.count || 0);
    },
    appendTaskEvents(taskId: string, events: readonly Record<string, any>[], maxCount: number) {
      return db.transaction(() => {
        const lastSeq = this.lastTaskEventSeq(taskId);
        const count = this.countTaskEvents(taskId);
        if (count + events.length > maxCount) {
          throw Object.assign(new Error("Managed task event timeline is full."), {
            code: "managed_event_overflow", statusCode: 409
          });
        }
        let tail = lastSeq;
        for (const event of events) {
          // Worker-owned sequence: strictly increasing and above the stored
          // tail — gaps are legal (the device owns the counter).
          if (event.seq <= tail) {
            throw Object.assign(new Error("Managed task event seq must stay above the stored tail."), {
              code: "managed_event_seq_conflict", statusCode: 409
            });
          }
          statements.insertTaskEvent.run({
            task_id: taskId, seq: event.seq, kind: event.kind,
            at_ms: Date.parse(event.at), payload_json: canonicalJson(event.payload ?? null)
          });
          tail = event.seq;
        }
        return tail;
      })();
    },
    listTaskEvents(taskId: string, after = 0, limit = 256): Record<string, unknown>[] {
      const rows = statements.listTaskEvents.all(taskId, after, Math.max(1, Math.min(limit, 256))) as
        Record<string, unknown>[];
      return rows.map((row) => ({
        seq: Number(row.seq), kind: row.kind, at: new Date(Number(row.at_ms)).toISOString(),
        payload: parseJson(row.payload_json, null)
      }));
    },
    observeContact(endpoint: Record<string, any>, now: number) {
      statements.contact.run({
        endpoint_id: endpoint.endpointId, tenant_id: endpoint.tenantId, organization_id: endpoint.organizationId,
        generation: endpoint.generation, now
      });
    },
    endpointObservations(tenantId: string, organizationId: string) {
      return (statements.observations.all(tenantId, organizationId) as Record<string, unknown>[]).map((row) => ({
        endpointId: row.endpoint_id, lastContactAtMs: Number(row.last_contact_at_ms) || null
      }));
    },
    countActiveEndpoints(tenantId: string, organizationId: string): number {
      const row = statements.countEndpoints.get(tenantId, organizationId) as { count: number };
      return Number(row?.count || 0);
    },
    createEnrollment({ token, endpointId, tenantId, organizationId, nowMs, ttlMs }: Record<string, unknown>) {
      statements.insertEnrollment.run({
        token_hash: hashSecret(text(token)),
        endpoint_id: text(endpointId),
        tenant_id: text(tenantId),
        organization_id: text(organizationId),
        created_at_ms: Number(nowMs),
        expires_at_ms: Number(nowMs) + Number(ttlMs)
      });
    },
    getEnrollment(token: string): Record<string, unknown> | null {
      const row = statements.getEnrollment.get(hashSecret(token)) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        endpointId: row.endpoint_id,
        tenantId: row.tenant_id,
        organizationId: row.organization_id,
        boundCredentialHash: row.bound_credential_hash,
        createdAtMs: Number(row.created_at_ms || 0),
        expiresAtMs: Number(row.expires_at_ms || 0),
        consumedAtMs: Number(row.consumed_at_ms || 0)
      };
    },
    bindEnrollment(token: string, credential: string, nowMs: number): void {
      statements.bindEnrollment.run({
        token_hash: hashSecret(token),
        credential_hash: hashSecret(credential),
        consumed_at_ms: nowMs
      });
    },
    bindCredential({ credential, endpointId, tenantId, organizationId, generation, nowMs }: Record<string, unknown>) {
      statements.insertCredential.run({
        credential_hash: hashSecret(text(credential)),
        endpoint_id: text(endpointId),
        tenant_id: text(tenantId),
        organization_id: text(organizationId),
        generation: Number(generation || 0),
        created_at_ms: Number(nowMs)
      });
    },
    resolveCredential(credential: string): Record<string, unknown> | null {
      const row = statements.getCredential.get(hashSecret(credential)) as Record<string, unknown> | undefined;
      if (!row || Number(row.revoked_at_ms || 0) > 0) return null;
      return {
        endpointId: row.endpoint_id,
        tenantId: row.tenant_id,
        organizationId: row.organization_id,
        generation: Number(row.generation || 0)
      };
    },
    revokeCredentials(endpointId: string, nowMs: number): void {
      statements.revokeEndpointCredentials.run(nowMs, endpointId);
    },
    requestDigest(request: unknown): string {
      return digestJson(request);
    },
    reserveTask(task: Record<string, any>, nowMs: number) {
      return db.transaction(() => {
        const existing = this.getTaskByRequestId(task.tenantId, task.organizationId, task.requestId);
        if (existing) {
          if (existing.requestDigest !== task.requestDigest ||
              canonicalJson(existing.requester) !== canonicalJson(task.requester)) {
            throw Object.assign(new Error("Managed requestId is already bound to a different request."), {
              code: "managed_request_conflict", statusCode: 409
            });
          }
          return { task: existing, created: false };
        }
        return { task: this.createTask(task, nowMs), created: true };
      })();
    },
    createTask(task: Record<string, unknown>, nowMs: number): Record<string, unknown> {
      statements.insertTask.run({
        task_id: text(task.taskId),
        request_id: text(task.requestId),
        request_digest: text(task.requestDigest),
        tenant_id: text(task.tenantId),
        organization_id: text(task.organizationId),
        endpoint_id: text(task.endpointId),
        capability_id: text(task.capabilityId),
        capability_revision: Number(task.capabilityRevision || 0),
        workspace_id: text(task.workspaceId),
        input_json: canonicalJson(task.input ?? null),
        requester_json: JSON.stringify(task.requester || {}),
        queue_definition_id: text(task.queueDefinitionId),
        work_item_id: text(task.workItemId),
        authority_json: canonicalJson(task.authority),
        governance_json: canonicalJson(task.governance || {}),
        created_at_ms: nowMs,
        updated_at_ms: nowMs
      });
      return this.getTask(text(task.taskId)) as Record<string, unknown>;
    },
    getTask(taskId: string): Record<string, unknown> | null {
      const row = statements.getTask.get(taskId) as Record<string, unknown> | undefined;
      return row ? taskFromRow(row) : null;
    },
    getTaskByRequestId(tenantId: string, organizationId: string, requestId: string): Record<string, unknown> | null {
      const row = statements.getTaskByRequest.get(tenantId, organizationId, requestId) as
        Record<string, unknown> | undefined;
      return row ? taskFromRow(row) : null;
    },
    listTasks(tenantId: string, organizationId: string, limit = 200): Record<string, unknown>[] {
      return (statements.listTasks.all(tenantId, organizationId, Math.max(1, Math.min(limit, 1000))) as
        Record<string, unknown>[]).map(taskFromRow);
    },
    taskPage({ endpointId, admissionState, settlementPending, deliveryPending, controlPending, after = "" }: {
      endpointId?: string; admissionState?: string; settlementPending?: boolean;
      deliveryPending?: boolean; controlPending?: boolean; after?: string
    } = {}): Record<string, any>[] {
      const predicates = ["task_id > ?"];
      const values: Array<string | number> = [after];
      for (const [column, value] of [
        ["endpoint_id", endpointId], ["admission_state", admissionState],
        ["settlement_pending", settlementPending], ["delivery_pending", deliveryPending],
        ["control_pending", controlPending]
      ] as const) {
        if (value !== undefined) {
          predicates.push(`${column} = ?`);
          values.push(typeof value === "boolean" ? Number(value) : value);
        }
      }
      return (db.prepare(`SELECT * FROM managed_tasks WHERE ${predicates.join(" AND ")}
        ORDER BY task_id LIMIT 128`).all(...values) as Record<string, unknown>[]).map(taskFromRow);
    },
    updateTask(task: Record<string, unknown>, patch: Record<string, unknown>, nowMs: number): void {
      const merged = { ...task, ...patch };
      statements.updateTask.run({
        task_id: text(task.taskId),
        admission_state: text(merged.admissionState),
        authority_json: merged.authority ? canonicalJson(merged.authority) : null,
        outcome_state: text(merged.outcomeState),
        settlement_pending: merged.settlementPending === true ? 1 : 0,
        start_authorized: merged.startAuthorized === true ? 1 : 0,
        start_receipt_json: merged.startReceipt ? canonicalJson(merged.startReceipt) : null,
        delivery_pending: merged.deliveryPending === true ? 1 : 0,
        control_pending: merged.controlPending === true ? 1 : 0,
        cancel_requested: merged.cancelRequested === true ? 1 : 0,
        result_json: merged.result === undefined || merged.result === null
          ? null
          : JSON.stringify(merged.result),
        error_code: text(merged.errorCode),
        result_lease_id: text(merged.resultLeaseId),
        result_lease_seq: Number(merged.resultLeaseSeq || 0),
        updated_at_ms: nowMs,
        terminal_at_ms: Number(merged.terminalAtMs || 0)
      });
    },
    createPermission(permission: Record<string, unknown>, nowMs: number): Record<string, unknown> {
      statements.insertPermission.run({
        permission_id: text(permission.permissionId),
        task_id: text(permission.taskId),
        tenant_id: text(permission.tenantId),
        organization_id: text(permission.organizationId),
        endpoint_id: text(permission.endpointId),
        lease_id: text(permission.leaseId),
        lease_seq: Number(permission.leaseSeq || 0),
        prompt_json: JSON.stringify(permission.prompt || {}),
        created_at_ms: nowMs
      });
      return this.getPermission(text(permission.permissionId)) as Record<string, unknown>;
    },
    getPermission(permissionId: string): Record<string, unknown> | null {
      const row = statements.getPermission.get(permissionId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        permissionId: row.permission_id,
        taskId: row.task_id,
        tenantId: row.tenant_id,
        organizationId: row.organization_id,
        endpointId: row.endpoint_id,
        leaseId: row.lease_id,
        leaseSeq: Number(row.lease_seq || 0),
        prompt: parseJson(row.prompt_json, {}),
        state: row.state,
        selectedOptionId: String(row.selected_option_id ?? ""),
        resolvedBy: parseJson(row.resolved_by_json, null),
        createdAtMs: Number(row.created_at_ms || 0),
        resolvedAtMs: Number(row.resolved_at_ms || 0)
      };
    },
    getPendingPermission(taskId: string, leaseId: string): Record<string, unknown> | null {
      const row = statements.getPendingPermissionForTask.get(taskId, leaseId) as
        Record<string, unknown> | undefined;
      return row ? this.getPermission(text(row.permission_id)) : null;
    },
    listOrgPendingPermissions(tenantId: string, organizationId: string): Record<string, unknown>[] {
      return (statements.listOrgPermissions.all(tenantId, organizationId) as Record<string, unknown>[])
        .map((row) => this.getPermission(text(row.permission_id)) as Record<string, unknown>);
    },
    listResolvedPermissionsForDevice(endpointId: string, after = ""): Record<string, unknown>[] {
      return (statements.listPendingPermissionsForDevice.all(endpointId, after) as Record<string, unknown>[])
        .map((row) => this.getPermission(text(row.permission_id)) as Record<string, unknown>);
    },
    resolvePermission(permissionId: string, selectedOptionId: string, resolvedBy: unknown, nowMs: number): boolean {
      const result = statements.resolvePermission.run({
        permission_id: permissionId,
        selected_option_id: selectedOptionId,
        resolved_by_json: JSON.stringify(resolvedBy || null),
        resolved_at_ms: nowMs
      });
      return result.changes > 0;
    },
    ackPermissionDelivered(permissionId: string): void {
      statements.ackResolvedPermission.run(permissionId);
    },
    invalidateTaskPermissions(taskId: string): void {
      statements.invalidateTaskPermissions.run(taskId);
    },
    close(): void {
      db.close();
    }
  };
}
