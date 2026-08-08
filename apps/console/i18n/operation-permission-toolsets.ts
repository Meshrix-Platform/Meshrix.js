import { currentConsoleLocale, resolveEffectiveConsoleLocale } from "./console-locale-state";

const toolsetNames: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  "meshrix.admin": ["Meshrix.js 管理", "Meshrix.js admin"],
  "meshrix.agent.sync.publish": ["智能体同步发布", "Agent sync publish"],
  "meshrix.agent.workspace": ["智能体工作空间", "Agent workspace"],
  "meshrix.agent.workspace.maintain": ["智能体工作空间维护", "Agent workspace maintain"],
  "meshrix.agent.workspace.read": ["智能体工作空间读取", "Agent workspace read"],
  "meshrix.authorization.admin": ["授权管理", "Authorization admin"],
  "meshrix.console.read": ["控制台读取", "Console read"],
  "meshrix.gateway.admin": ["网关管理", "Gateway admin"],
  "meshrix.gateway.maintain": ["网关维护", "Gateway maintenance"],
  "meshrix.gateway.read": ["网关读取", "Gateway read"],
  "meshrix.gateway.write": ["网关写入", "Gateway write"],
  "meshrix.jobs.read": ["任务读取", "Jobs read"],
  "meshrix.jobs.write": ["任务操作", "Jobs operate"],
  "meshrix.maintenance.maintain": ["维护智能体维护", "Maintenance Agent maintain"],
  "meshrix.maintenance.read": ["维护智能体读取", "Maintenance Agent read"],
  "meshrix.maintenance.run": ["维护智能体运行", "Maintenance Agent run"],
  "meshrix.model.call": ["模型调用", "Model calls"],
  "meshrix.mount.dev": ["挂载开发", "Mount development"],
  "meshrix.result.export": ["结果导出", "Result export"],
  "meshrix.runtime.maintain": ["运行时维护", "Runtime maintain"],
  "meshrix.runtime.read": ["运行时读取", "Runtime read"],
  "meshrix.storage.read": ["存储读取", "Storage read"],
  "meshrix.storage.write": ["存储写入", "Storage write"],
  "meshrix.uploads.write": ["上传写入", "Uploads write"],
});

export function operationPermissionToolsetName(toolsetId: string, fallback = ""): string {
  const name = toolsetNames[String(toolsetId || "")];
  if (!name) return fallback || String(toolsetId || "");
  return resolveEffectiveConsoleLocale(currentConsoleLocale.value) === "en" ? name[1] : name[0];
}
