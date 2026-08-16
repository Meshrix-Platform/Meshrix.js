import { CONFIG_SCHEMA_VERSION } from "./constants.mjs";

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function onlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}

function string(value) {
  return typeof value === "string" && value.length > 0;
}

function uniqueByJson(values) {
  return new Set(values.map((value) => JSON.stringify(value))).size === values.length;
}

function closedPair(value) {
  return plainObject(value) && onlyKeys(value, ["id", "kind"]) && string(value.id) && string(value.kind);
}

function credentialRef(value) {
  return plainObject(value) && onlyKeys(value, ["id", "ref"]) && string(value.id) && string(value.ref);
}

function schedule(value) {
  return plainObject(value) && onlyKeys(value, ["id", "cron"]) && string(value.id) && string(value.cron);
}

function runbook(value) {
  if (!plainObject(value) || !onlyKeys(value, ["id", "steps"]) || !string(value.id) ||
      !Array.isArray(value.steps) || value.steps.length === 0) return false;
  return value.steps.every((step) => plainObject(step) && onlyKeys(step, ["operationId"]) && string(step.operationId));
}

function stringArray(value, pattern) {
  return Array.isArray(value) && value.every((entry) => string(entry) && (!pattern || pattern.test(entry))) && uniqueByJson(value);
}

export function assertLocalConfig(value) {
  const keys = [
    "schemaVersion", "enabledRevision", "targets", "strategies", "schedules", "runbooks", "budgets",
    "operationAllowlist", "resourceAllowlist", "workspaceSelectors", "credentialRefs"
  ];
  if (!plainObject(value) || !onlyKeys(value, keys)) throw new Error("config_closed_schema_invalid");
  if (value.schemaVersion !== CONFIG_SCHEMA_VERSION) throw new Error("config_schema_version_invalid");
  if (!string(value.enabledRevision) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value.enabledRevision)) {
    throw new Error("config_revision_invalid");
  }
  const arrays = [
    [value.targets, closedPair, "config_targets_invalid"],
    [value.strategies, closedPair, "config_strategies_invalid"],
    [value.schedules, schedule, "config_schedules_invalid"],
    [value.runbooks, runbook, "config_runbooks_invalid"],
    [value.credentialRefs, credentialRef, "config_credential_refs_invalid"]
  ];
  for (const [entries, validate, code] of arrays) {
    if (!Array.isArray(entries) || !entries.every(validate) || !uniqueByJson(entries)) throw new Error(code);
  }
  if (!plainObject(value.budgets) || !onlyKeys(value.budgets, ["maxConcurrentCalls", "maxCallsPerDay", "maxCostUnitsPerDay"])) {
    throw new Error("config_budgets_invalid");
  }
  for (const key of ["maxConcurrentCalls", "maxCallsPerDay", "maxCostUnitsPerDay"]) {
    if (!Number.isSafeInteger(value.budgets[key]) || value.budgets[key] < 1) throw new Error("config_budgets_invalid");
  }
  if (!stringArray(value.operationAllowlist, /^[a-z][a-zA-Z0-9._-]*$/u)) throw new Error("config_operation_allowlist_invalid");
  if (!stringArray(value.resourceAllowlist) || !stringArray(value.workspaceSelectors)) {
    throw new Error("config_resource_policy_invalid");
  }
  const ids = [value.targets, value.strategies, value.schedules, value.runbooks, value.credentialRefs];
  if (ids.some((entries) => new Set(entries.map((entry) => entry.id)).size !== entries.length)) {
    throw new Error("config_duplicate_id");
  }
  return Object.freeze(structuredClone(value));
}
