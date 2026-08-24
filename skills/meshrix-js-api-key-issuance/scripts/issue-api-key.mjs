#!/usr/bin/env node
// Issue a Meshrix.js organization-scoped API Key for a downstream MCP client.
// Checks organization governance, discovers the issuer scope, and POSTs the
// key with a policy that covers the requested gateway capability.
//
// Usage:
//   node issue-api-key.mjs \
//     --origin http://127.0.0.1:7228 \
//     --username owner --password '...' \
//     --display-name command-code \
//     --capability cap:upstream:svc_...:tools-call \
//     [--node organization:group] [--target opencode] [--risk high] [--days 30]

function args() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].startsWith("--")) {
      const key = a[i].slice(2);
      const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[camel] = a[i + 1];
    }
  }
  return out;
}

async function main() {
  const opt = args();
  const origin = String(opt.origin || "http://127.0.0.1:7228").replace(/\/$/, "");
  const username = opt.username || "owner";
  const password = opt.password || "";
  const displayName = opt.displayName || "command-code";
  const capabilityIds = String(opt.capability || "").split(",").map((s) => s.trim()).filter(Boolean);
  const risk = ["low", "medium", "high"].includes(opt.risk) ? opt.risk : "high";
  const days = Number(opt.days || 30);
  if (!password) throw new Error("--password is required");
  if (capabilityIds.length === 0) throw new Error("--capability is required (dynamic capability id, e.g. cap:upstream:<serviceId>:<opKey>)");

  const login = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const loginPayload = await login.json();
  if (!loginPayload.ok) throw new Error(`login failed: ${loginPayload.error || login.status}`);
  const csrf = loginPayload.csrfToken;
  const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
  const headers = {
    cookie,
    "content-type": "application/json",
    "x-meshrix-csrf": csrf,
    "x-meshrix-safety-confirm": "true",
  };

  // Governance check
  const governance = await (await fetch(`${origin}/api/authorization/organization-governance`, { headers: { cookie } })).json();
  if (governance.snapshot?.configured !== true) {
    throw new Error("organization governance is not configured; run $meshrix-js-organization-governance first");
  }

  // Issuer scope
  const scopes = await (await fetch(`${origin}/api/operation-permission/v1/api-keys/issuer-scopes`, { headers: { cookie } })).json();
  const nodeId = opt.node || scopes.eligibleNodes?.[0]?.nodeId || "";
  const serverAudience = scopes.serverAudience || "";
  const catalogFingerprint = scopes.catalogFingerprint || "";
  if (!nodeId) throw new Error("no eligible organization node; configure organization governance first");
  if (!catalogFingerprint) throw new Error("issuer scope did not return a catalog fingerprint");

  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const body = {
    workloadDisplayName: displayName,
    organizationNodeId: nodeId,
    expiresAt,
    policy: {
      protocol: "mcp",
      serviceIds: [],
      capabilityIds,
      toolsetIds: ["meshrix.gateway.read", "meshrix.gateway.write"],
      allowedTools: [],
      deniedTools: [],
      scopeIds: ["gateway:read", "gateway:write"],
      maximumRisk: risk,
      audience: { serverAudience, targetIds: [opt.target || "opencode"], connectorPackageIds: [] },
      resources: {
        mode: "unrestricted", workspaceIds: [], dataClassifications: [], egressClasses: [],
        semanticFamilies: [], capabilityDomains: [], capabilityVerbs: [], resourceKinds: [],
        effectKinds: [], secretBindingIds: [], allowedOrigins: [], allowedCidrs: [],
      },
      processIdentity: { mode: "optional" },
      limits: { maxUses: 100, requestsPerWindow: 100, windowSeconds: 3600, maxConcurrentEffects: 4 },
      catalogFingerprint,
    },
  };

  const issued = await (await fetch(`${origin}/api/operation-permission/v1/api-keys`, {
    method: "POST", headers, body: JSON.stringify(body),
  })).json();
  if (!issued.apiKey) throw new Error(`key issuance failed: ${JSON.stringify(issued.error || issued)}`);
  console.log(JSON.stringify({
    ok: true,
    keyId: issued.record?.keyId,
    displayPrefix: issued.record?.displayPrefix,
    apiKey: issued.apiKey,
    expiresAt: issued.record?.expiresAt,
  }));
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
