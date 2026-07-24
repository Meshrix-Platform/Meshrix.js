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
} from "./shared.mjs";
import { createPathBrowserRoots, resolvePathBrowserVirtualValue } from "./path-browser.mjs";
import { applyWorkspaceRuntimeContext } from "./workspace-runtime-helpers.mjs";
import {
  securityAlertStoreFor,
  workspaceGovernanceRegistryFor
} from "./registry-services.mjs";

const RUNTIME_ASSEMBLY_PROTOCOL_VERSION = "v0.0.1:release:runtime-assembly-package-1";

function stringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function componentKey(component = {}) {
  return String(component.componentId || component.moduleId || "").trim();
}

function componentLookupKeys(component = {}) {
  return [
    component.componentId,
    component.moduleId
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

function requiredAssemblyComponent(component = {}) {
  return component.hydratable === false || String(component.hydration || "").toLowerCase() === "essential";
}

function sanitizeArchitectureComponent(component = {}) {
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

function featureCount(features = null) {
  if (Array.isArray(features?.activeFeatures)) {
    return features.activeFeatures.length;
  }
  if (Array.isArray(features?.activeFeatureIds)) {
    return features.activeFeatureIds.length;
  }
  return 0;
}

function runtimeMountCount(runtime = null) {
  return Object.keys(runtime?.mounts || {}).length;
}

function runtimeProfile(context = {}) {
  return String(context.runtime?.runtimeOptions?.profile || "");
}

function artifactTimestampSegment(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 16).toLowerCase();
}

function safePackageSegment(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "component";
}

function sha256Text(value = "") {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

async function writePackageTextFile(packageRoot, relativePath, text) {
  const normalizedRelativePath = relativePath.split(path.sep).join("/");
  const targetPath = path.join(packageRoot, ...normalizedRelativePath.split("/"));
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, text, "utf8");
  return {
    path: normalizedRelativePath,
    byteSize: Buffer.byteLength(text, "utf8"),
    sha256: sha256Text(text)
  };
}

async function loadArchitectureInventory(context = {}) {
  if (typeof context.moduleManagement?.getArchitectureComponentInventory === "function") {
    return context.moduleManagement.getArchitectureComponentInventory();
  }
  if (typeof context.consoleDomainServices?.buildRuntimeConsoleSummary === "function") {
    const summary = await context.consoleDomainServices.buildRuntimeConsoleSummary({
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

async function buildRuntimeAssemblyPackage({ input = {}, context = {} } = {}) {
  const inventory = await loadArchitectureInventory(context);
  const allComponents = Array.isArray(inventory?.allComponents) ? inventory.allComponents : [];
  if (allComponents.length === 0) {
    return result(409, {
      ok: false,
      error: "当前运行时没有可装配的架构组件。"
    });
  }

  const requestedComponentIds = stringArray(input.selectedComponentIds || input.componentIds || input.components);
  const componentById = new Map();
  for (const component of allComponents) {
    for (const key of componentLookupKeys(component)) {
      componentById.set(key, component);
    }
  }

  const selectedComponents = [];
  const selectedKeySet = new Set();
  for (const componentId of requestedComponentIds) {
    const component = componentById.get(componentId);
    const key = componentKey(component);
    if (component && key && !selectedKeySet.has(key)) {
      selectedKeySet.add(key);
      selectedComponents.push(component);
    }
  }

  const requiredComponents = allComponents.filter(requiredAssemblyComponent);
  for (const component of requiredComponents) {
    const key = componentKey(component);
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

  const includedComponentIds = selectedComponents.map(componentKey).filter(Boolean);
  const includedIdSet = new Set(includedComponentIds);
  const requiredComponentIds = requiredComponents.map(componentKey).filter(Boolean);
  const unknownRequestedComponentIds = requestedComponentIds.filter((componentId) => !componentById.has(componentId));
  const omittedComponentIds = allComponents
    .map(componentKey)
    .filter((componentId) => componentId && !includedIdSet.has(componentId));
  const createdAt = new Date();
  const randomSegment = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const artifactId = `runtime-assembly-${artifactTimestampSegment(createdAt)}-${randomSegment}`;
  const fileName = `${artifactId}.json`;
  const portableDirectoryName = `${artifactId}-portable`;
  const portableManifestFileName = `${portableDirectoryName}/manifest.json`;
  const portablePackageMetadataFileName = `${portableDirectoryName}/package.json`;
  const portableChecksumFileName = `${portableDirectoryName}/checksums.sha256`;
  const manifest = {
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
      hydratableComponentCount: selectedComponents.filter((component) => component.hydratable !== false).length,
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
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const assemblyRoot = path.join(context.userDataPath, "runtime-assembly");
  const packageRoot = path.join(assemblyRoot, portableDirectoryName);
  await fs.mkdir(assemblyRoot, { recursive: true });
  await fs.writeFile(path.join(assemblyRoot, fileName), manifestText, "utf8");

  const packageFiles = [];
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
    const componentFile = `components/${safePackageSegment(component.componentId || component.moduleId)}.json`;
    packageFiles.push(await writePackageTextFile(packageRoot, componentFile, `${JSON.stringify(component, null, 2)}\n`));
  }
  packageFiles.push(await writePackageTextFile(packageRoot, "README.md", [
    "# Meshrix Runtime Assembly Portable Directory",
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
  const checksumText = `${packageFiles
    .map((file) => `${file.sha256}  ${file.path}`)
    .sort()
    .join("\n")}\n`;
  const checksumFile = await writePackageTextFile(packageRoot, "checksums.sha256", checksumText);
  const packageByteSize = packageFiles.reduce((sum, file) => sum + file.byteSize, 0) + checksumFile.byteSize;
  const packageFileCount = packageFiles.length + 1;

  const operationResult = {
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

export async function executeStrategyManagementOperation({ operationId, input = {}, context }) {
  const id = String(operationId || "");
  const handledOperations = new Set([
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

export async function executeSecurityAlertsOperation({ operationId, input = {}, context = {} }) {
  const id = String(operationId || "");
  if (!id.startsWith("security_alerts.")) {
    return null;
  }
  const store = securityAlertStoreFor(context);
  if (id === "security_alerts.list") {
    return result(200, {
      protocolVersion: store.protocolVersion,
      alerts: store.listAlerts(input)
    });
  }
  if (id === "security_alerts.ack") {
    const actor = input.acknowledgedBy || input["acknowledged-by"] || context.authSession?.user?.username || "operator";
    const ack = store.transitionAlert(input.alertId || input["alert-id"] || input.id, "acknowledge", {
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

export async function executeRuntimeMountOperation({ operationId, input = {}, context }) {
  const id = String(operationId || "");
  const handledOperations = new Set([
    "runtime.assembly.build",
    "runtime.mounts",
    "runtime.set_mounts",
    "runtime.reload_mounts",
    "runtime.external_gateway",
    "runtime.external_gateway.validate",
    "runtime.external_gateway.apply",
    "runtime.external_gateway.switch_direct"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }

  if (id === "runtime.assembly.build") {
    return buildRuntimeAssemblyPackage({ input, context });
  }

  if (id.startsWith("runtime.external_gateway")) {
    const management = context.externalGatewayManagement;
    if (!management) return result(503, { error: "外置网关管理 provider 不可用。" });
    if (id === "runtime.external_gateway") {
      return result(200, {
        ...management.getState(),
        availableAdapters: typeof management.listAdapters === "function" ? management.listAdapters() : []
      });
    }
    const operationResult = id === "runtime.external_gateway.validate"
      ? await management.validate(input)
      : id === "runtime.external_gateway.apply"
        ? await management.apply(input)
        : await management.switchDirect(input);
    return result(operationResult.ok === false ? 400 : 200, operationResult);
  }

  const moduleManagement = context.moduleManagement;
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
    const roots = createPathBrowserRoots({
      userDataPath: context.userDataPath,
      distPath: context.distPath
    });
    const operationResult = await moduleManagement.setMounts(resolvePathBrowserVirtualValue(input?.value || input, roots));
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
    const operationResult = await moduleManagement.reloadMounts(input);
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


export async function executeMaintenanceAgentOperation({ operationId, input = {}, context }) {
  const id = String(operationId || "");
  const handledOperations = new Set([
    "maintenance_agent.config.get",
    "maintenance_agent.config.set",
    "maintenance_agent.chat",
    "maintenance_agent.runs.create",
    "maintenance_agent.runs.list",
    "maintenance_agent.runs.get",
    "maintenance_agent.runs.approve",
    "maintenance_agent.runs.cancel"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }

  const maintenanceAgent = context.maintenanceAgent;
  if (!maintenanceAgent) {
    return result(503, { error: "维护智能体模块不可用。" });
  }
  const authSession = context.authSession || null;
  try {
    if (id === "maintenance_agent.config.get") {
      return result(200, await maintenanceAgent.getConfig());
    }
    if (id === "maintenance_agent.config.set") {
      return result(200, await maintenanceAgent.setConfig(input.config || input.value || input, {
        authSession
      }));
    }
    if (id === "maintenance_agent.chat") {
      return result(200, await maintenanceAgent.chat(input, { authSession }));
    }
    if (id === "maintenance_agent.runs.list") {
      return result(200, await maintenanceAgent.listRuns({
        limit: Number(input.limit || 50)
      }));
    }
    if (id === "maintenance_agent.runs.create") {
      return result(200, await maintenanceAgent.startRun(input, { authSession }));
    }
    if (id === "maintenance_agent.runs.get") {
      const runId = String(input.runId || input["run-id"] || input.id || "").trim();
      const run = await maintenanceAgent.getRun(runId);
      if (!run) {
        return result(404, { error: "维护运行不存在。" });
      }
      return result(200, { run });
    }
    if (id === "maintenance_agent.runs.approve") {
      const runId = String(input.runId || input["run-id"] || input.id || "").trim();
      const run = await maintenanceAgent.approveRun(runId, input, { authSession });
      if (!run) {
        return result(404, { error: "维护运行不存在。" });
      }
      return result(200, { run });
    }
    if (id === "maintenance_agent.runs.cancel") {
      const runId = String(input.runId || input["run-id"] || input.id || "").trim();
      const run = await maintenanceAgent.cancelRun(runId, input, { authSession });
      if (!run) {
        return result(404, { error: "维护运行不存在。" });
      }
      return result(200, { run });
    }
  } catch (error) {
    const status = id === "maintenance_agent.runs.approve" ? 409 : 400;
    const fallbackByOperation = {
      "maintenance_agent.config.set": "维护智能体配置保存失败。",
      "maintenance_agent.chat": "维护智能体对话失败。",
      "maintenance_agent.runs.create": "维护智能体运行创建失败。",
      "maintenance_agent.runs.approve": "维护运行审批失败。",
      "maintenance_agent.runs.cancel": "维护运行取消失败。"
    };
    return result(status, errorPayload(error, fallbackByOperation[id] || "维护智能体操作失败。"));
  }

  return null;
}


export async function executeContextRuntimeOperation({ operationId, input, context }) {
  if (!String(operationId || "").startsWith("context.")) {
    return null;
  }
  const contextRuntime = context.contextRuntime;
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
    const workspaceApplied = applyWorkspaceRuntimeContext(
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

export async function executeWorkspaceGovernanceOperation({ operationId, input, context }) {
  if (!String(operationId || "").startsWith("workspace_governance.")) {
    return null;
  }
  const governance = workspaceGovernanceRegistryFor(context);
  if (operationId === "workspace_governance.describe") {
    return result(200, await governance.describe());
  }
  if (operationId === "workspace_governance.policy.set") {
    try {
      return result(200, await governance.upsertPolicy(input.policy || input));
    } catch (error) {
      return result(400, errorPayload(error, "Workspace governance policy update failed."));
    }
  }
  if (operationId === "workspace_governance.evaluate") {
    try {
      return result(200, await governance.evaluate(input));
    } catch (error) {
      return result(400, errorPayload(error, "Workspace governance evaluation failed."));
    }
  }
  if (operationId === "workspace_governance.share_grant") {
    try {
      return result(200, await governance.createShareGrant(input));
    } catch (error) {
      return result(400, errorPayload(error, "Workspace governance share grant failed."));
    }
  }
  return null;
}

export async function executeProtocolFacadeOperation({ operationId, input = {} }) {
  const id = String(operationId || "");
  void input;
  void id;
  return null;
}
