import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { MAX_JOURNAL_RECORDS } from "./constants.mjs";
import { acquireDataRootOwnership } from "./data-root-ownership.mjs";

const BUDGET_SNAPSHOT = "daily_budget_snapshot";

async function atomicWrite(file, value, { durable = false } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.replace-${crypto.randomUUID()}`;
  const handle = await fs.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    if (durable) await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  if (durable) {
    const directoryHandle = await fs.open(path.dirname(file), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
}

async function readArray(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(value)) throw new Error("private_state_array_invalid");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function emptyDailyBudget(day) {
  return { day, calls: 0, cost: 0, reservations: {} };
}

function dailyBudgetFrom(records, day) {
  const snapshot = records.filter((entry) => entry?.state === BUDGET_SNAPSHOT).at(-1);
  if (!snapshot) return emptyDailyBudget(day);
  if (typeof snapshot.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(snapshot.day)) {
    throw new Error("daily_budget_state_invalid");
  }
  if (snapshot.day !== day) return emptyDailyBudget(day);
  if (!Number.isSafeInteger(snapshot.calls) || snapshot.calls < 0 ||
      !Number.isSafeInteger(snapshot.cost) || snapshot.cost < 0 ||
      !snapshot.reservations || typeof snapshot.reservations !== "object" || Array.isArray(snapshot.reservations)) {
    throw new Error("daily_budget_state_invalid");
  }
  const reservations = Object.entries(snapshot.reservations);
  if (reservations.length !== snapshot.calls || reservations.some(([key, costUnits]) =>
    !/^[0-9a-f]{32}:(?:model|operation:\d+)$/u.test(key) ||
    !Number.isSafeInteger(costUnits) || costUnits < 0 || costUnits > 1
  )) {
    throw new Error("daily_budget_state_invalid");
  }
  const cost = reservations.reduce((total, [, costUnits]) => total + costUnits, 0);
  if (cost !== snapshot.cost) throw new Error("daily_budget_state_invalid");
  return { day, calls: snapshot.calls, cost: snapshot.cost, reservations: { ...snapshot.reservations } };
}

function withBudgetSnapshot(records, budget) {
  const events = records.filter((entry) => entry?.state !== BUDGET_SNAPSHOT);
  const snapshot = {
    at: new Date().toISOString(),
    state: BUDGET_SNAPSHOT,
    day: budget.day,
    calls: budget.calls,
    cost: budget.cost,
    reservations: budget.reservations
  };
  return [snapshot, ...events.slice(-MAX_JOURNAL_RECORDS)];
}

export class PrivateStateStore {
  #root;
  #journalFile;
  #queueFile;
  #journalTail = Promise.resolve();
  #queueTail = Promise.resolve();
  #ownership = null;

  constructor(root) {
    this.#root = root;
    this.#journalFile = path.join(root, "journal.json");
    this.#queueFile = path.join(root, "queue.json");
  }

  async acquireOwnership() {
    if (this.#ownership) return;
    this.#ownership = await acquireDataRootOwnership(this.#root);
  }

  async close() {
    if (!this.#ownership) return;
    const settled = await Promise.allSettled([this.#journalTail, this.#queueTail]);
    this.#ownership.close();
    this.#ownership = null;
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  #assertOwned() {
    if (!this.#ownership) throw new Error("self_maintenance_data_root_not_owned");
  }

  async record(entry) {
    this.#assertOwned();
    this.#journalTail = this.#journalTail.catch(() => {}).then(async () => {
      const records = await readArray(this.#journalFile);
      const event = Object.freeze({
        at: new Date().toISOString(),
        runId: entry.runId || null,
        revision: entry.revision || null,
        scheduleId: entry.scheduleId || null,
        state: entry.state,
        code: entry.code || null,
        operationId: entry.operationId || null,
        operationIndex: Number.isSafeInteger(entry.operationIndex) ? entry.operationIndex : null
      });
      const snapshot = records.filter((record) => record?.state === BUDGET_SNAPSHOT).at(-1);
      const events = records.filter((record) => record?.state !== BUDGET_SNAPSHOT);
      events.push(event);
      await atomicWrite(this.#journalFile, [
        ...(snapshot ? [snapshot] : []),
        ...events.slice(-MAX_JOURNAL_RECORDS)
      ], { durable: true });
    });
    await this.#journalTail;
  }

  async loadDailyBudget(day) {
    this.#assertOwned();
    await this.#journalTail;
    return dailyBudgetFrom(await readArray(this.#journalFile), day);
  }

  async reserveDailyBudget({ day, reservationKey, maxCalls, maxCostUnits, costUnits }) {
    this.#assertOwned();
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(day) ||
        !/^[0-9a-f]{32}:(?:model|operation:\d+)$/u.test(reservationKey) ||
        !Number.isSafeInteger(maxCalls) || maxCalls < 1 ||
        !Number.isSafeInteger(maxCostUnits) || maxCostUnits < 1 ||
        !Number.isSafeInteger(costUnits) || costUnits < 0 || costUnits > 1) {
      throw new TypeError("daily_budget_reservation_invalid");
    }
    const task = this.#journalTail.catch(() => {}).then(async () => {
      const records = await readArray(this.#journalFile);
      const budget = dailyBudgetFrom(records, day);
      if (Object.hasOwn(budget.reservations, reservationKey)) {
        if (budget.reservations[reservationKey] !== costUnits) throw new Error("daily_budget_reservation_conflict");
        return { reserved: true, duplicate: true, budget };
      }
      if (budget.calls + 1 > maxCalls || budget.cost + costUnits > maxCostUnits) {
        return { reserved: false, duplicate: false, budget };
      }
      const next = {
        day,
        calls: budget.calls + 1,
        cost: budget.cost + costUnits,
        reservations: { ...budget.reservations, [reservationKey]: costUnits }
      };
      await atomicWrite(this.#journalFile, withBudgetSnapshot(records, next), { durable: true });
      return { reserved: true, duplicate: false, budget: next };
    });
    this.#journalTail = task;
    return task;
  }

  async loadCompletedRunIds() {
    this.#assertOwned();
    await this.#journalTail;
    return new Set((await readArray(this.#journalFile))
      .filter((entry) => entry?.state === "completed" &&
        typeof entry.runId === "string")
      .map((entry) => entry.runId));
  }

  async loadCompletedOperationIndices(runId) {
    this.#assertOwned();
    await this.#journalTail;
    return new Set((await readArray(this.#journalFile))
      .filter((entry) => entry?.state === "operation_completed" && entry.runId === runId &&
        Number.isSafeInteger(entry.operationIndex) && entry.operationIndex >= 0)
      .map((entry) => entry.operationIndex));
  }

  async loadQueue() {
    this.#assertOwned();
    return readArray(this.#queueFile);
  }

  async saveQueue(items) {
    this.#assertOwned();
    this.#queueTail = this.#queueTail.catch(() => {}).then(() => atomicWrite(this.#queueFile, items));
    await this.#queueTail;
  }
}
