export function createSystemControllerSettingsHandlers({
  sendConsoleDomainOperation,
  parseJsonBody,
  settingsContext,
}: Readonly<{
  sendConsoleDomainOperation: (input: Readonly<Record<string, unknown>>) => Promise<unknown>;
  parseJsonBody: (input: unknown) => unknown;
  settingsContext: (authSession: unknown) => unknown;
}>): Record<string, unknown> {
  return {
    async handleGetSettings({ operation, authSession, response }: Readonly<{
      operation?: { id?: string };
      authSession?: unknown;
      response?: unknown;
    }>): Promise<void> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "settings.get",
        response,
        context: settingsContext(authSession),
        errorMessage: "读取设置失败。",
      });
    },
    async handleSetSettings({ operation, requestBody, authSession, response }: Readonly<{
      operation?: { id?: string };
      requestBody?: unknown;
      authSession?: unknown;
      response?: unknown;
    }>): Promise<void> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "settings.set",
        input: parseJsonBody(requestBody),
        response,
        context: settingsContext(authSession),
        errorMessage: "保存设置失败。",
      });
    },
  };
}
