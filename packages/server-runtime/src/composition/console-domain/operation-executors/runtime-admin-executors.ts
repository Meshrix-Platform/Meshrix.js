import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  errorPayload,
  parseBooleanFlag,
  protocolPayload,
  publishProtocolEvent,
  requireRuntimeMethod,
  requireStrategyManagementProvider,
  result,
  workspaceAccessOptions
} from "./shared.ts";
import { createPathBrowserRoots, resolvePathBrowserVirtualValue } from "./path-browser.ts";
import { applyWorkspaceRuntimeContext } from "./workspace-runtime-helpers.ts";
import {
  securityAlertStoreFor,
  workspaceGovernanceRegistryFor
} from "./registry-services.ts";
import { GATEWAY_CHANNEL_SELECTION_SOURCE } from "@meshrix/contracts/plugins/gateway-channel-contract";

const RUNTIME_ASSEMBLY_PROTOCOL_VERSION: any = "v0.0.1:release:runtime-assembly-package-1";

function stringArray(value?: any) : any {
  return Array.isArray(value)
    ? value.map((item?: any) : any => String(item || "").trim()).filter(Boolean)
    : [];
}

function componentKey(component: Record<string, any> = {}) : any {
  return String(component.componentId || component.moduleId || "").trim();
}

function componentLookupKeys(component: Record<string, any> = {}) : any {
  return [
    component.componentId,
    component.moduleId
  ].map((value?: any) : any => String(value || "").trim()).filter(Boolean);
}

function requiredAssemblyComponent(component: Record<string, any> = {}) : any {
  return component.hydratable === false || String(component.hydration || "").toLowerCase() === "essential";
}

function sanitizeArchitectureComponent(component: Record<string, any> = {}) : any {
  return {
    componentId: String(component.componentId || ""),
    moduleId: String(component.moduleId || ""),
    parentModuleId: String(component.parentModuleId || ""),
    label: String(component.label || component.componentId || component.moduleId || ""),
    layerId: String(component.layerId || ""),
    moduleCategory: String(component.moduleCategory || ""),
    hydration: String(component.hydration || ""),
    hydratable: component.hydratable !== false,
    functionItems: stringArray(component.functionItems)
  };
}

function featureCount(features: any = null) : any {
  if (Array.isArray(features?.activeFeatures)) {
    return features.activeFeatures.length;
  }
  if (Array.isArray(features?.activeFeatureIds)) {
    return features.activeFeatureIds.length;
  }
  return 0;
}

function runtimeMountCount(runtime: any = null) : any {
  return Object.keys(runtime?.mounts || {}).length;
}

function runtimeProfile(context: Record<string, any> = {}) : any {
  return String(context.runtime?.runtimeOptions?.profile || "");
}

function artifactTimestampSegment(date: any = new Date()) : any {
  return date.toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 16).toLowerCase();
}

function safePackageSegment(value: any = "") : any {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "component";
}

function sha256Text(value: any = "") : any {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

async function writePackageTextFile(packageRoot?: any, relativePath?: any, text?: any) : Promise<any> {
  const normalizedRelativePath: any = relativePath.split(path.sep).join("/");
  const targetPath: any = path.join(packageRoot, ...normalizedRelativePath.split("/"));
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, text, "utf8");
  return {
    path: normalizedRelativePath,
    byteSize: Buffer.byteLength(text, "utf8"),
    sha256: sha256Text(text)
  };
}

async function loadArchitectureInventory(context: Record<string, any> = {}) : Promise<any> {
  if (typeof context.moduleManagement?.getArchitectureComponentInventory === "function") {
    return context.moduleManagement.getArchitectureComponentInventory();
  }
  if (typeof context.consoleDomainServices?.buildRuntimeConsoleSummary === "function") {
    const summary: any = await context.consoleDomainServices.buildRuntimeConsoleSummary({
      userDataPath: context.userDataPath,
      runtime: context.runtime,
      moduleManagement: context.moduleManagement,
      features: context.features,
      listAvailableAnalysisModules: context.consoleDomainServices?.listAvailableAnalysisModules
    });
    return summary?.architectureComponents || null;
  }
  return null;
}

