import { publishProtocolEvent, result } from "./shared.ts";

interface SettingsPort {
  loadSettings(userDataPath: string, options?: Readonly<Record<string, unknown>>): Promise<unknown>;
  saveSettings(
    userDataPath: string,
    input: Readonly<Record<string, unknown>>,
    options?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

interface SettingsOperationContext {
  readonly userDataPath?: unknown;
  readonly settingsPort?: unknown;
  readonly moduleManagement?: unknown;
  readonly protocolEventBus?: unknown;
}

interface SettingsOperationResult {
  readonly status: number;
  readonly payload: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function settingsPort(value: unknown): SettingsPort | null {
  if (!isRecord(value) || typeof value.loadSettings !== "function" || typeof value.saveSettings !== "function") {
    return null;
  }
  return value as unknown as SettingsPort;
}

export async function executeSettingsOperation({
  operationId,
  input = {},
  context = {},
}: Readonly<{
  operationId?: unknown;
  input?: unknown;
  context?: SettingsOperationContext;
}>): Promise<SettingsOperationResult | null> {
  if (operationId !== "settings.get" && operationId !== "settings.set") return null;
  const port = settingsPort(context.settingsPort);
  const userDataPath = typeof context.userDataPath === "string" ? context.userDataPath : "";
  if (!port || !userDataPath) return result(503, { error: "设置 port 不可用。" });

  if (operationId === "settings.get") {
    return result(200, await port.loadSettings(userDataPath, { redactSecrets: true }));
  }
  if (!isRecord(input)) return result(400, { error: "设置输入必须是对象。" });
  const saved = await port.saveSettings(userDataPath, input, { redactSecrets: false });
  if (isRecord(context.moduleManagement) && typeof context.moduleManagement.refreshMounts === "function") {
    await context.moduleManagement.refreshMounts({ settings: saved });
  }
  const redacted = await port.loadSettings(userDataPath, { redactSecrets: true });
  await publishProtocolEvent(context.protocolEventBus, "settings.current", redacted, { type: "settings.updated" });
  return result(200, redacted);
}
