
import {
  buildConsoleState,
  buildRuntimeInfo
} from "@meshrix/protocols/http/api-facade";
import { buildBootstrapPayload } from "@meshrix/protocols/http/bootstrap-payload";
import { buildProductionHealthReport } from "@meshrix/foundation/observability/report-reader";
import { buildArchitectureLiveMap } from "@meshrix/foundation/observability/architecture-live-map";
import {
  actorFrom,
  errorPayload,
  parseBooleanFlag,
  protocolPayload,
  requireDevopsProvider,
  result
} from "./shared.ts";
import {
  browseServerPath,
  normalizePathBrowserExtensions,
  normalizePathBrowserMode
} from "./path-browser.ts";
import { runCheckpointWorkspaceFileRestore } from "./workspace-runtime-helpers.ts";
import {
  executiveReportProviderFor,
  readinessBaselineProviderFor,
  sampleCapabilityPackStoreFor
} from "./registry-services.ts";

export async function executeSystemObservationOperation({ operationId, input = {}, context }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  const handledOperations: any = new Set<any>([
    "system.background_processes",
    "system.checkpoint_trees.list",
    "system.checkpoint_trees.get",
    "workspace.checkpoint.tree.list",
    "workspace.checkpoint.node.get",
    "workspace.checkpoint.diff",
    "workspace.checkpoint.restore.preview",
    "workspace.checkpoint.restore",
    "workspace.checkpoint.scope.query"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }

  if (id === "system.background_processes") {
    const { devopsProvider, error } = requireDevopsProvider(context);
    if (error) {
      return error;
    }
    return result(200, await devopsProvider.getBackgroundProcessStatus({ userDataPath: context.userDataPath }));
  }

  const checkpointTreeApi: any = context.checkpointTreeApi;
  if (!checkpointTreeApi) {
    return result(503, { error: "工作队列 checkpoint 接口未注册。" });
  }
  if (id === "system.checkpoint_trees.list" || id === "workspace.checkpoint.tree.list") {
    const trees: any = await checkpointTreeApi.listCheckpointTrees({
      userDataPath: context.userDataPath,
      ownerId: input.ownerId || input["owner-id"] || input.workspaceId || input["workspace-id"] || input.workspaceRef || input["workspace-ref"] || "",
      kind: input.kind || "",
      limit: Number(input.limit || 100)
    });
    return result(200, {
      schemaVersion: "v0.0.1:schema:definition-1",
      count: trees.length,
      items: trees.map((tree?: any) : any => checkpointTreeApi.checkpointTreeSummary(tree))
    });
  }
  if (id === "system.checkpoint_trees.get" || id === "workspace.checkpoint.node.get") {
    const treeId: any = String(input.treeId || input["tree-id"] || input.id || "").trim();
    const tree: any = await checkpointTreeApi.loadCheckpointTree({
      userDataPath: context.userDataPath,
      treeId
    });
    if (!tree) {
      return result(404, {
        error: "checkpoint tree 不存在。"
      });
    }
    return result(200, tree);
  }
  if (id === "workspace.checkpoint.diff") {
    if (typeof checkpointTreeApi.diffCheckpointTree !== "function") {
      return result(503, { error: "checkpoint diff 接口不可用。" });
    }
    try {
      return result(200, protocolPayload(await checkpointTreeApi.diffCheckpointTree({
        userDataPath: context.userDataPath,
        treeId: input.treeId || input["tree-id"] || input.id || "",
        fromTreeId: input.fromTreeId || input["from-tree-id"] || "",
        toTreeId: input.toTreeId || input["to-tree-id"] || "",
        fromNodeId: input.fromNodeId || input["from-node-id"] || "",
        toNodeId: input.toNodeId || input["to-node-id"] || ""
      })));
    } catch (error: any) {
      return result(404, errorPayload(error, "checkpoint diff 失败。"));
    }
  }
  if (id === "workspace.checkpoint.scope.query") {
    if (typeof checkpointTreeApi.queryCheckpointScope !== "function") {
      return result(503, { error: "checkpoint scope 接口不可用。" });
    }
    try {
      return result(200, protocolPayload(await checkpointTreeApi.queryCheckpointScope({
        userDataPath: context.userDataPath,
        treeId: input.treeId || input["tree-id"] || input.id || "",
        nodeId: input.nodeId || input["node-id"] || input.checkpointNodeId || ""
      })));
    } catch (error: any) {
      return result(404, errorPayload(error, "checkpoint scope 查询失败。"));
    }
  }
  if (id === "workspace.checkpoint.restore.preview") {
    if (typeof checkpointTreeApi.previewCheckpointRestore !== "function") {
      return result(503, { error: "checkpoint restore preview 接口不可用。" });
    }
    try {
      const restorePlan: any = await checkpointTreeApi.previewCheckpointRestore({
        userDataPath: context.userDataPath,
        treeId: input.treeId || input["tree-id"] || input.id || "",
        nodeId: input.nodeId || input["node-id"] || input.checkpointNodeId || "",
        mode: input.mode || "",
        reason: input.reason || ""
      });
      const fileRestore: any = await runCheckpointWorkspaceFileRestore({
        plan: restorePlan,
        input,
        context,
        dryRun: true
      });
      if (fileRestore && fileRestore.payload?.ok !== true) {
        return fileRestore;
      }
      return result(200, protocolPayload({
        ...restorePlan,
        actions: fileRestore
          ? [
              ...restorePlan.actions,
              {
                action: "restore_workspace_files",
                workspaceId: fileRestore.payload.workspaceId,
                dryRun: true
              }
            ]
          : restorePlan.actions,
        workspaceFileRestore: fileRestore?.payload
      }));
    } catch (error: any) {
      return result(404, errorPayload(error, "checkpoint restore preview 失败。"));
    }
  }
  if (id === "workspace.checkpoint.restore") {
    if (typeof checkpointTreeApi.restoreCheckpointTree !== "function") {
      return result(503, { error: "checkpoint restore 接口不可用。" });
    }
    try {
      const restorePlan: any = typeof checkpointTreeApi.previewCheckpointRestore === "function"
        ? await checkpointTreeApi.previewCheckpointRestore({
            userDataPath: context.userDataPath,
            treeId: input.treeId || input["tree-id"] || input.id || "",
            nodeId: input.nodeId || input["node-id"] || input.checkpointNodeId || "",
            mode: input.mode || "",
            reason: input.reason || ""
          })
        : null;
      const fileRestore: any = restorePlan
        ? await runCheckpointWorkspaceFileRestore({
            plan: restorePlan,
            input,
            context,
            dryRun: false
          })
        : null;
      if (fileRestore && fileRestore.payload?.ok !== true) {
        return fileRestore;
      }
      const markerRestore: any = await checkpointTreeApi.restoreCheckpointTree({
        userDataPath: context.userDataPath,
        treeId: input.treeId || input["tree-id"] || input.id || "",
        nodeId: input.nodeId || input["node-id"] || input.checkpointNodeId || "",
        actor: actorFrom(context.authSession, input),
        mode: input.mode || "",
        reason: input.reason || ""
      });
      return result(200, protocolPayload({
        ...markerRestore,
        actions: fileRestore
          ? [
              ...markerRestore.actions,
              {
                action: "restore_workspace_files",
                workspaceId: fileRestore.payload.workspaceId,
                dryRun: false
              }
            ]
          : markerRestore.actions,
        workspaceFileRestore: fileRestore?.payload
      }));
    } catch (error: any) {
      return result(404, errorPayload(error, "checkpoint restore 失败。"));
    }
  }

  return null;
}

export async function executeJobObservationOperation({ operationId, input = {}, context }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  if (id !== "jobs.failed_review") {
    return null;
  }
  const jobWorkflowProvider: any = context.jobWorkflowProvider;
  if (!jobWorkflowProvider || typeof jobWorkflowProvider.listJobs !== "function") {
    return result(503, { error: "任务工作流 provider 不可用。" });
  }
  const jobs: any = await jobWorkflowProvider.listJobs({
    limit: Number(input.limit || 50)
  });
  const failed: any = (jobs.items || []).filter((job?: any) : any => job.status === "failed");
  return result(200, {
    ok: true,
    summary: jobs.summary,
    failedCount: failed.length,
    failedJobs: failed.map((job?: any) : any => ({
      id: job.id,
      stage: job.stage || "",
      error: job.error || "",
      createdAt: job.createdAt || "",
      updatedAt: job.updatedAt || ""
    })),
    suggestions:
      failed.length > 0
        ? [
            "查看失败任务的输入来源与索引流程。",
            "确认存储、队列与模型配置是否可用。",
            "需要重跑时由管理员在任务面板或 CLI 明确触发。"
          ]
        : ["最近任务未发现失败项。"]
  });
}

export async function executeSystemCoreOperation({ operationId, context }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  if (!["system.health", "system.bootstrap"].includes(id)) {
    return null;
  }

  const discoveryState: any = context.discoveryState || {};
  if (id === "system.health") {
    const integrationSnapshot: any =
      context.integrationTaskSupervisorSnapshot &&
      typeof context.integrationTaskSupervisorSnapshot === "object"
        ? context.integrationTaskSupervisorSnapshot
        : {};
    const integrationSummary: any =
      integrationSnapshot.summary &&
      typeof integrationSnapshot.summary === "object"
        ? integrationSnapshot.summary
        : {};
    const integrationStateCounts: any =
      integrationSummary.stateCounts &&
      typeof integrationSummary.stateCounts === "object"
        ? integrationSummary.stateCounts
        : {};
    return result(200, {
      ok: true,
      serverId: discoveryState.serverId,
      mode: discoveryState.mode,
      activeServiceUrl: discoveryState.activeServiceUrl,
      optionalIntegrations: {
        lifecycleState: String(integrationSnapshot.lifecycleState || "unavailable"),
        acceptingTasks: integrationSnapshot.acceptingTasks === true,
        admittedAdapterCount: Number(integrationSummary.admittedAdapterCount || 0),
        readyAdapterCount: Number(integrationStateCounts.ready || 0),
        degradedAdapterCount: Number(integrationStateCounts.degraded || 0),
        inactiveAdapterCount:
          Number(integrationStateCounts.disabled || 0) +
          Number(integrationStateCounts.unconfigured || 0) +
          Number(integrationStateCounts.invalid || 0)
      }
    });
  }

  return result(200, {
    ...buildBootstrapPayload(discoveryState),
    resolvedAt: new Date().toISOString()
  });
}

export async function executeConsoleStateOperation({ operationId, context }: Record<string, any>) : Promise<any> {
  if (operationId === "readiness.baseline.status") {
    const provider: any = readinessBaselineProviderFor(context);
    return result(200, await provider.status());
  }

  if (operationId === "runtime.info") {
    return result(200, await buildRuntimeInfo({
      userDataPath: context.userDataPath,
      distPath: context.distPath,
      runtime: context.runtime,
      moduleManagement: context.moduleManagement,
      discoveryState: context.discoveryState,
      storageProvider: context.storageProvider,
      serverUrl: context.serverUrl,
      securityPermissions: context.securityPermissions,
      request: context.request,
      features: context.features,
      consoleDomainServices: context.consoleDomainServices
    }));
  }

  if (operationId === "system.console_state") {
    return result(200, await buildConsoleState({
      userDataPath: context.userDataPath,
      distPath: context.distPath,
      runtime: context.runtime,
      moduleManagement: context.moduleManagement,
      discoveryState: context.discoveryState,
      jobWorkflowProvider: context.jobWorkflowProvider,
      storageProvider: context.storageProvider,
      clientRegistryService: context.clientRegistryService,
      serverUrl: context.serverUrl,
      securityPermissions: context.securityPermissions,
      request: context.request,
      maintenanceAgent: context.maintenanceAgent,
      features: context.features,
      toolSkillManagementProvider: context.toolSkillManagementProvider,
      consoleDomainServices: context.consoleDomainServices
    }));
  }

  return null;
}

export async function executeSystemInterfaceOperation({ operationId, context }: Record<string, any>) : Promise<any> {
  if (operationId !== "system.interfaces") {
    return null;
  }
  if (context.coreProvider && typeof context.coreProvider.buildSystemInterfaces === "function") {
    return result(200, context.coreProvider.buildSystemInterfaces({
      controllers: typeof context.getControllers === "function" ? context.getControllers() : null,
      features: typeof context.getFeatureEntries === "function" ? context.getFeatureEntries() : null
    }));
  }
  const getFeatureEntries: any = typeof context.getFeatureEntries === "function"
    ? context.getFeatureEntries
    : null;
  const getInterfaceCatalog: any = typeof context.getInterfaceCatalog === "function"
    ? context.getInterfaceCatalog
    : () : any => [];
  return result(200, {
    transport: {
      http: "direct",
      rpc: "POST /api/rpc",
      events: "GET /api/events"
    },
    interfaces: getInterfaceCatalog(),
    features: getFeatureEntries ? getFeatureEntries() : null
  });
}

export async function executeRuntimePathBrowseOperation({ operationId, input = {}, context }: Record<string, any>) : Promise<any> {
  if (operationId !== "runtime.path_browse") {
    return null;
  }
  const mode: any = normalizePathBrowserMode(input.mode);
  return result(200, await browseServerPath({
    requestedPath: input.path || input.currentPath || "",
    mode,
    extensions: normalizePathBrowserExtensions(input.extensions),
    includeHidden: parseBooleanFlag(input.includeHidden ?? input["include-hidden"], false),
    userDataPath: context.userDataPath,
    distPath: context.distPath
  }));
}

export async function executeProductionReadinessOperation({ operationId, input = {}, context }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  const handledOperations: any = new Set<any>([
    "production.health",
    "architecture.live_map",
    "executive_report.list",
    "executive_report.preview",
    "executive_report.generate",
    "sample_capability_pack.list",
    "sample_capability_pack.get",
    "sample_capability_pack.materialize"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }

  if (id === "production.health") {
    return result(200, await buildProductionHealthReport({
      userDataPath: context.userDataPath
    }));
  }
  if (id === "architecture.live_map") {
    return result(200, await buildArchitectureLiveMap());
  }

  if (id.startsWith("executive_report.")) {
    try {
      const provider: any = executiveReportProviderFor(context);
      if (id === "executive_report.preview") {
        return result(200, await provider.preview(input));
      }
      if (id === "executive_report.list") {
        return result(200, await provider.list(input));
      }
      if (id === "executive_report.generate") {
        return result(200, await provider.generate(input));
      }
    } catch (error: any) {
      return result(400, errorPayload(error, id === "executive_report.generate"
        ? "Executive report generation failed."
        : "Executive report preview failed."));
    }
  }

  if (id.startsWith("sample_capability_pack.")) {
    const store: any = sampleCapabilityPackStoreFor(context);
    if (id === "sample_capability_pack.list") {
      return result(200, store.list());
    }
    if (id === "sample_capability_pack.get") {
      const pack: any = store.get(input.packId || input["pack-id"] || input.id || "");
      if (!pack) {
        return result(404, { ok: false, error: "Sample capability pack not found." });
      }
      return result(200, pack);
    }
    if (id === "sample_capability_pack.materialize") {
      try {
        return result(200, await store.materialize(input));
      } catch (error: any) {
        return result(400, errorPayload(error, "Sample capability pack materialization failed."));
      }
    }
  }

  return null;
}
