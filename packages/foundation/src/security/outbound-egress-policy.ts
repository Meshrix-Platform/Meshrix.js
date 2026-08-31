import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as undiciFetch, request as undiciRequest } from "undici";

export const OUTBOUND_EGRESS_DECISION_VERSION = "v0.0.1:security:outbound-egress-decision-1";
export const DEVELOPMENT_LOCAL_EGRESS_POLICY_PRESET = "security.development-local";
export const OUTBOUND_REDIRECT_DECISION_VERSION = "v0.0.1:security:outbound-redirect-decision-1";

type DataRecord = Record<string, unknown>;
type AddressCategory = "benchmark" | "carrier-grade-nat" | "cloud-metadata" | "hostname" | "invalid" | "link-local" | "loopback" | "multicast" | "private" | "public" | "reserved" | "unspecified";
type HostKind = "hostname" | "ipv4" | "ipv6" | "missing";
type DnsLookup = (host: string, options: { all: true; verbatim: true }) => Promise<unknown>;
type FetchImplementation = typeof undiciFetch;
type RequestImplementation = typeof undiciRequest;
type FetchResponse = Awaited<ReturnType<FetchImplementation>> | globalThis.Response;
type RequestResponse = Awaited<ReturnType<RequestImplementation>>;

export interface OutboundEgressPolicies {
  egress?: {
    allowLocalForConfiguredModelService?: boolean;
    allowLocalForDevelopment?: boolean;
  };
}

export interface OutboundHostClassification {
  host: string;
  kind: HostKind;
  category: AddressCategory;
  restricted: boolean;
  metadataEndpoint: boolean;
}

export interface OutboundEgressOptions {
  url?: string | URL;
  policyPreset?: string;
  policies?: OutboundEgressPolicies;
  label?: string;
}

export interface OutboundEgressDecision {
  schemaVersion: typeof OUTBOUND_EGRESS_DECISION_VERSION;
  ok: boolean;
  label: string;
  url: string;
  reason: string;
  protocol?: string;
  host?: string;
  port?: string;
  hostKind?: HostKind;
  addressCategory?: AddressCategory;
  metadataEndpoint?: boolean;
  allowLocalForDevelopment?: boolean;
  allowLocalForConfiguredModelService?: boolean;
  allowLoopbackAndPrivate?: boolean;
  allowLinkLocal?: false;
}

interface DnsAddressDecision {
  address: string;
  family: 4 | 6;
  hostKind: HostKind;
  addressCategory: AddressCategory;
  restricted: boolean;
  metadataEndpoint: boolean;
}

interface DnsDecision {
  status: "failed" | "resolved" | "skipped";
  reason?: string;
  host?: string;
  error?: string;
  addresses?: DnsAddressDecision[];
  addressCount?: number;
  restrictedAddressCount?: number;
  deniedAddressCount?: number;
}

export interface OutboundRuntimeEgressDecision extends OutboundEgressDecision {
  dns: DnsDecision;
}

export interface PinnedDnsAddress {
  host: string;
  address: string;
  family: number;
  addressCategory: string;
  restricted: boolean;
}

interface PinnedDnsDispatcher {
  dispatcher: Agent | undefined;
  pinnedDns: PinnedDnsAddress | null;
  close: () => Promise<void>;
}

export interface FetchWithPinnedDnsOptions extends OutboundEgressOptions {
  init?: Parameters<FetchImplementation>[1];
  lookup?: DnsLookup;
  fetchImpl?: FetchImplementation;
  maxRedirects?: number;
}

export interface RequestWithPinnedDnsOptions extends OutboundEgressOptions {
  init?: Parameters<RequestImplementation>[1] & { maxRedirections?: number };
  lookup?: DnsLookup;
  requestImpl?: RequestImplementation;
  maxRedirects?: number;
}

export interface PinnedFetchResult {
  response: FetchResponse;
  decision: OutboundRuntimeEgressDecision;
  egressDecision: OutboundRuntimeEgressDecision;
  pinnedDns: PinnedDnsAddress | null;
  close: () => Promise<void>;
}

export interface PinnedRequestResult {
  response: RequestResponse;
  decision: OutboundRuntimeEgressDecision;
  egressDecision: OutboundRuntimeEgressDecision;
  pinnedDns: PinnedDnsAddress | null;
  close: () => Promise<void>;
}

type PinnedTransportResult = PinnedFetchResult | PinnedRequestResult;
type RedirectRequestInit = Record<string, unknown>;

