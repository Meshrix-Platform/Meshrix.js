export function createSystemControllerRuntimeHandlers({
  sendConsoleDomainOperation,
  parseJsonBody,
  queryPayload,
  isFeatureActive,
  runtimeWorkflowContext = () : any => ({}),
  coreProvider,
  getControllers,
  getFeatureEntries,
  protocolEventBus,
  getDiscoveryState,
  setDiscoveryState,
  getListenUrl,
  serverLabel,
  distPath,
  runtime,
  moduleManagement,
  externalGatewayManagement,
  jobWorkflowProvider,
  storageProvider,
  clientRegistryService,
  securityPermissions,
  maintenanceAgent,
  getToolSkillManagementProvider = () : any => null,
  getIntegrationTaskSupervisorSnapshot = () : any => null,
  consoleDomainServices
}: Record<string, any>) : any {
  return {
    async handleBootstrap({ operation, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "system.bootstrap",
        response,
        context: {
          ...runtimeWorkflowContext(),
          discoveryState: getDiscoveryState()
        },
        errorMessage: "读取客户端启动配置失败。"
      });
    },
    async handleHealthz({ operation, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "system.health",
        response,
        context: {
          discoveryState: getDiscoveryState(),
          integrationTaskSupervisorSnapshot: getIntegrationTaskSupervisorSnapshot()
        },
        errorMessage: "读取健康状态失败。"
      });
    },
    async handleGetStorageSummary({ operation, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "storage.summary",
        response,
        context: { storageProvider },
        errorMessage: "读取存储摘要失败。"
      });
    },
    async handleStorageDoctor({ operation, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "storage.doctor",
        response,
        context: { storageProvider },
        errorMessage: "存储诊断失败。"
      });
    },
    async handleStorageReconcile({ operation, input, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "storage.reconcile",
        input,
        response,
        context: { storageProvider },
        errorMessage: "存储协调失败。"
      });
    },
    async handleStorageBackups({ operation, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "storage.backups.list",
        response,
        context: { storageProvider },
        errorMessage: "读取存储备份失败。"
      });
    },
    async handleStorageBackupCreate({ operation, input, response, operationLock, signal }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "storage.backups.create",
        input,
        response,
        context: { storageProvider, operationLock, signal },
        errorMessage: "创建存储备份失败。"
      });
    },
    async handleStorageBackupRetention({ operation, input, response, operationLock, signal }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "storage.backups.retention",
        input,
        response,
        context: { storageProvider, operationLock, signal },
        errorMessage: "执行存储备份保留策略失败。"
      });
    },
    async handleStorageBackupRestorePreview({ operation, input, response, operationLock, signal }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "storage.backups.restore_preview",
        input,
        response,
        context: { storageProvider, operationLock, signal },
        errorMessage: "预览存储恢复失败。"
      });
    },
    async handleStorageBackupRestore({ operation, input, response, operationLock, signal }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "storage.backups.restore",
        input,
        response,
        context: { storageProvider, operationLock, signal },
        errorMessage: "恢复存储备份失败。"
      });
    },
    async handleListInterfaces({ operation, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "system.interfaces",
        response,
        context: { coreProvider, getControllers, getFeatureEntries },
        errorMessage: "读取接口注册表失败。"
      });
    },
    async handleReadinessBaselineStatus({ operation, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "readiness.baseline.status",
        response,
        context: {},
        errorMessage: "读取运行基线状态失败。"
      });
    },
    async handleSubscribeEvents({ operation, request, url, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "events.subscribe",
        input: queryPayload(url),
        response,
        context: {
          protocolEventBus,
          request,
          response,
          agentSyncFeatureActive: isFeatureActive("agent-gateway")
        },
        errorMessage: "订阅事件失败。"
      });
    },
    async handleAgentSyncConfig({ operation, requestBody, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || (requestBody.length === 0 ? "agent_sync.config.get" : "agent_sync.config.set"),
        input: requestBody.length === 0 ? {} : parseJsonBody(requestBody),
        response,
        context: {
          protocolEventBus,
          agentSyncFeatureActive: isFeatureActive("agent-gateway")
        },
        errorMessage: "处理智能体同步配置失败。"
      });
    },
    async handleAgentSyncPublish({ operation, request, requestBody, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_sync.publish",
        input: parseJsonBody(requestBody),
        response,
        context: {
          protocolEventBus,
          toolSkillManagementProvider: getToolSkillManagementProvider(),
          request,
          agentSyncFeatureActive: isFeatureActive("agent-gateway")
        },
        errorMessage: "发布智能体同步事件失败。"
      });
    },
    async handleAgentSyncSubscribe({ operation, request, url, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "agent_sync.subscribe",
        input: queryPayload(url),
        response,
        context: {
          protocolEventBus,
          request,
          response,
          agentSyncFeatureActive: isFeatureActive("agent-gateway")
        },
        errorMessage: "订阅智能体同步事件失败。"
      });
    },
    async handleDiscoveryCheckIn({ requestBody, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: "discovery.check_in",
        input: parseJsonBody(requestBody),
        response,
        context: {
          ...runtimeWorkflowContext(),
          discoveryState: getDiscoveryState(),
          protocolEventBus
        },
        errorMessage: "客户端迁移登记失败。"
      });
    },
    async handleListDiscoveryClients({ operation, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "discovery.clients",
        response,
        context: {
          clientRegistryService,
          discoveryState: getDiscoveryState(),
          toolSkillManagementProvider: getToolSkillManagementProvider(),
          consoleDomainServices
        },
        errorMessage: "读取 discovery client 列表失败。"
      });
    },
    async handleRequestClientAlignmentCommand({ operation, clientId, requestBody, response, authSession }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "discovery.clients.alignment_command",
        input: {
          ...parseJsonBody(requestBody),
          ...(clientId ? { clientId } : {})
        },
        response,
        context: {
          discoveryState: getDiscoveryState(),
          clientRegistryService,
          protocolEventBus,
          authSession
        },
        errorMessage: "发布客户端配置对齐指令失败。"
      });
    },
    async handleGetDiscoveryConfig({ operation, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "discovery.get_config",
        response,
        context: { discoveryState: getDiscoveryState() },
        errorMessage: "读取服务发现配置失败。"
      });
    },
    async handleSetDiscoveryConfig({ operation, requestBody, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "discovery.set_config",
        input: parseJsonBody(requestBody),
        response,
        context: {
          listenUrl: getListenUrl(),
          serverLabel,
          setDiscoveryState,
          protocolEventBus
        },
        errorMessage: "保存服务发现配置失败。"
      });
    },
    async handleGetRuntimeInfo({ operation, request, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "runtime.info",
        response,
        context: {
          distPath,
          runtime,
          moduleManagement,
          discoveryState: getDiscoveryState(),
          storageProvider,
          clientRegistryService,
          serverUrl: getListenUrl(),
          securityPermissions,
          request,
          features: getFeatureEntries ? getFeatureEntries() : null,
          consoleDomainServices
        },
        errorMessage: "读取运行时信息失败。"
      });
    },
    async handleBuildRuntimeAssembly({ operation, request, requestBody, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "runtime.assembly.build",
        input: parseJsonBody(requestBody),
        response,
        context: {
          distPath,
          runtime,
          moduleManagement,
          discoveryState: getDiscoveryState(),
          storageProvider,
          serverUrl: getListenUrl(),
          securityPermissions,
          request,
          protocolEventBus,
          features: getFeatureEntries ? getFeatureEntries() : null,
          consoleDomainServices
        },
        errorMessage: "生成运行时装配清单失败。"
      });
    },
    async handleBrowseServerPath({ operation, requestBody, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "runtime.path_browse",
        input: parseJsonBody(requestBody),
        response,
        context: { distPath },
        errorMessage: "浏览服务端路径失败。"
      });
    },
    async handleGetMounts({ operation, request, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "runtime.mounts",
        response,
        context: {
          moduleManagement,
          distPath,
          discoveryState: getDiscoveryState(),
          storageProvider,
          serverUrl: getListenUrl(),
          securityPermissions,
          request,
          features: getFeatureEntries ? getFeatureEntries() : null,
          consoleDomainServices
        },
        errorMessage: "读取挂载配置失败。"
      });
    },
    async handleGetExternalGateway({ operation, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "runtime.external_gateway",
        response,
        context: { externalGatewayManagement },
        errorMessage: "读取外置网关配置失败。"
      });
    },
    async handleValidateExternalGateway({ operation, requestBody, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "runtime.external_gateway.validate",
        input: parseJsonBody(requestBody),
        response,
        context: { externalGatewayManagement },
        errorMessage: "校验外置网关配置失败。"
      });
    },
    async handleApplyExternalGateway({ operation, requestBody, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "runtime.external_gateway.apply",
        input: parseJsonBody(requestBody),
        response,
        context: { externalGatewayManagement },
        errorMessage: "启用外置网关配置失败。"
      });
    },
    async handleSwitchExternalGatewayDirect({ operation, requestBody, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "runtime.external_gateway.switch_direct",
        input: parseJsonBody(requestBody),
        response,
        context: { externalGatewayManagement },
        errorMessage: "切换内置网关流控失败。"
      });
    },
	    async handleSetMounts({ operation, requestBody, response }: Record<string, any>) : Promise<any> {
	      await sendConsoleDomainOperation({
	        operationId: operation?.id || "runtime.set_mounts",
	        input: parseJsonBody(requestBody),
	        response,
	        context: { moduleManagement, protocolEventBus, distPath },
	        errorMessage: "保存挂载配置失败。"
	      });
	    },
    async handleReloadMounts({ operation, requestBody, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "runtime.reload_mounts",
        input: parseJsonBody(requestBody),
        response,
        context: { moduleManagement, protocolEventBus },
        errorMessage: "重载挂载配置失败。"
      });
    },
    async handleGetConsoleState({ operation, request, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "system.console_state",
        response,
        context: {
          distPath,
          runtime,
          moduleManagement,
          discoveryState: getDiscoveryState(),
          jobWorkflowProvider,
          storageProvider,
          clientRegistryService,
          serverUrl: getListenUrl(),
          securityPermissions,
          request,
          maintenanceAgent,
          features: getFeatureEntries ? getFeatureEntries() : null,
          toolSkillManagementProvider: getToolSkillManagementProvider(),
          consoleDomainServices
        },
        errorMessage: "读取控制台状态失败。"
      });
    },
    async handleMaintenanceAgentConfig({ operation, requestBody, authSession, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || (requestBody.length > 0
          ? "maintenance_agent.config.set"
          : "maintenance_agent.config.get"),
        input: requestBody.length > 0 ? parseJsonBody(requestBody) : {},
        response,
        context: { maintenanceAgent, authSession },
        errorMessage: "维护智能体配置操作失败。"
      });
    },
    async handleMaintenanceAgentChat({ operation, request, requestBody, authSession, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "maintenance_agent.chat",
        input: parseJsonBody(requestBody),
        response,
        context: { maintenanceAgent, authSession, request },
        errorMessage: "维护智能体对话失败。"
      });
    },
    async handleMaintenanceAgentRuns({
      operation,
      request,
      requestBody,
      url,
      authSession,
      response
    }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || (requestBody.length > 0
          ? "maintenance_agent.runs.create"
          : "maintenance_agent.runs.list"),
        input: requestBody.length > 0
          ? parseJsonBody(requestBody)
          : { limit: Number(url.searchParams.get("limit") || 50) },
        response,
        context: { maintenanceAgent, authSession, request },
        errorMessage: "维护智能体运行操作失败。"
      });
    },
    async handleMaintenanceAgentRun({ operation, runId, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "maintenance_agent.runs.get",
        input: { runId },
        response,
        context: { maintenanceAgent },
        errorMessage: "读取维护智能体运行失败。"
      });
    },
    async handleMaintenanceAgentApprove({
      operation,
      request,
      runId,
      requestBody,
      authSession,
      response
    }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "maintenance_agent.runs.approve",
        input: {
          ...parseJsonBody(requestBody),
          runId
        },
        response,
        context: { maintenanceAgent, authSession, request },
        errorMessage: "维护运行审批失败。"
      });
    },
    async handleMaintenanceAgentCancel({ operation, runId, requestBody, authSession, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "maintenance_agent.runs.cancel",
        input: {
          ...parseJsonBody(requestBody),
          runId
        },
        response,
        context: { maintenanceAgent, authSession },
        errorMessage: "维护运行取消失败。"
      });
    }
  };
}
