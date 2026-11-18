import path from "node:path";
import { Agent, fetch as undiciFetch } from "undici";

import { AtomicConfigSource } from "./atomic-config.mjs";
import { FileCredentialStore } from "./credential-store.mjs";
import { DEFAULT_CONFIG_PATH, DEFAULT_STORAGE_ROOT, MAX_QUEUE_ITEMS, POLL_INTERVAL_MS } from "./constants.mjs";
import { DirectModelGatewayClient, GovernedMeshrixOperationClient } from "./http-clients.mjs";
import { PrivateStateStore } from "./private-state.mjs";
import { assertProposal } from "./proposal-policy.mjs";
import { buildPinnedRun, cronMatches } from "./schedule.mjs";

const REQUEST_DISPATCHER_OPTIONS = Object.freeze({ connectTimeout: 0, headersTimeout: 0, bodyTimeout: 0 });

const CONFIGURATION_ERROR_CODES = new Set([
  "config_unreadable", "config_file_invalid", "config_in_place_mutation", "config_non_atomic_read",
  "config_revision_reused", "config_closed_schema_invalid", "config_schema_version_invalid",
  "config_revision_invalid", "config_targets_invalid", "config_strategies_invalid", "config_schedules_invalid",
  "config_runbooks_invalid", "config_credential_refs_invalid", "config_budgets_invalid",
  "config_operation_allowlist_invalid", "config_resource_policy_invalid", "config_duplicate_id"
]);

const SCHEDULE_ERROR_CODES = new Set([
  "schedule_service_target_invalid", "schedule_service_endpoint_invalid", "schedule_binding_ambiguous",
  "schedule_credentials_missing"
]);

const RUN_FAILURE_CODES = new Set([
  "daily_budget_exhausted", "response_too_large", "external_response_invalid", "external_request_rejected",
  "model_proposal_invalid", "credential_reference_invalid", "credential_file_not_private",
  "credential_record_invalid", "proposal_closed_schema_invalid", "proposal_budget_exceeded",
  "proposal_operation_closed_schema_invalid", "proposal_operation_denied", "proposal_resource_denied",
  "proposal_input_invalid", "daily_budget_state_invalid", "daily_budget_reservation_invalid",
  "daily_budget_reservation_conflict", "self_maintenance_data_root_not_owned"
]);

function stableErrorCode(error, allowlist, fallback) {
  return error instanceof Error && allowlist.has(error.message) ? error.message : fallback;
}

export class SelfMaintenanceRuntime {
  #configSource;
  #state;
  #credentials;
  #fetchImpl;
  #fetch;
  #agentFactory;
  #dispatcher = null;
  #now;
  #pollIntervalMs;
  #timer = null;
  #activeConfig = null;
  #lastConfigurationStatus = null;
  #admissionOpen = false;
  #queue = [];
  #running = null;
  #admittedIds = new Set();
  #started = false;
  #startTask = null;
  #inFlightTicks = new Set();

