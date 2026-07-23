import { isIP } from "node:net";

const MAX_FORWARDED_FOR_CHAIN_LENGTH = 32;

let cachedTrustedProxyText = null;
let cachedTrustedProxyAddresses = new Set();

export function normalizeIpAddress(value = "") {
  const text = String(value || "").trim().replace(/^\[|\]$/g, "");
  return text.startsWith("::ffff:") ? text.slice("::ffff:".length) : text;
}

function normalizeNetworkIp(value = "") {
  const normalized = normalizeIpAddress(value);
  return isIP(normalized) ? normalized.toLowerCase() : "";
}

function trustedProxySet(value = process.env.LICO_TRUSTED_PROXIES || "") {
  if (value instanceof Set || Array.isArray(value)) {
    const entries = value instanceof Set ? [...value] : value;
    return new Set(entries.map(normalizeNetworkIp).filter(Boolean));
  }
  const text = String(value || "");
  if (text === cachedTrustedProxyText) {
    return cachedTrustedProxyAddresses;
  }
  cachedTrustedProxyText = text;
  cachedTrustedProxyAddresses = new Set(
    text.split(",").map(normalizeNetworkIp).filter(Boolean)
  );
  return cachedTrustedProxyAddresses;
}

export function forwardedForChain(request) {
  const header = request?.headers?.["x-forwarded-for"];
  const text = Array.isArray(header) ? header.join(",") : String(header || "");
  if (!text.trim()) {
    return [];
  }
  const entries = text.split(",").map((entry) => entry.trim());
  if (
    entries.length === 0 ||
    entries.length > MAX_FORWARDED_FOR_CHAIN_LENGTH ||
    entries.some((entry) => !entry)
  ) {
    return [];
  }
  const normalized = entries.map(normalizeNetworkIp);
  return normalized.every(Boolean) ? normalized : [];
}

export function firstForwardedFor(request) {
  return forwardedForChain(request)[0] || "";
}

export function isLoopbackAddress(value = "") {
  const address = normalizeIpAddress(value).toLowerCase();
  return address === "localhost" ||
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "0:0:0:0:0:0:0:1" ||
    address.startsWith("127.");
}

export function isTrustedProxyAddress(value = "", {
  trustedProxies = process.env.LICO_TRUSTED_PROXIES || ""
} = {}) {
  const remoteAddress = normalizeNetworkIp(value);
  return Boolean(remoteAddress) && trustedProxySet(trustedProxies).has(remoteAddress);
}

export function clientIpFromRequest(request, {
  unknown = "",
  trustedProxies = process.env.LICO_TRUSTED_PROXIES || ""
} = {}) {
  const remoteAddress = normalizeNetworkIp(
    request?.socket?.remoteAddress ||
      request?.connection?.remoteAddress ||
      ""
  );
  const trusted = trustedProxySet(trustedProxies);
  if (remoteAddress && trusted.has(remoteAddress)) {
    const forwarded = forwardedForChain(request);
    if (forwarded.length > 0) {
      let clientAddress = remoteAddress;
      for (let index = forwarded.length - 1; index >= 0; index -= 1) {
        if (!trusted.has(clientAddress)) {
          break;
        }
        clientAddress = forwarded[index];
      }
      return clientAddress;
    }
  }
  return remoteAddress || unknown;
}

export function hostnameFromHostHeader(value = "") {
  const host = String(value || "").trim().toLowerCase();
  if (!host) {
    return "";
  }
  if (host.startsWith("[")) {
    const closing = host.indexOf("]");
    return closing > 0 ? host.slice(1, closing) : "";
  }
  const colon = host.indexOf(":");
  return colon >= 0 ? host.slice(0, colon) : host;
}

export function isLocalHttpHost(value = "") {
  return isLoopbackAddress(hostnameFromHostHeader(value));
}

export function originHost(value = "") {
  try {
    return new URL(String(value || "")).host.toLowerCase();
  } catch {
    return "";
  }
}

export function isLocalHttpOrigin(value = "") {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) && isLoopbackAddress(url.hostname);
  } catch {
    return false;
  }
}
