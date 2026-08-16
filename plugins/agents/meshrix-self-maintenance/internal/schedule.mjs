import crypto from "node:crypto";

function fieldMatches(field, value, minimum, maximum) {
  if (field === "*") return true;
  const interval = /^\*\/(\d+)$/u.exec(field);
  if (interval) {
    const step = Number(interval[1]);
    return step >= 1 && step <= maximum - minimum + 1 && (value - minimum) % step === 0;
  }
  return field.split(",").every((part) => /^\d+$/u.test(part)) &&
    field.split(",").map(Number).some((entry) => entry >= minimum && entry <= maximum && entry === value);
}

export function cronMatches(cron, date) {
  const fields = cron.trim().split(/\s+/u);
  if (fields.length !== 5) return false;
  return fieldMatches(fields[0], date.getUTCMinutes(), 0, 59) &&
    fieldMatches(fields[1], date.getUTCHours(), 0, 23) &&
    fieldMatches(fields[2], date.getUTCDate(), 1, 31) &&
    fieldMatches(fields[3], date.getUTCMonth() + 1, 1, 12) &&
    fieldMatches(fields[4], date.getUTCDay(), 0, 6);
}

export function occurrenceMinute(date) {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000).toISOString();
}

export function runIdentity(revision, scheduleId, occurrence) {
  return crypto.createHash("sha256").update(`${revision}\0${scheduleId}\0${occurrence}`).digest("hex").slice(0, 32);
}

function selectBySchedule(entries, scheduleId) {
  return entries.find((entry) => entry.id === scheduleId) || (entries.length === 1 ? entries[0] : null);
}

function serviceEndpoint(targets, kind) {
  const matches = targets.filter((target) => target.kind === kind);
  if (matches.length !== 1) throw new Error("schedule_service_target_invalid");
  try {
    const url = new URL(matches[0].id);
    const allowed = url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(url.hostname));
    if (!allowed || url.username || url.password || url.search || url.hash) throw new Error();
    return matches[0].id.replace(/\/+$/u, "");
  } catch {
    throw new Error("schedule_service_endpoint_invalid");
  }
}

export function buildPinnedRun(config, schedule, date) {
  const runbook = selectBySchedule(config.runbooks, schedule.id);
  const strategy = selectBySchedule(config.strategies, schedule.id);
  const target = selectBySchedule(config.targets.filter((entry) => !["model-gateway", "meshrix"].includes(entry.kind)), schedule.id);
  if (!runbook || !strategy || !target) throw new Error("schedule_binding_ambiguous");
  const credentials = Object.fromEntries(config.credentialRefs.map((entry) => [entry.id, entry.ref]));
  if (typeof credentials["model-gateway-client"] !== "string" || typeof credentials["meshrix-client"] !== "string") {
    throw new Error("schedule_credentials_missing");
  }
  const occurrence = occurrenceMinute(date);
  return Object.freeze({
    runId: runIdentity(config.enabledRevision, schedule.id, occurrence),
    revision: config.enabledRevision,
    scheduleId: schedule.id,
    occurrence,
    state: "queued",
    targetRef: target.id,
    modelGatewayEndpoint: serviceEndpoint(config.targets, "model-gateway"),
    meshrixEndpoint: serviceEndpoint(config.targets, "meshrix"),
    strategyKind: strategy.kind,
    runbookId: runbook.id,
    operationIds: runbook.steps.map((step) => step.operationId),
    operationAllowlist: [...config.operationAllowlist],
    resourceAllowlist: [...config.resourceAllowlist],
    workspaceSelectors: [...config.workspaceSelectors],
    maxCallsPerDay: config.budgets.maxCallsPerDay,
    maxCostUnitsPerDay: config.budgets.maxCostUnitsPerDay,
    modelCredentialRef: credentials["model-gateway-client"],
    meshrixCredentialRef: credentials["meshrix-client"]
  });
}
