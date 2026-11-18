import dns from "node:dns/promises";
import net from "node:net";
import { isUpstreamCredentialHeaderName } from "@meshrix/contracts/upstream-service-publishing";
import { Agent, fetch as undiciFetch, request as undiciRequest } from "undici";
import {
  classifyOutboundHost,
  cloudMetadataEndpoint,
  expandIpv6,
  ipv4Parts,
  ipv4RangeCategory,
  ipv6BigInt,
  ipv6RangeCategory,
  LOCAL_NETWORK_ADDRESS_CATEGORIES,
  normalizeOutboundHost,
  type AddressCategory,
  type HostKind,
  type OutboundHostClassification,
} from "./outbound-host-classifier.ts";

export {
  classifyOutboundHost,
  LOCAL_NETWORK_ADDRESS_CATEGORIES,
  type AddressCategory,
  type HostKind,
  type OutboundHostClassification,
};

export const OUTBOUND_EGRESS_DECISION_VERSION = "v0.0.1:security:outbound-egress-decision-1";
export const DEVELOPMENT_LOCAL_EGRESS_POLICY_PRESET = "security.development-local";
export const OUTBOUND_REDIRECT_DECISION_VERSION = "v0.0.1:security:outbound-redirect-decision-1";

type DataRecord = Record<string, unknown>;
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

export interface OutboundEgressOptions {
  url?: string | URL;
  policyPreset?: string;
  policies?: OutboundEgressPolicies;
  label?: string;
}

export interface OutboundResponseTimeouts {
  headersTimeout?: number;
  bodyTimeout?: number;
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
  beforeFetch?: () => void | Promise<void>;
  maxRedirects?: number;
  responseTimeouts?: OutboundResponseTimeouts;
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


const CROSS_ORIGIN_INTERNAL_HEADER_NAMES = new Set([
  "x-meshrix-gateway-service",
  "x-meshrix-skill-hub-subject"
]);
function dataRecord(value: unknown): DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as DataRecord : {};
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
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

function plaintextHttpMayReachLocalHost(host: OutboundHostClassification, allowLocal = false): boolean {
  if (!allowLocal) return false;
  if (LOCAL_NETWORK_ADDRESS_CATEGORIES.has(host.category)) return true;
  // A hostname can only be accepted provisionally here. Runtime egress performs
  // DNS validation and requires every answer to be loopback/private before use.
  return host.kind === "hostname" && host.category === "hostname";
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
  const plaintextRemote = parsed.protocol === "http:" && !plaintextHttpMayReachLocalHost(host, allowLocal);
  const ok = !blocked && !plaintextRemote;
  return {
    schemaVersion: OUTBOUND_EGRESS_DECISION_VERSION,
    ok,
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
    reason: blocked
      ? `restricted_address_${host.metadataEndpoint ? "cloud-metadata" : host.category}`
      : plaintextRemote
        ? "plaintext_remote_transport"
        : "allowed"
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

function createPinnedDnsDispatcher(decision: OutboundRuntimeEgressDecision, responseTimeouts?: OutboundResponseTimeouts): PinnedDnsDispatcher {
  const pinned = selectedPinnedDnsAddress(decision);
  if (!pinned?.address && !responseTimeouts) return { dispatcher: undefined, pinnedDns: null, async close() {} };
  const expectedHost = normalizeOutboundHost(decision.host);
  const address = String(pinned?.address || "").trim();
  const family = Number(pinned?.family || net.isIP(address) || 0);
  const dispatcher = new Agent({
    // Bound only TCP/TLS establishment. Response headers and body remain
    // governed by the operation's explicit budget or owner cancellation.
    connectTimeout: 10_000,
    ...(pinned?.address ? {
      connect: {
        lookup(hostname, options, callback) {
          const requestedHost = normalizeOutboundHost(hostname);
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
    } : {}),
    ...(responseTimeouts || {})
  });
  return {
    dispatcher,
    pinnedDns: pinned?.address ? { host: expectedHost, address, family, addressCategory: pinned.addressCategory, restricted: pinned.restricted } : null,
    async close(): Promise<void> { await dispatcher.close(); }
  };
}

export async function evaluateOutboundEgressUrlWithDns({ lookup = defaultDnsLookup, ...options }: OutboundEgressOptions & { lookup?: DnsLookup } = {}): Promise<OutboundRuntimeEgressDecision> {
  const decision = evaluateOutboundEgressUrl(options);
  if (!decision.ok) return { ...decision, dns: { status: "skipped", reason: "host_decision_denied" } };
  if (decision.hostKind !== "hostname") return { ...decision, dns: { status: "skipped", reason: "literal_address" } };
  let records: unknown;
  try {
    records = await lookup(decision.host ?? "", { all: true, verbatim: true });
  } catch (error: unknown) {
    return { ...decision, ok: false, reason: "dns_lookup_failed", dns: { status: "failed", host: decision.host, error: normalizeErrorMessage(error) } };
  }
  const addresses = normalizeDnsLookupRecords(records);
  const restricted = addresses.filter((record) => record.restricted);
  const denied = addresses.filter((record) => !outboundHostAllowed(record, decision.allowLoopbackAndPrivate === true));
  const plaintextRemote = decision.protocol === "http" && !(
    addresses.length > 0 &&
    decision.allowLoopbackAndPrivate === true &&
    addresses.every((record) => LOCAL_NETWORK_ADDRESS_CATEGORIES.has(record.addressCategory))
  );
  const blocked = addresses.length === 0 || denied.length > 0 || plaintextRemote;
  return {
    ...decision,
    ok: !blocked,
    reason: addresses.length === 0
      ? "dns_no_addresses"
      : denied.length > 0
        ? `restricted_dns_address_${denied[0]?.metadataEndpoint ? "cloud-metadata" : denied[0]?.addressCategory}`
        : plaintextRemote
          ? "plaintext_remote_transport"
          : "allowed",
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

async function fetchPinnedDnsHop({ url = "", label = "outbound.url", policyPreset = "", policies = {}, init = {}, lookup = defaultDnsLookup, fetchImpl, beforeFetch, responseTimeouts }: FetchWithPinnedDnsOptions = {}): Promise<PinnedFetchResult> {
  const decision = await assertOutboundRuntimeEgressAllowed({ url, label, policyPreset, policies, lookup });
  const pinned = createPinnedDnsDispatcher(decision, responseTimeouts);
  try {
    const requestInit = { ...init, ...(pinned.dispatcher ? { dispatcher: pinned.dispatcher } : {}) };
    await beforeFetch?.();
    const target = typeof url === "string" ? url : url.href;
    const response = fetchImpl ? await fetchImpl(target, requestInit) : pinned.dispatcher ? await undiciFetch(target, requestInit) : await globalThis.fetch(target, globalRequestInit(init));
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
    for (const name of [...headers.keys()]) {
      if (isUpstreamCredentialHeaderName(name) || CROSS_ORIGIN_INTERNAL_HEADER_NAMES.has(name)) {
        headers.delete(name);
      }
    }
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
