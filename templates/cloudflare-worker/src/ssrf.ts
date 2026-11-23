export class UpstreamUrlError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UpstreamUrlError";
    this.code = code;
  }
}

const ALLOWED_HTTPS_PORTS = new Set(["", "443", "8443"]);

const BLOCKED_EXACT_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".localhost.localdomain",
  ".local",
  ".internal",
  ".home.arpa",
  ".localdomain",
];

function parseIpv4(host: string): number | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!match) return null;
  let ip = 0;
  for (let i = 1; i <= 4; i += 1) {
    const raw = match[i]!;
    if (raw.length > 1 && raw.startsWith("0")) return null;
    const octet = Number(raw);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    ip = ((ip << 8) | octet) >>> 0;
  }
  return ip;
}

function isBlockedIpv4(ip: number): boolean {
  const first = (ip >>> 24) & 0xff;
  const second = (ip >>> 16) & 0xff;
  const top24 = ip >>> 8;
  const top16 = ip >>> 16;

  // 0.0.0.0/8 (unspecified / current network)
  if (first === 0) return true;
  // 10.0.0.0/8 (RFC 1918)
  if (first === 10) return true;
  // 100.64.0.0/10 (RFC 6598 CGNAT)
  if (first === 100 && second >= 64 && second <= 127) return true;
  // 127.0.0.0/8 (loopback)
  if (first === 127) return true;
  // 169.254.0.0/16 (link-local & cloud metadata)
  if (top16 === 0xa9fe) return true;
  // 172.16.0.0/12 (RFC 1918)
  if (first === 172 && second >= 16 && second <= 31) return true;
  // 192.0.0.0/24 (IETF protocol assignments)
  if (top24 === 0xc00000) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (top24 === 0xc00002) return true;
  // RFC 3068 deprecated 6to4 relay anycast prefix
  if (top24 === 0xc05863) return true;
  // 192.168.0.0/16 (RFC 1918)
  if (top16 === 0xc0a8) return true;
  // 198.18.0.0/15 (benchmarking)
  if (first === 198 && (second === 18 || second === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (top24 === 0xc63364) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (top24 === 0xcb0071) return true;
  // 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved / broadcast)
  if (first >= 224) return true;

  return false;
}

function parseIpv6Hextets(raw: string): number[] | null {
  if (!raw || raw.includes("%")) return null;
  let addr = raw.toLowerCase();

  const lastColon = addr.lastIndexOf(":");
  let embeddedIpv4: number | null = null;
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes(".")) {
    embeddedIpv4 = parseIpv4(addr.slice(lastColon + 1));
    if (embeddedIpv4 === null) return null;
    const hi = ((embeddedIpv4 >>> 16) & 0xffff).toString(16);
    const lo = (embeddedIpv4 & 0xffff).toString(16);
    addr = `${addr.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const doubleColonParts = addr.split("::");
  if (doubleColonParts.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const tokens = side.split(":");
    const out: number[] = [];
    for (const token of tokens) {
      if (!/^[0-9a-f]{1,4}$/u.test(token)) return null;
      out.push(Number.parseInt(token, 16));
    }
    return out;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseSide(doubleColonParts[0]!);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseSide(doubleColonParts[0]!);
  const right = parseSide(doubleColonParts[1]!);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isBlockedIpv6(hextets: readonly number[]): boolean {
  const h0 = hextets[0]!;
  const h1 = hextets[1]!;
  const h2 = hextets[2]!;
  const h3 = hextets[3]!;
  const h4 = hextets[4]!;
  const h5 = hextets[5]!;
  const h6 = hextets[6]!;
  const h7 = hextets[7]!;

  // Unspecified (::)
  if (hextets.every((h) => h === 0)) return true;
  // Loopback (::1)
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0 && h7 === 1) {
    return true;
  }
  // IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), and SIIT IPv4-translated (::ffff:0:0:0/96)
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && (
    (h4 === 0 && (h5 === 0xffff || h5 === 0)) ||
    (h4 === 0xffff && h5 === 0)
  )) {
    return true;
  }
  // NAT64 (64:ff9b::/96 and 64:ff9b:1::/48)
  if (h0 === 0x0064 && h1 === 0xff9b) return true;
  // Discard-Only (100::/64)
  if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) return true;
  // Teredo (2001::/32)
  if (h0 === 0x2001 && h1 === 0x0000) return true;
  // Documentation (2001:db8::/32)
  if (h0 === 0x2001 && h1 === 0x0db8) return true;
  // 6to4 (2002::/16)
  if (h0 === 0x2002) return true;
  // Unique Local IPv6 / Private (fc00::/7, includes fd00:ec2::254 metadata)
  if ((h0 & 0xfe00) === 0xfc00) return true;
  // Link-Local (fe80::/10)
  if ((h0 & 0xffc0) === 0xfe80) return true;
  // Site-Local deprecated (fec0::/10)
  if ((h0 & 0xffc0) === 0xfec0) return true;
  // Multicast (ff00::/8)
  if ((h0 & 0xff00) === 0xff00) return true;

  return false;
}

/**
 * Validate an upstream MCP endpoint URL against SSRF rules.
 * Rejects non-HTTPS, credentials, non-443/8443 ports, local/internal domains,
 * private/loopback/link-local/CGNAT/unspecified/metadata IPv4/IPv6 ranges,
 * and `::ffff:` IPv4-mapped IPv6 addresses.
 */
export function validateUpstreamUrl(rawUrl: string): URL {
  if (typeof rawUrl !== "string") {
    throw new UpstreamUrlError("ssrf_invalid_url", "Upstream URL must be a string.");
  }
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048 || /[\u0000-\u001f\u007f\s]/u.test(trimmed)) {
    throw new UpstreamUrlError("ssrf_invalid_url", "Upstream URL contains invalid or empty characters.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new UpstreamUrlError("ssrf_invalid_url", "Upstream URL is malformed.");
  }

  if (parsed.protocol !== "https:") {
    throw new UpstreamUrlError("ssrf_https_required", "Only https:// upstream URLs are permitted.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new UpstreamUrlError("ssrf_credentials_forbidden", "Credentials in upstream URLs are forbidden.");
  }
  if (!ALLOWED_HTTPS_PORTS.has(parsed.port)) {
    throw new UpstreamUrlError("ssrf_port_forbidden", "Upstream URL port must be 443 or 8443.");
  }

  const rawHost = parsed.hostname.toLowerCase();
  if (!rawHost) {
    throw new UpstreamUrlError("ssrf_invalid_host", "Upstream URL must include a host.");
  }

  if (rawHost.startsWith("[") && rawHost.endsWith("]")) {
    const hextets = parseIpv6Hextets(rawHost.slice(1, -1));
    if (!hextets) {
      throw new UpstreamUrlError("ssrf_invalid_host", "Upstream IPv6 address is invalid.");
    }
    if (isBlockedIpv6(hextets)) {
      throw new UpstreamUrlError("ssrf_blocked_address", "Upstream IPv6 address is in a blocked or private range.");
    }
    return parsed;
  }

  const host = rawHost.replace(/\.+$/u, "");
  if (!host || host.includes("..") || host.includes("%")) {
    throw new UpstreamUrlError("ssrf_invalid_host", "Upstream hostname is invalid.");
  }

  if (BLOCKED_EXACT_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new UpstreamUrlError("ssrf_blocked_host", "Local and internal upstream hostnames are forbidden.");
  }

  const ipv4 = parseIpv4(host);
  if (ipv4 !== null) {
    if (isBlockedIpv4(ipv4)) {
      throw new UpstreamUrlError("ssrf_blocked_address", "Upstream IPv4 address is in a blocked or private range.");
    }
    return parsed;
  }

  // Reject single-label hostnames (e.g., Kubernetes/Docker internal service names)
  // and raw integer/hex host strings if not normalized by URL parser.
  if (!host.includes(".") || /^\d+$/u.test(host) || /^0x[0-9a-f]+$/iu.test(host)) {
    throw new UpstreamUrlError("ssrf_blocked_host", "Single-label or non-FQDN upstream hosts are forbidden.");
  }

  return parsed;
}

/**
 * Perform an outbound fetch against a validated upstream URL with redirects refused:
 * the request does not follow redirects and a redirect response is rejected.
 */
export async function safeUpstreamFetch(
  rawUrl: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const validated = validateUpstreamUrl(rawUrl);
  let pending: Promise<Response>;
  try {
    pending = fetchImpl(validated.toString(), {
      ...init,
      redirect: "manual",
    });
  } catch {
    // A synchronous throw means the request never left the gateway, so the
    // caller can treat this the same as an address validation refusal.
    throw new UpstreamUrlError(
      "upstream_request_not_sent",
      "Upstream request could not be dispatched.",
    );
  }
  const response = await pending;
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    void response.body?.cancel();
    throw new UpstreamUrlError(
      "upstream_redirect_refused",
      "Upstream responded with a redirect; redirects are not followed.",
    );
  }
  return response;
}
