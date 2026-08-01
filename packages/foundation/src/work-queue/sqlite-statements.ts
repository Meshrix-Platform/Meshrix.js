import { WORK_QUEUE_STATES } from "../workflow/state-machine/work-queue/state-machine.ts";

export function prepareSqliteWorkQueueStatements(database?: any) : any {
  return {
    insertDefinition: database.prepare(`
      INSERT INTO queue_definitions (
        queue_definition_id, queue_definition_version, label, lifecycle_state,
        owner_capability, allow_deprecated_enqueue, metadata_json, policy_json,
        routes_json, label_history_json, registered_at_ms, updated_at_ms
      ) VALUES (
        @queue_definition_id, @queue_definition_version, @label, @lifecycle_state,
        @owner_capability, @allow_deprecated_enqueue, @metadata_json, @policy_json,
        @routes_json, @label_history_json, @registered_at_ms, @updated_at_ms
      )
    `),
    insertWorkItem: database.prepare(`
      INSERT INTO work_items (
        work_item_id, queue_definition_id, queue_definition_version, scope_key,
        scope_json, dedupe_key, state, owner_ref_json, payload_ref_json,
        payload_kind, priority, priority_class, tenant_id, workspace_id, project_id,
        available_at_ms, expires_at_ms, attempt, max_attempts, lease_id,
        lease_seq, leased_by_worker_id, lease_expires_at_ms, concurrency_key,
        route_version, policy_version, fallback_task_id, last_error_json,
        checkpoint_ref_json, checkpoint_digest, checkpoint_seq, checkpoint_updated_at_ms,
        last_transition_seq, created_at_ms, updated_at_ms
      ) VALUES (
        @work_item_id, @queue_definition_id, @queue_definition_version, @scope_key,
        @scope_json, @dedupe_key, @state, @owner_ref_json, @payload_ref_json,
        @payload_kind, @priority, @priority_class, @tenant_id, @workspace_id, @project_id,
        @available_at_ms, @expires_at_ms, @attempt, @max_attempts,
        @lease_id, @lease_seq, @leased_by_worker_id, @lease_expires_at_ms,
        @concurrency_key, @route_version, @policy_version, @fallback_task_id,
        @last_error_json, @checkpoint_ref_json, @checkpoint_digest, @checkpoint_seq,
        @checkpoint_updated_at_ms, @last_transition_seq, @created_at_ms, @updated_at_ms
      )
    `),
    updateCheckpoint: database.prepare(`
      UPDATE work_items
      SET checkpoint_ref_json = @checkpoint_ref_json,
          checkpoint_digest = @checkpoint_digest,
          checkpoint_seq = @checkpoint_seq,
          checkpoint_updated_at_ms = @checkpoint_updated_at_ms,
          updated_at_ms = @updated_at_ms
      WHERE work_item_id = @work_item_id
    `),
    agedCandidates: database.prepare(`
      SELECT work_item_id, priority, priority_class, available_at_ms
      FROM work_items
      WHERE queue_definition_id = @queue_definition_id
        AND (@queue_definition_version = 0 OR queue_definition_version = @queue_definition_version)
        AND scope_key = @scope_key
        AND state IN (@queued_state, @recovered_state)
        AND priority_class <> @critical_class
        AND available_at_ms <= @aging_threshold_ms
      ORDER BY available_at_ms ASC, created_at_ms ASC, work_item_id ASC
      LIMIT @limit
    `),
    updatePriorityClass: database.prepare(`
      UPDATE work_items
      SET priority_class = @priority_class,
          updated_at_ms = @updated_at_ms
      WHERE work_item_id = @work_item_id
    `),
    countUnderReservedTenants: database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT pending.tenant_id
        FROM work_items pending
        WHERE pending.queue_definition_id = @queue_definition_id
          AND pending.scope_key = @scope_key
          AND pending.state IN (@queued_state, @recovered_state)
          AND pending.available_at_ms <= @now_ms
          AND (pending.expires_at_ms = 0 OR pending.expires_at_ms > @now_ms)
          AND pending.tenant_id <> @tenant_id
        GROUP BY pending.tenant_id
        HAVING (SELECT COUNT(*) FROM work_items running
          WHERE running.queue_definition_id = pending.queue_definition_id
            AND running.state = @running_state
            AND running.tenant_id = pending.tenant_id) < @reservation
        LIMIT @limit
      )
    `),
    countUnderReservedWorkspaces: database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT pending.workspace_id
        FROM work_items pending
        WHERE pending.queue_definition_id = @queue_definition_id
          AND pending.scope_key = @scope_key
          AND pending.state IN (@queued_state, @recovered_state)
          AND pending.available_at_ms <= @now_ms
          AND (pending.expires_at_ms = 0 OR pending.expires_at_ms > @now_ms)
          AND pending.tenant_id = @tenant_id
          AND pending.workspace_id <> @workspace_id
        GROUP BY pending.workspace_id
        HAVING (SELECT COUNT(*) FROM work_items running
          WHERE running.queue_definition_id = pending.queue_definition_id
            AND running.state = @running_state
            AND running.tenant_id = pending.tenant_id
            AND running.workspace_id = pending.workspace_id) < @reservation
        LIMIT @limit
      )
    `),
    countUnderReservedProjects: database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT pending.project_id
        FROM work_items pending
        WHERE pending.queue_definition_id = @queue_definition_id
          AND pending.scope_key = @scope_key
          AND pending.state IN (@queued_state, @recovered_state)
          AND pending.available_at_ms <= @now_ms
          AND (pending.expires_at_ms = 0 OR pending.expires_at_ms > @now_ms)
          AND pending.tenant_id = @tenant_id
          AND pending.workspace_id = @workspace_id
          AND pending.project_id <> @project_id
        GROUP BY pending.project_id
        HAVING (SELECT COUNT(*) FROM work_items running
          WHERE running.queue_definition_id = pending.queue_definition_id
            AND running.state = @running_state
            AND running.tenant_id = pending.tenant_id
            AND running.workspace_id = pending.workspace_id
            AND running.project_id = pending.project_id) < @reservation
        LIMIT @limit
      )
    `),
    insertJournal: database.prepare(`
      INSERT INTO work_queue_transition_journal (
        journal_entry_id, work_item_id, queue_definition_id, queue_definition_version,
        transition, from_state, to_state, lease_id, lease_seq, operation_id,
        actor_json, reason, policy_version, decision_json, created_at_ms, adopted_time_ms
      ) VALUES (
        @journal_entry_id, @work_item_id, @queue_definition_id, @queue_definition_version,
        @transition, @from_state, @to_state, @lease_id, @lease_seq, @operation_id,
        @actor_json, @reason, @policy_version, @decision_json, @created_at_ms, @adopted_time_ms
      )
    `),
    updateLastTransitionSeq: database.prepare(`
      UPDATE work_items
      SET last_transition_seq = @seq,
          updated_at_ms = @updated_at_ms
      WHERE work_item_id = @work_item_id
    `),
    getWorkItem: database.prepare("SELECT * FROM work_items WHERE work_item_id = ?"),
    getDefinitionPolicy: database.prepare(`
      SELECT policy_json FROM queue_definitions
      WHERE queue_definition_id = ? AND queue_definition_version = ?
    `),
    getLatestDefinitionPolicy: database.prepare(`
      SELECT policy_json FROM queue_definitions
      WHERE queue_definition_id = @queue_definition_id
        AND (@queue_definition_version = 0 OR queue_definition_version = @queue_definition_version)
      ORDER BY queue_definition_version DESC
      LIMIT 1
    `),
    getLastTransition: database.prepare(`
      SELECT transition, lease_id, lease_seq
      FROM work_queue_transition_journal
      WHERE work_item_id = ?
      ORDER BY seq DESC
      LIMIT 1
    `),
    getDedupe: database.prepare(`
      SELECT *
      FROM work_items
      WHERE queue_definition_id = ?
        AND scope_key = ?
        AND dedupe_key = ?
        AND dedupe_key <> ''
      ORDER BY created_at_ms ASC
      LIMIT 1
    `),
    materializeDelayed: database.prepare(`
      SELECT *
      FROM work_items
      WHERE state = @state
        AND available_at_ms <= @now_ms
        AND (expires_at_ms = 0 OR expires_at_ms > @now_ms)
        AND (@queue_definition_id = '' OR queue_definition_id = @queue_definition_id)
        AND (@scope_key = '' OR scope_key = @scope_key)
      ORDER BY available_at_ms ASC, created_at_ms ASC
      LIMIT @limit
    `),
    expiredLeases: database.prepare(`
      SELECT *
      FROM work_items
      WHERE state = @state
        AND lease_expires_at_ms > 0
        AND lease_expires_at_ms <= @now_ms
        AND (@queue_definition_id = '' OR queue_definition_id = @queue_definition_id)
        AND (@scope_key = '' OR scope_key = @scope_key)
      ORDER BY lease_expires_at_ms ASC, created_at_ms ASC
      LIMIT @limit
    `),
    expiredWorkItems: database.prepare(`
      SELECT *
      FROM work_items
      WHERE state IN (@queued_state, @retry_wait_state, @running_state, @recovered_state)
        AND expires_at_ms > 0
        AND expires_at_ms <= @now_ms
        AND (@queue_definition_id = '' OR queue_definition_id = @queue_definition_id)
        AND (@scope_key = '' OR scope_key = @scope_key)
      ORDER BY expires_at_ms ASC, created_at_ms ASC
      LIMIT @limit
    `),
    updateStateProjection: database.prepare(`
      UPDATE work_items
      SET state = @state,
          available_at_ms = @available_at_ms,
          attempt = @attempt,
          max_attempts = @max_attempts,
          lease_id = @lease_id,
          lease_seq = @lease_seq,
          leased_by_worker_id = @leased_by_worker_id,
          lease_expires_at_ms = @lease_expires_at_ms,
          fallback_task_id = @fallback_task_id,
          last_error_json = @last_error_json,
          updated_at_ms = @updated_at_ms
      WHERE work_item_id = @work_item_id
    `),
    claimCandidatesBase: database.prepare(`
      SELECT *
      FROM work_items candidate
      WHERE candidate.queue_definition_id = @queue_definition_id
        AND candidate.scope_key = @scope_key
        AND candidate.state = @state
        AND candidate.available_at_ms <= @now_ms
        AND (candidate.expires_at_ms = 0 OR candidate.expires_at_ms > @now_ms)
        AND (@queue_definition_version = 0 OR candidate.queue_definition_version = @queue_definition_version)
        AND NOT EXISTS (
          SELECT 1
          FROM work_items active
          WHERE active.queue_definition_id = candidate.queue_definition_id
            AND active.scope_key = candidate.scope_key
            AND active.concurrency_key = candidate.concurrency_key
            AND active.concurrency_key <> ''
            AND active.state = '${WORK_QUEUE_STATES.RUNNING}'
            AND active.work_item_id <> candidate.work_item_id
        )
      ORDER BY candidate.priority DESC, candidate.available_at_ms ASC, candidate.created_at_ms ASC
      LIMIT @limit
    `),
    countOutstanding: database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM work_items
        WHERE queue_definition_id = @queue_definition_id
          AND state IN ('queued', 'retry_wait', 'running', 'recovered')
          AND (@tenant_id = '' OR tenant_id = @tenant_id)
          AND (@workspace_id = '' OR workspace_id = @workspace_id)
          AND (@project_id = '' OR project_id = @project_id)
        LIMIT @limit
      )
    `),
    countStateByHierarchy: database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM work_items
        WHERE queue_definition_id = @queue_definition_id
          AND state = @state
          AND (@tenant_id = '' OR tenant_id = @tenant_id)
          AND (@workspace_id = '' OR workspace_id = @workspace_id)
          AND (@project_id = '' OR project_id = @project_id)
        LIMIT @limit
      )
    `),
    countRetainedState: database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM work_items
        WHERE queue_definition_id = @queue_definition_id
          AND state = @state
        LIMIT @limit
      )
    `),
    oldestFailedItems: database.prepare(`
      SELECT * FROM work_items
      WHERE queue_definition_id = @queue_definition_id
        AND state = @state
        AND work_item_id <> @exclude_work_item_id
      ORDER BY updated_at_ms ASC, work_item_id ASC
      LIMIT @limit
    `),
    oldestTerminalItems: database.prepare(`
      SELECT work_item_id FROM work_items
      WHERE queue_definition_id = @queue_definition_id
        AND state IN (@completed_state, @cancelled_state, @expired_state)
        AND work_item_id <> @exclude_work_item_id
      ORDER BY updated_at_ms ASC, work_item_id ASC
      LIMIT @limit
    `),
    deleteJournalByWorkItem: database.prepare(`
      DELETE FROM work_queue_transition_journal WHERE work_item_id = ?
    `),
    deleteFallbackTasksByWorkItem: database.prepare(`
      DELETE FROM work_queue_fallback_tasks WHERE work_item_id = ?
    `),
    deleteWorkItem: database.prepare("DELETE FROM work_items WHERE work_item_id = ?"),
    countJournalByQueue: database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM work_queue_transition_journal
        WHERE queue_definition_id = @queue_definition_id
        LIMIT @limit
      )
    `),
    countJournalByWorkItem: database.prepare(`
      SELECT COUNT(*) AS count FROM work_queue_transition_journal WHERE work_item_id = ?
    `),
    oldestJournalCandidates: database.prepare(`
      SELECT work_item_id FROM work_queue_transition_journal
      WHERE queue_definition_id = @queue_definition_id
        AND work_item_id <> @exclude_work_item_id
      ORDER BY seq ASC
      LIMIT @limit
    `),
    getFairnessCursor: database.prepare(`
      SELECT cursor_value
      FROM work_queue_fairness_cursors
      WHERE queue_definition_id = @queue_definition_id
        AND queue_definition_version = @queue_definition_version
        AND selector_scope_key = @selector_scope_key
        AND priority_class = @priority_class
        AND level = @level
        AND parent_key = @parent_key
    `),
    upsertFairnessCursor: database.prepare(`
      INSERT INTO work_queue_fairness_cursors (
        queue_definition_id, queue_definition_version, selector_scope_key,
        priority_class, level, parent_key, cursor_value, updated_at_ms
      ) VALUES (
        @queue_definition_id, @queue_definition_version, @selector_scope_key,
        @priority_class, @level, @parent_key, @cursor_value, @updated_at_ms
      )
      ON CONFLICT(
        queue_definition_id, queue_definition_version, selector_scope_key,
        priority_class, level, parent_key
      ) DO UPDATE SET
        cursor_value = excluded.cursor_value,
        updated_at_ms = excluded.updated_at_ms
    `),
    countNonterminalByBoundary: database.prepare(`
      SELECT COUNT(*) AS count
      FROM work_items
      WHERE queue_definition_id = @queue_definition_id
        AND scope_key = @scope_key
        AND state NOT IN (@completed_state, @cancelled_state, @expired_state)
    `),
    deleteFairnessCursorsByBoundary: database.prepare(`
      DELETE FROM work_queue_fairness_cursors
      WHERE queue_definition_id = @queue_definition_id
        AND selector_scope_key = @scope_key
    `),
    nextFairTenant: database.prepare(`
      SELECT tenant_id AS value
      FROM work_items
      WHERE queue_definition_id = @queue_definition_id
        AND scope_key = @scope_key
        AND (@queue_definition_version = 0 OR queue_definition_version = @queue_definition_version)
        AND state IN (@state, @recovered_state)
        AND priority_class = @priority_class
        AND available_at_ms <= @now_ms
        AND (expires_at_ms = 0 OR expires_at_ms > @now_ms)
        AND (@from_start = 1 OR tenant_id > @cursor)
      GROUP BY tenant_id
      ORDER BY tenant_id ASC
      LIMIT 1
    `),
    nextFairWorkspace: database.prepare(`
      SELECT workspace_id AS value
      FROM work_items
      WHERE queue_definition_id = @queue_definition_id
        AND scope_key = @scope_key
        AND (@queue_definition_version = 0 OR queue_definition_version = @queue_definition_version)
        AND state IN (@state, @recovered_state)
        AND priority_class = @priority_class
        AND available_at_ms <= @now_ms
        AND (expires_at_ms = 0 OR expires_at_ms > @now_ms)
        AND tenant_id = @tenant_id
        AND (@from_start = 1 OR workspace_id > @cursor)
      GROUP BY workspace_id
      ORDER BY workspace_id ASC
      LIMIT 1
    `),
    nextFairProject: database.prepare(`
      SELECT project_id AS value
      FROM work_items
      WHERE queue_definition_id = @queue_definition_id
        AND scope_key = @scope_key
        AND (@queue_definition_version = 0 OR queue_definition_version = @queue_definition_version)
        AND state IN (@state, @recovered_state)
        AND priority_class = @priority_class
        AND available_at_ms <= @now_ms
        AND (expires_at_ms = 0 OR expires_at_ms > @now_ms)
        AND tenant_id = @tenant_id
        AND workspace_id = @workspace_id
        AND (@from_start = 1 OR project_id > @cursor)
      GROUP BY project_id
      ORDER BY project_id ASC
      LIMIT 1
    `),
    fairLeafCandidate: database.prepare(`
      SELECT *
      FROM work_items candidate
      WHERE candidate.queue_definition_id = @queue_definition_id
        AND candidate.scope_key = @scope_key
        AND (@queue_definition_version = 0 OR candidate.queue_definition_version = @queue_definition_version)
        AND candidate.state IN (@state, @recovered_state)
        AND candidate.priority_class = @priority_class
        AND candidate.available_at_ms <= @now_ms
        AND (candidate.expires_at_ms = 0 OR candidate.expires_at_ms > @now_ms)
        AND candidate.tenant_id = @tenant_id
        AND candidate.workspace_id = @workspace_id
        AND candidate.project_id = @project_id
        AND NOT EXISTS (
          SELECT 1 FROM work_items active
          WHERE active.queue_definition_id = candidate.queue_definition_id
            AND active.scope_key = candidate.scope_key
            AND active.concurrency_key = candidate.concurrency_key
            AND active.concurrency_key <> ''
            AND active.state = '${WORK_QUEUE_STATES.RUNNING}'
            AND active.work_item_id <> candidate.work_item_id
        )
      ORDER BY candidate.available_at_ms ASC, candidate.created_at_ms ASC, candidate.work_item_id ASC
      LIMIT 1
    `),
    insertBackgroundWrite: database.prepare(`
      INSERT OR REPLACE INTO work_queue_background_writes (
        background_write_id, aspect_type, entity_id, state_json, status,
        attempt, next_retry_at_ms, last_error_json, created_at_ms, updated_at_ms
      ) VALUES (
        @background_write_id, @aspect_type, @entity_id, @state_json, @status,
        @attempt, @next_retry_at_ms, @last_error_json, @created_at_ms, @updated_at_ms
      )
    `),
    upsertHealth: database.prepare(`
      INSERT INTO work_queue_internal_health (health_key, state_json, updated_at_ms)
      VALUES (@health_key, @state_json, @updated_at_ms)
      ON CONFLICT(health_key) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at_ms = excluded.updated_at_ms
    `),
    insertFallbackTask: database.prepare(`
      INSERT OR REPLACE INTO work_queue_fallback_tasks (
        fallback_task_id, work_item_id, state, attempt, max_attempts,
        reason, decision_json, created_at_ms, updated_at_ms
      ) VALUES (
        @fallback_task_id, @work_item_id, @state, @attempt, @max_attempts,
        @reason, @decision_json, @created_at_ms, @updated_at_ms
      )
    `),
    upsertQueueControl: database.prepare(`
      INSERT INTO work_queue_controls (
        queue_definition_id, scope_key, mode, reason, actor_json, updated_at_ms
      ) VALUES (
        @queue_definition_id, @scope_key, @mode, @reason, @actor_json, @updated_at_ms
      )
      ON CONFLICT(queue_definition_id, scope_key) DO UPDATE SET
        mode = excluded.mode,
        reason = excluded.reason,
        actor_json = excluded.actor_json,
        updated_at_ms = excluded.updated_at_ms
    `),
    getQueueControl: database.prepare(`
      SELECT *
      FROM work_queue_controls
      WHERE queue_definition_id = @queue_definition_id
        AND scope_key = @scope_key
    `)
  };
}
