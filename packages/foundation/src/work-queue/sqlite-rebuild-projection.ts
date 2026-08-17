import { assertLegalWorkQueueTransition } from "../workflow/state-machine/work-queue/state-machine.ts";
import { asObject, journalRowToTransition } from "./store-serialization.ts";
import type Database from "better-sqlite3";

type SqlRow = Record<string, unknown>;
interface RebuildStatements {
  insertWorkItem: Database.Statement<[SqlRow], unknown>;
}
interface RebuildInput {
  dryRun?: boolean;
}
interface RebuildOptions {
  database: Database.Database;
  statements: RebuildStatements;
  input?: RebuildInput;
}
interface ReplayEvent {
  seq: number;
  workItemId: string;
  transition: string;
  toState: string;
  decision: SqlRow;
}
interface ReplayError {
  seq: number;
  workItemId: string;
  error: string;
}
type Drift = Record<string, unknown> & { workItemId: string };
function record(value: unknown): SqlRow | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as SqlRow)
    : null;
}
function replayEvent(value: unknown): ReplayEvent {
  const row = record(value);
  const decision = record(row?.decision);
  if (
    !row ||
    !decision ||
    !Number.isSafeInteger(row.seq) ||
    typeof row.workItemId !== "string" ||
    typeof row.transition !== "string" ||
    typeof row.toState !== "string"
  )
    throw new TypeError("SQLite journal transition is invalid.");
  return {
    seq: Number(row.seq),
    workItemId: row.workItemId,
    transition: row.transition,
    toState: row.toState,
    decision,
  };
}

export function rebuildSqliteProjection({
  database,
  statements,
  input = {},
}: RebuildOptions) {
  const journalRows = database
    .prepare<[], SqlRow>(
      `
    SELECT *
    FROM work_queue_transition_journal
    ORDER BY seq ASC
  `,
    )
    .all();
  const replayed = new Map<string, SqlRow>();
  const errors: ReplayError[] = [];
  for (const journalRow of journalRows) {
    const event = replayEvent(journalRowToTransition(journalRow));
    const current = replayed.get(event.workItemId) || null;
    try {
      assertLegalWorkQueueTransition({
        transition: event.transition,
        fromState: current ? current.state : null,
        toState: event.toState,
      });
    } catch (error: unknown) {
      errors.push({
        seq: event.seq,
        workItemId: event.workItemId,
        error: error instanceof Error ? error.message : "invalid transition",
      });
      continue;
    }
    if (
      event.transition === "enqueue" ||
      event.transition === "retention_snapshot"
    ) {
      const projectionRow = record(event.decision.projectionRow);
      if (!projectionRow) {
        errors.push({
          seq: event.seq,
          workItemId: event.workItemId,
          error: "projection baseline event has no projectionRow",
        });
        continue;
      }
      replayed.set(event.workItemId, {
        ...projectionRow,
        state: event.toState,
        last_transition_seq: event.seq,
      });
      continue;
    }
    if (!current) {
      errors.push({
        seq: event.seq,
        workItemId: event.workItemId,
        error: "transition has no prior projection",
      });
      continue;
    }
    replayed.set(event.workItemId, {
      ...current,
      ...asObject(event.decision.projectionPatch),
      state: event.toState,
      last_transition_seq: event.seq,
    });
  }

  const actualRows = database
    .prepare<[], SqlRow>("SELECT * FROM work_items ORDER BY work_item_id ASC")
    .all();
  const drift: Drift[] = [];
  const actualIds = new Set<string>(
    actualRows.map((row) => String(row.work_item_id || "")),
  );
  for (const actual of actualRows) {
    const workItemId = String(actual.work_item_id || "");
    const expected = replayed.get(workItemId);
    if (!expected) {
      drift.push({ workItemId, reason: "missing_from_replay" });
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
      "available_at_ms",
    ]) {
      const expectedValue =
        column === "expires_at_ms"
          ? (expected[column] ?? 0)
          : (expected[column] ?? "");
      if (String(actual[column]) !== String(expectedValue)) {
        drift.push({
          workItemId,
          column,
          actual: actual[column],
          expected: expected[column],
        });
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
        last_transition_seq: row.last_transition_seq || 0,
      });
    }
    database.prepare("DELETE FROM work_queue_virtual_finish").run();
    database
      .prepare(
        `
      INSERT OR IGNORE INTO work_queue_virtual_finish (
        queue_definition_id, queue_definition_version, selector_scope_key,
        priority_class, tenant_id, workspace_id, project_id, virtual_finish, updated_at_ms
      )
      SELECT queue_definition_id, queue_definition_version, scope_key, priority_class,
             tenant_id, workspace_id, project_id, 0, MAX(updated_at_ms)
      FROM work_items
      GROUP BY queue_definition_id, queue_definition_version, scope_key, priority_class,
               tenant_id, workspace_id, project_id
    `,
      )
      .run();
    applied = true;
  }

  return {
    ok: errors.length === 0 && (applied || drift.length === 0),
    applied,
    replayed: replayed.size,
    journalEntries: journalRows.length,
    errors,
    drift: applied ? [] : drift,
    repairedDrift: applied ? drift : [],
  };
}
