#!/usr/bin/env node
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createSecureContext } from "node:tls";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { createGateway } from "@meshrix/gateway";
import { createIsolatedSchemaValidator } from "@meshrix/gateway/schema";
import type { AuthenticatedContext, CatalogDescriptor, RouteSnapshot, UpstreamPort } from "@meshrix/contracts/gateway";
import { createGatewayPolicy } from "@meshrix/capabilities/gateway-policy";
import { createGatewayPermitAuthority } from "@meshrix/foundation/security/gateway-permit";
import { fetchWithPinnedDns } from "@meshrix/foundation/security/outbound-egress-policy";
import { createLegacyMcpAdapter } from "@meshrix/protocols/mcp/legacy";
import { createModernDownstreamAdapter } from "@meshrix/protocols/mcp/modern-downstream";
import { createModernUpstreamAdapter } from "@meshrix/protocols/mcp/modern-upstream";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSIONS = new Set(["2025-03-26", "2025-06-18", "2025-11-25"]);

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function configError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function localUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw configError("gateway_target_unsafe", "The local profile only permits literal loopback HTTP upstreams without URL credentials.");
  return url;
}

function remoteUrl(value: string, allowedHosts: readonly string[], allowLoopback: boolean): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !allowedHosts.includes(url.hostname.toLowerCase()) ||
      !allowLoopback && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname.toLowerCase())) throw configError("gateway_target_unsafe", "Remote upstream needs a pinned HTTPS host explicitly allowed by the operator.");
  return url;
}

function environmentBinding(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^env:[A-Z][A-Z0-9_]*$/u.test(value)) throw configError("gateway_credential_invalid", `${label} requires an explicit environment binding.`);
  const name = value.slice(4);
  if (!process.env[name]) throw configError("gateway_credential_missing", `${label} environment binding is unavailable.`);
  return name;
}

interface ServiceConfig {
  readonly serviceId: string;
  readonly transport: "http" | "stdio";
  readonly baseUrl?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly allowedHosts?: readonly string[];
  readonly protocolVersion: string;
  readonly authorization?: string;
  readonly toolRisk: Readonly<Record<string, "read" | "safe_write" | "destructive">>;
}
interface RuntimeConfig {
  readonly profile: "local" | "remote";
  readonly listen: { readonly host: string; readonly port: number };
  readonly services: readonly ServiceConfig[];
  readonly remoteAuth?: { readonly bearerTokenEnv: string; readonly tlsCertEnv: string; readonly tlsKeyEnv: string; readonly allowedServiceIds: readonly string[]; readonly allowLoopbackUpstreams: boolean; readonly expiresAt?: number };
}

