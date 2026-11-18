export type ReadonlyValue<T> = {
  readonly value: T;
};

export function shortId(value: string | number | null | undefined, prefix: any = 6, suffix: any = 4) : any {
  const text: any = String(value ?? "").trim();
  if (!text || text.length <= prefix + suffix + 1) {
    return text;
  }
  return `${text.slice(0, prefix)}...${text.slice(-suffix)}`;
}

export function compactLogDetail(parts: Array<string | number | boolean | null | undefined>) : any {
  return parts
    .map((item?: any) : any => String(item ?? "").trim())
    .filter(Boolean)
	    .join("，");
}

export function genericStatusTone(status: string) : any {
  const normalized: any = String(status || "").toLowerCase();
  if (["failed", "error", "denied", "unauthorized", "critical", "interrupted", "blocked"].some((item?: any) : any => normalized.includes(item))) {
    return "danger";
  }
  if (["warning", "warn", "pending", "queued", "stale", "awaiting"].some((item?: any) : any => normalized.includes(item))) {
    return "warning";
  }
  if (["success", "ok", "completed", "allowed", "available", "active", "running", "recovered"].some((item?: any) : any => normalized.includes(item))) {
    return "success";
  }
  return "info";
}

export function stateProgressPercent(status: string) : any {
  const normalized: any = String(status || "").toLowerCase();
  if (["completed", "success", "ok", "closed", "available", "recovered"].some((item?: any) : any => normalized.includes(item))) {
    return 100;
  }
  if (["running", "active", "allowed"].some((item?: any) : any => normalized.includes(item))) {
    return 80;
  }
  if (["queued", "pending", "awaiting"].some((item?: any) : any => normalized.includes(item))) {
    return 20;
  }
  if (["failed", "error", "interrupted", "critical", "denied"].some((item?: any) : any => normalized.includes(item))) {
    return 0;
  }
  return 50;
}
