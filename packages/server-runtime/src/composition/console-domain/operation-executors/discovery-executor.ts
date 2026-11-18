
import { hashClientString, serverToken } from "@meshrix/foundation/security/client-strings";
import { isClientCredential } from "../../../state/client-registry-repository.ts";
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
    offlineAfterSeconds: value.offlineAfterSeconds,
    checkInPolicy: value.checkInPolicy
  };
}

function presentedClientCredential(input: Record<string, any> = {}, request?: any) : any {
  const authorization: any = String(request?.headers?.authorization || "");
  if (authorization.startsWith("Bearer ")) {
    const bearer: any = authorization.slice("Bearer ".length).trim();
    if (isClientCredential(bearer)) {
      return bearer;
    }
  }
  const inline: any = String(input.clientCredential || "");
  return isClientCredential(inline) ? inline : "";
}

function checkInPolicyOf(discoveryState: Record<string, any> = {}) : any {
  return String(discoveryState.checkInPolicy || "").trim().toLowerCase() === "open"
    ? "open"
    : "credential";
}

export async function executeDiscoveryOperation({ operationId, input = {}, context }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  const handledOperations: any = new Set<any>([
    "discovery.check_in",
    "discovery.clients",
    "discovery.clients.alignment_command",
    "discovery.clients.enrollment_token",
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
    // check_in stays a public route; client identity is established here by a
    // server-issued credential (Bearer mck_… or input.clientCredential), a
    // one-time enrollmentToken minted by an operator, or — only when the
    // deployment's checkInPolicy is explicitly "open" — the legacy
    // input-derived identity.
    const checkInPolicy: any = checkInPolicyOf(discoveryState);
    const credential: any = presentedClientCredential(input, context.request);
    const enrollmentToken: any = String(input.enrollmentToken || "").trim();
    let clientId: any = "";
    let issuedCredential: any = "";
    if (credential) {
      const resolved: any = typeof clientRegistryService.resolveClientCredential === "function"
        ? clientRegistryService.resolveClientCredential(credential)
        : { ok: false };
      if (!resolved?.ok) {
        return result(401, {
          error: "客户端凭证无效或已吊销。",
          code: "client_credential_invalid"
        });
      }
      clientId = String(resolved.clientId || "");
    } else if (enrollmentToken) {
      const consumed: any = typeof clientRegistryService.consumeEnrollmentToken === "function"
        ? clientRegistryService.consumeEnrollmentToken(enrollmentToken)
        : { ok: false };
      if (!consumed?.ok) {
        return result(403, {
          error: "客户端登记令牌无效、已使用或已过期。",
          code: String(consumed?.code || "client_enrollment_denied")
        });
      }
      clientId = serverToken("client", hashClientString(enrollmentToken, "client.enroll"));
    } else if (checkInPolicy === "open") {
      clientId = serverToken(
        "client",
        input.clientId || input.hostname || input.currentServiceUrl || "anonymous"
      );
    } else {
      return result(401, {
        error: "客户端登记需要有效凭证或登记令牌。",
        code: "client_credential_required"
      });
    }
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
    if (enrollmentToken && typeof clientRegistryService.issueClientCredential === "function") {
      const issued: any = clientRegistryService.issueClientCredential({ clientId });
      issuedCredential = String(issued?.credential || "");
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
      ...(issuedCredential ? { credential: issuedCredential } : {}),
      bootstrap: {
        ...buildBootstrapPayload(discoveryState)
      }
    });
  }

  if (id === "discovery.clients.enrollment_token") {
    const { clientRegistryService, error } = requireClientRegistryService(context);
    if (error) {
      return error;
    }
    if (typeof clientRegistryService.issueEnrollmentToken !== "function") {
      return result(503, { error: "客户端登记令牌存储不可用。" });
    }
    const issued: any = clientRegistryService.issueEnrollmentToken({
      ttlSeconds: input.ttlSeconds
    });
    if (issued?.ok === false) {
      return result(issued.statusCode || 429, {
        error: issued.error || "客户端登记令牌签发失败。",
        code: issued.code || "client_enrollment_token_rejected"
      });
    }
    await publishProtocolEvent(
      context.protocolEventBus,
      "discovery.clients",
      {
        serverId: discoveryState.serverId,
        expiresAt: issued.expiresAt
      },
      { type: "discovery.client.enrollment_token.issued" }
    );
    return result(200, {
      ok: true,
      token: issued.token,
      expiresAt: issued.expiresAt
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
