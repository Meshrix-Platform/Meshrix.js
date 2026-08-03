
import { hashClientString, serverToken } from "@meshrix/foundation/security/client-strings";
import { buildBootstrapPayload } from "@meshrix/protocols/http/bootstrap-payload";
import {
  buildClientConnectionList,
  buildConsoleDiscoveryConfig
} from "@meshrix/protocols/http/api-facade";
import { publishProtocolEvent, requireClientRegistryService, requireDiscoveryPort, result } from "./shared.ts";

export function hasClientSuppliedString(value?: any, keys?: any) : any {
  if (!value || typeof value !== "object") {
    return false;
  }
  return keys.some((key?: any) : any => typeof value[key] === "string" && value[key].trim());
}

export function clientVersionString(value?: any) : any {
  const text: any = String(value || "").trim().slice(0, 80);
  return /^[A-Za-z0-9._:@+ -]*$/.test(text) ? text : hashClientString(text, "client.version");
}

export function stripClientDiscoveryStrings(value: Record<string, any> = {}) : any {
  return {
    mode: ["active", "forward"].includes(String(value.mode || "").trim())
      ? String(value.mode).trim()
      : "",
    refreshIntervalSeconds: value.refreshIntervalSeconds,
    checkInIntervalSeconds: value.checkInIntervalSeconds,
    offlineAfterSeconds: value.offlineAfterSeconds
  };
}

