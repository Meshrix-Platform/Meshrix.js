export function createSystemControllerOpsObservationHandlers({
  sendConsoleDomainOperation,
  parseJsonBody,
  jobWorkflowProvider,
  checkpointTreeApi,
  workQueueObservation,
  devopsProvider
}: Record<string, any>) : any {
  return {
    async handleFailedJobsReview({ operation, limit, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "jobs.failed_review",
        input: { limit },
        response,
        context: { jobWorkflowProvider },
        errorMessage: "生成失败任务复盘失败。"
      });
    },
    async handleGetBackgroundProcesses({ operation, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "system.background_processes",
        response,
        context: { devopsProvider },
        errorMessage: "读取后台进程状态失败。"
      });
    },
    async handleListCheckpointTrees({ operation, url, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "system.checkpoint_trees.list",
        input: {
          ownerId: url.searchParams.get("ownerId") || url.searchParams.get("owner-id") || "",
          kind: url.searchParams.get("kind") || "",
          limit: Number(url.searchParams.get("limit") || 100)
        },
        response,
        context: { checkpointTreeApi },
        errorMessage: "读取 checkpoint tree 列表失败。"
      });
    },
    async handleGetCheckpointTree({ operation, treeId, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "system.checkpoint_trees.get",
        input: { treeId },
        response,
        context: { checkpointTreeApi },
        errorMessage: "读取 checkpoint tree 失败。"
      });
    },
    async handleMonitorAlerts({ operation, requestBody, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || (requestBody.length > 0
          ? "system.monitor_alerts.set"
          : "system.monitor_alerts.get"),
        input: requestBody.length > 0 ? parseJsonBody(requestBody) : {},
        response,
        context: { devopsProvider, workQueueObservation },
        errorMessage: "监控报警操作失败。"
      });
    },
    async handleAcknowledgeMonitorAlert({ operation, alertId, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "system.monitor_alerts.ack",
        input: { alertId },
        response,
        context: { devopsProvider, workQueueObservation },
        errorMessage: "确认监控报警失败。"
      });
    },
    async handleRecoverBackgroundSupervisor({ operation, response }: Record<string, any>) : Promise<any> {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "system.background_supervisor.recover",
        input: {},
        response,
        context: { devopsProvider, workQueueObservation },
        errorMessage: "拉起后台 Worker 管理进程失败。"
      });
    }
  };
}
