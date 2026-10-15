import { canonicalSerialize } from "./manifest-compiler.ts";
import { asArray, object, text } from "./support.ts";

export const CONTENT_POLICY_DENIED_REASON = "upstream_content_policy_denied";
const MAX_SCAN_TEXT_BYTES = 1024 * 1024;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const ARRAY_INDEX = /^\d{1,6}$/u;
const REQUEST_DATA_KEYS = Object.freeze([
  "arguments",
  "args",
  "input",
  "payload",
  "query",
  "body",
  "bodyJson",
  "rpcParams",
  "params",
  "pathParameters",
  "inputResponses",
  "requestState"
]);

export interface UpstreamContentPolicyDenial {
  ruleId: string;
  scope: "service" | "operation";
  reasonCode: typeof CONTENT_POLICY_DENIED_REASON;
  inputLimitExceeded: boolean;
}

function requestDataSubject(input: Record<string, any> = {}): Record<string, any> {
  const source = object(input);
  const subject: Record<string, any> = {};
  for (const key of REQUEST_DATA_KEYS) {
    if (Object.hasOwn(source, key)) subject[key] = source[key];
  }
  return subject;
}

function resolveSelector(subject: Record<string, any>, path: string): { found: boolean; value?: any } {
  let current: any = subject;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || FORBIDDEN_SEGMENTS.has(segment)) {
      return { found: false };
    }
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (!Object.hasOwn(current, segment)) return { found: false };
    current = current[segment];
  }
  return { found: true, value: current };
}

function isScalar(value: any): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function scanText(value: any): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return canonicalSerialize(value);
}

function compilePattern(source: unknown): RegExp | null {
  try {
    return new RegExp(String(source), "u");
  } catch {
    return null;
  }
}

/**
 * Numeric comparison conjunction: every declared bound must hold, and the
 * selected value must be a finite number — a non-numeric or absent selection
 * is a miss on the deny side and a denial on the allow side.
 */
function compareHolds(compare: Record<string, any>, selected: any): boolean {
  if (typeof selected !== "number" || !Number.isFinite(selected)) return false;
  if (compare.gt !== undefined && !(selected > compare.gt)) return false;
  if (compare.gte !== undefined && !(selected >= compare.gte)) return false;
  if (compare.lt !== undefined && !(selected < compare.lt)) return false;
  if (compare.lte !== undefined && !(selected <= compare.lte)) return false;
  return true;
}

/**
 * Parameter-level matcher predicates shared by both sides. Each returns true
 * when its declared condition holds; a non-scalar or absent selection only
 * satisfies presence matchers (`exists`) — type mismatches never hit a deny
 * matcher and never satisfy an allow matcher.
 */
function scalarMatcherHit(matcher: Record<string, any>, found: boolean, selected: any): boolean {
  // Only a presence matcher can hit on an absent path.
  if (!found) return matcher.exists === false;
  // `exists:true` is satisfied by presence alone; `exists:false` failed (the
  // field is present) but the remaining matchers still apply — OR semantics.
  if (matcher.exists === true) return true;
  if (matcher.eq !== undefined && isScalar(selected) && selected === matcher.eq) return true;
  if (matcher.neq !== undefined && isScalar(selected) && selected !== matcher.neq) return true;
  const notIn = asArray(matcher.notIn);
  if (notIn.length && isScalar(selected) && !notIn.some((entry: any) => entry === selected)) return true;
  if (typeof matcher.startsWith === "string" && typeof selected === "string" && selected.startsWith(matcher.startsWith)) return true;
  if (typeof matcher.endsWith === "string" && typeof selected === "string" && selected.endsWith(matcher.endsWith)) return true;
  if (matcher.compare !== undefined && compareHolds(object(matcher.compare), selected)) return true;
  return false;
}

function denyOutcome(deny: Record<string, any>, found: boolean, selected: any): "hit" | "miss" | "limit" {
  if (!found) {
    // Only presence matchers can hit on an absent path: `exists:false` denies
    // when the field is missing; every other matcher is a miss.
    return deny.exists === false ? "hit" : "miss";
  }
  const oneOf = asArray(deny.oneOf);
  if (oneOf.length && isScalar(selected) && oneOf.some((entry: any) => entry === selected)) {
    return "hit";
  }
  if (scalarMatcherHit(deny, found, selected)) return "hit";
  const contains = asArray(deny.contains);
  const matches = asArray(deny.matches);
  if (contains.length === 0 && matches.length === 0) return "miss";
  const haystack = scanText(selected);
  if (Buffer.byteLength(haystack, "utf8") > MAX_SCAN_TEXT_BYTES) return "limit";
  if (contains.some((literal: any) => haystack.includes(String(literal)))) return "hit";
  for (const source of matches) {
    const regex = compilePattern(source);
    // An operator policy that cannot compile fails closed: never let a broken
    // matcher silently widen the admitted call surface.
    if (!regex || regex.test(haystack)) return "hit";
  }
  return "miss";
}

function allowOutcome(allow: Record<string, any>, found: boolean, selected: any): "ok" | "deny" | "limit" {
  if (!found) return allow.exists === false ? "ok" : "deny";
  if (scalarMatcherHit(allow, found, selected)) return "ok";
  if (!isScalar(selected)) return "deny";
  const oneOf = asArray(allow.oneOf);
  if (oneOf.some((entry: any) => entry === selected)) return "ok";
  const matches = asArray(allow.matches);
  if (matches.length) {
    const value = selected === null ? "null" : String(selected);
    if (Buffer.byteLength(value, "utf8") > MAX_SCAN_TEXT_BYTES) return "limit";
    for (const source of matches) {
      const regex = compilePattern(source);
      if (regex && regex.test(value)) return "ok";
    }
  }
  return "deny";
}

function policyRules(policy: any, scope: "service" | "operation"): Array<{ rule: any; scope: "service" | "operation" }> {
  return asArray(object(object(policy).request).rules).map((rule: any) => ({ rule, scope }));
}

export function evaluateRequestContentPolicy(
  service: Record<string, any> = {},
  operation: Record<string, any> = {},
  input: Record<string, any> = {}
): UpstreamContentPolicyDenial | null {
  const entries = [
    ...policyRules(service?.contentPolicy, "service"),
    ...policyRules(operation?.contentPolicy, "operation")
  ];
  if (entries.length === 0) return null;
  const subject = requestDataSubject(input);
  for (const { rule, scope } of entries) {
    const ruleId = text(rule?.id);
    const path = text(rule?.path);
    const resolved = path ? resolveSelector(subject, path) : { found: true, value: subject };
    const deny = object(rule?.deny);
    if (Object.keys(deny).length) {
      const outcome = denyOutcome(deny, resolved.found, resolved.value);
      if (outcome === "hit" || outcome === "limit") {
        return {
          ruleId,
          scope,
          reasonCode: CONTENT_POLICY_DENIED_REASON,
          inputLimitExceeded: outcome === "limit"
        };
      }
      continue;
    }
    const allow = object(rule?.allow);
    if (Object.keys(allow).length) {
      const outcome = allowOutcome(allow, resolved.found, resolved.value);
      if (outcome !== "ok") {
        return {
          ruleId,
          scope,
          reasonCode: CONTENT_POLICY_DENIED_REASON,
          inputLimitExceeded: outcome === "limit"
        };
      }
    }
  }
  return null;
}
