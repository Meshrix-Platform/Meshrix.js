import crypto from "node:crypto";

const RISK_RANK: Readonly<Record<string, any>> = Object.freeze({
  read_only: 0,
  safe_write: 1,
  repair_write: 2,
  destructive: 3
});

export function nowIso() : any {
  return new Date().toISOString();
}

export function randomId(prefix?: any) : any {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

export function stringSet(values: any = []) : any {
  return new Set<any>(uniqueStrings(values));
}

export function objectOrNull(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function firstString(...values: any[]) : any {
  for (const value of values) {
    const text: any = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

export function stringsFrom(...values: any[]) : any {
  const output: any[] = [];
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

export function deniedOutsideAllowed(values: any = [], allowedValues: any = []) : any {
  const allowed: any = allowedValues instanceof Set ? allowedValues : stringSet(allowedValues);
  return stringsFrom(...values).find((value?: any) : any => allowed.size > 0 && !allowed.has(value)) || "";
}


export function riskRank(value: any = "read_only") : any {
  return RISK_RANK[String(value || "read_only")] ?? RISK_RANK.read_only;
}

export function effectDetails(effect?: any, reasonCode?: any, redactedReason?: any, extra: Record<string, any> = {}) : any {
  return { effect, reasonCode, redactedReason, ...extra };
}
