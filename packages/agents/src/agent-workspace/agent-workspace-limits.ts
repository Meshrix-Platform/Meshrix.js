export function workspaceIntegerLimit(
  environmentName?: any,
  { defaultValue, minimum, maximum, environment = process.env }: Record<string, any> = {}
) : any {
  const rawValue: any = String(environment?.[environmentName] ?? "").trim();
  const value: any = rawValue ? Number(rawValue) : Number(defaultValue);
  if (
    !Number.isSafeInteger(value) ||
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum > maximum ||
    value < minimum ||
    value > maximum
  ) {
    const error: Error & Record<string, any> = new Error(`${environmentName} must be an integer between ${minimum} and ${maximum}.`);
    error.code = "agent_workspace_limit_invalid";
    throw error;
  }
  return value;
}
