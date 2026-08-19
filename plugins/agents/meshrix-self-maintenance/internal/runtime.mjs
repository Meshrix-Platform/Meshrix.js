import path from "node:path";

import { AtomicConfigSource } from "./atomic-config.mjs";
import { FileCredentialStore } from "./credential-store.mjs";
import { DEFAULT_CONFIG_PATH, DEFAULT_STORAGE_ROOT, MAX_QUEUE_ITEMS, POLL_INTERVAL_MS, REQUEST_TIMEOUT_MS } from "./constants.mjs";
import { DirectModelGatewayClient, GovernedMeshrixOperationClient } from "./http-clients.mjs";
import { PrivateStateStore } from "./private-state.mjs";
import { assertProposal } from "./proposal-policy.mjs";
import { buildPinnedRun, cronMatches } from "./schedule.mjs";

export class SelfMaintenanceRuntime {
  #configSource;
  #state;
  #credentials;
  #fetch;
  #pollIntervalMs;
  #timer = null;
  #activeConfig = null;
  #admissionOpen = false;
  #queue = [];
  #running = null;
  #daily = new Map();
  #admittedIds = new Set();
  #started = false;
  #inFlightTicks = new Set();

  constructor({
    configPath = DEFAULT_CONFIG_PATH,
    storageRoot = DEFAULT_STORAGE_ROOT,
    credentialRoot = path.join(storageRoot, "credentials"),
    fetchImpl = fetch,
    pollIntervalMs = POLL_INTERVAL_MS
  } = {}) {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10) throw new TypeError("poll_interval_invalid");
    this.#configSource = new AtomicConfigSource(configPath);
    this.#state = new PrivateStateStore(storageRoot);
    this.#credentials = new FileCredentialStore(credentialRoot);
    this.#fetch = fetchImpl;
    this.#pollIntervalMs = pollIntervalMs;
  }

  async start() {
    if (this.#started) return;
    this.#started = true;
    await this.#reload();
    this.#queue = (await this.#state.loadQueue()).filter((item) => item && ["queued", "running"].includes(item.state))
      .slice(0, MAX_QUEUE_ITEMS).map((item) => ({ ...item, state: "queued", recovered: true }));
    for (const item of this.#queue) this.#admittedIds.add(item.runId);
    this.#timer = setInterval(() => void this.#runTick(), this.#pollIntervalMs);
    void this.#runTick();
  }

  async close() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#started = false;
    await Promise.all([...this.#inFlightTicks]);
    while (this.#running) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  async #runTick() {
    if (!this.#started) return;
    const task = this.#tick();
    this.#inFlightTicks.add(task);
    try {
      await task;
    } finally {
      this.#inFlightTicks.delete(task);
    }
  }

  async #tick() {
    try {
      await this.#reload();
      await this.#schedule(new Date());
      await this.#pump();
    } catch {
      await this.#state.record({ state: "worker_error", code: "tick_failed" });
    }
  }

  async #reload() {
    const result = await this.#configSource.read();
    if (result.status === "unchanged") return;
    if (result.status !== "replaced") {
      this.#admissionOpen = false;
      await this.#state.record({ state: result.status, code: result.code || null });
      return;
    }
    const previousRevision = this.#activeConfig?.enabledRevision || null;
    this.#activeConfig = result.config;
    this.#admissionOpen = true;
    if (previousRevision && previousRevision !== result.config.enabledRevision) {
      const allowedSchedules = new Set(result.config.schedules.map((entry) => entry.id));
      for (const item of this.#queue) {
        if (item.state === "queued" && !allowedSchedules.has(item.scheduleId)) {
          item.state = "cancelled";
          await this.#state.record({ ...item, state: "cancelled", code: "configuration_replaced" });
        }
      }
      this.#queue = this.#queue.filter((item) => item.state === "queued");
      await this.#persistQueue();
    }
    await this.#state.record({ revision: result.config.enabledRevision, state: "configuration_active" });
  }

  async #schedule(now) {
    if (!this.#admissionOpen || !this.#activeConfig) return;
    for (const schedule of this.#activeConfig.schedules) {
      if (!cronMatches(schedule.cron, now)) continue;
      let item;
      try {
        item = buildPinnedRun(this.#activeConfig, schedule, now);
      } catch (error) {
        await this.#state.record({ revision: this.#activeConfig.enabledRevision, scheduleId: schedule.id, state: "rejected", code: error.message });
        continue;
      }
      if (this.#admittedIds.has(item.runId)) continue;
      if (this.#queue.length >= Math.min(MAX_QUEUE_ITEMS, this.#activeConfig.budgets.maxCallsPerDay)) {
        await this.#state.record({ ...item, state: "rejected", code: "queue_capacity_exceeded" });
        continue;
      }
      this.#queue.push({ ...item });
      this.#admittedIds.add(item.runId);
      if (this.#admittedIds.size > MAX_QUEUE_ITEMS * 2) {
        this.#admittedIds = new Set([...this.#admittedIds].slice(-MAX_QUEUE_ITEMS));
      }
      await this.#state.record({ ...item, state: "queued" });
      await this.#persistQueue();
    }
  }

  #budgetFor(item) {
    const day = new Date().toISOString().slice(0, 10);
    const key = `${item.revision}:${day}`;
    const current = this.#daily.get(key) || { calls: 0, cost: 0 };
    return { key, current };
  }

  async #pump() {
    if (this.#running) return;
    const item = this.#queue.shift();
    if (!item) return;
    this.#running = item;
    item.state = "running";
    await this.#persistQueue();
    await this.#state.record({ ...item, state: "running" });
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const { key, current } = this.#budgetFor(item);
      const remainingCalls = item.maxCallsPerDay - current.calls;
      const remainingCost = item.maxCostUnitsPerDay - current.cost;
      if (remainingCalls < 2 || remainingCost < 1) throw new Error("daily_budget_exhausted");
      const model = new DirectModelGatewayClient({
        endpoint: item.modelGatewayEndpoint,
        credentialStore: this.#credentials,
        credentialRef: item.modelCredentialRef,
        fetchImpl: this.#fetch
      });
      current.calls += 1;
      this.#daily.set(key, current);
      const rawProposal = await model.propose(item, signal);
      const operations = assertProposal(rawProposal, {
        ...item,
        maxCalls: Math.min(item.operationIds.length, remainingCalls - 1, remainingCost)
      });
      const meshrix = new GovernedMeshrixOperationClient({
        endpoint: item.meshrixEndpoint,
        credentialStore: this.#credentials,
        credentialRef: item.meshrixCredentialRef,
        fetchImpl: this.#fetch
      });
      for (const operation of operations) {
        await meshrix.execute(operation, item.runId, signal);
        current.calls += 1;
        current.cost += 1;
        await this.#state.record({ ...item, state: "operation_completed", operationId: operation.operationId });
      }
      await this.#state.record({ ...item, state: "completed" });
    } catch (error) {
      await this.#state.record({ ...item, state: "failed", code: String(error?.message || "run_failed") });
    } finally {
      this.#running = null;
      await this.#persistQueue();
      if (this.#queue.length > 0) await this.#pump();
    }
  }

  async #persistQueue() {
    const pending = this.#queue.map((entry) => ({ ...entry, state: "queued" }));
    if (this.#running) pending.unshift({ ...this.#running, state: "running" });
    await this.#state.saveQueue(pending.slice(0, MAX_QUEUE_ITEMS));
  }
}