export async function executeDiscoveryOperation({ operationId, input = {}, context }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  const handledOperations: any = new Set<any>([
    "discovery.check_in",
    "discovery.clients",
    "discovery.clients.alignment_command",
    "discovery.get_config",
    "discovery.set_config"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }

  const discoveryState: any = context.discoveryState || {};

  if (id === "discovery.check_in") {
    const { clientRegistryService, error } = requireClientRegistryService(context);
    if (error) {
      return error;
    }
    if (typeof clientRegistryService.recordClientCheckIn !== "function") {
      return result(503, { error: "客户端登记存储不可用。" });
    }
    const clientId: any = serverToken(
      "client",
      input.clientId || input.hostname || input.currentServiceUrl || "anonymous"
    );
    const record: any = clientRegistryService.recordClientCheckIn({
      clientId,
      clientLabel: hashClientString(input.clientLabel || input.hostname || clientId, "client.label"),
      appVersion: clientVersionString(input.appVersion || ""),
      platform: hashClientString(input.platform || "", "client.platform"),
      hostname: hashClientString(input.hostname || "", "client.hostname"),
      bootstrapUrl: "",
      currentServiceUrl: hashClientString(input.currentServiceUrl || "", "service.url"),
      desiredServiceUrl: hashClientString(discoveryState.activeServiceUrl || "", "service.url"),
      currentJobServiceUrl: input.currentJobServiceUrl
        ? hashClientString(input.currentJobServiceUrl || "", "service.url")
        : "",
      configVersion: clientVersionString(input.configVersion || ""),
      busy: Boolean(input.busy),
      lastJobId: hashClientString(input.lastJobId || "", "client.last_job_id"),
      lastError: hashClientString(input.lastError || "", "client.last_error"),
      serverId: discoveryState.serverId,
      offlineAfterSeconds: discoveryState.offlineAfterSeconds
    });
    if (record?.ok === false) {
      return result(record.statusCode || 429, {
        error: record.error || "客户端登记失败。",
        code: record.code || "client_registration_rejected"
      });
    }
    await publishProtocolEvent(
      context.protocolEventBus,
      "discovery.clients",
      {
        client: record,
        serverId: discoveryState.serverId
      },
      { type: "discovery.client.checked_in" }
    );
    return result(200, {
      ok: true,
      client: record,
      bootstrap: {
        ...buildBootstrapPayload(discoveryState)
      }
    });
  }

  if (id === "discovery.clients") {
    const { clientRegistryService, error } = requireClientRegistryService(context);
    if (error) {
      return error;
    }
    if (typeof clientRegistryService.listClientRegistrations !== "function") {
      return result(503, { error: "客户端登记存储不可用。" });
    }
    return result(200, buildClientConnectionList(
      clientRegistryService.listClientRegistrations({
        offlineAfterSeconds: discoveryState.offlineAfterSeconds
      }),
      []
    ));
  }

  if (id === "discovery.clients.alignment_command") {
    const { clientRegistryService, error } = requireClientRegistryService(context);
    if (error) {
      return error;
    }
    if (typeof clientRegistryService.findClientRegistration !== "function") {
      return result(503, { error: "客户端登记存储不可用。" });
    }
    const targetClientId: any = String(input.clientId || input["client-id"] || input.id || "").trim();
    if (!targetClientId) {
      return result(400, { error: "缺少客户端 ID。" });
    }
    const client: any = clientRegistryService.findClientRegistration({
      clientId: targetClientId,
      offlineAfterSeconds: discoveryState.offlineAfterSeconds
    });
    if (!client) {
      return result(404, { error: "未找到目标客户端。" });
    }
    const command: Record<string, any> = {
      schemaVersion: "v0.0.1:schema:definition-1",
      command: "align_to_active_service",
      clientId: targetClientId,
      desiredServiceUrl: discoveryState.activeServiceUrl || "",
      configVersion: discoveryState.configVersion || "",
      serverId: discoveryState.serverId || "",
      requestedAt: new Date().toISOString(),
      reason: String(input.reason || "console").trim() || "console",
      requestedBy: context.authSession?.user?.username || "console"
    };
    const event: any = await publishProtocolEvent(
      context.protocolEventBus,
      `discovery.client.alignment.${targetClientId}`,
      { client, command },
      {
        type: "discovery.client.alignment.requested",
        publisher: "console",
        retain: true
      }
    );
    await publishProtocolEvent(
      context.protocolEventBus,
      "discovery.client.alignment",
      {
        clientId: targetClientId,
        command
      },
      {
        type: "discovery.client.alignment.requested",
        publisher: "console",
        retain: true
      }
    );
    return result(200, {
      ok: true,
      client,
      command,
      event
    });
  }

  if (id === "discovery.get_config") {
    const publicDiscoveryState: any = buildConsoleDiscoveryConfig(discoveryState);
    return result(200, {
      value: publicDiscoveryState,
      bootstrap: buildBootstrapPayload(publicDiscoveryState)
    });
  }

  if (id === "discovery.set_config") {
    const discoveryPortResult: any = requireDiscoveryPort(context);
    if (discoveryPortResult.error) {
      return discoveryPortResult.error;
    }
    const { discoveryPort } = discoveryPortResult;
    const value: any = input?.value || input;
    if (
      hasClientSuppliedString(value, [
        "bootstrapBaseUrl",
        "advertisedBaseUrl",
        "activeServiceUrl",
        "forwardBaseUrl",
        "serverId",
        "serverLabel",
        "configVersion"
      ])
    ) {
      return result(400, {
        error: "discovery 配置不接受客户端传入的 URL、服务标识或标签字符串。"
      });
    }
    const nextDiscoveryState: any = await discoveryPort.saveDiscoveryConfig(
      context.userDataPath,
      stripClientDiscoveryStrings(value),
      {
        listenUrl: context.listenUrl,
        serverLabel: context.serverLabel
      }
    );
    if (typeof context.setDiscoveryState === "function") {
      context.setDiscoveryState(nextDiscoveryState);
    }
    const publicDiscoveryState: any = buildConsoleDiscoveryConfig(nextDiscoveryState);
    await publishProtocolEvent(
      context.protocolEventBus,
      "discovery.config",
      {
        value: publicDiscoveryState,
        bootstrap: buildBootstrapPayload(publicDiscoveryState)
      },
      { type: "discovery.config.updated" }
    );
    return result(200, {
      value: publicDiscoveryState,
      bootstrap: buildBootstrapPayload(publicDiscoveryState)
    });
  }

  return null;
}
