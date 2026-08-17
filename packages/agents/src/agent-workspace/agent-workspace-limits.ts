export interface WorkspaceIntegerLimitOptions {
  defaultValue?: number;
  minimum?: number;
  maximum?: number;
  environment?: Readonly<Record<string, string | undefined>>;
}

export function workspaceIntegerLimit(
  environmentName = "",
  {
    defaultValue,
    minimum,
    maximum,
    environment = process.env
  }: WorkspaceIntegerLimitOptions = {}
): number {
  const rawValue = String(environment[environmentName] ?? "").trim();
  const value = rawValue ? Number(rawValue) : Number(defaultValue);
  const minimumValue = Number(minimum);
  const maximumValue = Number(maximum);
  if (
    !Number.isSafeInteger(value) ||
    !Number.isSafeInteger(minimumValue) ||
    !Number.isSafeInteger(maximumValue) ||
    minimumValue > maximumValue ||
    value < minimumValue ||
    value > maximumValue
  ) {
    const error: Error & { code?: string } = new Error(
      `${environmentName} must be an integer between ${minimum} and ${maximum}.`
    );
    error.code = "agent_workspace_limit_invalid";
    throw error;
  }
  return value;
}
