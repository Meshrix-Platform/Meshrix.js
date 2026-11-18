import { isIP } from "node:net";

const MAX_FORWARDED_FOR_CHAIN_LENGTH = 32;

type TrustedProxyInput = string | readonly unknown[] | ReadonlySet<unknown>;
interface RequestAddressLike {
  headers?: Record<string, unknown>;
  socket?: { remoteAddress?: string };
  connection?: { remoteAddress?: string };
}

let cachedTrustedProxyText: string | null = null;
let cachedTrustedProxyAddresses = new Set<string>();

export function normalizeIpAddress(value: unknown = ""): string {
  const text = String(value || "").trim().replace(/^\[|\]$/g, "");
  return text.startsWith("::ffff:") ? text.slice("::ffff:".length) : text;
}

function normalizeNetworkIp(value: unknown = ""): string {
  const normalized = normalizeIpAddress(value);
  return isIP(normalized) ? normalized.toLowerCase() : "";
}

function trustedProxySet(value: TrustedProxyInput = process.env.MESHRIX_TRUSTED_PROXIES || ""): Set<string> {
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

export function forwardedForChain(request?: RequestAddressLike): string[] {
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

export function firstForwardedFor(request?: RequestAddressLike): string {
  return forwardedForChain(request)[0] || "";
}

export function isLoopbackAddress(value: unknown = ""): boolean {
  const address = normalizeIpAddress(value).toLowerCase();
  return address === "localhost" ||
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "0:0:0:0:0:0:0:1" ||
    address.startsWith("127.");
}

export function isTrustedProxyAddress(value: unknown = "", {
  trustedProxies = process.env.MESHRIX_TRUSTED_PROXIES || ""
}: { trustedProxies?: TrustedProxyInput } = {}): boolean {
  const remoteAddress = normalizeNetworkIp(value);
  return Boolean(remoteAddress) && trustedProxySet(trustedProxies).has(remoteAddress);
}

export function clientIpFromRequest(request?: RequestAddressLike, {
  unknown = "",
  trustedProxies = process.env.MESHRIX_TRUSTED_PROXIES || ""
}: { unknown?: string; trustedProxies?: TrustedProxyInput } = {}): string {
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

export function hostnameFromHostHeader(value: unknown = ""): string {
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

export function isLocalHttpHost(value: unknown = ""): boolean {
  return isLoopbackAddress(hostnameFromHostHeader(value));
}

export function originHost(value: unknown = ""): string {
  try {
    return new URL(String(value || "")).host.toLowerCase();
  } catch {
    return "";
  }
}

export function isLocalHttpOrigin(value: unknown = ""): boolean {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) && isLoopbackAddress(url.hostname);
  } catch {
    return false;
  }
}