async function buildRuntimeAssemblyPackage({ input = {}, context = {} }: Record<string, any> = {}) : Promise<any> {
  const inventory: any = await loadArchitectureInventory(context);
  const allComponents: any = Array.isArray(inventory?.allComponents) ? inventory.allComponents : [];
  if (allComponents.length === 0) {
    return result(409, {
      ok: false,
      error: "当前运行时没有可装配的架构组件。"
    });
  }

  const requestedComponentIds: any = stringArray(input.selectedComponentIds || input.componentIds || input.components);
  const componentById: any = new Map<any, any>();
  for (const component of allComponents) {
    for (const key of componentLookupKeys(component)) {
      componentById.set(key, component);
    }
  }

  const selectedComponents: any[] = [];
  const selectedKeySet: any = new Set<any>();
  for (const componentId of requestedComponentIds) {
    const component: any = componentById.get(componentId);
    const key: any = componentKey(component);
    if (component && key && !selectedKeySet.has(key)) {
      selectedKeySet.add(key);
      selectedComponents.push(component);
    }
  }

  const requiredComponents: any = allComponents.filter(requiredAssemblyComponent);
  for (const component of requiredComponents) {
    const key: any = componentKey(component);
    if (key && !selectedKeySet.has(key)) {
      selectedKeySet.add(key);
      selectedComponents.push(component);
    }
  }

  if (selectedComponents.length === 0) {
    return result(400, {
      ok: false,
      error: "请选择至少一个架构组件后再生成装配清单。"
    });
  }

  const includedComponentIds: any = selectedComponents.map(componentKey).filter(Boolean);
  const includedIdSet: any = new Set<any>(includedComponentIds);
  const requiredComponentIds: any = requiredComponents.map(componentKey).filter(Boolean);
  const unknownRequestedComponentIds: any = requestedComponentIds.filter((componentId?: any) : any => !componentById.has(componentId));
  const omittedComponentIds: any = allComponents
    .map(componentKey)
    .filter((componentId?: any) : any => componentId && !includedIdSet.has(componentId));
  const createdAt: any = new Date();
  const randomSegment: any = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const artifactId: any = `runtime-assembly-${artifactTimestampSegment(createdAt)}-${randomSegment}`;
  const fileName: any = `${artifactId}.json`;
  const portableDirectoryName: any = `${artifactId}-portable`;
  const portableManifestFileName: any = `${portableDirectoryName}/manifest.json`;
  const portablePackageMetadataFileName: any = `${portableDirectoryName}/package.json`;
  const portableChecksumFileName: any = `${portableDirectoryName}/checksums.sha256`;
  const manifest: Record<string, any> = {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: RUNTIME_ASSEMBLY_PROTOCOL_VERSION,
    artifactId,
    artifactRef: `runtime-assembly:${artifactId}`,
    createdAt: createdAt.toISOString(),
    source: "runtime.architecture-components",
    request: {
      selectedComponentIds: requestedComponentIds
    },
    selection: {
      requestedComponentIds,
      includedComponentIds,
      requiredComponentIds,
      omittedComponentIds,
      unknownRequestedComponentIds
    },
    summary: {
      componentCount: includedComponentIds.length,
      hydratableComponentCount: selectedComponents.filter((component?: any) : any => component.hydratable !== false).length,
      requiredComponentCount: requiredComponentIds.length,
      omittedComponentCount: omittedComponentIds.length,
      runtimeProfile: runtimeProfile(context),
      featureCount: featureCount(context.features),
      mountCount: runtimeMountCount(context.runtime)
    },
    components: selectedComponents.map(sanitizeArchitectureComponent)
  };

  if (!context.userDataPath) {
    return result(503, {
      ok: false,
      error: "运行时数据目录不可用，无法写入装配清单。"
    });
  }
  const manifestText: any = `${JSON.stringify(manifest, null, 2)}\n`;
  const assemblyRoot: any = path.join(context.userDataPath, "runtime-assembly");
  const packageRoot: any = path.join(assemblyRoot, portableDirectoryName);
  await fs.mkdir(assemblyRoot, { recursive: true });
  await fs.writeFile(path.join(assemblyRoot, fileName), manifestText, "utf8");

  const packageFiles: any[] = [];
  packageFiles.push(await writePackageTextFile(packageRoot, "manifest.json", manifestText));
  packageFiles.push(await writePackageTextFile(packageRoot, "package.json", `${JSON.stringify({
    schemaVersion: "v0.0.1:schema:definition-1",
    packageKind: "meshrix.runtime-assembly.portable-directory",
    artifactId,
    artifactRef: manifest.artifactRef,
    createdAt: manifest.createdAt,
    protocolVersion: RUNTIME_ASSEMBLY_PROTOCOL_VERSION,
    entrypoint: "manifest.json",
    componentDirectory: "components",
    checksumFile: "checksums.sha256",
    componentCount: includedComponentIds.length,
    requiredComponentCount: requiredComponentIds.length,
    omittedComponentCount: omittedComponentIds.length
  }, null, 2)}\n`));
  for (const component of manifest.components) {
    const componentFile: any = `components/${safePackageSegment(component.componentId || component.moduleId)}.json`;
    packageFiles.push(await writePackageTextFile(packageRoot, componentFile, `${JSON.stringify(component, null, 2)}\n`));
  }
  packageFiles.push(await writePackageTextFile(packageRoot, "README.md", [
    "# Meshrix.js Runtime Assembly Portable Directory",
    "",
    "This directory is a portable runtime assembly evidence package generated from the current architecture component inventory.",
    "",
    "- `manifest.json` is the complete assembly manifest.",
    "- `components/` contains one normalized component record per included architecture component.",
    "- `checksums.sha256` records SHA-256 digests for every package file except itself.",
    "",
    "The package contains only public architecture and assembly metadata. It does not contain secrets, local absolute paths, bearer tokens, or decrypted client payloads.",
    ""
  ].join("\n")));
  const checksumText: any = `${packageFiles
    .map((file?: any) : any => `${file.sha256}  ${file.path}`)
    .sort()
    .join("\n")}\n`;
  const checksumFile: any = await writePackageTextFile(packageRoot, "checksums.sha256", checksumText);
  const packageByteSize: any = packageFiles.reduce((sum?: any, file?: any) : any => sum + file.byteSize, 0) + checksumFile.byteSize;
  const packageFileCount: any = packageFiles.length + 1;

  const operationResult: Record<string, any> = {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: RUNTIME_ASSEMBLY_PROTOCOL_VERSION,
    ok: true,
    artifact: {
      artifactId,
      artifactRef: manifest.artifactRef,
      fileName,
      byteSize: Buffer.byteLength(manifestText),
      createdAt: manifest.createdAt,
      componentCount: includedComponentIds.length,
      requiredComponentCount: requiredComponentIds.length,
      omittedComponentCount: omittedComponentIds.length,
      portableDirectoryName,
      portableManifestFileName,
      portablePackageMetadataFileName,
      portableChecksumFileName,
      portablePackageFileCount: packageFileCount,
      portablePackageByteSize: packageByteSize,
      portablePackageSha256: sha256Text(checksumText)
    },
    selection: manifest.selection,
    summary: manifest.summary
  };

  await publishProtocolEvent(
    context.protocolEventBus,
    "runtime.assembly",
    operationResult,
    { type: "runtime.assembly.built" }
  );

  return result(200, operationResult);
}

