import { isIP, BlockList } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";

export class ProviderEgressError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = "ProviderEgressError";
    this.status = status;
  }
}

const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;
// Aggregate bound on provider response bytes buffered concurrently across all
// calls on one egress manager; calls beyond the envelope wait for capacity
// instead of growing process memory past it.
const MAX_AGGREGATE_RESPONSE_BUFFER_BYTES = 512 * 1024 * 1024;
const PROVIDER_DISPATCHER_OPTIONS = Object.freeze({
  connectTimeout: 0,
  headersTimeout: 0,
  bodyTimeout: 0
});
const FORWARDED_HEADERS = Object.freeze({
  openai: new Set(["x-client-request-id"]),
  anthropic: new Set(["anthropic-version"]),
  http: new Set()
});


const privateAddresses = new BlockList();
const configuredNetworks = new BlockList();
for (const [ip, prefix] of [["10.0.0.0",8],["172.16.0.0",12],["192.168.0.0",16]]) configuredNetworks.addSubnet(ip,prefix,"ipv4");
configuredNetworks.addSubnet("fc00::",7,"ipv6");
for (const [ip, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],
  ["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],
  ["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]]) {
  privateAddresses.addSubnet(ip, prefix, "ipv4");
}
for (const [ip,prefix] of [["::",96],["::1",128],["fc00::",7],["fe80::",10],["fec0::",10],
  ["ff00::",8],["2001:db8::",32],["64:ff9b::",96]]) privateAddresses.addSubnet(ip,prefix,"ipv6");

function normalizedAddress(address) {
  return isIP(address) === 6 ? new URL(`http://[${address}]`).hostname.slice(1, -1) : address;
}

function approvedAddress(address, allowed) {
  const family = isIP(address);
  if (!family) return false;
  if (allowed.has(normalizedAddress(address))) return true;
  return !privateAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

export function createGuardedLookup({ allowedAddresses = [], lookup = dnsLookup } = {}) {
  const allowed = new Set(allowedAddresses.map(normalizedAddress));
  return (hostname, options, callback) => {
    // Return only the addresses actually checked. The connector never resolves
    // the name a second time, so rebinding cannot substitute another target.
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) { callback(error); return; }
      if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 32 ||
          addresses.some((entry) => !approvedAddress(entry.address, allowed))) {
        callback(new ProviderEgressError("Provider address is outside its approved egress boundary."));
        return;
      }
      if (options?.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function admittedAddresses(url, egressPolicy) {
  const raw = egressPolicy?.allowedAddresses ?? [];
  if (!Array.isArray(raw) || raw.length > 32 || raw.some((entry) => typeof entry !== "string" || !isIP(entry)) ||
      (egressPolicy && Object.keys(egressPolicy).some((key) => key !== "allowedAddresses"))) {
    throw new ProviderEgressError("Provider egress policy is invalid.");
  }
  const allowed = new Set(raw.map(normalizedAddress));
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  // An operator-owned literal loopback or private LAN URL grants only that
  // exact destination. DNS names and metadata/link-local ranges never gain it.
  const family = isIP(host);
  if (host === "::1" || (family === 4 && host.startsWith("127.")) ||
      (family && configuredNetworks.check(host, family === 4 ? "ipv4" : "ipv6"))) allowed.add(normalizedAddress(host));
  if (isIP(host) && !approvedAddress(host, allowed)) {
    throw new ProviderEgressError("Provider address is outside its approved egress boundary.");
  }
  return [...allowed].sort();
}

async function readBoundedResponse(response) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ProviderEgressError("Provider response exceeded the configured service bound.", { status: response.status });
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProviderEgressError("Provider response exceeded the configured service bound.", { status: response.status });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function validateBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl));
  } catch {
    throw new ProviderEgressError("Provider base URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderEgressError("Provider base URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new ProviderEgressError("Provider base URL must not embed credentials.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback = host === "::1" || (isIP(host) === 4 && host.split(".")[0] === "127");
  if (url.protocol === "http:" && !loopback) {
    throw new ProviderEgressError("Provider base URL must use HTTPS except for loopback endpoints.");
  }
  return url;
}

export function createProviderEgress({ fetchImpl, lookupImpl = dnsLookup, agentFactory = (options) => new Agent(options), maxAggregateResponseBufferBytes = MAX_AGGREGATE_RESPONSE_BUFFER_BYTES } = {}) {
  const dispatchers = new Map();
  let accepting = true;
  const send = fetchImpl === undefined ? undiciFetch : fetchImpl;
  let closePromise = null;
  const responseBufferLimit = Math.max(MAX_PROVIDER_RESPONSE_BYTES, Math.trunc(Number(maxAggregateResponseBufferBytes) || 0));
  let inFlightResponseBytes = 0;
  const responseBufferWaiters = [];

  function drainResponseBuffer() {
    while (responseBufferWaiters.length > 0) {
      const next = responseBufferWaiters[0];
      if (inFlightResponseBytes + next.bytes > responseBufferLimit) break;
      inFlightResponseBytes += next.bytes;
      responseBufferWaiters.shift().resolve();
    }
  }
  function acquireResponseBuffer(bytes) {
    if (inFlightResponseBytes + bytes <= responseBufferLimit) {
      inFlightResponseBytes += bytes;
      return Promise.resolve();
    }
    return new Promise((resolve) => responseBufferWaiters.push({ bytes, resolve }));
  }
  function releaseResponseBuffer(bytes) {
    inFlightResponseBytes = Math.max(0, inFlightResponseBytes - bytes);
    drainResponseBuffer();
  }

  function forwardedHeaders(incoming, protocol) {
    const forwarded = {};
    const allowed = FORWARDED_HEADERS[protocol];
    if (!allowed) return forwarded;
    for (const [name, value] of Object.entries(incoming ?? {})) {
      const lower = String(name).toLowerCase();
      if (!allowed.has(lower) || typeof value !== "string") continue;
      forwarded[lower] = value;
    }
    return forwarded;
  }

  async function call({
    protocol,
    baseUrl,
    credential,
    egressPolicy,
    body,
    headers = {},
    signal
  }) {
    if (!accepting) throw new ProviderEgressError("Provider egress is closed.");
    const url = validateBaseUrl(baseUrl);
    const allowedAddresses = admittedAddresses(url, egressPolicy);
    let managedDispatcher;
    if (fetchImpl === undefined) {
      const key = JSON.stringify([url.origin, allowedAddresses]);
      managedDispatcher = dispatchers.get(key);
      if (!managedDispatcher) {
        if (dispatchers.size >= 1024) throw new ProviderEgressError("Provider destination capacity is exhausted.");
        managedDispatcher = agentFactory({ ...PROVIDER_DISPATCHER_OPTIONS,
          connect: { lookup: createGuardedLookup({ allowedAddresses, lookup: lookupImpl }) } });
        dispatchers.set(key, managedDispatcher);
      }
    }
    let target = url;
    const requestHeaders = { "content-type": "application/json", ...forwardedHeaders(headers, protocol) };
    if (protocol === "openai") {
      target = new URL("/v1/chat/completions", url);
      requestHeaders.authorization = `Bearer ${credential}`;
    } else if (protocol === "anthropic") {
      target = new URL("/v1/messages", url);
      requestHeaders["x-api-key"] = credential;
      requestHeaders["anthropic-version"] = String(headers["anthropic-version"] || "2023-06-01");
    } else if (protocol === "http") {
      requestHeaders["x-api-key"] = credential;
    } else {
      throw new ProviderEgressError(`Unsupported provider protocol: ${protocol}`);
    }

    let response;
    try {
      response = await send(target, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal,
        redirect: "error",
        ...(managedDispatcher ? { dispatcher: managedDispatcher } : {})
      });
    } catch {
      throw new ProviderEgressError("Provider egress failed.", {
        status: 0
      });
    }
    const declaredLength = Number(response.headers?.get?.("content-length"));
    const reservation = Number.isSafeInteger(declaredLength) && declaredLength > 0
      ? Math.min(declaredLength, MAX_PROVIDER_RESPONSE_BYTES)
      : MAX_PROVIDER_RESPONSE_BYTES;
    await acquireResponseBuffer(reservation);
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        releaseResponseBuffer(reservation);
      }
    };
    let parsed = null;
    try {
      const text = await readBoundedResponse(response);
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new ProviderEgressError("Provider returned invalid JSON.", { status: response.status });
        }
      }
    } catch (error) {
      release();
      throw error;
    }
    // The reservation stays held while the parsed body remains live; the
    // caller releases it once the response has been consumed downstream.
    return { status: response.status, body: parsed, release };
  }

  return {
    validateDestination({ baseUrl, egressPolicy }) {
      const url = validateBaseUrl(baseUrl);
      admittedAddresses(url, egressPolicy);
    },
    call,
    close() {
      accepting = false;
      if (!closePromise) closePromise = Promise.all([...dispatchers.values()].map((agent) => agent.close())).then(() => {});
      return closePromise;
    }
  };
}
