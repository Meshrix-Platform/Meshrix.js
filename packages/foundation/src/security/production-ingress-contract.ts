import { isIP } from "node:net";

import {
  forwardedForChain,
  isLoopbackAddress,
  isTrustedProxyAddress,
  normalizeIpAddress
} from "./trusted-client-ip.ts";

export const PRODUCTION_INGRESS_MODE_ENV: any = "MESHRIX_PRODUCTION_INGRESS_MODE";
export const PRODUCTION_INGRESS_TRUSTED_PROXY_MODE: any = "trusted-proxy";

const MAX_TRUSTED_PROXIES: any = 16;
const LOCAL_PROBE_PATHS: any = new Set<any>(["/api/healthz", "/api/readyz"]);

function controlledError(code?: any) : any {
  return Object.assign(new Error(code), { code });
}

function singleHeader(value: any = "") : any {
  const text: any = Array.isArray(value) ? value.join(",") : String(value || "");
  const entries: any = text.split(",").map((entry?: any) : any => entry.trim()).filter(Boolean);
  return entries.length === 1 ? entries[0] : "";
}

function normalizedTrustedProxyAddresses(value: any = "") : any {
  const entries: any = String(value || "")
    .split(",")
    .map((entry?: any) : any => normalizeIpAddress(entry).toLowerCase())
    .filter(Boolean);
  if (
    entries.length === 0 ||
    entries.length > MAX_TRUSTED_PROXIES ||
    entries.some((entry?: any) : any => isIP(entry) === 0) ||
    new Set<any>(entries).size !== entries.length
  ) {
    throw controlledError("production_ingress_trusted_proxies_invalid");
  }
  return Object.freeze(entries);
}

function securePublicOrigin(value: any = "") : any {
  let parsed: any;
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

function requestPath(request?: any) : any {
  try {
    return new URL(String(request?.url || "/"), "http://127.0.0.1").pathname;
  } catch {
    return "";
  }
}

function hasForwardingHeaders(request?: any) : any {
  return [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-prefix",
    "x-forwarded-proto"
  ].some((name?: any) : any => request?.headers?.[name] !== undefined);
}

export function createProductionIngressContract({
  mode = process.env[PRODUCTION_INGRESS_MODE_ENV] || "",
  advertisedBaseUrl = "",
  trustedProxies = process.env.MESHRIX_TRUSTED_PROXIES || "",
  cookieSecure = process.env.MESHRIX_COOKIE_SECURE || "auto"
}: Record<string, any> = {}) : any {
  const normalizedMode: any = String(mode || "").trim().toLowerCase();
  if (!normalizedMode) {
    return Object.freeze({
      mode: "local",
      enabled: false,
      admit: () : any => Object.freeze({ ok: true, source: "direct" })
    });
  }
  if (normalizedMode !== PRODUCTION_INGRESS_TRUSTED_PROXY_MODE) {
    throw controlledError("production_ingress_mode_invalid");
  }

  const publicOrigin: any = securePublicOrigin(advertisedBaseUrl);
  const publicUrl: any = new URL(publicOrigin);
  const trustedProxyAddresses: any = normalizedTrustedProxyAddresses(trustedProxies);
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
    admit(request?: any) : any {
      const remoteAddress: any = normalizeIpAddress(
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
      const protocol: any = singleHeader(request?.headers?.["x-forwarded-proto"]).toLowerCase();
      const host: any = singleHeader(request?.headers?.["x-forwarded-host"]).toLowerCase();
      const port: any = singleHeader(request?.headers?.["x-forwarded-port"]);
      const clientChain: any = forwardedForChain(request);
      const expectedPort: any = publicUrl.port || "443";
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
