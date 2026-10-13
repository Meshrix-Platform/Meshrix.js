import { createHash } from "node:crypto";

export function text(value: unknown = ""): string {
  return String(value ?? "").trim();
}

export function asArray<T = unknown>(value?: T | readonly T[] | null): T[] {
  if (Array.isArray(value)) return [...value] as T[];
  if (value === undefined || value === null || value === "") return [];
  return [value as T];
}

export function object(value: unknown = {}): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

export function hash(value: unknown = "", length = 24): string {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
}

export function sha256Base64Url(value: unknown): string {
  return createHash("sha256").update(String(value)).digest("base64url");
}

export function normalizeRisk(value?: unknown): "read_only" | "safe_write" | "repair_write" | "destructive" {
  const risk = text(value || "safe_write");
  return ["read_only", "safe_write", "repair_write", "destructive"].includes(risk)
    ? risk as "read_only" | "safe_write" | "repair_write" | "destructive"
    : "safe_write";
}

export function safePublicToolSegment(value?: unknown): string {
  return text(value).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "service";
}

export function normalizeTrafficPolicy(input: Record<string, any> = {}) {
  const source = object(input.trafficPolicy || input.rateLimit);
  const perMinute = Math.max(1, Math.min(Number(source.perMinute || input.perMinute || 120), 10_000));
  const burst = Math.max(1, Math.min(Number(source.burst || input.burst || 30), 10_000));
  return {
    algorithm: "token_bucket_with_concurrency",
    routingAlgorithm: "weighted_endpoint_round_robin_with_circuit_breaker",
    perMinute,
    burst,
    maxConcurrent: Math.max(1, Math.min(Number(
      source.maxConcurrent || source.concurrency || source.concurrent || input.maxConcurrent || input.concurrency || burst
    ), 10_000))
  };
}
