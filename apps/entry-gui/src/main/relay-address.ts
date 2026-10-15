const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function relayAddressError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Normalize an explicitly configured relay base while retaining its route prefix. */
export function normalizeRelayBase(input: string | URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    throw relayAddressError("private_endpoint_relay_invalid", "Relay URL is invalid.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw relayAddressError("private_endpoint_relay_invalid", "Relay URL must not include credentials, a query or a fragment.");
  }
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase()))) {
    throw relayAddressError("private_endpoint_relay_unsafe", "Relay URL must use wss:; ws: is allowed only for literal loopback fixtures.");
  }

  const path = url.pathname.replace(/\/+$/u, "") || "/";
  if (path.includes("//") || path.split("/").some((segment) => {
    if (!segment) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return decoded === "." || decoded === ".." || /[\\/\u0000-\u001f\u007f]/u.test(decoded);
  })) {
    throw relayAddressError("private_endpoint_relay_invalid", "Relay URL contains an invalid route prefix.");
  }
  url.pathname = path;
  return url;
}

/** Convert the configured relay base to HTTP while preserving its route prefix. */
export function relayHttpBase(input: string | URL): string {
  const url = normalizeRelayBase(input);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.toString().replace(/\/$/u, "");
}

/** Build a session URL relative to the relay base rather than resetting its path. */
export function relaySessionUrl(input: string | URL, tenantId: string, routeId: string): string {
  const url = normalizeRelayBase(input);
  const prefix = url.pathname === "/" ? "" : url.pathname;
  url.pathname = `${prefix}/session/${encodeURIComponent(tenantId)}/${encodeURIComponent(routeId)}`;
  return url.toString();
}
