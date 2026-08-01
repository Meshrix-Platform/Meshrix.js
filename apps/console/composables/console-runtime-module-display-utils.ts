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

export function moduleCapabilityText(item: RuntimeModuleRow) : any {
  const mount: any = item.runtimeMount;

  if (!mount) {
    return "未加载运行实例";
  }

  const capabilities: any = [
    mount.supportsStructuredDocument ? "结构化文档" : "",
    mount.supportsTextExtraction ? "文本提取" : "",
    mount.supportsBatchHook ? "批次回调" : "",
  ].filter(Boolean);

	  return capabilities.length > 0 ? capabilities.join("，") : "基础运行";
}

export function moduleStatusText(item: RuntimeModuleRow) : any {
  if (!item.runtimeMount) {
    return item.configuredPath ? "等待重载" : "未加载运行实例";
  }

  if (item.runtimeMount.enabled === false) {
    const reason: any = String(item.runtimeMount.reason || "").trim();
    return !reason || reason === "disabled" ? "已禁用" : reason;
  }

  return "可用";
}

export function moduleAvailabilityLabel(item: RuntimeModuleRow) : any {
  return item.runtimeMount?.enabled === false || !item.externalEnabled ? "不可用" : "可用";
}

export function moduleAvailabilityTone(item: RuntimeModuleRow) : any {
  return moduleAvailabilityLabel(item) === "可用" ? "success" : "warning";
}

export function currentModulePathPlaceholder(item: RuntimeModuleRow) : any {
  return item.pathHint || "填写外置模块 .ts 路径";
}
