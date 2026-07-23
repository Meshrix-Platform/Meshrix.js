import { ref, type Ref } from "vue";
import {
  listMcpAuthorizationRequests,
  resolveMcpAuthorizationRequest as resolveMcpAuthorizationRequestApi,
  type McpAuthorizationRequest,
} from "../lib/authorization-governance-client";
import type { OptionBarOption } from "../types/app";

type McpAuthorizationStatus = "all" | "pending" | "approved" | "rejected";

type ConsoleMcpAuthorizationControllerOptions = {
  clearBusy: (key: string) => void;
  error: Ref<string>;
  setBusy: (key: string) => void;
};

export function createConsoleMcpAuthorizationController(
  options: ConsoleMcpAuthorizationControllerOptions,
) {
  const mcpAuthorizationRequests = ref<McpAuthorizationRequest[]>([]);
  const mcpAuthorizationStatus = ref<McpAuthorizationStatus>("pending");
  const mcpAuthorizationStatusOptionBarOptions: OptionBarOption[] = [
    { value: "pending", label: "待审批" },
    { value: "approved", label: "已批准" },
    { value: "rejected", label: "已拒绝" },
    { value: "all", label: "所有" },
  ];

  async function refreshMcpAuthorizationRequests() {
    const busy = "mcp-authorization-requests:refresh";
    options.setBusy(busy);
    try {
      const result = await listMcpAuthorizationRequests(mcpAuthorizationStatus.value);
      mcpAuthorizationRequests.value = Array.isArray(result.requests) ? result.requests : [];
    } catch (nextError) {
      mcpAuthorizationRequests.value = [];
      options.error.value =
        nextError instanceof Error ? nextError.message : "加载 MCP 授权请求失败。";
    } finally {
      options.clearBusy(busy);
    }
  }

  async function resolveMcpAuthorizationRequest(
    requestId: string,
    resolution: "approved" | "rejected",
  ) {
    const busy = `mcp-authorization-requests:resolve:${requestId}`;
    const request = mcpAuthorizationRequests.value.find((item) => item.requestId === requestId);
    options.setBusy(busy);
    try {
      await resolveMcpAuthorizationRequestApi(requestId, {
        resolution,
        clientName: request?.clientName,
        scopes: request?.requestedScopes || [],
        toolsets: [],
        toolAllow: request?.requestedTools || [],
      });
      await refreshMcpAuthorizationRequests();
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "处理 MCP 授权请求失败。";
    } finally {
      options.clearBusy(busy);
    }
  }

  return {
    mcpAuthorizationRequests,
    mcpAuthorizationStatus,
    mcpAuthorizationStatusOptionBarOptions,
    refreshMcpAuthorizationRequests,
    resolveMcpAuthorizationRequest,
  };
}
