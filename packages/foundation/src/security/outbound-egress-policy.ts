import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as undiciFetch, request as undiciRequest } from "undici";

export const OUTBOUND_EGRESS_DECISION_VERSION: any = "v0.0.1:security:outbound-egress-decision-1";
export const DEVELOPMENT_LOCAL_EGRESS_POLICY_PRESET: any = "security.development-local";
export const OUTBOUND_REDIRECT_DECISION_VERSION: any = "v0.0.1:security:outbound-redirect-decision-1";

const LOCAL_NETWORK_ADDRESS_CATEGORIES: any = new Set<any>(["loopback", "private"]);
const CLOUD_METADATA_HOSTS: any = new Set<any>([
  "instance-data.ec2.internal",
  "metadata.google.internal",
  "metadata.goog"
]);
const CLOUD_METADATA_IPV4_ADDRESSES: any = new Set<any>([
  "169.254.169.254",
  "169.254.170.2",
  "169.254.170.23"
]);
const AWS_METADATA_IPV6: any = 0xfd000ec2000000000000000000000254n;

function asObject(value?: any, fallback: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function normalizeHost(value: any = "") : any {
  return String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function normalizeErrorMessage(error?: any) : any {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

function ipv4Parts(value: any = "") : any {
  const parts: any = String(value || "").split(".").map((part?: any) : any => Number(part));
  return parts.length === 4 && parts.every((part?: any) : any => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function ipv4RangeCategory(address: any = "") : any {
  const parts: any = ipv4Parts(address);
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

function expandIpv6(address: any = "") : any {
  const input: any = String(address || "").toLowerCase();
  if (!input.includes(":")) {
    return null;
  }
  const [headText, tailText] = input.split("::");
  if (input.split("::").length > 2) {
    return null;
  }
  const head: any = headText ? headText.split(":").filter(Boolean) : [];
  const tail: any = tailText ? tailText.split(":").filter(Boolean) : [];
  const expandedTail: any[] = [];
  for (const part of tail) {
    if (part.includes(".")) {
      const v4: any = ipv4Parts(part);
      if (!v4) return null;
      expandedTail.push(((v4[0] << 8) | v4[1]).toString(16));
      expandedTail.push(((v4[2] << 8) | v4[3]).toString(16));
    } else {
      expandedTail.push(part);
    }
  }
  const missing: any = 8 - head.length - expandedTail.length;
  if (missing < 0 || (!input.includes("::") && missing !== 0)) {
    return null;
  }
  const parts: any[] = [
    ...head,
    ...Array.from({ length: missing }, () : any => "0"),
    ...expandedTail
  ];
  if (parts.length !== 8 || parts.some((part?: any) : any => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }
  return parts.map((part?: any) : any => Number.parseInt(part, 16));
}

function ipv6BigInt(parts: any = []) : any {
  return parts.reduce((acc?: any, part?: any) : any => (acc << 16n) + BigInt(part), 0n);
}

function cloudMetadataEndpoint(host: any = "") : any {
  const normalized: any = normalizeHost(host);
  if (CLOUD_METADATA_HOSTS.has(normalized) || CLOUD_METADATA_IPV4_ADDRESSES.has(normalized)) {
    return true;
  }
  const parts: any = expandIpv6(normalized);
  return Boolean(parts && ipv6BigInt(parts) === AWS_METADATA_IPV6);
}

function ipv6RangeCategory(address: any = "") : any {
  const parts: any = expandIpv6(address);
  if (!parts) return "";
  const value: any = ipv6BigInt(parts);
  if (value === 0n) return "unspecified";
  if (value === 1n) return "loopback";
  const first: any = parts[0];
  if ((first & 0xfe00) === 0xfc00) return "private";
  if ((first & 0xffc0) === 0xfe80) return "link-local";
  if ((first & 0xff00) === 0xff00) return "multicast";
  if (parts.slice(0, 5).every((part?: any) : any => part === 0) && parts[5] === 0xffff) {
    return ipv4RangeCategory(`${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`);
  }
  return "public";
}

export function classifyOutboundHost(host: any = "") : any {
  const normalized: any = normalizeHost(host);
  if (!normalized) {
    return { host: "", kind: "missing", category: "invalid", restricted: true, metadataEndpoint: false };
  }
  if (CLOUD_METADATA_HOSTS.has(normalized)) {
    return { host: normalized, kind: "hostname", category: "cloud-metadata", restricted: true, metadataEndpoint: true };
  }
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return { host: normalized, kind: "hostname", category: "loopback", restricted: true, metadataEndpoint: false };
  }
  const ipVersion: any = net.isIP(normalized);
  if (ipVersion === 4) {
    const category: any = ipv4RangeCategory(normalized);
    return {
      host: normalized,
      kind: "ipv4",
      category,
      restricted: category !== "public",
      metadataEndpoint: cloudMetadataEndpoint(normalized)
    };
  }
  if (ipVersion === 6) {
    const category: any = ipv6RangeCategory(normalized);
    return {
      host: normalized,
      kind: "ipv6",
      category,
      restricted: category !== "public",
      metadataEndpoint: cloudMetadataEndpoint(normalized)
    };
  }
  return { host: normalized, kind: "hostname", category: "hostname", restricted: false, metadataEndpoint: false };
}

export function localEgressAllowed({ policyPreset = "", policies = {} }: Record<string, any> = {}) : any {
  const egress: any = asObject(asObject(policies).egress);
  return String(policyPreset || "").trim() === DEVELOPMENT_LOCAL_EGRESS_POLICY_PRESET ||
    egress.allowLocalForDevelopment === true ||
    egress.allowLocalForConfiguredModelService === true;
}

function outboundHostAllowed(host: Record<string, any> = {}, allowLocal: any = false) : any {
  const category: any = String(host.category || host.addressCategory || "");
  if (host.metadataEndpoint === true || category === "link-local") {
    return false;
  }
  if (!host.restricted) {
    return true;
  }
  return allowLocal && LOCAL_NETWORK_ADDRESS_CATEGORIES.has(category);
}

export function evaluateOutboundEgressUrl({
  url = "",
  policyPreset = "",
  policies = {},
  label = "outbound.url"
}: Record<string, any> = {}) : any {
  let parsed: any;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    return {
      schemaVersion: OUTBOUND_EGRESS_DECISION_VERSION,
      ok: false,
      label,
      url: String(url || "").trim(),
      reason: "invalid_url"
    };
  }
  const host: any = classifyOutboundHost(parsed.hostname);
  const egress: any = asObject(asObject(policies).egress);
  const allowLocalForDevelopment: any = String(policyPreset || "").trim() === DEVELOPMENT_LOCAL_EGRESS_POLICY_PRESET ||
    egress.allowLocalForDevelopment === true;
  const allowLocalForConfiguredModelService: any = egress.allowLocalForConfiguredModelService === true;
  const allowLocal: any = localEgressAllowed({ policyPreset, policies });
  const blocked: any = !outboundHostAllowed(host, allowLocal);
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
    metadataEndpoint: host.metadataEndpoint === true,
    allowLocalForDevelopment,
    allowLocalForConfiguredModelService,
    allowLoopbackAndPrivate: allowLocal,
    allowLinkLocal: false,
    reason: blocked
      ? `restricted_address_${host.metadataEndpoint === true ? "cloud-metadata" : host.category}`
      : "allowed"
  };
}

export function assertOutboundEgressAllowed(options: Record<string, any> = {}) : any {
  const decision: any = evaluateOutboundEgressUrl(options);
  if (!decision.ok) {
    const error: Error & Record<string, any> = new Error(`Outbound egress denied for ${decision.label}: ${decision.reason}.`);
    error.code = "outbound_egress_denied";
    error.decision = decision;
    throw error;
  }
  return decision;
}

function normalizeDnsLookupRecords(records: any = []) : any {
  const values: any = Array.isArray(records) ? records : [records];
  const seen: any = new Set<any>();
  const normalized: any[] = [];
  for (const record of values) {
    const address: any = String(record?.address || record || "").trim();
    const family: any = net.isIP(address);
    if (!address || family === 0) {
      continue;
    }
    const key: any = `${address}/${family}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const classified: any = classifyOutboundHost(address);
    normalized.push({
      address,
      family,
      hostKind: classified.kind,
      addressCategory: classified.category,
      restricted: classified.restricted,
      metadataEndpoint: classified.metadataEndpoint === true
    });
  }
  return normalized;
}

async function defaultDnsLookup(host?: any) : Promise<any> {
  return dns.lookup(host, { all: true, verbatim: true });
}

function selectedPinnedDnsAddress(decision: Record<string, any> = {}) : any {
  const addresses: any = Array.isArray(decision?.dns?.addresses) ? decision.dns.addresses : [];
  if (addresses.length === 0) {
    return null;
  }
  return addresses.find((record?: any) : any => record?.restricted !== true) || addresses[0] || null;
}

function createPinnedDnsDispatcher(decision: Record<string, any> = {}) : any {
  const pinned: any = selectedPinnedDnsAddress(decision);
  if (!pinned?.address) {
    return { dispatcher: undefined, pinnedDns: null, async close() : Promise<any> {} };
  }
  const expectedHost: any = normalizeHost(decision.host);
  const address: any = String(pinned.address || "").trim();
  const family: any = Number(pinned.family || net.isIP(address) || 0);
  const dispatcher: any = new Agent({
    connect: {
      lookup(hostname?: any, options: Record<string, any> = {}, callback?: any) : any {
        const requestedHost: any = normalizeHost(hostname);
        if (requestedHost && expectedHost && requestedHost !== expectedHost) {
          callback(new Error(`Pinned DNS lookup rejected unexpected host: ${requestedHost}`));
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
    pinnedDns: {
      host: expectedHost,
      address,
      family,
      addressCategory: String(pinned.addressCategory || ""),
      restricted: pinned.restricted === true
    },
    async close() : Promise<any> {
      await dispatcher.close();
    }
  };
}

export async function evaluateOutboundEgressUrlWithDns({
  lookup = defaultDnsLookup,
  ...options
}: Record<string, any> = {}) : Promise<any> {
  const decision: any = evaluateOutboundEgressUrl(options);
  if (!decision.ok) {
    return { ...decision, dns: { status: "skipped", reason: "host_decision_denied" } };
  }
  if (decision.hostKind !== "hostname" || decision.addressCategory !== "hostname") {
    return { ...decision, dns: { status: "skipped", reason: "literal_address" } };
  }
  let records: any;
  try {
    records = await lookup(decision.host, { all: true, verbatim: true });
  } catch (error: any) {
    return {
      ...decision,
      ok: false,
      reason: "dns_lookup_failed",
      dns: { status: "failed", host: decision.host, error: normalizeErrorMessage(error) }
    };
  }
  const addresses: any = normalizeDnsLookupRecords(records);
  const restricted: any = addresses.filter((record?: any) : any => record.restricted);
  const denied: any = addresses.filter((record?: any) : any => !outboundHostAllowed(record, decision.allowLoopbackAndPrivate === true));
  const blocked: any = addresses.length === 0 || denied.length > 0;
  return {
    ...decision,
    ok: !blocked,
    reason: addresses.length === 0
      ? "dns_no_addresses"
      : blocked
        ? `restricted_dns_address_${denied[0].metadataEndpoint === true ? "cloud-metadata" : denied[0].addressCategory}`
        : "allowed",
    dns: {
      status: "resolved",
      host: decision.host,
      addresses,
      addressCount: addresses.length,
      restrictedAddressCount: restricted.length,
      deniedAddressCount: denied.length
    }
  };
}

export async function assertOutboundRuntimeEgressAllowed(options: Record<string, any> = {}) : Promise<any> {
  const decision: any = await evaluateOutboundEgressUrlWithDns(options);
  if (!decision.ok) {
    const error: Error & Record<string, any> = new Error(`Outbound egress denied for ${decision.label}: ${decision.reason}.`);
    error.code = "outbound_egress_denied";
    error.decision = decision;
    throw error;
  }
  return decision;
}

export async function fetchWithPinnedDns({
  url = "",
  label = "outbound.url",
  policyPreset = "",
  policies = {},
  init = {},
  lookup = defaultDnsLookup,
  fetchImpl
}: Record<string, any> = {}) : Promise<any> {
  const decision: any = await assertOutboundRuntimeEgressAllowed({
    url,
    label,
    policyPreset,
    policies,
    lookup
  });
  const pinned: any = createPinnedDnsDispatcher(decision);
  const resolvedFetchImpl: any = fetchImpl ?? (pinned.dispatcher ? undiciFetch : globalThis.fetch);
  try {
    const response: any = await resolvedFetchImpl(url, {
      ...asObject(init),
      ...(pinned.dispatcher ? { dispatcher: pinned.dispatcher } : {})
    });
    return {
      response,
      decision,
      egressDecision: decision,
      pinnedDns: pinned.pinnedDns,
      close: pinned.close
    };
  } catch (error: any) {
    await pinned.close();
    error.decision = error.decision || decision;
    throw error;
  }
}

export async function requestWithPinnedDns({
  url = "",
  label = "outbound.url",
  policyPreset = "",
  policies = {},
  init = {},
  lookup = defaultDnsLookup,
  requestImpl = undiciRequest
}: Record<string, any> = {}) : Promise<any> {
  const decision: any = await assertOutboundRuntimeEgressAllowed({
    url,
    label,
    policyPreset,
    policies,
    lookup
  });
  const pinned: any = createPinnedDnsDispatcher(decision);
  try {
    const response: any = await requestImpl(url, {
      ...asObject(init),
      maxRedirections: 0,
      ...(pinned.dispatcher ? { dispatcher: pinned.dispatcher } : {})
    });
    return {
      response,
      decision,
      egressDecision: decision,
      pinnedDns: pinned.pinnedDns,
      close: pinned.close
    };
  } catch (error: any) {
    await pinned.close();
    error.decision = error.decision || decision;
    throw error;
  }
}

function redirectStatus(value?: any) : any {
  const status: any = Number(value || 0);
  return Number.isInteger(status) && status >= 300 && status < 400;
}

export function evaluateOutboundRedirectLocation({
  sourceUrl = "",
  status = 0,
  location = "",
  policyPreset = "",
  policies = {},
  label = "redirect.location"
}: Record<string, any> = {}) : any {
  const normalizedLocation: any = String(location || "").trim();
  if (!redirectStatus(status)) {
    return {
      schemaVersion: OUTBOUND_REDIRECT_DECISION_VERSION,
      ok: true,
      status: Number(status || 0),
      sourceUrl: String(sourceUrl || "").trim(),
      location: normalizedLocation,
      reason: "not_redirect"
    };
  }
  if (!normalizedLocation) {
    return {
      schemaVersion: OUTBOUND_REDIRECT_DECISION_VERSION,
      ok: false,
      status: Number(status || 0),
      sourceUrl: String(sourceUrl || "").trim(),
      location: "",
      reason: "redirect_location_missing"
    };
  }
  let target: any;
  try {
    target = new URL(normalizedLocation, String(sourceUrl || "").trim());
  } catch {
    return {
      schemaVersion: OUTBOUND_REDIRECT_DECISION_VERSION,
      ok: false,
      status: Number(status || 0),
      sourceUrl: String(sourceUrl || "").trim(),
      location: normalizedLocation,
      reason: "invalid_redirect_location"
    };
  }
  const targetUrl: any = target.toString();
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return {
      schemaVersion: OUTBOUND_REDIRECT_DECISION_VERSION,
      ok: false,
      status: Number(status || 0),
      sourceUrl: String(sourceUrl || "").trim(),
      location: normalizedLocation,
      targetUrl,
      reason: "unsupported_redirect_protocol"
    };
  }
  const targetDecision: any = evaluateOutboundEgressUrl({ url: targetUrl, policyPreset, policies, label });
  return {
    schemaVersion: OUTBOUND_REDIRECT_DECISION_VERSION,
    ok: targetDecision.ok,
    status: Number(status || 0),
    sourceUrl: String(sourceUrl || "").trim(),
    location: normalizedLocation,
    targetUrl,
    reason: targetDecision.ok ? "redirect_location_allowed" : targetDecision.reason,
    targetDecision
  };
}

export async function evaluateOutboundRedirectLocationWithDns({
  lookup = defaultDnsLookup,
  ...options
}: Record<string, any> = {}) : Promise<any> {
  const decision: any = evaluateOutboundRedirectLocation(options);
  if (!decision.ok || !decision.targetUrl) {
    return decision;
  }
  const targetDecision: any = await evaluateOutboundEgressUrlWithDns({
    url: decision.targetUrl,
    policyPreset: options.policyPreset,
    policies: options.policies,
    label: options.label || "redirect.location",
    lookup
  });
  return {
    ...decision,
    ok: targetDecision.ok,
    reason: targetDecision.ok ? "redirect_location_allowed" : targetDecision.reason,
    targetDecision
  };
}