async function loadConfig(path?: string): Promise<RuntimeConfig> {
  const provided = path ? JSON.parse(await readFile(path, "utf8")) as unknown : {};
  if (!record(provided)) throw configError("gateway_config_invalid", "Gateway configuration must be an object.");
  if (provided.profile !== undefined && provided.profile !== "local" && provided.profile !== "remote") throw configError("gateway_profile_unsupported", "Gateway profile is unsupported.");
  const profile = provided.profile === "remote" ? "remote" : "local";
  const listen = record(provided.listen) ? provided.listen : {};
  if (profile === "local" && listen.host !== undefined && listen.host !== "127.0.0.1") throw configError("gateway_listen_unsafe", "The local profile only listens on IPv4 loopback.");
  const host = typeof listen.host === "string" ? listen.host : "127.0.0.1";
  if (profile === "remote" && !["127.0.0.1", "0.0.0.0", "::1", "::"].includes(host)) throw configError("gateway_listen_unsafe", "Remote listener host must be an explicit IP binding.");
  const port = listen.port === undefined ? 0 : Number(listen.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw configError("gateway_port_invalid", "Listener port is invalid.");
  let remoteAuth: RuntimeConfig["remoteAuth"];
  if (profile === "remote") {
    const remote = provided.remoteAuth;
    if (!record(remote) || !Array.isArray(remote.allowedServiceIds) || remote.allowedServiceIds.length === 0 || !remote.allowedServiceIds.every((id: unknown) => typeof id === "string" && id.trim())) throw configError("gateway_remote_auth_invalid", "Remote profile needs a nonempty explicit service grant.");
    const bearerTokenEnv = environmentBinding(remote.bearerToken, "Remote bearer token");
    const tlsCertEnv = environmentBinding(remote.tlsCert, "Remote TLS certificate");
    const tlsKeyEnv = environmentBinding(remote.tlsKey, "Remote TLS private key");
    try { createSecureContext({ cert: process.env[tlsCertEnv], key: process.env[tlsKeyEnv] }); }
    catch { throw configError("gateway_tls_invalid", "Remote TLS identity is invalid."); }
    const expiresAt = remote.expiresAt === undefined ? undefined : Date.parse(String(remote.expiresAt));
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw configError("gateway_remote_auth_invalid", "Remote grant expiration is invalid.");
    remoteAuth = { bearerTokenEnv, tlsCertEnv, tlsKeyEnv, allowedServiceIds: Object.freeze([...remote.allowedServiceIds]), allowLoopbackUpstreams: remote.allowLoopbackUpstreams === true, ...(expiresAt === undefined ? {} : { expiresAt }) };
  }
  if (provided.services !== undefined && !Array.isArray(provided.services)) throw configError("gateway_services_invalid", "Services must be an array.");
  const rawServices = Array.isArray(provided.services) ? provided.services : [];
  const peerEndpoint = process.env.MESHRIX_INTEROP_PEER_ENDPOINT;
  if (peerEndpoint && rawServices.length === 0) rawServices.push({ serviceId: "interop-peer", baseUrl: peerEndpoint, authorization: process.env.MESHRIX_INTEROP_UPSTREAM_AUTHORIZATION ? "$MESHRIX_INTEROP_UPSTREAM_AUTHORIZATION" : undefined });
  const services: ServiceConfig[] = rawServices.map((value: unknown, index: number) => {
    if (!record(value) || typeof value.serviceId !== "string" || !value.serviceId.trim()) throw configError("gateway_service_invalid", `Service ${index} needs a serviceId.`);
    if (value.transport !== undefined && !["stdio", "http", "streamable-http"].includes(String(value.transport))) throw configError("gateway_transport_invalid", "Service transport is unsupported.");
    const transport = value.transport === "stdio" ? "stdio" : "http";
    const endpoint = value.baseUrl === "$MESHRIX_INTEROP_PEER_ENDPOINT" ? peerEndpoint : value.baseUrl;
    const allowedHosts = Array.isArray(value.allowedHosts) && value.allowedHosts.every((host: unknown) => typeof host === "string" && host.length > 0 && host.length < 254)
      ? value.allowedHosts.map((host: string) => host.toLowerCase()) : [];
    const baseUrl = transport === "http" && typeof endpoint === "string"
      ? profile === "local" ? localUrl(endpoint).toString() : remoteUrl(endpoint, allowedHosts, remoteAuth!.allowLoopbackUpstreams).toString() : undefined;
    if (transport === "http" && !baseUrl) throw configError("gateway_target_missing", "HTTP service needs an explicit endpoint.");
    if (profile === "remote" && transport === "stdio") throw configError("gateway_remote_stdio_unsupported", "Remote profile cannot launch local stdio children.");
    const command = transport === "stdio" && typeof value.command === "string" ? value.command.trim() : undefined;
    const args = Array.isArray(value.args) && value.args.every((item: unknown) => typeof item === "string") && value.args.length <= 64 ? value.args as string[] : [];
    if (transport === "stdio" && (!command || value.authorization !== undefined || value.env !== undefined || value.args !== undefined && (!Array.isArray(value.args) || args.length !== value.args.length))) throw configError("gateway_stdio_invalid", "Stdio service needs a command and supported arguments; use environment bindings for credentials.");
    if (value.envBindings !== undefined && (transport !== "stdio" || !record(value.envBindings))) throw configError("gateway_stdio_invalid", "Stdio environment bindings must be an object.");
    const env: Record<string, string> = {};
    for (const [key, reference] of Object.entries(record(value.envBindings) ? value.envBindings : {})) {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || typeof reference !== "string" || !/^env:[A-Z][A-Z0-9_]*$/u.test(reference)) throw configError("gateway_stdio_invalid", "Stdio environment fields require explicit environment references.");
      const resolved = process.env[reference.slice(4)];
      if (!resolved) throw configError("gateway_credential_missing", "A required stdio environment binding is unavailable.");
      env[key] = resolved;
    }
    const protocolVersion = typeof value.protocolVersion === "string" ? value.protocolVersion : MODERN_VERSION;
    if (protocolVersion !== MODERN_VERSION && !LEGACY_VERSIONS.has(protocolVersion)) throw configError("gateway_protocol_invalid", "Service protocol version is unsupported.");
    const binding = value.authorization === "$MESHRIX_INTEROP_UPSTREAM_AUTHORIZATION" ? "MESHRIX_INTEROP_UPSTREAM_AUTHORIZATION" : typeof value.authorization === "string" && /^env:[A-Z][A-Z0-9_]*$/u.test(value.authorization) ? value.authorization.slice(4) : undefined;
    if (value.authorization !== undefined && !binding) throw configError("gateway_credential_invalid", "Service authorization must be an environment binding, not an inline secret.");
    const authorization = binding ? process.env[binding] : undefined;
    if (binding && !authorization) throw configError("gateway_credential_missing", "The required environment credential is unavailable.");
    if (value.toolRisk !== undefined && !record(value.toolRisk)) throw configError("gateway_risk_invalid", "Tool risk declarations must be a keyed object.");
    const toolRisk = Object.fromEntries(Object.entries(record(value.toolRisk) ? value.toolRisk : {}).map(([name, risk]) => {
      if (!name || !["read", "safe_write", "destructive"].includes(String(risk))) throw configError("gateway_risk_invalid", "Every declared tool needs a recognized operator risk class.");
      return [name, risk];
    })) as Record<string, "read" | "safe_write" | "destructive">;
    return Object.freeze({ serviceId: value.serviceId, transport, ...(baseUrl ? { baseUrl, allowedHosts: Object.freeze(allowedHosts) } : {}), ...(command ? { command, args: Object.freeze(args), env: Object.freeze(env) } : {}), protocolVersion, toolRisk: Object.freeze(toolRisk), ...(authorization ? { authorization } : {}) });
  });
  if (new Set(services.map((service) => service.serviceId)).size !== services.length) throw configError("gateway_service_duplicate", "Service identities must be unique.");
  if (remoteAuth && remoteAuth.allowedServiceIds.some((id) => !services.some((service) => service.serviceId === id))) throw configError("gateway_remote_auth_invalid", "Remote grant references an unknown service.");
  return Object.freeze({ profile, listen: { host, port }, services: Object.freeze(services), ...(remoteAuth ? { remoteAuth } : {}) });
}

