export function createSystemControllerAgentSettingsHandlers({
  sendConsoleDomainOperation,
  parseJsonBody,
  settingsAgentGatewayContext
}) {
  return {
    async handleGetSettings({ operation, authSession, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "settings.get",
        response,
        context: settingsAgentGatewayContext(authSession),
        errorMessage: "读取设置失败。"
      });
    },
    async handleSetSettings({ operation, requestBody, authSession, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "settings.set",
        input: parseJsonBody(requestBody),
        response,
        context: settingsAgentGatewayContext(authSession),
        errorMessage: "保存设置失败。"
      });
    },
    async handleProbeModel({ operation, requestBody, authSession, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "settings.model_probe",
        input: parseJsonBody(requestBody),
        response,
        context: settingsAgentGatewayContext(authSession),
        errorMessage: "模型探测失败。"
      });
    },
    async handleAgentGatewayCall({ operation, requestBody, response, authSession }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_gateway.call",
        input: parseJsonBody(requestBody),
        response,
        context: settingsAgentGatewayContext(authSession),
        errorMessage: "Agent Gateway 调用失败。"
      });
    },
    async handleAgentRegistry({ operation, authSession, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agents.list",
        response,
        context: settingsAgentGatewayContext(authSession),
        errorMessage: "读取智能体模型注册表失败。"
      });
    },
    async handleModelRoutingHealth({ operation, url, authSession, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "model_routing.health",
        input: { limit: Number(url.searchParams.get("limit") || 50) },
        response,
        context: settingsAgentGatewayContext(authSession),
        errorMessage: "读取模型路由健康状态失败。"
      });
    },
    async handleCreateAgent({ operation, requestBody, authSession, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agents.create",
        input: parseJsonBody(requestBody),
        response,
        context: settingsAgentGatewayContext(authSession),
        errorMessage: "创建智能体模型配置失败。"
      });
    },
    async handleUpdateAgent({ operation, agentId, requestBody, authSession, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agents.update",
        input: {
          ...parseJsonBody(requestBody),
          agentId
        },
        response,
        context: settingsAgentGatewayContext(authSession),
        errorMessage: "更新智能体模型配置失败。"
      });
    },
    async handleDeleteAgent({ operation, agentId, authSession, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agents.delete",
        input: { agentId },
        response,
        context: settingsAgentGatewayContext(authSession),
        errorMessage: "删除智能体模型配置失败。"
      });
    }
  };
}