export interface OutboundRedirectOptions {
  sourceUrl?: string;
  status?: number;
  location?: string;
  policyPreset?: string;
  policies?: OutboundEgressPolicies;
  label?: string;
}

export interface OutboundRedirectDecision {
  schemaVersion: typeof OUTBOUND_REDIRECT_DECISION_VERSION;
  ok: boolean;
  status: number;
  sourceUrl: string;
  location: string;
  reason: string;
  targetUrl?: string;
  targetDecision?: OutboundEgressDecision | OutboundRuntimeEgressDecision;
}

const LOCAL_NETWORK_ADDRESS_CATEGORIES = new Set<AddressCategory>(["loopback", "private"]);
const CLOUD_METADATA_HOSTS = new Set<string>(["instance-data.ec2.internal", "metadata.google.internal", "metadata.goog"]);
const CLOUD_METADATA_IPV4_ADDRESSES = new Set<string>(["169.254.169.254", "169.254.170.2", "169.254.170.23"]);
const AWS_METADATA_IPV6 = 0xfd000ec2000000000000000000000254n;

function dataRecord(value: unknown): DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as DataRecord : {};
}

function normalizeHost(value: unknown = ""): string {
  return String(value ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function ipv4Parts(value: unknown = ""): [number, number, number, number] | null {
  const parts = String(value ?? "").split(".").map((part) => Number(part));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts as [number, number, number, number]
    : null;
}

function ipv4RangeCategory(address: unknown = ""): AddressCategory | "" {
  const parts = ipv4Parts(address);
  if (!parts) return "";
  const [a, b] = parts;
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade-nat";
  if (a === 198 && (b === 18 || b === 19)) return "benchmark";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return "public";
}

function expandIpv6(address: unknown = ""): number[] | null {
  const input = String(address ?? "").toLowerCase();
  if (!input.includes(":")) return null;
  const split = input.split("::");
  if (split.length > 2) return null;
  const [headText = "", tailText = ""] = split;
  const head = headText ? headText.split(":").filter(Boolean) : [];
  const tail = tailText ? tailText.split(":").filter(Boolean) : [];
  const expandedTail: string[] = [];
  for (const part of tail) {
    if (part.includes(".")) {
      const v4 = ipv4Parts(part);
      if (!v4) return null;
      expandedTail.push(((v4[0] << 8) | v4[1]).toString(16));
      expandedTail.push(((v4[2] << 8) | v4[3]).toString(16));
    } else {
      expandedTail.push(part);
    }
  }
  const missing = 8 - head.length - expandedTail.length;
  if (missing < 0 || (!input.includes("::") && missing !== 0)) return null;
  const parts = [...head, ...Array.from({ length: missing }, () => "0"), ...expandedTail];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

function ipv6BigInt(parts: readonly number[]): bigint {
  return parts.reduce((acc, part) => (acc << 16n) + BigInt(part), 0n);
}

function cloudMetadataEndpoint(host: unknown = ""): boolean {
  const normalized = normalizeHost(host);
  if (CLOUD_METADATA_HOSTS.has(normalized) || CLOUD_METADATA_IPV4_ADDRESSES.has(normalized)) return true;
  const parts = expandIpv6(normalized);
  return Boolean(parts && ipv6BigInt(parts) === AWS_METADATA_IPV6);
}

function ipv6RangeCategory(address: unknown = ""): AddressCategory | "" {
  const parts = expandIpv6(address);
  if (!parts) return "";
  const value = ipv6BigInt(parts);
  if (value === 0n) return "unspecified";
  if (value === 1n) return "loopback";
  const first = parts[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) return "private";
  if ((first & 0xffc0) === 0xfe80) return "link-local";
  if ((first & 0xff00) === 0xff00) return "multicast";
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
    return ipv4RangeCategory(`${(parts[6] ?? 0) >> 8}.${(parts[6] ?? 0) & 255}.${(parts[7] ?? 0) >> 8}.${(parts[7] ?? 0) & 255}`);
  }
  return "public";
}

export function classifyOutboundHost(host: unknown = ""): OutboundHostClassification {
  const normalized = normalizeHost(host);
  if (!normalized) return { host: "", kind: "missing", category: "invalid", restricted: true, metadataEndpoint: false };
  if (CLOUD_METADATA_HOSTS.has(normalized)) return { host: normalized, kind: "hostname", category: "cloud-metadata", restricted: true, metadataEndpoint: true };
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return { host: normalized, kind: "hostname", category: "loopback", restricted: true, metadataEndpoint: false };
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    const category = ipv4RangeCategory(normalized) || "invalid";
    return { host: normalized, kind: "ipv4", category, restricted: category !== "public", metadataEndpoint: cloudMetadataEndpoint(normalized) };
  }
  if (ipVersion === 6) {
    const category = ipv6RangeCategory(normalized) || "invalid";
    return { host: normalized, kind: "ipv6", category, restricted: category !== "public", metadataEndpoint: cloudMetadataEndpoint(normalized) };
  }
  return { host: normalized, kind: "hostname", category: "hostname", restricted: false, metadataEndpoint: false };
}

export function localEgressAllowed({ policyPreset = "", policies = {} }: Pick<OutboundEgressOptions, "policyPreset" | "policies"> = {}): boolean {
  const egress = policies.egress;
  return policyPreset.trim() === DEVELOPMENT_LOCAL_EGRESS_POLICY_PRESET || egress?.allowLocalForDevelopment === true || egress?.allowLocalForConfiguredModelService === true;
}

function outboundHostAllowed(host: { category?: AddressCategory; addressCategory?: AddressCategory; metadataEndpoint: boolean; restricted: boolean }, allowLocal = false): boolean {
  const category = host.category ?? host.addressCategory ?? "invalid";
  if (host.metadataEndpoint || category === "link-local") return false;
  if (!host.restricted) return true;
  return allowLocal && LOCAL_NETWORK_ADDRESS_CATEGORIES.has(category);
}

export function evaluateOutboundEgressUrl({ url = "", policyPreset = "", policies = {}, label = "outbound.url" }: OutboundEgressOptions = {}): OutboundEgressDecision {
  const normalizedUrl = String(url).trim();
  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    return { schemaVersion: OUTBOUND_EGRESS_DECISION_VERSION, ok: false, label, url: normalizedUrl, reason: "invalid_url" };
  }
  const host = classifyOutboundHost(parsed.hostname);
  const allowLocalForDevelopment = policyPreset.trim() === DEVELOPMENT_LOCAL_EGRESS_POLICY_PRESET || policies.egress?.allowLocalForDevelopment === true;
  const allowLocalForConfiguredModelService = policies.egress?.allowLocalForConfiguredModelService === true;
  const allowLocal = localEgressAllowed({ policyPreset, policies });
  const blocked = !outboundHostAllowed(host, allowLocal);
  return {
    schemaVersion: OUTBOUND_EGRESS_DECISION_VERSION,
    ok: !blocked,
    label,
    url: parsed.toString(),
    protocol: parsed.protocol.replace(/:$/, ""),
    host: host.host,
    port: parsed.port,
    hostKind: host.kind,
    addressCategory: host.category,
    metadataEndpoint: host.metadataEndpoint,
    allowLocalForDevelopment,
    allowLocalForConfiguredModelService,
    allowLoopbackAndPrivate: allowLocal,
    allowLinkLocal: false,
    reason: blocked ? `restricted_address_${host.metadataEndpoint ? "cloud-metadata" : host.category}` : "allowed"
  };
}