async function version(): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  if (!record(manifest) || typeof manifest.version !== "string") throw configError("gateway_package_invalid", "Installed package has no version.");
  return manifest.version;
}

async function fetchRpc(endpoint: string, request: Readonly<Record<string, unknown>>, headers: Readonly<Record<string, string>>, signal?: AbortSignal, remote?: RuntimeConfig["remoteAuth"]) {
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const init = { method: "POST", body: JSON.stringify(request), headers, redirect: "manual" as const, signal: boundedSignal };
  const literalLoopback = ["127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname);
  const pinned = remote ? await fetchWithPinnedDns({ url: endpoint, init, maxRedirects: 0,
    policies: remote.allowLoopbackUpstreams && literalLoopback ? { egress: { allowLocalForDevelopment: true } } : {}, label: "gateway.remote.upstream" }) : undefined;
  const response = pinned?.response ?? await fetch(endpoint, init);
  const chunks: Buffer[] = [];
  let size = 0;
  try { if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) throw configError("gateway_response_oversize", "Peer response exceeds the configured budget.");
        chunks.push(chunk);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } } finally { await pinned?.close(); }
  const text = Buffer.concat(chunks).toString("utf8");
  return { status: response.status, headers: Object.fromEntries(response.headers), body: text ? JSON.parse(text) as unknown : null };
}