  constructor({
    configPath = DEFAULT_CONFIG_PATH,
    storageRoot = DEFAULT_STORAGE_ROOT,
    credentialRoot = path.join(storageRoot, "credentials"),
    fetchImpl = undiciFetch,
    agentFactory = (options) => new Agent(options),
    now = () => new Date(),
    pollIntervalMs = POLL_INTERVAL_MS
  } = {}) {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10) throw new TypeError("poll_interval_invalid");
    this.#configSource = new AtomicConfigSource(configPath);
    this.#state = new PrivateStateStore(storageRoot);
    this.#credentials = new FileCredentialStore(credentialRoot);
    this.#fetchImpl = fetchImpl;
    this.#fetch = (url, init = {}) => {
      const dispatcher = this.#dispatcher ??= this.#agentFactory(REQUEST_DISPATCHER_OPTIONS);
      return this.#fetchImpl(url, { ...init, dispatcher });
    };
    this.#agentFactory = agentFactory;
    this.#now = now;
    this.#pollIntervalMs = pollIntervalMs;
  }

  start() {
    if (this.#started) return this.#startTask || Promise.resolve();
    this.#started = true;
    const task = this.#startOwned();
    this.#startTask = task;
    void task.finally(() => {
      if (this.#startTask === task) this.#startTask = null;
    }).catch(() => {});
    return task;
  }

  async #startOwned() {
    try {
      await this.#state.acquireOwnership();
      await this.#reload();
      const budgetDay = this.#now().toISOString().slice(0, 10);
      await this.#state.loadDailyBudget(budgetDay);
      const completedRunIds = await this.#state.loadCompletedRunIds();
      for (const runId of completedRunIds) this.#admittedIds.add(runId);
      const storedQueue = await this.#state.loadQueue();
      this.#queue = storedQueue.filter((item) => item && ["queued", "running"].includes(item.state) && !completedRunIds.has(item.runId))
        .slice(0, MAX_QUEUE_ITEMS).map((item) => ({ ...item, state: "queued", recovered: true }));
      for (const item of this.#queue) this.#admittedIds.add(item.runId);
      if (this.#queue.length !== storedQueue.length) await this.#persistQueue();
      if (!this.#started) return;
      this.#timer = setInterval(() => void this.#runTick(), this.#pollIntervalMs);
      void this.#runTick();
    } catch (error) {
      this.#started = false;
      if (this.#timer) clearInterval(this.#timer);
      this.#timer = null;
      await this.#state.close();
      throw error;
    }
  }

  async close() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#started = false;
    if (this.#startTask) await this.#startTask.catch(() => {});
    const ticks = await Promise.allSettled([...this.#inFlightTicks]);
    try {
      await this.#closeDispatcher();
    } finally {
      await this.#state.close();
    }
    const failedTick = ticks.find((result) => result.status === "rejected");
    if (failedTick) throw failedTick.reason;
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
      await this.#schedule(this.#now());
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
      const code = CONFIGURATION_ERROR_CODES.has(result.code) ? result.code : "config_invalid";
      const statusKey = `${result.status}:${code}`;
      if (statusKey !== this.#lastConfigurationStatus) {
        await this.#state.record({ state: result.status, code });
        this.#lastConfigurationStatus = statusKey;
      }
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
    const statusKey = `replaced:${result.config.enabledRevision}`;
    if (statusKey !== this.#lastConfigurationStatus) {
      await this.#state.record({ revision: result.config.enabledRevision, state: "configuration_active" });
      this.#lastConfigurationStatus = statusKey;
    }
  }

  async #schedule(now) {
    if (!this.#admissionOpen || !this.#activeConfig) return;
    for (const schedule of this.#activeConfig.schedules) {
      if (!cronMatches(schedule.cron, now)) continue;
      let item;
      try {
        item = buildPinnedRun(this.#activeConfig, schedule, now);
      } catch (error) {
        await this.#state.record({
          revision: this.#activeConfig.enabledRevision,
          scheduleId: schedule.id,
          state: "rejected",
          code: stableErrorCode(error, SCHEDULE_ERROR_CODES, "schedule_rejected")
        });
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

  async #pump() {
    if (!this.#started || this.#running) return;
    const item = this.#queue.shift();
    if (!item) return;
    this.#running = item;
    item.state = "running";
    await this.#persistQueue();
    await this.#state.record({ ...item, state: "running" });
    try {
      const budgetDay = this.#now().toISOString().slice(0, 10);
      const current = await this.#state.loadDailyBudget(budgetDay);
      const modelReservationKey = `${item.runId}:model`;
      const operationPrefix = `${item.runId}:operation:`;
      const hasModelReservation = Object.hasOwn(current.reservations, modelReservationKey);
      const hasOperationReservation = Object.keys(current.reservations).some((key) => key.startsWith(operationPrefix));
      const minimumCalls = (hasModelReservation ? 0 : 1) + (hasOperationReservation ? 0 : 1);
      const minimumCost = hasOperationReservation ? 0 : 1;
      if (current.calls + minimumCalls > item.maxCallsPerDay || current.cost + minimumCost > item.maxCostUnitsPerDay) {
        throw new Error("daily_budget_exhausted");
      }
      const modelReservation = await this.#state.reserveDailyBudget({
        day: budgetDay,
        reservationKey: modelReservationKey,
        maxCalls: item.maxCallsPerDay,
        maxCostUnits: item.maxCostUnitsPerDay,
        costUnits: 0
      });
      if (!modelReservation.reserved) throw new Error("daily_budget_exhausted");
      const model = new DirectModelGatewayClient({
        endpoint: item.modelGatewayEndpoint,
        credentialStore: this.#credentials,
        credentialRef: item.modelCredentialRef,
        fetchImpl: this.#fetch
      });
      const rawProposal = await model.propose(item);
      const operations = assertProposal(rawProposal, {
        ...item,
        maxCalls: item.operationIds.length
      });
      const newOperationReservations = operations.filter((_, index) =>
        !Object.hasOwn(modelReservation.budget.reservations, `${operationPrefix}${index}`)
      ).length;
      if (modelReservation.budget.calls + newOperationReservations > item.maxCallsPerDay ||
          modelReservation.budget.cost + newOperationReservations > item.maxCostUnitsPerDay) {
        throw new Error("daily_budget_exhausted");
      }
      const meshrix = new GovernedMeshrixOperationClient({
        endpoint: item.meshrixEndpoint,
        credentialStore: this.#credentials,
        credentialRef: item.meshrixCredentialRef,
        fetchImpl: this.#fetch
      });
      const completedOperationIndices = await this.#state.loadCompletedOperationIndices(item.runId);
      for (const [index, operation] of operations.entries()) {
        if (completedOperationIndices.has(index)) continue;
        const operationReservation = await this.#state.reserveDailyBudget({
          day: budgetDay,
          reservationKey: `${operationPrefix}${index}`,
          maxCalls: item.maxCallsPerDay,
          maxCostUnits: item.maxCostUnitsPerDay,
          costUnits: 1
        });
        if (!operationReservation.reserved) throw new Error("daily_budget_exhausted");
        await meshrix.execute(operation, item.runId, index);
        await this.#state.record({ ...item, state: "operation_completed", operationId: operation.operationId, operationIndex: index });
      }
      await this.#state.record({ ...item, state: "completed" });
    } catch (error) {
      await this.#state.record({ ...item, state: "failed", code: stableErrorCode(error, RUN_FAILURE_CODES, "run_failed") });
    } finally {
      this.#running = null;
      await this.#persistQueue();
      if (this.#started && this.#queue.length > 0) await this.#pump();
    }
  }

  async #persistQueue() {
    const pending = this.#queue.map((entry) => ({ ...entry, state: "queued" }));
    if (this.#running) pending.unshift({ ...this.#running, state: "running" });
    await this.#state.saveQueue(pending.slice(0, MAX_QUEUE_ITEMS));
  }

  async #closeDispatcher() {
    const dispatcher = this.#dispatcher;
    this.#dispatcher = null;
    if (dispatcher) await dispatcher.close();
  }
}
