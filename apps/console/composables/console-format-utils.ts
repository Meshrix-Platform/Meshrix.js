import type { SplitJobStatus } from "../lib/types";
export { formatCompactDate } from "@lico/ui-console/console-format-utils";

export function parseFilterDate(value: string, boundary: "start" | "end") {
  if (!value) {
    return 0;
  }
  const suffix = boundary === "start" ? "T00:00:00" : "T23:59:59";
  const time = new Date(`${value}${suffix}`).getTime();
  return Number.isFinite(time) ? time : 0;
}

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

export function formatMachineDate(value: string, mode: "compact" | "full") {
  if (!value) {
    return "未记录";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());
  const hour = padDatePart(date.getHours());
  const minute = padDatePart(date.getMinutes());
  if (mode === "compact") {
    return `${month}-${day} ${hour}:${minute}`;
  }
  return [
    date.getFullYear(),
    month,
    day,
  ].join("-") + ` ${hour}:${minute}:${padDatePart(date.getSeconds())}`;
}

export function csvCell(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function jsonPreview(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

export function safeDownloadName(value: string, fallback = "export") {
  const normalized = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return normalized || fallback;
}

export function formatBytes(value: unknown) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function parseTime(value?: string) {
  if (!value) {
    return 0;
  }

  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function formatDate(value: string) {
  if (!value) {
    return "未记录";
  }

  try {
    return new Date(value).toLocaleString("zh-CN", {
      hour12: false,
    });
  } catch {
    return value;
  }
}

export function formatDuration(start?: string, end?: string) {
  const startedAt = parseTime(start);
  const endedAt = parseTime(end) || Date.now();

  if (!startedAt || endedAt <= startedAt) {
    return "--";
  }

  let totalSeconds = Math.floor((endedAt - startedAt) / 1000);
  const days = Math.floor(totalSeconds / 86400);
  totalSeconds -= days * 86400;
  const hours = Math.floor(totalSeconds / 3600);
  totalSeconds -= hours * 3600;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

export function jobStatusTone(status: SplitJobStatus) {
  return status;
}
