import { WORK_QUEUE_STATES } from "../workflow/state-machine/work-queue/state-machine.ts";
import type Database from "better-sqlite3";

export function prepareSqliteWorkQueueStatements(database: Database.Database): Record<string, Database.Statement> {
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
    getWorkItem: database.prepare(
      "SELECT * FROM work_items WHERE work_item_id = ?",
    ),
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
    insertSinkFence: database.prepare(`
      INSERT OR IGNORE INTO work_queue_sink_fences (
        work_item_id, generation, sink_id, effect_id, status, settled_at_ms
      ) VALUES (@work_item_id, @generation, @sink_id, @effect_id, @status, @settled_at_ms)
    `),
    readSinkFence: database.prepare(`
      SELECT *
      FROM work_queue_sink_fences
      WHERE work_item_id = @work_item_id AND generation = @generation
      ORDER BY sink_id
    `),
    inDoubtCandidates: database.prepare(`
      SELECT *
      FROM work_items
      WHERE state = @state
        AND (@queue_definition_id = '' OR queue_definition_id = @queue_definition_id)
        AND (@scope_key = '' OR scope_key = @scope_key)
        AND (@work_item_id = '' OR work_item_id = @work_item_id)
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
    deleteWorkItem: database.prepare(
      "DELETE FROM work_items WHERE work_item_id = ?",
    ),
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
    incrementRetentionState: database.prepare(`
      INSERT INTO work_queue_retention_state (
        queue_definition_id, pending_transitions, updated_at_ms
      ) VALUES (@queue_definition_id, 1, @updated_at_ms)
      ON CONFLICT(queue_definition_id) DO UPDATE SET
        pending_transitions = work_queue_retention_state.pending_transitions + 1,
        updated_at_ms = excluded.updated_at_ms
      RETURNING pending_transitions
    `),
    resetRetentionState: database.prepare(`
      UPDATE work_queue_retention_state
      SET pending_transitions = 0,
          updated_at_ms = @updated_at_ms
      WHERE queue_definition_id = @queue_definition_id
        AND pending_transitions >= @threshold
    `),
    upsertVirtualFinish: database.prepare(`
      INSERT INTO work_queue_virtual_finish (
        queue_definition_id, queue_definition_version, selector_scope_key,
        priority_class, tenant_id, workspace_id, project_id, virtual_finish, updated_at_ms
      ) VALUES (
        @queue_definition_id, @queue_definition_version, @selector_scope_key,
        @priority_class, @tenant_id, @workspace_id, @project_id, 0, @updated_at_ms
      )
      ON CONFLICT(
        queue_definition_id, queue_definition_version, selector_scope_key,
        priority_class, tenant_id, workspace_id, project_id
      ) DO UPDATE SET
        updated_at_ms = excluded.updated_at_ms
    `),
    advanceVirtualFinish: database.prepare(`
      UPDATE work_queue_virtual_finish
      SET virtual_finish = virtual_finish + 1,
          updated_at_ms = @updated_at_ms
      WHERE queue_definition_id = @queue_definition_id
        AND queue_definition_version = @queue_definition_version
        AND selector_scope_key = @selector_scope_key
        AND priority_class = @priority_class
        AND tenant_id = @tenant_id
        AND workspace_id = @workspace_id
        AND project_id = @project_id
    `),
    virtualFinishTotal: database.prepare(`
      SELECT COALESCE(SUM(virtual_finish), 0) AS total
      FROM work_queue_virtual_finish
      WHERE queue_definition_id = @queue_definition_id
        AND selector_scope_key = @selector_scope_key
        AND (@queue_definition_version = 0 OR queue_definition_version = @queue_definition_version)
    `),
    countNonterminalByBoundary: database.prepare(`
      SELECT COUNT(*) AS count
      FROM work_items
      WHERE queue_definition_id = @queue_definition_id
        AND scope_key = @scope_key
        AND state NOT IN (@completed_state, @cancelled_state, @expired_state)
    `),
    deleteVirtualFinishByBoundary: database.prepare(`
      DELETE FROM work_queue_virtual_finish
      WHERE queue_definition_id = @queue_definition_id
        AND selector_scope_key = @scope_key
    `),
    fairRankedCandidate: database.prepare(`
      WITH all_partitions AS (
        SELECT projection.queue_definition_version,
               projection.tenant_id, projection.workspace_id, projection.project_id,
               projection.virtual_finish
        FROM work_queue_virtual_finish projection
        WHERE projection.queue_definition_id = @queue_definition_id
          AND projection.selector_scope_key = @selector_scope_key
          AND (@queue_definition_version = 0 OR projection.queue_definition_version = @queue_definition_version)
          AND projection.priority_class = @priority_class
          AND (@tenant_id = '' OR projection.tenant_id = @tenant_id)
          AND (@workspace_id = '' OR projection.workspace_id = @workspace_id)
          AND (@project_id = '' OR projection.project_id = @project_id)
          AND NOT EXISTS (
            SELECT 1 FROM json_each(@rejected_partitions)
            WHERE json_each.value = projection.tenant_id || char(31) || projection.workspace_id || char(31) || projection.project_id
          )
      ),
      eligible_partitions AS (
        SELECT all_partitions.*
        FROM all_partitions
        WHERE EXISTS (
          SELECT 1 FROM work_items pending
          WHERE pending.queue_definition_id = @queue_definition_id
            AND pending.scope_key = @selector_scope_key
            AND pending.state IN (@state, @recovered_state)
            AND pending.priority_class = @priority_class
            AND pending.available_at_ms <= @now_ms
            AND (pending.expires_at_ms = 0 OR pending.expires_at_ms > @now_ms)
            AND pending.tenant_id = all_partitions.tenant_id
            AND pending.workspace_id = all_partitions.workspace_id
            AND pending.project_id = all_partitions.project_id
            AND NOT EXISTS (
              SELECT 1 FROM work_items active
              WHERE active.queue_definition_id = pending.queue_definition_id
                AND active.scope_key = pending.scope_key
                AND active.concurrency_key = pending.concurrency_key
                AND active.concurrency_key <> ''
                AND active.state = '${WORK_QUEUE_STATES.RUNNING}'
                AND active.work_item_id <> pending.work_item_id
            )
        )
      ),
      ranked_partitions AS (
        SELECT ep.*,
               DENSE_RANK() OVER (ORDER BY ep.tenant_id) - 1 AS tenant_rank,
               DENSE_RANK() OVER (PARTITION BY ep.tenant_id ORDER BY ep.workspace_id) - 1 AS workspace_rank,
               DENSE_RANK() OVER (PARTITION BY ep.tenant_id, ep.workspace_id ORDER BY ep.project_id) - 1 AS project_rank,
               (SELECT SUM(claims.virtual_finish)
                FROM all_partitions claims
                WHERE claims.tenant_id = ep.tenant_id) AS tenant_claims,
               (SELECT SUM(claims.virtual_finish)
                FROM all_partitions claims
                WHERE claims.tenant_id = ep.tenant_id
                  AND claims.workspace_id = ep.workspace_id) AS workspace_claims,
               (SELECT COUNT(DISTINCT tenants.tenant_id) FROM all_partitions tenants) AS tenant_count,
               (SELECT COUNT(DISTINCT workspaces.workspace_id)
                FROM all_partitions workspaces
                WHERE workspaces.tenant_id = ep.tenant_id) AS workspace_count,
               (SELECT COUNT(DISTINCT projects.project_id)
                FROM all_partitions projects
                WHERE projects.tenant_id = ep.tenant_id
                  AND projects.workspace_id = ep.workspace_id) AS project_count
        FROM eligible_partitions ep
      )
      SELECT candidate.*
      FROM ranked_partitions ranked
      JOIN work_items candidate
        ON candidate.queue_definition_id = @queue_definition_id
       AND candidate.scope_key = @selector_scope_key
       AND (@queue_definition_version = 0 OR candidate.queue_definition_version = @queue_definition_version)
       AND candidate.state IN (@state, @recovered_state)
       AND candidate.priority_class = @priority_class
       AND candidate.available_at_ms <= @now_ms
       AND (candidate.expires_at_ms = 0 OR candidate.expires_at_ms > @now_ms)
       AND candidate.queue_definition_version = ranked.queue_definition_version
       AND candidate.tenant_id = ranked.tenant_id
       AND candidate.workspace_id = ranked.workspace_id
       AND candidate.project_id = ranked.project_id
       AND NOT EXISTS (
         SELECT 1 FROM work_items active
         WHERE active.queue_definition_id = candidate.queue_definition_id
           AND active.scope_key = candidate.scope_key
           AND active.concurrency_key = candidate.concurrency_key
           AND active.concurrency_key <> ''
           AND active.state = '${WORK_QUEUE_STATES.RUNNING}'
           AND active.work_item_id <> candidate.work_item_id
       )
      ORDER BY (ranked.tenant_claims * ranked.tenant_count + ranked.tenant_rank) ASC,
               (ranked.workspace_claims * ranked.workspace_count + ranked.workspace_rank) ASC,
               (ranked.virtual_finish * ranked.project_count + ranked.project_rank) ASC,
               candidate.available_at_ms ASC, candidate.created_at_ms ASC, candidate.work_item_id ASC
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
    `),
  };
}
