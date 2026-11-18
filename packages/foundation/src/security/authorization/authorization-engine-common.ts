import crypto from "node:crypto";

const RISK_RANK: Readonly<Record<string, number>> = Object.freeze({
  read_only: 0,
  safe_write: 1,
  repair_write: 2,
  destructive: 3
});

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomId(prefix?: unknown): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function uniqueStrings(values: readonly unknown[] = []): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function stringSet(values: readonly unknown[] = []): Set<string> {
  return new Set(uniqueStrings(values));
}

export function objectOrNull(value?: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

export function stringsFrom(...values: unknown[]): string[] {
  const output: unknown[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      output.push(...value);
    } else if (typeof value === "string" && value.includes(",")) {
      output.push(...value.split(","));
    } else if (value !== undefined && value !== null) {
      output.push(value);
    }
  }
  return uniqueStrings(output);
}

export function deniedOutsideAllowed(
  values: readonly unknown[] = [],
  allowedValues: readonly unknown[] | ReadonlySet<string> = []
): string {
  const allowed: ReadonlySet<string> = Array.isArray(allowedValues)
    ? stringSet(allowedValues)
    : allowedValues as ReadonlySet<string>;
  return stringsFrom(...values).find((value) => allowed.size > 0 && !allowed.has(value)) || "";
}


export function riskRank(value: unknown = "read_only"): number {
  return RISK_RANK[String(value || "read_only")] ?? RISK_RANK.read_only;
}

export interface AuthorizationEffectDetails extends Record<string, unknown> {
  effect: string;
  reasonCode: string;
  redactedReason: string;
}

export function effectDetails(
  effect?: unknown,
  reasonCode?: unknown,
  redactedReason?: unknown,
  extra: Record<string, unknown> = {}
): AuthorizationEffectDetails {
  return {
    effect: String(effect || ""),
    reasonCode: String(reasonCode || ""),
    redactedReason: String(redactedReason || ""),
    ...extra
  };
}
