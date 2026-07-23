
import {
  appendConsoleLog,
  errorPayload,
  firstProtocolInputValue,
  normalizeSearchQueryInput,
  parseOptionalBooleanFlag,
  publishProtocolEvent,
  protocolPayload,
  requireSettingsPort,
  result,
  workspaceAccessOptions
} from "./shared.mjs";
import {
  applyAgentModelPatch,
  agentConfigRegistryFrom,
  agentRuntimeProviderFrom,
  createAgentUid,
  diffModelLibraryAgents,
  findAgentModelIndex,
  loadAgentRuntimeSettings,
  mergeSettingsForModelProbe,
  normalizeAgentModelPayload,
  normalizeModelLibraryAgentAuditAgent,
  normalizeModelLibraryAuditList,
  sanitizeAgentPatchForLog,
  saveAgentModelLibrary
} from "./settings-agent-gateway-models.mjs";
import { applyWorkspaceRuntimeContext } from "./workspace-runtime-helpers.mjs";

export async function executeSettingsAgentGatewayOperation({ operationId, input = {}, context }) {
  const id = String(operationId || "");
  const handledOperations = new Set([
    "settings.get",
    "settings.set",
    "settings.model_probe",
    "agent_gateway.call",
    "model_routing.health",
    "agents.list",
    "agents.create",
    "agents.update",
    "agents.delete"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }

  const settingsPortResult = requireSettingsPort(context);
  if (settingsPortResult.error) {
    return settingsPortResult.error;
  }
  const { settingsPort } = settingsPortResult;

  const settingsInput = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const agentRuntimeProvider = agentRuntimeProviderFrom(context);
  if (!agentRuntimeProvider) {
    return result(503, { error: "Agent runtime provider is not configured." });
  }
  const registry = agentConfigRegistryFrom(context);
  const requiresRegistry = id !== "model_routing.health";
  if (requiresRegistry && !registry) {
    return result(503, { error: "Agent config registry provider is not configured." });
  }

  if (id === "settings.get") {
    return result(200, await loadAgentRuntimeSettings(context, { redactSecrets: true }));
  }

  if (id === "settings.set") {
    const shouldAuditModelLibrary =
      Object.hasOwn(settingsInput, "modelLibraryAgents") ||
      Object.hasOwn(settingsInput, "modelLibraryEntries");
    const beforeSettings = shouldAuditModelLibrary
      ? await loadAgentRuntimeSettings(context, { redactSecrets: true })
      : null;
    const beforeModelLibrarySummary = shouldAuditModelLibrary
      ? normalizeModelLibraryAuditList((beforeSettings?.modelLibraryAgents || []).concat())
      : null;
    const saved = await settingsPort.saveSettings(context.userDataPath, settingsInput, {
      redactSecrets: false
    });
    const runtimeSettings = saved;
    if (typeof context.moduleManagement?.refreshMounts === "function") {
      await context.moduleManagement.refreshMounts({ settings: runtimeSettings });
    }
    const redactedSettings = await loadAgentRuntimeSettings(context, { redactSecrets: true });
    await publishProtocolEvent(
      context.protocolEventBus,
      "settings.current",
      redactedSettings,
      { type: "settings.updated" }
    );
    if (shouldAuditModelLibrary) {
      const afterModelLibrarySummary = normalizeModelLibraryAuditList(saved.modelLibraryAgents);
      const modelLibraryDiff = diffModelLibraryAgents(
        (beforeModelLibrarySummary?.items || []),
        afterModelLibrarySummary.items || []
      );
      appendConsoleLog(context, {
        operationId: "settings.model_library.save",
        event: "console.settings.model_library.saved",
        authSession: context.authSession,
        status: "ok",
        input: {
          actor: {
            userId: context.authSession?.user?.userId || "",
            username: context.authSession?.user?.username || ""
          },
          path: "/api/settings",
          method: "POST",
          settingsModelLibrary: {
            before: beforeModelLibrarySummary || normalizeModelLibraryAuditList([]),
            after: afterModelLibrarySummary,
            diff: modelLibraryDiff
          }
        },
        output: {
          operation: "settings.set",
          modelLibrarySaved: true,
          savedCount: afterModelLibrarySummary.total,
          addedCount: modelLibraryDiff.added.length,
          removedCount: modelLibraryDiff.removed.length,
          changedCount: modelLibraryDiff.changed.length
        },
        actor: context.authSession
      });
    }
    return result(200, redactedSettings);
  }

  if (id === "settings.model_probe") {
    const provider = String(settingsInput.provider || settingsInput.modelProvider || "").trim();
    const modelAlias = String(
      settingsInput.modelAlias || settingsInput.agentAlias || settingsInput.agentId || settingsInput.uid || ""
    ).trim();
    if (!modelAlias) {
      return result(400, { error: "Model probe requires an explicit modelAlias." });
    }
    const startedAt = Date.now();
    let probeResult;
    let status = "ok";
    let message = "";
    try {
      const current = await loadAgentRuntimeSettings(context);
      const candidateSettings = mergeSettingsForModelProbe(
        current,
        settingsInput.settings || settingsInput.value || {},
        settingsPort.normalizeSettings
      );
      probeResult = await agentRuntimeProvider.probeModelConnection({
        provider,
        settings: candidateSettings,
        modelAlias,
        userDataPath: context.userDataPath,
        contextCompactionSource: "settings.model_probe"
      });
    } catch (error) {
      status = "failed";
      message = error instanceof Error ? error.message : "模型探测失败。";
      probeResult = {
        ok: false,
        configured: false,
        provider,
        model: modelAlias,
        statusCode: 0,
        latencyMs: 0,
        checkedAt: new Date().toISOString(),
        message
      };
    }
    appendConsoleLog(context, {
      operationId: "settings.model_library.probe",
      event: "console.settings.model_library.probe",
      authSession: context.authSession,
      status,
      input: {
        actor: {
          userId: context.authSession?.user?.userId || "",
          username: context.authSession?.user?.username || ""
        },
        method: "POST",
        path: "/api/settings/model-probe",
        provider,
        modelAlias,
        modelLibraryModelCount: normalizeModelLibraryAuditList((
          settingsInput.settings?.modelLibraryAgents || []
        )).total
      },
      output: {
        provider,
        modelAlias,
        ok: Boolean(probeResult?.ok),
        configured: Boolean(probeResult?.configured),
        latencyMs: Number(probeResult?.latencyMs || 0),
        statusCode: Number(probeResult?.statusCode || 0),
        message: probeResult?.message || message || "",
        checkedAt: probeResult?.checkedAt || new Date().toISOString()
      },
      durationMs: Date.now() - startedAt,
      actor: context.authSession
    });
    return result(200, probeResult);
  }

  if (id === "agent_gateway.call") {
    if (typeof agentRuntimeProvider.callAgentGateway !== "function") {
      return result(503, { error: "Agent gateway runtime provider is not configured." });
    }
    const workspaceApplied = applyWorkspaceRuntimeContext(
      settingsInput,
      context.agentWorkspace,
      workspaceAccessOptions(context.authSession)
    );
    if (workspaceApplied.workspaceError) {
      return result(workspaceApplied.workspaceError.status, {
        error: workspaceApplied.workspaceError.error
      });
    }
    const settings = await loadAgentRuntimeSettings(context);
    const gatewayResult = await agentRuntimeProvider.callAgentGateway({
      settings,
      input: workspaceApplied.input,
      userDataPath: context.userDataPath,
      contextRuntime: context.contextRuntime,
      contextCompactionSource: "api.agent_gateway.call"
    });
    return result(
      200,
      workspaceApplied.workspaceContext
        ? {
            ...gatewayResult,
            workspaceContext: workspaceApplied.workspaceContext
          }
        : gatewayResult
    );
  }

  if (id === "agents.list") {
    if (typeof agentRuntimeProvider.publicAgentGatewayRegistry !== "function") {
      return result(503, { error: "Agent gateway runtime provider is not configured." });
    }
    const settings = await loadAgentRuntimeSettings(context);
    return result(200, await agentRuntimeProvider.publicAgentGatewayRegistry(settings));
  }

  if (id === "model_routing.health") {
    if (typeof agentRuntimeProvider.inspectAgentModelRouting !== "function") {
      return result(503, { error: "Agent gateway runtime provider is not configured." });
    }
    return result(200, await agentRuntimeProvider.inspectAgentModelRouting({
      userDataPath: context.userDataPath,
      limit: Number(settingsInput.limit || 50)
    }));
  }

  if (id === "agents.create") {
    const startedAt = Date.now();
    const patch = normalizeAgentModelPayload(settingsInput);
    const provider = patch.provider || "";
    const model = patch.model || patch.engine || "";
    const current = await loadAgentRuntimeSettings(context);
    const entry = {
      provider,
      ...patch,
      uid: patch.uid || createAgentUid({ ...patch, provider, model }),
      label: Object.hasOwn(patch, "label") ? patch.label : "",
      agentName: Object.hasOwn(patch, "agentName") ? patch.agentName : "",
      model,
      engine: Object.hasOwn(patch, "engine") ? patch.engine : ""
    };
    const models = [entry, ...(current.modelLibraryAgents || [])];
    try {
      const { registry: gatewayRegistry } = await saveAgentModelLibrary(context, current, models);
      const agent = gatewayRegistry.agents.find((item) => item.alias === entry.uid) || null;
      appendConsoleLog(context, {
        operationId: "settings.model_library.create",
        event: "console.settings.model_library.created",
        authSession: context.authSession,
        status: "ok",
        risk: "content_write",
        input: {
          actor: {
            userId: context.authSession?.user?.userId || "",
            username: context.authSession?.user?.username || ""
          },
          method: "POST",
          path: "/api/agents",
          agent: normalizeModelLibraryAgentAuditAgent(entry)
        },
        output: {
          ok: true,
          action: "created",
          agentId: entry.uid,
          registryVersion: gatewayRegistry.version || null,
          savedCount: gatewayRegistry.agents?.length || 0
        },
        durationMs: Date.now() - startedAt,
        actor: context.authSession
      });
      return result(200, {
        ok: true,
        action: "created",
        agentId: entry.uid,
        agent,
        registry: gatewayRegistry
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "创建智能体模型配置失败。";
      appendConsoleLog(context, {
        operationId: "settings.model_library.create",
        event: "console.settings.model_library.create_failed",
        authSession: context.authSession,
        status: "failed",
        risk: "content_write",
        input: {
          actor: {
            userId: context.authSession?.user?.userId || "",
            username: context.authSession?.user?.username || ""
          },
          method: "POST",
          path: "/api/agents",
          agent: {
            provider,
            model,
            label: entry.label || entry.agentName || ""
          }
        },
        error: message,
        durationMs: Date.now() - startedAt,
        actor: context.authSession
      });
      return result(500, { error: message });
    }
  }

  if (id === "agents.update") {
    const startedAt = Date.now();
    const agentId = settingsInput.agentId;
    const patch = normalizeAgentModelPayload(settingsInput);
    const current = await loadAgentRuntimeSettings(context);
    const models = [...(current.modelLibraryAgents || [])];
    const index = findAgentModelIndex(models, agentId);
    if (index < 0) {
      const message = "智能体模型配置不存在。";
      appendConsoleLog(context, {
        operationId: "settings.model_library.update",
        event: "console.settings.model_library.update_failed",
        authSession: context.authSession,
        status: "failed",
        risk: "content_write",
        input: {
          actor: {
            userId: context.authSession?.user?.userId || "",
            username: context.authSession?.user?.username || ""
          },
          method: "POST",
          path: `/api/agents/${String(agentId || "")}`,
          agentId: String(agentId || "")
        },
        error: message,
        output: { notFound: true },
        durationMs: Date.now() - startedAt,
        actor: context.authSession
      });
      return result(404, { error: message });
    }
    const previous = models[index];
    const next = applyAgentModelPatch(previous, patch);
    models[index] = next;
    try {
      const { registry: gatewayRegistry } = await saveAgentModelLibrary(context, current, models);
      const agent = gatewayRegistry.agents.find((item) => item.alias === next.uid) || null;
      appendConsoleLog(context, {
        operationId: "settings.model_library.update",
        event: "console.settings.model_library.updated",
        authSession: context.authSession,
        status: "ok",
        risk: "content_write",
        input: {
          actor: {
            userId: context.authSession?.user?.userId || "",
            username: context.authSession?.user?.username || ""
          },
          method: "POST",
          path: `/api/agents/${String(agentId || "")}`,
          previous: normalizeModelLibraryAgentAuditAgent(previous),
          patch: sanitizeAgentPatchForLog(patch),
          next: normalizeModelLibraryAgentAuditAgent(next)
        },
        output: {
          ok: true,
          action: "updated",
          agentId: next.uid,
          registryVersion: gatewayRegistry.version || null,
          savedCount: gatewayRegistry.agents?.length || 0
        },
        durationMs: Date.now() - startedAt,
        actor: context.authSession
      });
      return result(200, {
        ok: true,
        action: "updated",
        agentId: next.uid,
        agent,
        registry: gatewayRegistry
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "更新智能体模型配置失败。";
      appendConsoleLog(context, {
        operationId: "settings.model_library.update",
        event: "console.settings.model_library.update_failed",
        authSession: context.authSession,
        status: "failed",
        risk: "content_write",
        input: {
          actor: {
            userId: context.authSession?.user?.userId || "",
            username: context.authSession?.user?.username || ""
          },
          method: "POST",
          path: `/api/agents/${String(agentId || "")}`,
          patch: sanitizeAgentPatchForLog(patch),
          agentId: next.uid
        },
        output: {
          ok: false,
          action: "updated",
          agentId: next.uid
        },
        error: message,
        durationMs: Date.now() - startedAt,
        actor: context.authSession
      });
      return result(500, { error: message });
    }
  }

  if (id === "agents.delete") {
    const startedAt = Date.now();
    const agentId = settingsInput.agentId;
    const current = await loadAgentRuntimeSettings(context);
    const models = [...(current.modelLibraryAgents || [])];
    const index = findAgentModelIndex(models, agentId);
    const normalizedAgentId = String(agentId || "").trim();
    if (index < 0) {
      const message = "智能体模型配置不存在。";
      appendConsoleLog(context, {
        operationId: "settings.model_library.delete",
        event: "console.settings.model_library.delete_failed",
        authSession: context.authSession,
        status: "failed",
        risk: "content_write",
        input: {
          actor: {
            userId: context.authSession?.user?.userId || "",
            username: context.authSession?.user?.username || ""
          },
          method: "DELETE",
          path: `/api/agents/${normalizedAgentId}`,
          agentId: normalizedAgentId
        },
        error: message,
        output: { notFound: true },
        durationMs: Date.now() - startedAt,
        actor: context.authSession
      });
      return result(404, { error: message });
    }
    const [removed] = models.splice(index, 1);
    try {
      const { registry: gatewayRegistry } = await saveAgentModelLibrary(context, current, models);
      appendConsoleLog(context, {
        operationId: "settings.model_library.delete",
        event: "console.settings.model_library.deleted",
        authSession: context.authSession,
        status: "ok",
        risk: "content_write",
        input: {
          actor: {
            userId: context.authSession?.user?.userId || "",
            username: context.authSession?.user?.username || ""
          },
          method: "DELETE",
          path: `/api/agents/${normalizedAgentId}`,
          agent: normalizeModelLibraryAgentAuditAgent(removed)
        },
        output: {
          ok: true,
          action: "deleted",
          agentId: removed.uid || removed.instanceId || removed.alias || normalizedAgentId,
          registryVersion: gatewayRegistry.version || null,
          savedCount: gatewayRegistry.agents?.length || 0
        },
        durationMs: Date.now() - startedAt,
        actor: context.authSession
      });
      return result(200, {
        ok: true,
        action: "deleted",
        agentId: removed.uid || removed.instanceId || removed.alias || String(agentId || ""),
        registry: gatewayRegistry
      });
    } catch (error) {
      const removedAgentId = removed.uid || removed.instanceId || removed.alias || normalizedAgentId;
      const message = error instanceof Error ? error.message : "删除智能体模型配置失败。";
      appendConsoleLog(context, {
        operationId: "settings.model_library.delete",
        event: "console.settings.model_library.delete_failed",
        authSession: context.authSession,
        status: "failed",
        risk: "content_write",
        input: {
          actor: {
            userId: context.authSession?.user?.userId || "",
            username: context.authSession?.user?.username || ""
          },
          method: "DELETE",
          path: `/api/agents/${normalizedAgentId}`,
          agentId: removedAgentId
        },
        output: {
          ok: false,
          action: "deleted",
          agentId: removedAgentId
        },
        error: message,
        durationMs: Date.now() - startedAt,
        actor: context.authSession
      });
      return result(500, { error: message });
    }
  }

  return null;
}
