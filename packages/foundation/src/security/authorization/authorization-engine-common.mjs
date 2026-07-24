import crypto from "node:crypto";

const RISK_RANK = Object.freeze({
  read_only: 0,
  safe_write: 1,
  repair_write: 2,
  destructive: 3
});

export function nowIso() {
  return new Date().toISOString();
}

export function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function stringSet(values = []) {
  return new Set(uniqueStrings(values));
}

export function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function firstString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

export function stringsFrom(...values) {
  const output = [];
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

export function deniedOutsideAllowed(values = [], allowedValues = []) {
  const allowed = stringSet(allowedValues);
  return stringsFrom(...values).find((value) => allowed.size > 0 && !allowed.has(value)) || "";
}


export function riskRank(value = "read_only") {
  return RISK_RANK[String(value || "read_only")] ?? RISK_RANK.read_only;
}

export function effectDetails(effect, reasonCode, redactedReason, extra = {}) {
  return { effect, reasonCode, redactedReason, ...extra };
}
