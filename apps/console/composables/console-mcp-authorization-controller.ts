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
) : any {
  const mcpAuthorizationRequests: any = ref<McpAuthorizationRequest[]>([]);
  const mcpAuthorizationStatus: any = ref<McpAuthorizationStatus>("pending");
  const mcpAuthorizationStatusOptionBarOptions: OptionBarOption[] = [
    { value: "pending", label: "待审批" },
    { value: "approved", label: "已批准" },
    { value: "rejected", label: "已拒绝" },
    { value: "all", label: "所有" },
  ];
  let refreshGeneration: any = 0;

  async function refreshMcpAuthorizationRequests() : Promise<any> {
    const generation: any = ++refreshGeneration;
    const status: any = mcpAuthorizationStatus.value;
    const busy: any = "mcp-authorization-requests:refresh";
    options.setBusy(busy);
    try {
      const result: any = await listMcpAuthorizationRequests(status);
      if (generation !== refreshGeneration) return;
      mcpAuthorizationRequests.value = Array.isArray(result.requests)
        ? result.requests
        : [];
    } catch (nextError: any) {
      if (generation !== refreshGeneration) return;
      mcpAuthorizationRequests.value = [];
      options.error.value =
        nextError instanceof Error
          ? nextError.message
          : "加载 MCP 授权请求失败。";
    } finally {
      if (generation === refreshGeneration) {
        options.clearBusy(busy);
      }
    }
  }

  async function resolveMcpAuthorizationRequest(
    requestId: string,
    resolution: "approved" | "rejected",
  ) : Promise<any> {
    const busy: any = `mcp-authorization-requests:resolve:${requestId}`;
    const request: any = mcpAuthorizationRequests.value.find(
      (item?: any) : any => item.requestId === requestId,
    );
    options.setBusy(busy);
    try {
      const result: any = await resolveMcpAuthorizationRequestApi(requestId, {
        resolution,
        clientName: request?.clientName,
        scopes: request?.requestedScopes || [],
        toolsets: [],
        toolAllow: request?.requestedTools || [],
      });
      if (result.ok !== true) {
        throw new Error("MCP 授权请求未能完成。");
      }
      await refreshMcpAuthorizationRequests();
      return true;
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error
          ? nextError.message
          : "处理 MCP 授权请求失败。";
      return false;
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
