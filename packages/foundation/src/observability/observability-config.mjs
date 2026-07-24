function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function booleanValue(value, field) {
  if (typeof value !== "boolean") {
    const error = new Error(`${field} must be a boolean.`);
    error.code = "observability_config_boolean_invalid";
    throw error;
  }
  return value;
}

function integerValue(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    const error = new Error(`${field} must be an integer in the supported range.`);
    error.code = "observability_config_integer_invalid";
    throw error;
  }
  return value;
}

function stringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    const error = new Error(`${field} must be an array of non-empty strings.`);
    error.code = "observability_config_array_invalid";
    throw error;
  }
  return [...new Set(value.map((item) => item.trim()))].sort();
}

function normalizeRule(ruleId, input) {
  const source = asObject(input);
  const output = {};
  if (hasOwn(source, "enabled")) output.enabled = booleanValue(source.enabled, `rules.${ruleId}.enabled`);
  if (hasOwn(source, "severity")) {
    const severity = String(source.severity || "").trim();
    if (!["info", "warning", "critical"].includes(severity)) {
      const error = new Error(`rules.${ruleId}.severity is not supported.`);
      error.code = "observability_config_severity_invalid";
      throw error;
    }
    output.severity = severity;
  }
  if (hasOwn(source, "statuses")) output.statuses = stringArray(source.statuses, `rules.${ruleId}.statuses`);
  if (hasOwn(source, "restartCountThreshold")) {
    output.restartCountThreshold = integerValue(
      source.restartCountThreshold,
      `rules.${ruleId}.restartCountThreshold`,
      1,
      100_000
    );
  }
  return Object.freeze(output);
}

export function unconfiguredObservabilityConfig() {
  return Object.freeze({
    schemaVersion: "v0.0.1:schema:definition-1",
    configurationState: "unconfigured",
    rules: Object.freeze({})
  });
}

export function normalizeObservabilityConfig(input) {
  if (input === null || input === undefined) return unconfiguredObservabilityConfig();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const error = new Error("Observability configuration must be an object.");
    error.code = "observability_config_invalid";
    throw error;
  }
  const source = asObject(input);
  const allowed = new Set([
    "schemaVersion",
    "enabled",
    "intervalMs",
    "heartbeatStaleMs",
    "historyLimit",
    "supervisorRecovery",
    "rules"
  ]);
  const unknown = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    const error = new Error("Observability configuration contains unsupported fields.");
    error.code = "observability_config_unknown_field";
    error.fields = unknown.sort();
    throw error;
  }
  if (Object.keys(source).every((key) => key === "schemaVersion")) {
    return unconfiguredObservabilityConfig();
  }
  const output = {
    schemaVersion: "v0.0.1:schema:definition-1",
    configurationState: "configured"
  };
  if (hasOwn(source, "enabled")) output.enabled = booleanValue(source.enabled, "enabled");
  if (hasOwn(source, "intervalMs")) output.intervalMs = integerValue(source.intervalMs, "intervalMs", 1_000, 600_000);
  if (hasOwn(source, "heartbeatStaleMs")) output.heartbeatStaleMs = integerValue(source.heartbeatStaleMs, "heartbeatStaleMs", 1_000, 600_000);
  if (hasOwn(source, "historyLimit")) output.historyLimit = integerValue(source.historyLimit, "historyLimit", 10, 5_000);
  if (hasOwn(source, "supervisorRecovery")) {
    const recovery = asObject(source.supervisorRecovery);
    const normalized = {};
    if (hasOwn(recovery, "enabled")) normalized.enabled = booleanValue(recovery.enabled, "supervisorRecovery.enabled");
    if (hasOwn(recovery, "cooldownMs")) normalized.cooldownMs = integerValue(recovery.cooldownMs, "supervisorRecovery.cooldownMs", 1_000, 3_600_000);
    if (hasOwn(recovery, "startupWaitMs")) normalized.startupWaitMs = integerValue(recovery.startupWaitMs, "supervisorRecovery.startupWaitMs", 0, 60_000);
    output.supervisorRecovery = Object.freeze(normalized);
  }
  const rules = asObject(source.rules);
  output.rules = Object.freeze(Object.fromEntries(
    Object.keys(rules).sort().map((ruleId) => {
      if (!/^[A-Za-z0-9._:-]{1,96}$/u.test(ruleId)) {
        const error = new Error("Observability rule id is invalid.");
        error.code = "observability_config_rule_id_invalid";
        throw error;
      }
      return [ruleId, normalizeRule(ruleId, rules[ruleId])];
    })
  ));
  return Object.freeze(output);
}

export function observabilityConfigForPersistence(config) {
  const normalized = config?.configurationState === "configured" || config?.configurationState === "unconfigured"
    ? config
    : normalizeObservabilityConfig(config);
  if (normalized.configurationState === "unconfigured") return null;
  const { configurationState, ...persisted } = normalized;
  return persisted;
}
