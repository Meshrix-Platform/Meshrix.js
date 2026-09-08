#!/usr/bin/env node
import { open, readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseArgs } from "node:util";

const usage = "Usage: issue-api-key.mjs --origin <server-origin> --username <actor> --request <approved-request.json> --key-file <new-private-file> --password-stdin";

async function passwordFromStdin() {
  if (process.stdin.isTTY) throw new Error("password-stdin-required");
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value) > 8192) throw new Error("invalid-password-input");
  }
  return value.replace(/\r?\n$/, "");
}

export async function issueApiKey(argv, { fetchImpl = globalThis.fetch, readPassword = passwordFromStdin } = {}) {
  let options, origin, request;
  try {
    options = parseArgs({ args: argv, options: {
      origin: { type: "string" }, username: { type: "string" },
      request: { type: "string" }, "key-file": { type: "string" },
      "password-stdin": { type: "boolean" }, help: { type: "boolean" },
    } }).values;
  } catch { throw new Error("invalid-arguments; use --help"); }
  if (options.help) return usage;
  if (!["origin", "username", "request", "key-file"].every((key) => options[key]?.trim()) || !options["password-stdin"]) {
    throw new Error("missing-arguments; use --help");
  }
  try {
    const url = new URL(options.origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    origin = url.origin;
    request = JSON.parse(await readFile(options.request, "utf8"));
  } catch { throw new Error("invalid-origin-or-request-file"); }

  const policy = request?.policy;
  if (typeof request?.workloadDisplayName !== "string" || !request.workloadDisplayName.trim() ||
      typeof request?.organizationNodeId !== "string" || !request.organizationNodeId.trim() ||
      !(Date.parse(request.expiresAt) > Date.now()) || policy?.protocol !== "mcp" ||
      !["low", "medium", "high"].includes(policy.maximumRisk) ||
      !["restricted", "unrestricted"].includes(policy.resources?.mode) ||
      !["optional", "required"].includes(policy.processIdentity?.mode) ||
      !policy.limits || !Array.isArray(policy.audience?.targetIds) ||
      !Array.isArray(policy.audience?.connectorPackageIds) ||
      !["serviceIds", "capabilityIds", "toolsetIds", "allowedTools", "deniedTools", "scopeIds"]
        .every((key) => Array.isArray(policy[key]) && policy[key].every((value) => typeof value === "string"))) {
    throw new Error("invalid-issuance-request");
  }
  let password;
  try { password = await readPassword(); }
  catch { throw new Error("invalid-password-input"); }
  if (typeof password !== "string" || !password || Buffer.byteLength(password) > 8192) throw new Error("invalid-password-input");

  // Reserve the operator-selected destination before creating a credential.
  // Never overwrite another credential or follow an existing destination link.
  let output;
  try { output = await open(options["key-file"], "wx", 0o600); }
  catch { throw new Error("key-destination-unavailable"); }
  let delivered = false;
  async function jsonRequest(route, init, stage) {
    try {
      const response = await fetchImpl(origin + route, { ...init, redirect: "error" });
      if (!response.ok) throw new Error();
      const payload = await response.json();
      if (!payload || payload.ok === false) throw new Error();
      return { response, payload };
    } catch { throw new Error(stage + "-failed"); }
  }
  try {
    const { response, payload: login } = await jsonRequest("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: options.username, password }),
    }, "login");
    const cookie = String(response.headers.get("set-cookie") || "").split(";")[0];
    if (!cookie || typeof login.csrfToken !== "string" || !login.csrfToken) throw new Error("login-session-unavailable");
    const headers = { cookie, "content-type": "application/json", "x-meshrix-csrf": login.csrfToken, "x-meshrix-safety-confirm": "true" };
    const { payload: governance } = await jsonRequest("/api/authorization/organization-governance", { headers: { cookie } }, "governance-check");
    if (governance.snapshot?.configured !== true) throw new Error("organization-unconfigured; use the organization-governance workflow");
    const { payload: scopes } = await jsonRequest("/api/operation-permission/v1/api-keys/issuer-scopes", { headers: { cookie } }, "issuer-scope");
    if (!Array.isArray(scopes.eligibleNodes) || !scopes.eligibleNodes.some((node) => node.nodeId === request.organizationNodeId)) throw new Error("requested-node-not-eligible");
    if (typeof scopes.serverAudience !== "string" || !scopes.serverAudience || typeof scopes.catalogFingerprint !== "string" || !scopes.catalogFingerprint) throw new Error("issuer-authority-unavailable");
    if ((policy.audience.serverAudience && policy.audience.serverAudience !== scopes.serverAudience) ||
        (policy.catalogFingerprint && policy.catalogFingerprint !== scopes.catalogFingerprint)) throw new Error("issuer-authority-changed; review the request");
    // Only live authority bindings are filled in. The operator's policy is unchanged.
    request.policy = { ...policy, audience: { ...policy.audience, serverAudience: scopes.serverAudience }, catalogFingerprint: scopes.catalogFingerprint };
    let result;
    try {
      ({ payload: result } = await jsonRequest("/api/operation-permission/v1/api-keys", {
        method: "POST", headers, body: JSON.stringify(request),
      }, "key-issuance"));
    } catch { throw new Error("key-issuance-outcome-uncertain; inspect issuance before retrying"); }
    if (typeof result.apiKey !== "string" || !result.apiKey) throw new Error("key-response-invalid; inspect issuance before retrying");
    try {
      await output.writeFile(result.apiKey + "\n", "utf8");
      await output.sync();
      delivered = true;
    } catch { throw new Error("key-created-but-delivery-failed; inspect and revoke the undelivered key before retrying"); }
    return { ok: true, keyDelivered: true };
  } finally {
    await output.close().catch(() => {});
    if (!delivered) await unlink(options["key-file"]).catch(() => {});
    // Never automatically retry issuance or publish organization governance.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  issueApiKey(process.argv.slice(2)).then((result) => {
    console.log(typeof result === "string" ? result : JSON.stringify(result));
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
