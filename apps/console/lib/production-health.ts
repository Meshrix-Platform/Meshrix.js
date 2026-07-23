import { getProductionHealth } from "./production-health-client";
import type { ProductionHealthGate, ProductionHealthResponse, ReadinessBaselineStatus } from "./types";

type ProductionHealthSnapshot = {
  health?: ProductionHealthResponse;
  loadError?: string;
};

const statusLabels: Record<string, string> = {
  pass: "通过",
  fail: "失败",
  timeout: "超时",
  blocked: "阻塞",
  missing: "缺失",
  partial: "部分",
  warning: "预警",
  unknown: "未知",
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function statusLabel(status: string) {
  return statusLabels[status] || status || "未知";
}

export function statusTone(status: string) {
  if (status === "pass") return "success";
  if (status === "fail" || status === "timeout" || status === "blocked") return "danger";
  if (status === "missing" || status === "partial" || status === "warning") return "warning";
  return "neutral";
}

export function formatDateTime(value: string) {
  if (!value) return "未生成";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function elapsedText(gate: ProductionHealthGate) {
  const ms = Number(gate.commandSummary?.elapsedMs || 0);
  if (!ms) return "0ms";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
}

export async function loadProductionHealthSnapshot(): Promise<ProductionHealthSnapshot> {
  try {
    return { health: await getProductionHealth() };
  } catch (error) {
    return {
      loadError: errorMessage(error),
    };
  }
}

export type { ProductionHealthGate, ProductionHealthResponse, ReadinessBaselineStatus };
