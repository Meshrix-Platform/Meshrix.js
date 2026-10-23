/**
 * Pure outbound host classification shared by the Node egress policy and the
 * workerd publishing path. No Node builtins may be imported here.
 */

export type AddressCategory = "benchmark" | "carrier-grade-nat" | "cloud-metadata" | "hostname" | "invalid" | "link-local" | "loopback" | "multicast" | "private" | "public" | "reserved" | "unspecified";
export type HostKind = "hostname" | "ipv4" | "ipv6" | "missing";

export interface OutboundHostClassification {
  host: string;
  kind: HostKind;
  category: AddressCategory;
  restricted: boolean;
  metadataEndpoint: boolean;
}

export const LOCAL_NETWORK_ADDRESS_CATEGORIES = new Set<AddressCategory>(["loopback", "private"]);
const CLOUD_METADATA_HOSTS = new Set<string>(["instance-data.ec2.internal", "metadata.google.internal", "metadata.goog"]);
const CLOUD_METADATA_IPV4_ADDRESSES = new Set<string>(["169.254.169.254", "169.254.170.2", "169.254.170.23"]);
const AWS_METADATA_IPV6 = 0xfd000ec2000000000000000000000254n;

export function normalizeOutboundHost(value: unknown = ""): string {
  return String(value ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
}

export function ipv4Parts(value: unknown = ""): [number, number, number, number] | null {
  const parts = String(value ?? "").split(".").map((part) => Number(part));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts as [number, number, number, number]
    : null;
}

export function ipv4RangeCategory(address: unknown = ""): AddressCategory | "" {
  const parts = ipv4Parts(address);
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

export function expandIpv6(address: unknown = ""): number[] | null {
  const input = String(address ?? "").toLowerCase();
  if (!input.includes(":")) return null;
  const split = input.split("::");
  if (split.length > 2) return null;
  const [headText = "", tailText = ""] = split;
  const head = headText ? headText.split(":").filter(Boolean) : [];
  const tail = tailText ? tailText.split(":").filter(Boolean) : [];
  const expandedTail: string[] = [];
  for (const part of tail) {
    if (part.includes(".")) {
      const v4 = ipv4Parts(part);
      if (!v4) return null;
      expandedTail.push(((v4[0] << 8) | v4[1]).toString(16));
      expandedTail.push(((v4[2] << 8) | v4[3]).toString(16));
    } else {
      expandedTail.push(part);
    }
  }
  const missing = 8 - head.length - expandedTail.length;
  if (missing < 0 || (!input.includes("::") && missing !== 0)) return null;
  const parts = [...head, ...Array.from({ length: missing }, () => "0"), ...expandedTail];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

export function ipv6BigInt(parts: readonly number[]): bigint {
  return parts.reduce((acc, part) => (acc << 16n) + BigInt(part), 0n);
}

export function cloudMetadataEndpoint(host: unknown = ""): boolean {
  const normalized = normalizeOutboundHost(host);
  if (CLOUD_METADATA_HOSTS.has(normalized) || CLOUD_METADATA_IPV4_ADDRESSES.has(normalized)) return true;
  const parts = expandIpv6(normalized);
  return Boolean(parts && ipv6BigInt(parts) === AWS_METADATA_IPV6);
}

export function ipv6RangeCategory(address: unknown = ""): AddressCategory | "" {
  const parts = expandIpv6(address);
  if (!parts) return "";
  const value = ipv6BigInt(parts);
  if (value === 0n) return "unspecified";
  if (value === 1n) return "loopback";
  const first = parts[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) return "private";
  if ((first & 0xffc0) === 0xfe80) return "link-local";
  if ((first & 0xff00) === 0xff00) return "multicast";
  const embeddedIpv4 = ipv4EmbeddedInIpv6(parts);
  if (embeddedIpv4) return ipv4RangeCategory(embeddedIpv4);
  return "public";
}

function dottedQuad(a: number, b: number, c: number, d: number): string {
  return `${a}.${b}.${c}.${d}`;
}

/**
 * IPv6 literals that embed an IPv4 destination inherit the embedded address's
 * category — a translation prefix naming a private or link-local destination
 * is not public just because the outer address is IPv6.
 */
function ipv4EmbeddedInIpv6(parts: readonly number[]): string | null {
  // ::ffff:a.b.c.d — IPv4-mapped.
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
    return dottedQuad((parts[6] ?? 0) >> 8, (parts[6] ?? 0) & 255, (parts[7] ?? 0) >> 8, (parts[7] ?? 0) & 255);
  }
  // 64:ff9b::/96 — NAT64 well-known prefix (RFC 6052); IPv4 in the low 32 bits.
  if (parts[0] === 0x64 && parts[1] === 0xff9b && parts.slice(2, 6).every((part) => part === 0)) {
    return dottedQuad((parts[6] ?? 0) >> 8, (parts[6] ?? 0) & 255, (parts[7] ?? 0) >> 8, (parts[7] ?? 0) & 255);
  }
  // 64:ff9b:1::/48 — NAT64 local-use prefix (RFC 8215); bits 48-63 and the
  // u-octet are zero, IPv4 occupies bits 72-103.
  if (
    parts[0] === 0x64 && parts[1] === 0xff9b && parts[2] === 1 &&
    parts[3] === 0 && ((parts[4] ?? 0) & 0xff00) === 0
  ) {
    return dottedQuad((parts[4] ?? 0) & 255, (parts[5] ?? 0) >> 8, (parts[5] ?? 0) & 255, (parts[6] ?? 0) >> 8);
  }
  // 2002::/16 — 6to4 embeds the site's IPv4 at bits 16-47.
  if (parts[0] === 0x2002) {
    return dottedQuad((parts[1] ?? 0) >> 8, (parts[1] ?? 0) & 255, (parts[2] ?? 0) >> 8, (parts[2] ?? 0) & 255);
  }
  return null;
}

/** `net.isIP` without `node:net`: dotted-quad IPv4 or expandable IPv6. */
function ipVersion(host: string): 4 | 6 | 0 {
  if (ipv4Parts(host)) return 4;
  if (expandIpv6(host)) return 6;
  return 0;
}

export function classifyOutboundHost(host: unknown = ""): OutboundHostClassification {
  const normalized = normalizeOutboundHost(host);
  if (!normalized) return { host: "", kind: "missing", category: "invalid", restricted: true, metadataEndpoint: false };
  if (CLOUD_METADATA_HOSTS.has(normalized)) return { host: normalized, kind: "hostname", category: "cloud-metadata", restricted: true, metadataEndpoint: true };
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return { host: normalized, kind: "hostname", category: "loopback", restricted: true, metadataEndpoint: false };
  const version = ipVersion(normalized);
  if (version === 4) {
    const category = ipv4RangeCategory(normalized) || "invalid";
    return { host: normalized, kind: "ipv4", category, restricted: category !== "public", metadataEndpoint: cloudMetadataEndpoint(normalized) };
  }
  if (version === 6) {
    const category = ipv6RangeCategory(normalized) || "invalid";
    return { host: normalized, kind: "ipv6", category, restricted: category !== "public", metadataEndpoint: cloudMetadataEndpoint(normalized) };
  }
  return { host: normalized, kind: "hostname", category: "hostname", restricted: false, metadataEndpoint: false };
}
