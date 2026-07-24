import { sendJson } from "#meshrix/http-utils";
import {
  getStaticSemanticFamily,
  listStaticSemanticFamilyPublicSummaries,
  staticSemanticFamilyPublicSummary
} from "#meshrix/contracts/operations/static-semantic-family-catalog";

export function createSystemControllerCapabilityEcosystemHandlers({
  sendConsoleDomainOperation,
  parseJsonBody,
  moduleManagement = null,
  getStrategyManagementProvider = () => null
}) {
  const strategyOperationIds = new Set([
    "strategy.describe",
    "strategy.workflow_policy.evaluate",
    "strategy.agent_policy.evaluate",
    "strategy.route_policy.evaluate",
    "strategy.queue_policy.evaluate",
    "strategy.tool_policy.preview"
  ]);

  function operationInput(requestBody, url = null) {
    if (requestBody?.length > 0) {
      return parseJsonBody(requestBody);
    }
    return url ? Object.fromEntries(url.searchParams.entries()) : {};
  }

  return {
    async handleProductionHealth({ operation, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "production.health",
        response,
        errorMessage: "读取生产健康状态失败。"
      });
    },
    async handleExecutiveReport({ operation, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "executive_report.list",
        response,
        errorMessage: "读取管理层报告失败。"
      });
    },
    async handleExecutiveReportGenerate({ operation, requestBody, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "executive_report.generate",
        input: parseJsonBody(requestBody),
        response,
        errorMessage: "Executive report generation failed."
      });
    },
    async handleExecutiveReportPreview({ operation, requestBody, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "executive_report.preview",
        input: parseJsonBody(requestBody),
        response,
        errorMessage: "Executive report preview failed."
      });
    },
    async handleArchitectureLiveMap({ operation, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "architecture.live_map",
        response,
        errorMessage: "读取架构运行状态映射失败。"
      });
    },
    async handleSampleCapabilityPacks({ operation, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "sample_capability_pack.list",
        response,
        errorMessage: "读取样例能力包列表失败。"
      });
    },
    async handleSampleCapabilityPack({ operation, packId, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "sample_capability_pack.get",
        input: { packId },
        response,
        errorMessage: "读取样例能力包失败。"
      });
    },
    async handleSampleCapabilityPackMaterialize({ operation, requestBody, response }) {
      await sendConsoleDomainOperation({
        operationId: operation?.id || "sample_capability_pack.materialize",
        input: parseJsonBody(requestBody),
        response,
        errorMessage: "Sample capability pack materialization failed."
      });
    },
    async handleOperationSemanticsStaticFamiliesList({ response }) {
      sendJson(response, 200, {
        ok: true,
        schemaVersion: "v0.0.1:schema:definition-1",
        kind: "meshrix.operation.static-semantic-family-catalog",
        families: listStaticSemanticFamilyPublicSummaries()
      });
    },
    async handleOperationSemanticsStaticFamiliesGet({ requestBody, response }) {
      const payload = operationInput(requestBody);
      const family = getStaticSemanticFamily(payload.familyId || payload.staticSemanticFamilyId || payload.id || "");
      if (!family) {
        sendJson(response, 404, {
          ok: false,
          code: "static_semantic_family_not_found",
          error: "Static semantic family not found."
        });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        schemaVersion: "v0.0.1:schema:definition-1",
        family: staticSemanticFamilyPublicSummary(family)
      });
    },
    async handleStrategyManagement({ operation, requestBody, url, response, authSession }) {
      const operationId = operation?.id || "strategy.describe";
      if (!strategyOperationIds.has(operationId)) {
        await sendConsoleDomainOperation({
          operationId,
          input: operationInput(requestBody, url),
          response,
          errorMessage: "未知策略管理操作。"
        });
        return;
      }
      await sendConsoleDomainOperation({
        operationId,
        input: operationInput(requestBody, url),
        response,
        context: {
          authSession,
          strategyManagementProvider: getStrategyManagementProvider()
        },
        errorMessage: "策略管理操作失败。"
      });
    },
    async handleWorkspaceGovernance({ response }) {
      await sendConsoleDomainOperation({
        operationId: "workspace_governance.describe",
        response
      });
    },
    async handleWorkspaceGovernancePolicy({ requestBody, response }) {
      await sendConsoleDomainOperation({
        operationId: "workspace_governance.policy.set",
        input: parseJsonBody(requestBody),
        response,
        errorMessage: "Workspace governance policy update failed."
      });
    },
    async handleWorkspaceGovernanceEvaluate({ requestBody, response }) {
      await sendConsoleDomainOperation({
        operationId: "workspace_governance.evaluate",
        input: parseJsonBody(requestBody),
        response,
        errorMessage: "Workspace governance evaluation failed."
      });
    },
    async handleWorkspaceGovernanceShareGrant({ requestBody, response }) {
      await sendConsoleDomainOperation({
        operationId: "workspace_governance.share_grant",
        input: parseJsonBody(requestBody),
        response,
        errorMessage: "Workspace governance share grant failed."
      });
    }
  };
}