export async function executeStrategyManagementOperation({ operationId, input = {}, context }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  const handledOperations: any = new Set<any>([
    "strategy.describe",
    "strategy.workflow_policy.evaluate",
    "strategy.agent_policy.evaluate",
    "strategy.route_policy.evaluate",
    "strategy.queue_policy.evaluate",
    "strategy.tool_policy.preview"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }
  const { strategyManagementProvider, error } = requireStrategyManagementProvider(context);
  if (error) {
    return error;
  }
  if (id === "strategy.describe") {
    return result(200, strategyManagementProvider.describe());
  }
  if (id === "strategy.workflow_policy.evaluate") {
    return result(200, strategyManagementProvider.evaluateWorkflowPolicy(input));
  }
  if (id === "strategy.agent_policy.evaluate") {
    return result(200, strategyManagementProvider.evaluateAgentPolicy(input));
  }
  if (id === "strategy.route_policy.evaluate") {
    return result(200, strategyManagementProvider.evaluateRoutePolicy(input));
  }
  if (id === "strategy.queue_policy.evaluate") {
    return result(200, strategyManagementProvider.evaluateQueuePolicy(input));
  }
  if (id === "strategy.tool_policy.preview") {
    return result(200, {
      schemaVersion: "v0.0.1:schema:definition-1",
      decision: await strategyManagementProvider.evaluateToolPolicy(input)
    });
  }
  return null;
}

export async function executeSecurityAlertsOperation({ operationId, input = {}, context = {} }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  if (!id.startsWith("security_alerts.")) {
    return null;
  }
  const store: any = securityAlertStoreFor(context);
  if (id === "security_alerts.list") {
    return result(200, {
      protocolVersion: store.protocolVersion,
      alerts: store.listAlerts(input)
    });
  }
  if (id === "security_alerts.ack") {
    const actor: any = input.acknowledgedBy || input["acknowledged-by"] || context.authSession?.user?.username || "operator";
    const ack: any = store.transitionAlert(input.alertId || input["alert-id"] || input.id, "acknowledge", {
      actor
    });
    return result(ack.ok ? 200 : ack.status || 400, ack);
  }
  if (id === "security_alerts.export") {
    return result(200, {
      export: store.exportRedacted(input)
    });
  }
  if (id === "security_alerts.prune") {
    return result(200, {
      prune: store.pruneAlerts(input)
    });
  }
  return result(404, {
    ok: false,
    error: "Security alerts operation is not registered."
  });
}

export async function executeRuntimeMountOperation({ operationId, input = {}, context }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  const handledOperations: any = new Set<any>([
    "runtime.assembly.build",
    "runtime.gateway_channels",
    "runtime.gateway_channels.select",
    "runtime.mounts",
    "runtime.set_mounts",
    "runtime.reload_mounts"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }

  if (id === "runtime.assembly.build") {
    return buildRuntimeAssemblyPackage({ input, context });
  }

  if (id === "runtime.gateway_channels" || id === "runtime.gateway_channels.select") {
    const router: any = context.gatewayChannelRouter;
    if (!router || typeof router.snapshot !== "function" || typeof router.select !== "function") {
      return result(503, { ok: false, error: { code: "gateway_channel_router_unavailable" } });
    }
    if (!context.authSession?.user) {
      return result(403, { ok: false, error: { code: "gateway_channel_console_session_required" } });
    }
    if (id === "runtime.gateway_channels") {
      return result(200, { ok: true, ...router.snapshot() });
    }
    const fields: any[] = Object.keys(input || {});
    if (fields.some((field?: any) : any => !["direction", "channelId", "expectedGeneration"].includes(field))) {
      return result(400, { ok: false, error: { code: "gateway_channel_selection_input_invalid" } });
    }
    const direction: any = input.direction;
    const channelId: any = typeof input.channelId === "string" ? input.channelId.trim() : "";
    const expectedGeneration: any = input.expectedGeneration;
    if (!['downstream', 'upstream'].includes(direction) || !channelId || channelId.length > 128 ||
        !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      return result(400, { ok: false, error: { code: "gateway_channel_selection_input_invalid" } });
    }
    const before: any = router.snapshot();
    if (before.selections?.[direction]?.generation !== expectedGeneration) {
      return result(409, { ok: false, error: { code: "gateway_channel_selection_stale" }, ...before });
    }
    try {
      const selected: any = router.select({ direction, channelId, source: GATEWAY_CHANNEL_SELECTION_SOURCE });
      const after: any = router.snapshot();
      await publishProtocolEvent(
        context.protocolEventBus,
        "runtime.gateway_channels",
        { direction: selected.direction, channelId: selected.channelId, generation: selected.generation },
        { type: "runtime.gateway_channels.selected" }
      );
      return result(200, { ok: true, selected, ...after });
    } catch (error: any) {
      const code: any = String(error?.message || "gateway_channel_selection_failed");
      const current: any = router.snapshot();
      return result(code === "gateway_selected_channel_unavailable" ? 409 : 400, {
        ok: false,
        error: { code },
        ...current
      });
    }
  }

  const moduleManagement: any = context.moduleManagement;
  if (!moduleManagement) {
    return result(503, { error: "模块管理 provider 不可用。" });
  }

  if (id === "runtime.mounts") {
    return result(200, await moduleManagement.getMountsSnapshot({
      features: context.features,
      listAvailableAnalysisModules: context.consoleDomainServices?.listAvailableAnalysisModules
    }));
  }

  if (id === "runtime.set_mounts") {
    const roots: any = createPathBrowserRoots({
      userDataPath: context.userDataPath,
      distPath: context.distPath
    });
    const operationResult: any = await moduleManagement.setMounts(resolvePathBrowserVirtualValue(input?.value || input, roots));
    if (operationResult.ok === false) {
      const { statusCode = 400, ...payload } = operationResult;
      return result(statusCode, payload);
    }
    await publishProtocolEvent(
      context.protocolEventBus,
      "runtime.mounts",
      operationResult,
      { type: "runtime.mounts.updated" }
    );
    return result(200, operationResult);
  }

  if (id === "runtime.reload_mounts") {
    const operationResult: any = await moduleManagement.reloadMounts(input);
    if (operationResult.ok === false) {
      const { statusCode = 400, ...payload } = operationResult;
      return result(statusCode, payload);
    }
    await publishProtocolEvent(
      context.protocolEventBus,
      "runtime.mounts",
      operationResult,
      { type: "runtime.mounts.reloaded" }
    );
    return result(200, operationResult);
  }

  return null;
}


export async function executeContextRuntimeOperation({ operationId, input, context }: Record<string, any>) : Promise<any> {
  if (!String(operationId || "").startsWith("context.")) {
    return null;
  }
  const contextRuntime: any = context.contextRuntime;
  if (operationId === "context.profiles.get") {
    const { method, error } = requireRuntimeMethod(contextRuntime, "listProfiles", "上下文运行时不可用。");
    if (error) return error;
    return result(200, await method());
  }
  if (operationId === "context.profiles.set") {
    const { method, error } = requireRuntimeMethod(contextRuntime, "saveProfiles", "上下文运行时不可用。");
    if (error) return error;
    return result(200, await method(input));
  }
  if (operationId === "context.preview") {
    const { method, error } = requireRuntimeMethod(contextRuntime, "preview", "上下文预览运行时不可用。");
    if (error) return error;
    const workspaceApplied: any = applyWorkspaceRuntimeContext(
      input,
      context.agentWorkspace,
      workspaceAccessOptions(context.authSession)
    );
    if (workspaceApplied.workspaceError) {
      return result(workspaceApplied.workspaceError.status, {
        error: workspaceApplied.workspaceError.error
      });
    }
    return result(200, await method(workspaceApplied.input));
  }
  if (operationId === "context.compaction.preview") {
    const { method, error } = requireRuntimeMethod(contextRuntime, "previewCompaction", "上下文压缩预览运行时不可用。");
    if (error) return error;
    return result(200, await method(input));
  }
  if (operationId === "context.compaction.run") {
    const { method, error } = requireRuntimeMethod(contextRuntime, "runCompaction", "上下文压缩运行时不可用。");
    if (error) return error;
    return result(200, await method(input));
  }
  if (operationId === "context.compaction.records") {
    const { method, error } = requireRuntimeMethod(contextRuntime, "listCompactionRecords", "上下文压缩记录不可用。");
    if (error) return error;
    return result(200, await method({
      limit: Number(input.limit || 50)
    }));
  }
  if (operationId === "context.session_memory.get") {
    const { method, error } = requireRuntimeMethod(contextRuntime, "listSessionMemory", "上下文会话记忆不可用。");
    if (error) return error;
    return result(200, await method({
      limit: Number(input.limit || 50),
      sessionId: input.sessionId || input["session-id"] || "",
      profileId: input.profileId || input["profile-id"] || ""
    }));
  }
  if (operationId === "context.session_memory.clear") {
    const { method, error } = requireRuntimeMethod(contextRuntime, "clearSessionMemory", "上下文会话记忆不可用。");
    if (error) return error;
    return result(200, await method(input));
  }
  if (operationId === "context.build_records") {
    const { method, error } = requireRuntimeMethod(contextRuntime, "listBuildRecords", "上下文编译记录不可用。");
    if (error) return error;
    return result(200, await method({
      limit: Number(input.limit || 50)
    }));
  }
  if (operationId === "context.evaluation.runs.create") {
    const { method, error } = requireRuntimeMethod(contextRuntime, "runEvaluation", "上下文 replay 评估不可用。");
    if (error) return error;
    return result(201, await method(input));
  }
  return null;
}

export async function executeWorkspaceGovernanceOperation({ operationId, input, context }: Record<string, any>) : Promise<any> {
  if (!String(operationId || "").startsWith("workspace_governance.")) {
    return null;
  }
  const governance: any = workspaceGovernanceRegistryFor(context);
  if (operationId === "workspace_governance.describe") {
    return result(200, await governance.describe());
  }
  if (operationId === "workspace_governance.policy.set") {
    try {
      return result(200, await governance.upsertPolicy(input.policy || input));
    } catch (error: any) {
      return result(400, errorPayload(error, "Workspace governance policy update failed."));
    }
  }
  if (operationId === "workspace_governance.evaluate") {
    try {
      return result(200, await governance.evaluate(input));
    } catch (error: any) {
      return result(400, errorPayload(error, "Workspace governance evaluation failed."));
    }
  }
  if (operationId === "workspace_governance.share_grant") {
    try {
      return result(200, await governance.createShareGrant(input));
    } catch (error: any) {
      return result(400, errorPayload(error, "Workspace governance share grant failed."));
    }
  }
  return null;
}

export async function executeProtocolFacadeOperation({ operationId, input = {} }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  void input;
  void id;
  return null;
}
