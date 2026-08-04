export function formatCompactDate(value: string) : any {
  if (!value) {
    return "未记录";
  }

  try {
    return new Date(value).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return value;
  }
}

export function parseFilterDate(value: string, boundary: "start" | "end") : any {
  if (!value) {
    return 0;
  }
  const suffix: any = boundary === "start" ? "T00:00:00" : "T23:59:59";
  const time: any = new Date(`${value}${suffix}`).getTime();
  return Number.isFinite(time) ? time : 0;
}

function padDatePart(value: number) : any {
  return String(value).padStart(2, "0");
}

export function formatMachineDate(value: string, mode: "compact" | "full") : any {
  if (!value) {
    return "未记录";
  }
  const date: any = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const month: any = padDatePart(date.getMonth() + 1);
  const day: any = padDatePart(date.getDate());
  const hour: any = padDatePart(date.getHours());
  const minute: any = padDatePart(date.getMinutes());
  if (mode === "compact") {
    return `${month}-${day} ${hour}:${minute}`;
  }
  return [
    date.getFullYear(),
    month,
    day,
  ].join("-") + ` ${hour}:${minute}:${padDatePart(date.getSeconds())}`;
}

export function csvCell(value: unknown) : any {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function jsonPreview(value: unknown) : any {
  return JSON.stringify(value ?? {}, null, 2);
}

export function safeDownloadName(value: string, fallback: any = "export") : any {
  const normalized: any = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return normalized || fallback;
}

export function formatBytes(value: unknown) : any {
  const bytes: any = Number(value || 0);
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

export function parseTime(value?: string) : any {
  if (!value) {
    return 0;
  }

  const time: any = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function formatDate(value: string) : any {
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

export function formatDuration(start?: string, end?: string) : any {
  const startedAt: any = parseTime(start);
  const endedAt: any = parseTime(end) || Date.now();

  if (!startedAt || endedAt <= startedAt) {
    return "--";
  }

  let totalSeconds: any = Math.floor((endedAt - startedAt) / 1000);
  const days: any = Math.floor(totalSeconds / 86400);
  totalSeconds -= days * 86400;
  const hours: any = Math.floor(totalSeconds / 3600);
  totalSeconds -= hours * 3600;
  const minutes: any = Math.floor(totalSeconds / 60);
  const seconds: any = totalSeconds - minutes * 60;

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
