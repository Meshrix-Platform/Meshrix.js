/**
 * Opaque identifier and Durable Object name helpers.
 *
 * Identifiers stay opaque to the relay: they are validated against the same
 * shape the wire contract enforces, then used purely for routing names.
 */

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;

export function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

export function directoryObjectName(tenantId: string): string {
  return `directory:${tenantId}`;
}

export function sessionObjectName(tenantId: string, routeId: string): string {
  return `session:${tenantId}/${routeId}`;
}

export function vaultObjectName(vaultId: string): string {
  return `vault:${vaultId}`;
}

const encoder = new TextEncoder();

export function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  try {
    const binary = atob(padded + "=".repeat(padLength));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? utf8Bytes(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const view = new Uint8Array(digest);
  let hex = "";
  for (const byte of view) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function randomNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `n.${bytesToBase64Url(bytes)}`;
}

export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  const a = utf8Bytes(left);
  const b = utf8Bytes(right);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}
