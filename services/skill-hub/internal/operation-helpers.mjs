export function result(status, payload) {
  return { status, payload };
}

export function protocolPayload(payload = {}) {
  return { schemaVersion: "v0.0.1:schema:definition-1", ok: true, ...payload };
}

export function errorPayload(error, fallbackCode = "skill_hub_operation_failed", extra = {}) {
  const candidate = String(error?.code || "");
  const code = /^[a-z][a-z0-9_]{2,96}$/u.test(candidate)
    ? candidate
    : /^[a-z][a-z0-9_]{2,96}$/u.test(fallbackCode)
      ? fallbackCode
      : "skill_hub_operation_failed";
  return {
    ok: false,
    error: { code },
    ...extra
  };
}

export function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function claimsLocked(context = {}, subject = {}) {
  return context.transport === "mcp" || subject.type === "tool-grant";
}

function firstInputString(input = {}, keys = []) {
  for (const key of keys) {
    const value = String(input[key] || "").trim();
    if (value) return value;
  }
  return "";
}

export function callerIdClaim(context = {}, input = {}, subject = {}, keys = ["actorId", "actor-id", "actor"]) {
  const authenticatedId = subject.subjectId || subject.username || "anonymous";
  return claimsLocked(context, subject) ? authenticatedId : firstInputString(input, keys) || authenticatedId;
}

export function callerKindClaim(context = {}, input = {}, subject = {}) {
  if (claimsLocked(context, subject)) return subject.type || "agent";
  return String(input.contributorKind || input["contributor-kind"] || subject.type || "agent").trim() || "agent";
}

export function workspaceIdFrom(input = {}, fallback = "") {
  return String(input.workspaceId || input.workspace || fallback || "default").trim() || "default";
}
