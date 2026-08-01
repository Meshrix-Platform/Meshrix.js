import { isIP } from "node:net";

const MAX_FORWARDED_FOR_CHAIN_LENGTH: any = 32;

let cachedTrustedProxyText: any = null;
let cachedTrustedProxyAddresses: any = new Set<any>();

export function normalizeIpAddress(value: any = "") : any {
  const text: any = String(value || "").trim().replace(/^\[|\]$/g, "");
  return text.startsWith("::ffff:") ? text.slice("::ffff:".length) : text;
}

function normalizeNetworkIp(value: any = "") : any {
  const normalized: any = normalizeIpAddress(value);
  return isIP(normalized) ? normalized.toLowerCase() : "";
}

function trustedProxySet(value: any = process.env.MESHRIX_TRUSTED_PROXIES || "") : any {
  if (value instanceof Set || Array.isArray(value)) {
    const entries: any = value instanceof Set ? [...value] : value;
    return new Set<any>(entries.map(normalizeNetworkIp).filter(Boolean));
  }
  const text: any = String(value || "");
  if (text === cachedTrustedProxyText) {
    return cachedTrustedProxyAddresses;
  }
  cachedTrustedProxyText = text;
  cachedTrustedProxyAddresses = new Set<any>(
    text.split(",").map(normalizeNetworkIp).filter(Boolean)
  );
  return cachedTrustedProxyAddresses;
}

export function forwardedForChain(request?: any) : any {
  const header: any = request?.headers?.["x-forwarded-for"];
  const text: any = Array.isArray(header) ? header.join(",") : String(header || "");
  if (!text.trim()) {
    return [];
  }
  const entries: any = text.split(",").map((entry?: any) : any => entry.trim());
  if (
    entries.length === 0 ||
    entries.length > MAX_FORWARDED_FOR_CHAIN_LENGTH ||
    entries.some((entry?: any) : any => !entry)
  ) {
    return [];
  }
  const normalized: any = entries.map(normalizeNetworkIp);
  return normalized.every(Boolean) ? normalized : [];
}

export function firstForwardedFor(request?: any) : any {
  return forwardedForChain(request)[0] || "";
}

export function isLoopbackAddress(value: any = "") : any {
  const address: any = normalizeIpAddress(value).toLowerCase();
  return address === "localhost" ||
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "0:0:0:0:0:0:0:1" ||
    address.startsWith("127.");
}

export function isTrustedProxyAddress(value: any = "", {
  trustedProxies = process.env.MESHRIX_TRUSTED_PROXIES || ""
}: Record<string, any> = {}) : any {
  const remoteAddress: any = normalizeNetworkIp(value);
  return Boolean(remoteAddress) && trustedProxySet(trustedProxies).has(remoteAddress);
}

export function clientIpFromRequest(request?: any, {
  unknown = "",
  trustedProxies = process.env.MESHRIX_TRUSTED_PROXIES || ""
}: Record<string, any> = {}) : any {
  const remoteAddress: any = normalizeNetworkIp(
    request?.socket?.remoteAddress ||
      request?.connection?.remoteAddress ||
      ""
  );
  const trusted: any = trustedProxySet(trustedProxies);
  if (remoteAddress && trusted.has(remoteAddress)) {
    const forwarded: any = forwardedForChain(request);
    if (forwarded.length > 0) {
      let clientAddress: any = remoteAddress;
      for (let index: any = forwarded.length - 1; index >= 0; index -= 1) {
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

export function hostnameFromHostHeader(value: any = "") : any {
  const host: any = String(value || "").trim().toLowerCase();
  if (!host) {
    return "";
  }
  if (host.startsWith("[")) {
    const closing: any = host.indexOf("]");
    return closing > 0 ? host.slice(1, closing) : "";
  }
  const colon: any = host.indexOf(":");
  return colon >= 0 ? host.slice(0, colon) : host;
}

export function isLocalHttpHost(value: any = "") : any {
  return isLoopbackAddress(hostnameFromHostHeader(value));
}

export function originHost(value: any = "") : any {
  try {
    return new URL(String(value || "")).host.toLowerCase();
  } catch {
    return "";
  }
}

export function isLocalHttpOrigin(value: any = "") : any {
  try {
    const url: any = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) && isLoopbackAddress(url.hostname);
  } catch {
    return false;
  }
}