function egressDenied(decision: OutboundEgressDecision | OutboundRedirectDecision): Error {
  const label = "label" in decision ? decision.label : "redirect.location";
  return Object.assign(new Error(`Outbound egress denied for ${label}: ${decision.reason}.`), { code: "outbound_egress_denied", decision });
}

export function assertOutboundEgressAllowed(options: OutboundEgressOptions = {}): OutboundEgressDecision {
  const decision = evaluateOutboundEgressUrl(options);
  if (!decision.ok) throw egressDenied(decision);
  return decision;
}

function normalizeDnsLookupRecords(records: unknown = []): DnsAddressDecision[] {
  const values = Array.isArray(records) ? records : [records];
  const seen = new Set<string>();
  const normalized: DnsAddressDecision[] = [];
  for (const record of values) {
    const source = dataRecord(record);
    const address = String(source.address ?? (typeof record === "string" ? record : "")).trim();
    const family = net.isIP(address);
    if (!address || (family !== 4 && family !== 6)) continue;
    const key = `${address}/${family}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const classified = classifyOutboundHost(address);
    normalized.push({ address, family, hostKind: classified.kind, addressCategory: classified.category, restricted: classified.restricted, metadataEndpoint: classified.metadataEndpoint });
  }
  return normalized;
}

const defaultDnsLookup: DnsLookup = (host, options) => dns.lookup(host, options);

function selectedPinnedDnsAddress(decision: OutboundRuntimeEgressDecision): DnsAddressDecision | null {
  const addresses = decision.dns.addresses ?? [];
  return addresses.find((record) => !record.restricted) ?? addresses[0] ?? null;
}

function createPinnedDnsDispatcher(decision: OutboundRuntimeEgressDecision): PinnedDnsDispatcher {
  const pinned = selectedPinnedDnsAddress(decision);
  if (!pinned?.address) return { dispatcher: undefined, pinnedDns: null, async close() {} };
  const expectedHost = normalizeHost(decision.host);
  const address = pinned.address.trim();
  const family = Number(pinned.family || net.isIP(address) || 0);
  const dispatcher = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        const requestedHost = normalizeHost(hostname);
        if (requestedHost && expectedHost && requestedHost !== expectedHost) {
          callback(new Error(`Pinned DNS lookup rejected unexpected host: ${requestedHost}`), "", 0);
          return;
        }
        if (options?.all) {
          callback(null, [{ address, family }]);
          return;
        }
        callback(null, address, family);
      }
    }
  });
  return {
    dispatcher,
    pinnedDns: { host: expectedHost, address, family, addressCategory: pinned.addressCategory, restricted: pinned.restricted },
    async close(): Promise<void> { await dispatcher.close(); }
  };
}

export async function evaluateOutboundEgressUrlWithDns({ lookup = defaultDnsLookup, ...options }: OutboundEgressOptions & { lookup?: DnsLookup } = {}): Promise<OutboundRuntimeEgressDecision> {
  const decision = evaluateOutboundEgressUrl(options);
  if (!decision.ok) return { ...decision, dns: { status: "skipped", reason: "host_decision_denied" } };
  if (decision.hostKind !== "hostname" || decision.addressCategory !== "hostname") return { ...decision, dns: { status: "skipped", reason: "literal_address" } };
  let records: unknown;
  try {
    records = await lookup(decision.host ?? "", { all: true, verbatim: true });
  } catch (error: unknown) {
    return { ...decision, ok: false, reason: "dns_lookup_failed", dns: { status: "failed", host: decision.host, error: normalizeErrorMessage(error) } };
  }
  const addresses = normalizeDnsLookupRecords(records);
  const restricted = addresses.filter((record) => record.restricted);
  const denied = addresses.filter((record) => !outboundHostAllowed(record, decision.allowLoopbackAndPrivate === true));
  const blocked = addresses.length === 0 || denied.length > 0;
  return {
    ...decision,
    ok: !blocked,
    reason: addresses.length === 0 ? "dns_no_addresses" : blocked ? `restricted_dns_address_${denied[0]?.metadataEndpoint ? "cloud-metadata" : denied[0]?.addressCategory}` : "allowed",
    dns: { status: "resolved", host: decision.host, addresses, addressCount: addresses.length, restrictedAddressCount: restricted.length, deniedAddressCount: denied.length }
  };
}

export async function assertOutboundRuntimeEgressAllowed(options: OutboundEgressOptions & { lookup?: DnsLookup } = {}): Promise<OutboundRuntimeEgressDecision> {
  const decision = await evaluateOutboundEgressUrlWithDns(options);
  if (!decision.ok) throw egressDenied(decision);
  return decision;
}

function throwWithDecision(error: unknown, decision: OutboundRuntimeEgressDecision): never {
  if (error instanceof Error) Object.assign(error, { decision });
  throw error;
}

function globalRequestInit(init: Parameters<FetchImplementation>[1]): globalThis.RequestInit | undefined {
  // Node's global fetch and undici use the same runtime request-init shape, but
  // their independently published declarations differ on typed-array bodies.
  return init as globalThis.RequestInit | undefined;
}

async function fetchPinnedDnsHop({ url = "", label = "outbound.url", policyPreset = "", policies = {}, init = {}, lookup = defaultDnsLookup, fetchImpl }: FetchWithPinnedDnsOptions = {}): Promise<PinnedFetchResult> {
  const decision = await assertOutboundRuntimeEgressAllowed({ url, label, policyPreset, policies, lookup });
  const pinned = createPinnedDnsDispatcher(decision);
  try {
    const requestInit = { ...init, ...(pinned.dispatcher ? { dispatcher: pinned.dispatcher } : {}) };
    const response = fetchImpl ? await fetchImpl(url, requestInit) : pinned.dispatcher ? await undiciFetch(url, requestInit) : await globalThis.fetch(url, globalRequestInit(init));
    return { response, decision, egressDecision: decision, pinnedDns: pinned.pinnedDns, close: pinned.close };
  } catch (error: unknown) {
    await pinned.close();
    throwWithDecision(error, decision);
  }
}

async function requestPinnedDnsHop({ url = "", label = "outbound.url", policyPreset = "", policies = {}, init = {}, lookup = defaultDnsLookup, requestImpl = undiciRequest }: RequestWithPinnedDnsOptions = {}): Promise<PinnedRequestResult> {
  const decision = await assertOutboundRuntimeEgressAllowed({ url, label, policyPreset, policies, lookup });
  const pinned = createPinnedDnsDispatcher(decision);
  try {
    const requestInit = { ...init, maxRedirections: 0, ...(pinned.dispatcher ? { dispatcher: pinned.dispatcher } : {}) };
    const response = await requestImpl(url, requestInit);
    return { response, decision, egressDecision: decision, pinnedDns: pinned.pinnedDns, close: pinned.close };
  } catch (error: unknown) {
    await pinned.close();
    throwWithDecision(error, decision);
  }
}

function responseHeader(response: FetchResponse | RequestResponse, name: string): string {
  const headers = (response as FetchResponse | RequestResponse).headers as unknown as {
    get?: (headerName: string) => string | null;
  } & Record<string, unknown>;
  if (typeof headers?.get === "function") return String(headers.get(name) || "");
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

async function closeRedirectResponse(result: PinnedTransportResult, { keepResponse = false }: Record<string, unknown> = {}): Promise<void> {
  try {
    if (keepResponse !== true) {
      const body = result.response.body as unknown as {
        cancel?: () => Promise<void>;
        dump?: () => Promise<void>;
        destroy?: () => void;
      } | null | undefined;
      if (typeof body?.cancel === "function") await body.cancel();
      else if (typeof body?.dump === "function") await body.dump();
      else body?.destroy?.();
    }
  } finally {
    if (keepResponse !== true) await result.close();
  }
}

function redirectInit(init: RedirectRequestInit, sourceUrl: string, targetUrl: string, status: number, fetchMode: boolean): RedirectRequestInit {
  const sourceMethod = String(init?.method || "GET").toUpperCase();
  const switchToGet = status === 303 || ((status === 301 || status === 302) && sourceMethod === "POST");
  const method = switchToGet ? "GET" : sourceMethod;
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  if (new URL(sourceUrl).origin !== new URL(targetUrl).origin) {
    for (const name of ["authorization", "cookie", "proxy-authorization"]) headers.delete(name);
  }
  if (switchToGet) {
    for (const name of ["content-length", "content-type", "transfer-encoding"]) headers.delete(name);
  }
  return {
    ...init,
    method,
    headers: Object.fromEntries(headers.entries()),
    ...(switchToGet ? { body: undefined } : {}),
    ...(fetchMode ? { redirect: "manual" } : { maxRedirections: 0 })
  };
}

function redirectLimit(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10) {
    throw new Error("outbound_redirect_limit_invalid");
  }
  return parsed;
}

export async function fetchWithPinnedDns(options: FetchWithPinnedDnsOptions = {}): Promise<PinnedFetchResult> {
  const maximum = redirectLimit(options.maxRedirects);
  let currentUrl = String(options.url || "");
  let currentInit: RedirectRequestInit = { ...(options.init || {}), redirect: "manual" } as RedirectRequestInit;
  const visited = new Set<string>();
  for (let hop = 0; hop <= maximum; hop += 1) {
    if (visited.has(currentUrl)) throw new Error("outbound_redirect_loop_detected");
    visited.add(currentUrl);
    const result = await fetchPinnedDnsHop({ ...options, url: currentUrl, init: currentInit });
    const status = Number(result.response?.status || 0);
    if (!redirectStatus(status)) return result;
    const decision = evaluateOutboundRedirectLocation({
      sourceUrl: currentUrl,
      status,
      location: responseHeader(result.response, "location"),
      policyPreset: options.policyPreset,
      policies: options.policies,
      label: `${options.label || "outbound.url"}.redirect`
    });
    await closeRedirectResponse(result, { keepResponse: maximum === 0 });
    if (maximum === 0) return result;
    if (!decision.ok || !decision.targetUrl) throw egressDenied(decision);
    if (hop === maximum) throw new Error("outbound_redirect_limit_exceeded");
    currentInit = redirectInit(currentInit, currentUrl, decision.targetUrl, status, true);
    currentUrl = decision.targetUrl;
  }
  throw new Error("outbound_redirect_limit_exceeded");
}

export async function requestWithPinnedDns(options: RequestWithPinnedDnsOptions = {}): Promise<PinnedRequestResult> {
  const maximum = redirectLimit(options.maxRedirects);
  let currentUrl = String(options.url || "");
  let currentInit: RedirectRequestInit = { ...(options.init || {}), maxRedirections: 0 } as RedirectRequestInit;
  const visited = new Set<string>();
  for (let hop = 0; hop <= maximum; hop += 1) {
    if (visited.has(currentUrl)) throw new Error("outbound_redirect_loop_detected");
    visited.add(currentUrl);
    const result = await requestPinnedDnsHop({ ...options, url: currentUrl, init: currentInit });
    const status = Number(result.response?.statusCode || 0);
    if (!redirectStatus(status)) return result;
    const decision = evaluateOutboundRedirectLocation({
      sourceUrl: currentUrl,
      status,
      location: responseHeader(result.response, "location"),
      policyPreset: options.policyPreset,
      policies: options.policies,
      label: `${options.label || "outbound.url"}.redirect`
    });
    await closeRedirectResponse(result, { keepResponse: maximum === 0 });
    if (maximum === 0) return result;
    if (!decision.ok || !decision.targetUrl) throw egressDenied(decision);
    if (hop === maximum) throw new Error("outbound_redirect_limit_exceeded");
    currentInit = redirectInit(currentInit, currentUrl, decision.targetUrl, status, false);
    currentUrl = decision.targetUrl;
  }
  throw new Error("outbound_redirect_limit_exceeded");
}

function redirectStatus(value: unknown): boolean {
  const status = Number(value ?? 0);
  return Number.isInteger(status) && status >= 300 && status < 400;
}

export function evaluateOutboundRedirectLocation({ sourceUrl = "", status = 0, location = "", policyPreset = "", policies = {}, label = "redirect.location" }: OutboundRedirectOptions = {}): OutboundRedirectDecision {
  const normalizedLocation = location.trim();
  if (!redirectStatus(status)) return { schemaVersion: OUTBOUND_REDIRECT_DECISION_VERSION, ok: true, status: Number(status), sourceUrl: sourceUrl.trim(), location: normalizedLocation, reason: "not_redirect" };
  if (!normalizedLocation) return { schemaVersion: OUTBOUND_REDIRECT_DECISION_VERSION, ok: false, status: Number(status), sourceUrl: sourceUrl.trim(), location: "", reason: "redirect_location_missing" };
  let target: URL;
  try {
    target = new URL(normalizedLocation, sourceUrl.trim());
  } catch {
    return { schemaVersion: OUTBOUND_REDIRECT_DECISION_VERSION, ok: false, status: Number(status), sourceUrl: sourceUrl.trim(), location: normalizedLocation, reason: "invalid_redirect_location" };
  }
  const targetUrl = target.toString();
  if (target.protocol !== "http:" && target.protocol !== "https:") return { schemaVersion: OUTBOUND_REDIRECT_DECISION_VERSION, ok: false, status: Number(status), sourceUrl: sourceUrl.trim(), location: normalizedLocation, targetUrl, reason: "unsupported_redirect_protocol" };
  const targetDecision = evaluateOutboundEgressUrl({ url: targetUrl, policyPreset, policies, label });
  return { schemaVersion: OUTBOUND_REDIRECT_DECISION_VERSION, ok: targetDecision.ok, status: Number(status), sourceUrl: sourceUrl.trim(), location: normalizedLocation, targetUrl, reason: targetDecision.ok ? "redirect_location_allowed" : targetDecision.reason, targetDecision };
}

export async function evaluateOutboundRedirectLocationWithDns({ lookup = defaultDnsLookup, ...options }: OutboundRedirectOptions & { lookup?: DnsLookup } = {}): Promise<OutboundRedirectDecision> {
  const decision = evaluateOutboundRedirectLocation(options);
  if (!decision.ok || !decision.targetUrl) return decision;
  const targetDecision = await evaluateOutboundEgressUrlWithDns({ url: decision.targetUrl, policyPreset: options.policyPreset, policies: options.policies, label: options.label || "redirect.location", lookup });
  return { ...decision, ok: targetDecision.ok, reason: targetDecision.ok ? "redirect_location_allowed" : targetDecision.reason, targetDecision };
}
