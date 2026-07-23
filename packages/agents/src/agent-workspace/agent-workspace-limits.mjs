export function workspaceIntegerLimit(
  environmentName,
  { defaultValue, minimum, maximum, environment = process.env } = {}
) {
  const rawValue = String(environment?.[environmentName] ?? "").trim();
  const value = rawValue ? Number(rawValue) : Number(defaultValue);
  if (
    !Number.isSafeInteger(value) ||
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum > maximum ||
    value < minimum ||
    value > maximum
  ) {
    const error = new Error(`${environmentName} must be an integer between ${minimum} and ${maximum}.`);
    error.code = "agent_workspace_limit_invalid";
    throw error;
  }
  return value;
}
