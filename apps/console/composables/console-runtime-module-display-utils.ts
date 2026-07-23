import type { ServerConsoleState } from "../lib/types";

type RuntimeMount = ServerConsoleState["runtime"]["mounts"][number];

export type RuntimeModuleRow = {
  name: string;
  label: string;
  description: string;
  modulePath: string;
  configuredPath: string;
  runtimeMount: RuntimeMount | undefined;
  externalEnabled: boolean;
  pathHint: string;
};

export function moduleCapabilityText(item: RuntimeModuleRow) {
  const mount = item.runtimeMount;

  if (!mount) {
    return "未加载运行实例";
  }

  const capabilities = [
    mount.supportsStructuredDocument ? "结构化文档" : "",
    mount.supportsTextExtraction ? "文本提取" : "",
    mount.supportsBatchHook ? "批次回调" : "",
  ].filter(Boolean);

	  return capabilities.length > 0 ? capabilities.join("，") : "基础运行";
}

export function moduleStatusText(item: RuntimeModuleRow) {
  if (!item.runtimeMount) {
    return item.configuredPath ? "等待重载" : "未加载运行实例";
  }

  if (item.runtimeMount.enabled === false) {
    const reason = String(item.runtimeMount.reason || "").trim();
    return !reason || reason === "disabled" ? "已禁用" : reason;
  }

  return "可用";
}

export function moduleAvailabilityLabel(item: RuntimeModuleRow) {
  return item.runtimeMount?.enabled === false || !item.externalEnabled ? "不可用" : "可用";
}

export function currentModulePathPlaceholder(item: RuntimeModuleRow) {
  return item.pathHint || "填写外置模块 .mjs 路径";
}