class StdioPeerTransport {
  readonly #child: ChildProcess;
  readonly #pending = new Map<string, { resolve: (value: { status: number; body: unknown }) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout>; abort: () => void; signal?: AbortSignal }>();
  #partial = "";
  #closed = false;

  constructor(service: ServiceConfig) {
    if (!service.command) throw configError("gateway_stdio_invalid", "Stdio peer command is unavailable.");
    this.#child = spawn(service.command, [...(service.args ?? [])], { stdio: ["pipe", "pipe", "pipe"], shell: false,
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...service.env } });
    this.#child.stderr?.on("data", () => {});
    this.#child.stdin?.on("error", () => this.#fail(configError("gateway_stdio_lost", "Stdio peer input closed unexpectedly.")));
    this.#child.stdout?.setEncoding("utf8");
    this.#child.stdout?.on("data", (chunk: string) => {
      this.#partial += chunk;
      if (Buffer.byteLength(this.#partial) > MAX_REQUEST_BYTES) { this.#fail(configError("gateway_response_oversize", "Stdio peer response exceeded the budget.")); return; }
      let boundary: number;
      while ((boundary = this.#partial.indexOf("\n")) >= 0) {
        const line = this.#partial.slice(0, boundary).trim();
        this.#partial = this.#partial.slice(boundary + 1);
        if (!line) continue;
        let body: RecordValue;
        try { const parsed: unknown = JSON.parse(line); if (!record(parsed)) throw new Error("bad response"); body = parsed; }
        catch { this.#fail(configError("gateway_stdio_invalid", "Stdio peer sent invalid JSON-RPC.")); return; }
        const id = String(body.id ?? "");
        const waiting = this.#pending.get(id);
        if (!waiting) continue;
        this.#pending.delete(id);
        clearTimeout(waiting.timer);
        waiting.signal?.removeEventListener("abort", waiting.abort);
        waiting.resolve({ status: 200, body });
      }
    });
    this.#child.once("error", () => this.#fail(configError("gateway_stdio_lost", "Stdio peer failed to start.")));
    this.#child.once("exit", () => this.#fail(configError("gateway_stdio_lost", "Stdio peer exited.")));
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.abort);
      pending.reject(error);
      this.#pending.delete(id);
    }
    if (this.#child.exitCode === null) this.#child.kill("SIGTERM");
  }

  send({ request, signal }: { readonly request: Readonly<Record<string, unknown>>; readonly signal?: AbortSignal }): Promise<{ status: number; body: unknown }> {
    if (this.#closed || !this.#child.stdin?.writable) return Promise.reject(configError("gateway_stdio_lost", "Stdio peer is unavailable."));
    const wire = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(wire) > MAX_REQUEST_BYTES) return Promise.reject(configError("gateway_request_oversize", "Stdio request exceeds the budget."));
    const id = request.id;
    if (id === undefined) { this.#child.stdin.write(wire); return Promise.resolve({ status: 202, body: null }); }
    const key = String(id);
    if (this.#pending.has(key)) return Promise.reject(configError("gateway_stdio_duplicate_id", "Stdio request identity is already active."));
    return new Promise((resolve, reject) => {
      const abort = () => { const pending = this.#pending.get(key); if (pending) { clearTimeout(pending.timer); this.#pending.delete(key); reject(configError("gateway_stdio_cancelled", "Stdio request was cancelled.")); } };
      const timer = setTimeout(() => {
        this.#pending.delete(key);
        signal?.removeEventListener("abort", abort);
        reject(configError("gateway_stdio_timeout", "Stdio peer exceeded its response deadline."));
      }, 30_000);
      this.#pending.set(key, { resolve, reject, timer, abort, signal });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      this.#child.stdin!.write(wire);
    });
  }

  async close(): Promise<void> {
    if (this.#child.exitCode === null) {
      const exited = new Promise<void>((resolve) => this.#child.once("exit", () => resolve()));
      this.#fail(configError("gateway_stdio_closed", "Stdio peer was closed."));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]); }
      finally { if (timer) clearTimeout(timer); }
      if (this.#child.exitCode === null) { this.#child.kill("SIGKILL"); await exited; }
    }
  }
}

async function createRuntime(config: RuntimeConfig, serverVersion: string, signal?: AbortSignal) {
  if (config.services.length === 0) throw configError("gateway_services_missing", "A serving gateway requires at least one configured upstream service.");
  const transports = new Map<string, UpstreamPort>();
  const descriptors: CatalogDescriptor[] = [];
  const externalSchemas = createIsolatedSchemaValidator();
  const credentials = new Map<string, string>();
  try {
  for (const service of config.services) {
    if (signal?.aborted) throw configError("gateway_start_cancelled", "Gateway startup was cancelled.");
    const identity = digest([service.serviceId, service.transport, service.baseUrl, service.command, service.args, service.protocolVersion]);
    const transport = service.transport === "stdio"
      ? new StdioPeerTransport(service)
      : { send: ({ request, headers, signal }: { request: Readonly<Record<string, unknown>>; headers: Readonly<Record<string, string>>; signal?: AbortSignal }) => fetchRpc(service.baseUrl!, request, headers, signal, config.remoteAuth) };
    const adapter: UpstreamPort = service.protocolVersion === MODERN_VERSION
      ? createModernUpstreamAdapter({ transport, clientInfo: { name: "meshrix-gateway", version: serverVersion } })
      : createLegacyMcpAdapter({ version: service.protocolVersion, transport });
    transports.set(service.serviceId, adapter);
    if (service.authorization) credentials.set(identity, service.authorization);
    const route: RouteSnapshot = Object.freeze({ logicalRoute: `${service.serviceId}:catalog`, upstreamIdentity: service.serviceId, endpointIdentity: identity, protocolVersion: service.protocolVersion, schemaDigest: "catalog", policyRef: "local", revision: identity, effectClass: "read" });
    const context: AuthenticatedContext = { tenant: "local", principal: "discovery", authGeneration: "local", grant: { revision: "local", routes: [route.logicalRoute] } };
    for (const [method, kind, field] of [["tools/list", "tool", "tools"], ["resources/list", "resource", "resources"], ["resources/templates/list", "resource_template", "resourceTemplates"], ["prompts/list", "prompt", "prompts"]] as const) {
      const reply = await adapter.invoke({ context, request: { id: `${service.serviceId}-${method}`, method, params: {}, protocolVersion: service.protocolVersion, headers: {} }, route, signal, credential: service.authorization ? { Authorization: service.authorization } : undefined });
      if (!("status" in reply) || reply.status >= 400 || !record(reply.body) || !record(reply.body.result) || !Array.isArray(reply.body.result[field])) {
        if (method === "tools/list") throw configError("gateway_discovery_failed", "Upstream tool discovery failed.");
        continue;
      }
      for (const item of reply.body.result[field]) {
        if (!record(item)) continue;
        try {
          if (item.inputSchema !== undefined) await externalSchemas.preflight(item.inputSchema, signal);
          if (item.outputSchema !== undefined) await externalSchemas.preflight(item.outputSchema, signal);
        } catch { continue; }
        const name = typeof item.name === "string" ? item.name : "";
        const uri = typeof item.uri === "string" ? item.uri : typeof item.uriTemplate === "string" ? item.uriTemplate : "";
        if (!name && !uri) continue;
        const routeRef = `${service.serviceId}:${kind}:${digest([name, uri]).slice(0, 20)}`;
        const routeSnapshot: RouteSnapshot = Object.freeze({ ...route, logicalRoute: routeRef, schemaDigest: digest([item.inputSchema, item.outputSchema]), effectClass: kind === "tool" ? Object.hasOwn(service.toolRisk, name) ? service.toolRisk[name] : "unknown" : "read", operation: kind === "tool" ? "tools/call" : kind === "prompt" ? "prompts/get" : "resources/read", ...(name ? { upstreamName: name } : {}), ...(uri ? { upstreamUri: uri } : {}), ...(service.authorization ? { metadata: { credentialBinding: identity } } : {}) });
        descriptors.push({ kind, route: routeSnapshot, ...(name ? { upstreamName: name, publicName: name } : {}), ...(uri ? { upstreamUri: uri, publicUri: uri } : {}), ...(typeof item.description === "string" ? { description: item.description } : {}), ...(item.inputSchema !== undefined ? { inputSchema: item.inputSchema } : {}), ...(item.outputSchema !== undefined ? { outputSchema: item.outputSchema } : {}), ...(record(item.annotations) ? { annotations: item.annotations } : {}), ...(record(item._meta) ? { metadata: item._meta } : {}) });
      }
    }
  }
  } catch (error) {
    await externalSchemas.close();
    await Promise.allSettled([...transports.values()].map((adapter) => adapter.close?.()));
    throw error;
  }
  await externalSchemas.close();
  let gateway;
  try {
    if (signal?.aborted) throw configError("gateway_start_cancelled", "Gateway startup was cancelled.");
    gateway = createGateway({
    policy: createGatewayPolicy(), permits: createGatewayPermitAuthority(), descriptors,
    credentialProvider: { async resolve({ binding }) { const authorization = credentials.get(binding); if (!authorization) throw configError("gateway_credential_missing", "Credential binding is unavailable."); return { Authorization: authorization }; } },
    continuationKey: randomBytes(32),
    upstream: { async invoke(input) { const adapter = transports.get(input.route.upstreamIdentity); if (!adapter) throw configError("gateway_target_missing", "Upstream target is unavailable."); return adapter.invoke(input); }, async close() { await Promise.all([...transports.values()].map((adapter) => adapter.close?.())); } },
    ownedUpstream: true, serverInfo: { name: "meshrix-gateway", version: serverVersion }
  });
  await gateway.start(); }
  catch (error) {
    if (gateway) await gateway.close({ drainDeadline: 1000 }).catch(() => {});
    else await Promise.allSettled([...transports.values()].map((adapter) => adapter.close?.()));
    throw error;
  }
  const context: AuthenticatedContext = { tenant: config.profile, principal: config.profile === "local" ? "local-client" : "remote-operator", authGeneration: `${config.profile}-1`, grant: { revision: `${config.profile}-1`,
    routes: descriptors.filter((descriptor) => !config.remoteAuth || config.remoteAuth.allowedServiceIds.includes(descriptor.route.upstreamIdentity)).map((descriptor) => descriptor.route.logicalRoute),
    ...(config.remoteAuth?.expiresAt ? { expiresAt: config.remoteAuth.expiresAt } : {}) } };
  const authenticated = (header: unknown): boolean => {
    if (!config.remoteAuth || typeof header !== "string") return config.profile === "local";
    const secret = process.env[config.remoteAuth.bearerTokenEnv];
    if (!secret || config.remoteAuth.expiresAt !== undefined && config.remoteAuth.expiresAt <= Date.now()) return false;
    const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
    const supplied = createHash("sha256").update(header).digest();
    return timingSafeEqual(expected, supplied);
  };
  const adapter = createModernDownstreamAdapter({ gateway, serverInfo: { name: "meshrix-gateway", version: serverVersion }, authenticate: (request) => {
    if (!authenticated(request.headers?.authorization)) throw Object.assign(new Error("Gateway credential is invalid."), { code: "gateway_auth_required", status: 401 });
    return context;
  } });
  return { gateway, adapter, authenticated };
}

async function requestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw configError("gateway_request_oversize", "Request exceeds the configured byte budget.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export interface GatewayOnlyCliOptions { readonly health?: boolean; readonly dryRun?: boolean; readonly config?: string; }

/** Read-only check; unlike serve, this never contacts an upstream or starts a listener. */
export async function runGatewayOnly(options: GatewayOnlyCliOptions = {}): Promise<{ readonly profile: "gateway-only"; readonly health: "ok" | "dry-run" }> {
  if (options.dryRun) {
    if (options.config) await loadConfig(options.config);
    return Object.freeze({ profile: "gateway-only", health: "dry-run" });
  }
  await loadConfig(options.config);
  return Object.freeze({ profile: "gateway-only", health: "ok" });
}

export async function serveGateway(configPath?: string): Promise<void> {
  const config = await loadConfig(configPath);
  const serverVersion = await version();
  const startup = new AbortController();
  const cancelStartup = () => startup.abort();
  process.once("SIGTERM", cancelStartup);
  process.once("SIGINT", cancelStartup);
  let runtime;
  try { runtime = await createRuntime(config, serverVersion, startup.signal); }
  finally { process.off("SIGTERM", cancelStartup); process.off("SIGINT", cancelStartup); }
  const { gateway, adapter, authenticated } = runtime;
  let stopping = false;
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (config.remoteAuth && !authenticated(request.headers.authorization)) { response.writeHead(401).end(); return; }
      if (request.url === "/health" && request.method === "GET") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ status: stopping ? "stopping" : "ok" }));
        return;
      }
      if (request.url !== "/mcp") { response.writeHead(404).end(); return; }
      const body = await requestJson(request);
      const controller = new AbortController();
      const disconnected = () => { if (!response.writableEnded) controller.abort(); };
      response.once("close", disconnected);
      try {
        const answer = await adapter.handle({ method: request.method ?? "POST", headers: request.headers, body, signal: controller.signal });
        if (answer.stream) {
          response.writeHead(answer.status, { ...answer.headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          response.write(`data: ${JSON.stringify(answer.body)}\n\n`);
          try {
            for await (const event of answer.stream) {
              if (controller.signal.aborted) break;
              if (!response.write(`data: ${JSON.stringify(event)}\n\n`)) await new Promise<void>((resolve) => {
                const done = () => { response.off("drain", done); response.off("close", done); resolve(); };
                response.once("drain", done);
                response.once("close", done);
              });
            }
          } finally { answer.close?.(); response.end(); }
        } else {
          response.writeHead(answer.status, answer.headers);
          response.end(answer.body === undefined ? undefined : JSON.stringify(answer.body));
        }
      } finally { response.off("close", disconnected); }
    } catch {
      if (response.headersSent) { response.end(); return; }
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Gateway request was rejected." } }));
    }
  };
  const server = config.remoteAuth
    ? createSecureServer({ key: process.env[config.remoteAuth.tlsKeyEnv]!, cert: process.env[config.remoteAuth.tlsCertEnv]! }, handler)
    : createServer(handler);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.listen.port, config.listen.host, resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw configError("gateway_listener_failed", "Gateway listener has no TCP address.");
    process.stdout.write(`${JSON.stringify({ interopEndpoint: `${config.remoteAuth ? "https" : "http"}://127.0.0.1:${address.port}/mcp` })}\n`);
    await new Promise<void>((resolve) => {
      const shutdown = () => { if (stopping) return; stopping = true; server.close(() => resolve()); };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    });
  } finally { await gateway.close({ drainDeadline: 5_000 }); }
}

/** Standard newline-framed MCP over stdio; stdout never carries readiness or diagnostics. */
export async function serveStdioGateway(configPath?: string): Promise<void> {
  const config = await loadConfig(configPath);
  if (config.remoteAuth) throw configError("gateway_remote_stdio_unsupported", "Remote profile requires an authenticated TLS listener.");
  const startup = new AbortController();
  const cancelStartup = () => startup.abort();
  process.once("SIGTERM", cancelStartup);
  process.once("SIGINT", cancelStartup);
  let runtime;
  try { runtime = await createRuntime(config, await version(), startup.signal); }
  finally { process.off("SIGTERM", cancelStartup); process.off("SIGINT", cancelStartup); }
  const { gateway, adapter } = runtime;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lifetime = new AbortController();
  const stop = () => { lifetime.abort(); lines.close(); process.stdin.pause(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let reply: unknown;
      try {
        if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) throw configError("gateway_request_oversize", "Stdio request exceeds the byte budget.");
        const body: unknown = JSON.parse(line);
        const answer = await adapter.handle({ method: "POST", headers: { "content-type": "application/json", "mcp-protocol-version": MODERN_VERSION }, body, signal: lifetime.signal });
        if (answer.stream) {
          answer.close?.();
          throw configError("gateway_stdio_stream_unsupported", "Stdio transport cannot expose HTTP event streams.");
        }
        reply = answer.body;
      } catch {
        reply = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Gateway request was rejected." } };
      }
      if (reply !== undefined) {
        const serialized = JSON.stringify(reply);
        if (!process.stdout.write(`${serialized}\n`)) await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
      }
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    lines.close();
    await gateway.close({ drainDeadline: 5_000 });
  }
}

/** The installed and source CLIs invoke the same authoritative migration owner. */
export async function migrateGateway(command: "preview" | "apply" | "restore", inputPath: string, options: { readonly expectedRevision?: string; readonly backupRevision?: string; readonly backupPath?: string } = {}): Promise<unknown> {
  if (!inputPath) throw configError("gateway_migration_input_required", "Migration requires --input.");
  const owner = import.meta.url.endsWith(".ts")
    ? new URL("../../../tools/server-scripts/migrate-gateway-config.ts", import.meta.url)
    : new URL("./migration/migrate-gateway-config.js", import.meta.url);
  const migration = await import(owner.href) as typeof import("../../../tools/server-scripts/migrate-gateway-config.ts");
  if (command === "preview") return migration.previewGatewayMigration(inputPath, { expectedRevision: options.expectedRevision });
  if (!options.expectedRevision) throw configError("gateway_migration_preview_required", "Apply or restore requires --expected-revision from preview.");
  if (command === "apply") return migration.applyGatewayMigration(inputPath, { expectedRevision: options.expectedRevision, backupPath: options.backupPath });
  if (!options.backupRevision) throw configError("gateway_migration_backup_required", "Restore requires --backup-revision.");
  return migration.restoreGatewayMigration(inputPath, { expectedRevision: options.expectedRevision, backupRevision: options.backupRevision, backupPath: options.backupPath });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const command = process.argv[2] ?? "check";
  const configIndex = process.argv.indexOf("--config");
  const config = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
  const transportIndex = process.argv.indexOf("--transport");
  const transport = transportIndex >= 0 ? process.argv[transportIndex + 1] : "http";
  const option = (flag: string) => { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : undefined; };
  const action = command === "serve"
    ? transport === "http" ? serveGateway(config) : transport === "stdio" ? serveStdioGateway(config) : Promise.reject(configError("gateway_transport_invalid", "Expected http or stdio."))
    : command === "check" || command === "health" ? runGatewayOnly({ config }).then((value) => { process.stdout.write(`${JSON.stringify(value)}\n`); })
    : command === "migrate" && ["preview", "apply", "restore"].includes(process.argv[3] ?? "")
      ? migrateGateway(process.argv[3] as "preview" | "apply" | "restore", option("--input") ?? "", {
          expectedRevision: option("--expected-revision"), backupRevision: option("--backup-revision"), backupPath: option("--backup")
        }).then((report) => { process.stdout.write(`${JSON.stringify(report)}\n`); })
    : Promise.reject(configError("gateway_command_invalid", "Expected serve, check, or health."));
  action.catch((error: unknown) => { process.stderr.write(`${String((error as { code?: unknown })?.code ?? "gateway_failed")}\n`); process.exitCode = 1; });
}
