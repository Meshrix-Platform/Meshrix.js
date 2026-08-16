import { isIP } from "node:net";

import {
  forwardedForChain,
  isLoopbackAddress,
  isTrustedProxyAddress,
  normalizeIpAddress
} from "./trusted-client-ip.ts";

export const PRODUCTION_INGRESS_MODE_ENV = "MESHRIX_PRODUCTION_INGRESS_MODE";
export const PRODUCTION_INGRESS_TRUSTED_PROXY_MODE = "trusted-proxy";

const MAX_TRUSTED_PROXIES = 16;
const LOCAL_PROBE_PATHS = new Set(["/api/healthz", "/api/readyz"]);

type HeaderValue = string | string[] | undefined;
interface IngressRequest {
  url?: string;
  headers?: Record<string, HeaderValue>;
  socket?: { remoteAddress?: string };
  connection?: { remoteAddress?: string };
}
interface ProductionIngressOptions {
  mode?: string;
  advertisedBaseUrl?: string;
  trustedProxies?: string;
  cookieSecure?: string;
}

function controlledError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function singleHeader(value: HeaderValue = ""): string {
  const text = Array.isArray(value) ? value.join(",") : String(value || "");
  const entries = text.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length === 1 ? entries[0] : "";
}

function normalizedTrustedProxyAddresses(value = ""): readonly string[] {
  const entries = String(value || "")
    .split(",")
    .map((entry) => normalizeIpAddress(entry).toLowerCase())
    .filter(Boolean);
  if (
    entries.length === 0 ||
    entries.length > MAX_TRUSTED_PROXIES ||
    entries.some((entry) => isIP(entry) === 0) ||
    new Set(entries).size !== entries.length
  ) {
    throw controlledError("production_ingress_trusted_proxies_invalid");
  }
  return Object.freeze(entries);
}

function securePublicOrigin(value: unknown = ""): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw controlledError("production_ingress_public_origin_invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw controlledError("production_ingress_public_origin_invalid");
  }
  return parsed.origin;
}

function requestPath(request?: IngressRequest): string {
  try {
    return new URL(String(request?.url || "/"), "http://127.0.0.1").pathname;
  } catch {
    return "";
  }
}

function hasForwardingHeaders(request?: IngressRequest): boolean {
  return [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-prefix",
    "x-forwarded-proto"
  ].some((name) => request?.headers?.[name] !== undefined);
}

export function createProductionIngressContract({
  mode = process.env[PRODUCTION_INGRESS_MODE_ENV] || "",
  advertisedBaseUrl = "",
  trustedProxies = process.env.MESHRIX_TRUSTED_PROXIES || "",
  cookieSecure = process.env.MESHRIX_COOKIE_SECURE || "auto"
}: ProductionIngressOptions = {}) {
  const normalizedMode = String(mode || "").trim().toLowerCase();
  if (!normalizedMode) {
    return Object.freeze({
      mode: "local",
      enabled: false,
      admit: () => Object.freeze({ ok: true, source: "direct" })
    });
  }
  if (normalizedMode !== PRODUCTION_INGRESS_TRUSTED_PROXY_MODE) {
    throw controlledError("production_ingress_mode_invalid");
  }

  const publicOrigin = securePublicOrigin(advertisedBaseUrl);
  const publicUrl = new URL(publicOrigin);
  const trustedProxyAddresses = normalizedTrustedProxyAddresses(trustedProxies);
  if (
    ["never", "0", "false"].includes(
      String(cookieSecure || "auto").trim().toLowerCase()
    )
  ) {
    throw controlledError("production_ingress_secure_cookie_required");
  }

  return Object.freeze({
    mode: PRODUCTION_INGRESS_TRUSTED_PROXY_MODE,
    enabled: true,
    publicOrigin,
    trustedProxyCount: trustedProxyAddresses.length,
    admit(request?: IngressRequest) {
      const remoteAddress = normalizeIpAddress(
        request?.socket?.remoteAddress || request?.connection?.remoteAddress || ""
      );
      if (
        isLoopbackAddress(remoteAddress) &&
        LOCAL_PROBE_PATHS.has(requestPath(request)) &&
        !hasForwardingHeaders(request)
      ) {
        return Object.freeze({ ok: true, source: "local-probe" });
      }
      if (!isTrustedProxyAddress(remoteAddress, { trustedProxies: trustedProxyAddresses })) {
        return Object.freeze({
          ok: false,
          status: 403,
          code: "production_ingress_untrusted_peer"
        });
      }
      if (
        request?.headers?.forwarded !== undefined ||
        request?.headers?.["x-forwarded-prefix"] !== undefined
      ) {
        return Object.freeze({
          ok: false,
          status: 400,
          code: "production_ingress_forwarding_metadata_invalid"
        });
      }
      const protocol = singleHeader(request?.headers?.["x-forwarded-proto"]).toLowerCase();
      const host = singleHeader(request?.headers?.["x-forwarded-host"]).toLowerCase();
      const port = singleHeader(request?.headers?.["x-forwarded-port"]);
      const clientChain = forwardedForChain(request);
      const expectedPort = publicUrl.port || "443";
      if (
        protocol !== "https" ||
        host !== publicUrl.host.toLowerCase() ||
        port !== expectedPort ||
        clientChain.length !== 1
      ) {
        return Object.freeze({
          ok: false,
          status: 400,
          code: "production_ingress_forwarding_metadata_invalid"
        });
      }
      return Object.freeze({ ok: true, source: "trusted-proxy" });
    }
  });
}
