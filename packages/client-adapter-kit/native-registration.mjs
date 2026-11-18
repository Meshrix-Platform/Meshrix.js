import path from "node:path";
import { adapterError, clientCommand, readJson, registrationFrom, run, writeJson } from "./shared.mjs";

export const API_KEY_HEADER = "X-Meshrix.js-Api-Key";
export const NATIVE_AUTH_LIMITATIONS = Object.freeze({
  kimi: "Kimi Code documents bearerTokenEnvVar, not an environment reference for X-Meshrix.js-Api-Key. Meshrix rejects Bearer authentication; existing configuration was not changed.",
  antigravity: "Antigravity remote MCP supports headers, but a protected reference for X-Meshrix.js-Api-Key is not qualified. Existing configuration was not changed."
});

export function nativeCapability(target) {
  const reason = NATIVE_AUTH_LIMITATIONS[target];
  return reason ? { supported: false, reasonCode: "unsupported_protected_header_reference", reason }
    : { supported: true, transport: "streamable-http", credentialReferences: ["env"], header: API_KEY_HEADER };
}

function conflict() {
  return adapterError("registration_conflict", "The selected registration has a different endpoint, credential reference, or authentication/transport configuration. Preserve it and select another --server-name.", 65);
}

export function nativeEntry(target, registration) {
  const capability = nativeCapability(target);
  if (!capability.supported) throw adapterError(capability.reasonCode, capability.reason, 69);
  const name = registration.credentialRef.name;
  if (target === "claude-code" && ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "HTTPS_PROXY", "NPM_TOKEN"].includes(name)) {
    throw adapterError("unsupported_credential_reference", "Claude Code does not expand this reserved credential variable in remote headers. Select a dedicated environment reference for the chosen Meshrix authorization.", 69);
  }
  if (target === "codex") return { url: registration.url, env_http_headers: { [API_KEY_HEADER]: name } };
  const headers = { [API_KEY_HEADER]: target === "opencode" ? `{env:${name}}` : `\${${name}}` };
  if (target === "opencode") return { type: "remote", url: registration.url, oauth: false, headers };
  if (target === "openclaw") return { transport: "streamable-http", url: registration.url, headers };
  if (target === "claude-code") return { type: "http", url: registration.url, headers };
  return { url: registration.url, headers };
}

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function headerEntries(value, name) {
  return record(value) ? Object.entries(value).filter(([key]) => key.toLowerCase() === name.toLowerCase()) : [];
}

