import { option } from "./basic-utils.js";
// Client-side mirror of the server-side local-grant validation catalogs. The
// server remains authoritative; these copies let the connector fail fast with
// operator-facing errors before a device-authorization request is submitted.
// Sources of truth:
// - toolsets/scopes: packages/foundation/config/entity-config/tools/{toolsets,scopes}/*.json
//   (only toolsets with "grantable": true are listed; meshrix.admin and
//   meshrix.mount.dev are intentionally excluded)
// - risk levels: tool-skill-management-provider-local-mcp.ts LOCAL_GRANT_RISK_RANK
// - capability pattern: operation-permission-core/store-utils.ts
//   DYNAMIC_UPSTREAM_CAPABILITY_PATTERN
// - service ids: the server stores allowedServiceIds as plain non-empty strings
//   (operation-permission-core/store-utils.ts normalizeStringList) with no
//   character pattern, so path-segment ids such as file-parser/format-convert
//   are accepted; the client check below only fails fast on empty or
//   separator-leading values.
export const LOCAL_GRANT_MAX_RISK_LEVELS = Object.freeze([
    "read_only",
    "safe_write",
    "repair_write",
    "destructive"
]);
const LOCAL_GRANT_RISK_RANK = Object.freeze({
    read_only: 0,
    safe_write: 1,
    repair_write: 2,
    destructive: 3
});
const GRANTABLE_TOOLSET_MAX_RISK = Object.freeze({
    "meshrix.agent.sync.publish": "safe_write",
    "meshrix.agent.workspace": "safe_write",
    "meshrix.agent.workspace.maintain": "repair_write",
    "meshrix.agent.workspace.read": "read_only",
    "meshrix.authorization.admin": "repair_write",
    "meshrix.console.read": "read_only",
    "meshrix.gateway.admin": "repair_write",
    "meshrix.gateway.maintain": "destructive",
    "meshrix.gateway.read": "read_only",
    "meshrix.gateway.write": "safe_write",
    "meshrix.jobs.read": "read_only",
    "meshrix.jobs.write": "repair_write",
    "meshrix.maintenance.maintain": "repair_write",
    "meshrix.maintenance.read": "read_only",
    "meshrix.maintenance.run": "safe_write",
    "meshrix.model.call": "safe_write",
    "meshrix.result.export": "read_only",
    "meshrix.runtime.maintain": "repair_write",
    "meshrix.runtime.read": "read_only",
    "meshrix.storage.read": "read_only",
    "meshrix.storage.write": "safe_write",
    "meshrix.uploads.write": "safe_write"
});
const GRANTABLE_SCOPES = Object.freeze([
    "agent_sync:publish",
    "auth:admin",
    "console:read",
    "gateway:admin",
    "gateway:maintain",
    "gateway:read",
    "gateway:write",
    "jobs:read",
    "jobs:write",
    "maintenance:admin",
    "maintenance:approve",
    "maintenance:read",
    "maintenance:run",
    "model:call",
    "runtime:admin",
    "storage:read",
    "storage:write",
    "uploads:write",
    "workspace:maintain",
    "workspace:read",
    "workspace:write"
]);
const UPSTREAM_CAPABILITY_PATTERN = /^cap:upstream(?:-tuple)?:[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$/iu;
const UPSTREAM_SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/iu;
function riskRank(risk = "read_only") {
    return LOCAL_GRANT_RISK_RANK[String(risk || "read_only")] ?? 0;
}
function listOption(options, name, limit = 64) {
    const raw = option(options, name, "");
    const items = (Array.isArray(raw) ? raw : String(raw || "").split(","))
        .map((item) => String(item || "").trim())
        .filter(Boolean);
    return [...new Set(items)].slice(0, limit);
}
function assertFitsByteLimit(values, maxBytes, field) {
    for (const value of values) {
        if (Buffer.byteLength(String(value), "utf8") > maxBytes) {
            throw new Error(`MCP grant request contains an oversized ${field} identifier.`);
        }
    }
}
export function resolveGrantRequestFields(options = {}) {
    const toolsets = listOption(options, "toolsets");
    const scopes = listOption(options, "scopes");
    const maxRisk = String(option(options, "max-risk", "")).trim();
    const upstreamCapabilities = listOption(options, "upstream-capability", 512);
    const allowedServiceIds = listOption(options, "allowed-service", 512);
    const explicit = Boolean(toolsets.length ||
        scopes.length ||
        maxRisk ||
        upstreamCapabilities.length ||
        allowedServiceIds.length);
    if (!explicit) {
        return { explicit: false, fields: {}, summary: "" };
    }
    for (const toolset of toolsets) {
        if (!Object.hasOwn(GRANTABLE_TOOLSET_MAX_RISK, toolset)) {
            throw new Error(`Unsupported or non-grantable MCP grant toolset "${toolset}".`);
        }
    }
    for (const scope of scopes) {
        if (!GRANTABLE_SCOPES.includes(scope)) {
            throw new Error(`Unsupported MCP grant scope "${scope}".`);
        }
    }
    if (maxRisk && !LOCAL_GRANT_MAX_RISK_LEVELS.includes(maxRisk)) {
        throw new Error(`Unsupported MCP grant max risk "${maxRisk}". Supported values: ${LOCAL_GRANT_MAX_RISK_LEVELS.join(", ")}.`);
    }
    for (const capability of upstreamCapabilities) {
        if (!UPSTREAM_CAPABILITY_PATTERN.test(capability)) {
            throw new Error(`Invalid upstream capability "${capability}". Use canonical cap:upstream:<service>:<operation> identifiers.`);
        }
    }
    for (const serviceId of allowedServiceIds) {
        if (!UPSTREAM_SERVICE_ID_PATTERN.test(serviceId)) {
            throw new Error(`Invalid allowed upstream service id "${serviceId}".`);
        }
    }
    assertFitsByteLimit(toolsets, 256, "toolset");
    assertFitsByteLimit(scopes, 256, "scope");
    assertFitsByteLimit(upstreamCapabilities, 512, "capability");
    assertFitsByteLimit(allowedServiceIds, 512, "service");
    if ((upstreamCapabilities.length > 0 || allowedServiceIds.length > 0) && toolsets.length === 0 && scopes.length === 0) {
        throw new Error("Upstream capabilities or allowed services require an explicit --toolsets or --scopes request " +
            "(for example --toolsets meshrix.gateway.write); without one the grant stays read-only.");
    }
    const declaredMaxRisk = toolsets.reduce((max, toolset) => (riskRank(GRANTABLE_TOOLSET_MAX_RISK[toolset]) > riskRank(max) ? GRANTABLE_TOOLSET_MAX_RISK[toolset] : max), "read_only");
    if (riskRank(declaredMaxRisk) >= riskRank("repair_write") && riskRank(maxRisk) < riskRank("repair_write")) {
        throw new Error(`Requested toolsets allow repair-capable tools. Pass --max-risk repair_write or --max-risk destructive to acknowledge.`);
    }
    const fields = {};
    if (toolsets.length > 0) {
        fields.toolsets = toolsets;
    }
    if (scopes.length > 0) {
        fields.scopes = scopes;
    }
    if (maxRisk) {
        fields.maxRisk = maxRisk;
    }
    if (upstreamCapabilities.length > 0) {
        fields.dynamicCapabilities = upstreamCapabilities;
    }
    if (allowedServiceIds.length > 0) {
        fields.allowedServiceIds = allowedServiceIds;
    }
    const summary = [
        toolsets.length > 0 ? `toolsets=${toolsets.join(",")}` : "",
        scopes.length > 0 ? `scopes=${scopes.join(",")}` : "",
        maxRisk ? `maxRisk=${maxRisk}` : "",
        upstreamCapabilities.length > 0 ? `upstreamCapabilities=${upstreamCapabilities.join(",")}` : "",
        allowedServiceIds.length > 0 ? `allowedServices=${allowedServiceIds.join(",")}` : ""
    ].filter(Boolean).join("; ");
    return { explicit, fields, summary };
}
//# sourceMappingURL=grant-request.js.map