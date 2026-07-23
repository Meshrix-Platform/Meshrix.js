import { assertLegalWorkQueueTransition } from "../workflow/state-machine/work-queue/state-machine.mjs";
import { asObject, journalRowToTransition } from "./store-serialization.mjs";

export function rebuildSqliteProjection({ database, statements, input = {} }) {
  const journalRows = database.prepare(`
    SELECT *
    FROM work_queue_transition_journal
    ORDER BY seq ASC
  `).all();
  const replayed = new Map();
  const errors = [];
  for (const journalRow of journalRows) {
    const event = journalRowToTransition(journalRow);
    const current = replayed.get(event.workItemId) || null;
    try {
      assertLegalWorkQueueTransition({
        transition: event.transition,
        fromState: current ? current.state : null,
        toState: event.toState
      });
    } catch (error) {
      errors.push({ seq: event.seq, workItemId: event.workItemId, error: error.message });
      continue;
    }
    if (event.transition === "enqueue" || event.transition === "retention_snapshot") {
      const projectionRow = event.decision.projectionRow;
      if (!projectionRow) {
        errors.push({ seq: event.seq, workItemId: event.workItemId, error: "projection baseline event has no projectionRow" });
        continue;
      }
      replayed.set(event.workItemId, { ...projectionRow, state: event.toState, last_transition_seq: event.seq });
      continue;
    }
    if (!current) {
      errors.push({ seq: event.seq, workItemId: event.workItemId, error: "transition has no prior projection" });
      continue;
    }
    replayed.set(event.workItemId, {
      ...current,
      ...asObject(event.decision.projectionPatch),
      state: event.toState,
      last_transition_seq: event.seq
    });
  }

  const actualRows = database.prepare("SELECT * FROM work_items ORDER BY work_item_id ASC").all();
  const drift = [];
  const actualIds = new Set(actualRows.map((row) => row.work_item_id));
  for (const actual of actualRows) {
    const expected = replayed.get(actual.work_item_id);
    if (!expected) {
      drift.push({ workItemId: actual.work_item_id, reason: "missing_from_replay" });
      continue;
    }
    for (const column of [
      "state",
      "attempt",
      "lease_id",
      "lease_seq",
      "leased_by_worker_id",
      "lease_expires_at_ms",
      "expires_at_ms",
      "available_at_ms"
    ]) {
      const expectedValue = column === "expires_at_ms" ? expected[column] ?? 0 : expected[column] ?? "";
      if (String(actual[column]) !== String(expectedValue)) {
        drift.push({ workItemId: actual.work_item_id, column, actual: actual[column], expected: expected[column] });
      }
    }
  }

  for (const workItemId of replayed.keys()) {
    if (!actualIds.has(workItemId)) {
      drift.push({ workItemId, reason: "missing_from_projection" });
    }
  }

  let applied = false;
  if (input.dryRun === false && errors.length === 0) {
    database.prepare("DELETE FROM work_items").run();
    for (const row of replayed.values()) {
      statements.insertWorkItem.run({
        ...row,
        expires_at_ms: row.expires_at_ms || 0,
        last_transition_seq: row.last_transition_seq || 0
      });
    }
    applied = true;
  }

  return {
    ok: errors.length === 0 && (applied || drift.length === 0),
    applied,
    replayed: replayed.size,
    journalEntries: journalRows.length,
    errors,
    drift: applied ? [] : drift,
    repairedDrift: applied ? drift : []
  };
}