/** Recognize only the former generated Meshrix proxy, never an arbitrary stdio server. */
export function isOwnedProxy(entry, registration, target) {
  if (!record(entry)) return false;
  const command = Array.isArray(entry.command) ? entry.command[0] : entry.command;
  const args = Array.isArray(entry.command) ? entry.command.slice(1) : entry.args;
  if (typeof command !== "string" || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return false;
  const proxyIndex = args.indexOf("proxy");
  if (proxyIndex < 0) return false;
  const executable = (value) => /^meshrix-mcp(?:\.(?:mjs|cjs|js|ts|cmd|exe))?$/u.test(path.win32.basename(path.posix.basename(value)));
  if (!(proxyIndex === 0 && executable(command)) && !(proxyIndex === 1 && executable(args[0]))) return false;
  const tail = args.slice(proxyIndex + 1);
  if (tail.length !== 6 || tail[0] !== "--target" || tail[1] !== target || tail[2] !== "--url" || tail[4] !== "--token-env") return false;
  if (tail[3].replace(/\/+$/u, "") !== registration.baseUrl || tail[5] !== registration.credentialRef.name) return false;
  // These were not produced by the old installer. Do not erase or reinterpret user credentials.
  return ["url", "serverUrl", "env", "environment", "headers", "auth", "oauth"].every((key) => entry[key] === undefined);
}

export function matchesNativeEntry(entry, expected) {
  if (!record(entry) || entry.url !== expected.url || entry.command !== undefined || entry.args !== undefined) return false;
  if (entry.serverUrl !== undefined || entry.auth !== undefined || entry.oauth !== expected.oauth) return false;
  if (["bearer_token_env_var", "bearerTokenEnvVar", "headersHelper", "http_headers_helper"].some((key) => entry[key] !== undefined)) return false;
  for (const key of ["type", "transport"]) {
    if (expected[key] !== undefined ? entry[key] !== expected[key] : entry[key] !== undefined && !["http", "streamable-http"].includes(entry[key])) return false;
  }
  const headerKey = expected.env_http_headers ? "env_http_headers" : "headers";
  const expectedValue = expected[headerKey][API_KEY_HEADER];
  const selected = headerEntries(entry[headerKey], API_KEY_HEADER);
  if (selected.length !== 1 || selected[0][1] !== expectedValue) return false;
  for (const key of ["headers", "http_headers", "env_http_headers"]) {
    if (headerEntries(entry[key], "Authorization").length) return false;
    if (key !== headerKey && headerEntries(entry[key], API_KEY_HEADER).length) return false;
  }
  return true;
}

export function mergeNativeEntry(entry, expected, registration, target) {
  if (entry === undefined) return expected;
  if (matchesNativeEntry(entry, expected)) return entry;
  if (!isOwnedProxy(entry, registration, target)) throw conflict();
  const merged = { ...entry };
  for (const key of ["command", "args", "type", "transport", "cwd"]) delete merged[key];
  for (const [key, value] of Object.entries(expected)) {
    if (["headers", "env_http_headers"].includes(key)) {
      const headers = { ...(merged[key] || {}) };
      for (const name of Object.keys(headers)) if (name.toLowerCase() === API_KEY_HEADER.toLowerCase()) delete headers[name];
      merged[key] = { ...headers, ...value };
    } else merged[key] = value;
  }
  return merged;
}

export async function jsonRegistrationStore(filePath, rootKey, serverName, read = readJson) {
  const config = await read(filePath, {});
  if (!record(config) || (config[rootKey] !== undefined && !record(config[rootKey]))) {
    throw adapterError("invalid_client_config", "The client configuration must contain an object server map.", 74);
  }
  return {
    config,
    entry: config[rootKey]?.[serverName],
    async save(entry) {
      if (entry === undefined) delete config[rootKey][serverName];
      else config[rootKey] = { ...config[rootKey], [serverName]: entry };
      await writeJson(filePath, config);
    }
  };
}

/** Registration only: no network probe, auth-store mutation, credential resolution, or Agent turn. */
export function nativeAdapter({ description, load, probe, beforeInstall }) {
  const target = description.target;
  const capability = nativeCapability(target);
  async function inspect(request) {
    const registration = registrationFrom(request);
    const store = await load(request, registration);
    const expected = capability.supported ? nativeEntry(target, registration) : null;
    const installed = expected !== null && matchesNativeEntry(store.entry, expected);
    return {
      installed, present: store.entry !== undefined,
      status: !capability.supported ? "unsupported" : installed ? "configured" : store.entry === undefined ? "not-configured" : "conflict",
      credentialStatus: "external-reference-unverified", connectivity: "not-run", capability
    };
  }
  return {
    description: { ...description, nativeRegistration: capability },
    async scan(request) {
      const available = probe ? await probe(request) : (await run(clientCommand(request, description.commandNames[0]), ["--version"], { allowFailure: true })).ok;
      // Discovery without a selected endpoint must not claim the existing entry matches it.
      try {
        const state = request.baseUrl ? await inspect(request) : { installed: false, status: "not-checked", capability };
        return { available, ...state };
      } catch (error) {
        return { available, installed: false, status: "configuration-error", errorCode: error.adapterCode || "invalid_client_config", capability, credentialStatus: "external-reference-unverified", connectivity: "not-run" };
      }
    },
    async install(request) {
      const registration = registrationFrom(request);
      const expected = nativeEntry(target, registration); // capability failure precedes config access
      const store = await load(request, registration);
      const entry = mergeNativeEntry(store.entry, expected, registration, target);
      const changed = beforeInstall ? await beforeInstall(request, registration, store) : false;
      if (changed || JSON.stringify(entry) !== JSON.stringify(store.entry)) {
        await store.save(entry);
        if (!(await inspect(request)).installed) throw adapterError("registration_verification_failed", "The stored native configuration does not match the selected endpoint and reference.", 74);
      }
      return { installed: true, status: "configured", credentialStatus: "external-reference-unverified", connectivity: "not-run" };
    },
    verify: inspect,
    async uninstall(request) {
      const registration = registrationFrom(request);
      const store = await load(request, registration);
      if (store.entry === undefined) return { removed: false, installed: false, credentialsPreserved: true };
      const expected = capability.supported ? nativeEntry(target, registration) : null;
      if (!(expected && matchesNativeEntry(store.entry, expected)) && !isOwnedProxy(store.entry, registration, target)) throw conflict();
      await store.save(undefined);
      if ((await load(request, registration)).entry !== undefined) throw adapterError("registration_verification_failed", "The selected registration was not removed from native configuration.", 74);
      return { removed: true, installed: false, credentialsPreserved: true };
    }
  };
}
