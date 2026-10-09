/**
 * Pairing invite payload — the QR/deep-link artifact an endpoint admin
 * surface produces and the installed entry consumes.
 *
 * Wire shape:
 *
 *   meshrix-entry://pair#<base64url(canonical-json PairingInvite)>
 *   — or the raw JSON object for file/clipboard delivery.
 *
 * The invite carries endpoint reachability + trust anchors (route, SPKI pin,
 * principal ref, vault locator, enrolled recovery authority reference) and a
 * one-time `pairingToken` the endpoint issued out-of-band. It never contains
 * private key material, grants or credentials: pairing produces a *fresh*
 * trust binding, never a transferred one.
 */
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION
} from "@meshrix/contracts/private-relay";
import { entryError } from "../errors.ts";

export const ENTRY_PAIRING_SCHEMA = "v0.0.1:entry:pairing-invite-1";
export const ENTRY_PAIRING_KIND = "entry-pairing-invite";
export const ENTRY_PAIRING_URI_PREFIX = "meshrix-entry://pair#";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, max = 128): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && Buffer.byteLength(trimmed, "utf8") <= max ? trimmed : null;
}

function opaque(value: unknown): string | null {
  const text = bounded(value);
  return text && OPAQUE_ID.test(text) ? text : null;
}

function instant(value: unknown): string | null {
  const text = bounded(value, 64);
  return text && ISO_INSTANT.test(text) && Number.isFinite(Date.parse(text)) ? text : null;
}

export interface PairingRecoveryAuthority {
  readonly keyId: string;
  readonly generation: number;
}

export interface PairingInvite {
  readonly schemaVersion: string;
  readonly kind: typeof ENTRY_PAIRING_KIND;
  readonly inviteId: string;
  readonly endpointRouteId: string;
  readonly tenantId: string;
  readonly mode: "personal" | "enterprise";
  readonly endpointPrincipalRef: string;
  /** Endpoint SPKI pin — the inner-channel trust anchor (`spki` form). */
  readonly endpointSpkiPin: string;
  /** Relay service base URL the endpoint is reachable through. */
  readonly relayService: string;
  readonly vaultId: string;
  /** Recovery authority enrolled at invite issue (informational binding). */
  readonly recoveryAuthority: PairingRecoveryAuthority | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** One-time bearer token proving invite legitimacy to the endpoint. */
  readonly pairingToken: string;
}

export function parsePairingInvite(value: unknown): PairingInvite | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  const expected = [
    "endpointPrincipalRef", "endpointRouteId", "endpointSpkiPin", "expiresAt",
    "inviteId", "issuedAt", "kind", "mode", "pairingToken",
    "recoveryAuthority", "relayService", "schemaVersion", "tenantId", "vaultId"
  ];
  if (keys.length !== expected.length || !expected.every((key, i) => key === keys[i])) return null;
  if (value.schemaVersion !== ENTRY_PAIRING_SCHEMA || value.kind !== ENTRY_PAIRING_KIND) return null;
  const inviteId = opaque(value.inviteId);
  const endpointRouteId = opaque(value.endpointRouteId);
  const tenantId = opaque(value.tenantId);
  const endpointPrincipalRef = opaque(value.endpointPrincipalRef);
  const endpointSpkiPin = bounded(value.endpointSpkiPin, 128);
  const relayService = bounded(value.relayService, 512);
  const vaultId = opaque(value.vaultId);
  const issuedAt = instant(value.issuedAt);
  const expiresAt = instant(value.expiresAt);
  const pairingToken = bounded(value.pairingToken, 256);
  const mode = value.mode === "personal" || value.mode === "enterprise" ? value.mode : null;
  if (!inviteId || !endpointRouteId || !tenantId || !endpointPrincipalRef
    || !endpointSpkiPin || !relayService || !vaultId || !issuedAt || !expiresAt
    || !pairingToken || !mode) return null;
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) return null;
  let recoveryAuthority: PairingRecoveryAuthority | null = null;
  if (value.recoveryAuthority !== null) {
    if (!isRecord(value.recoveryAuthority)) return null;
    const keyId = opaque(value.recoveryAuthority.keyId);
    const generation = value.recoveryAuthority.generation;
    if (!keyId || !Number.isSafeInteger(generation) || (generation as number) < 1) return null;
    recoveryAuthority = Object.freeze({ keyId, generation: generation as number });
  }
  return Object.freeze({
    schemaVersion: ENTRY_PAIRING_SCHEMA,
    kind: ENTRY_PAIRING_KIND,
    inviteId,
    endpointRouteId,
    tenantId,
    mode,
    endpointPrincipalRef,
    endpointSpkiPin,
    relayService,
    vaultId,
    recoveryAuthority,
    issuedAt,
    expiresAt,
    pairingToken
  });
}

/** Serialize an invite into the deep-link payload form. */
export function encodePairingInvite(invite: PairingInvite): string {
  return `${ENTRY_PAIRING_URI_PREFIX}${Buffer.from(canonicalJson(invite), "utf8").toString("base64url")}`;
}

/**
 * Accepts the deep-link form or raw JSON text. Unknown prefixes and malformed
 * bodies fail with `pairing_invite_invalid`; an expired invite fails with
 * `pairing_expired`.
 */
export function parsePairingInviteText(text: unknown, options: { now?: () => number } = {}): PairingInvite {
  if (typeof text !== "string") {
    throw entryError("pairing_invite_invalid", "Pairing payload must be text.");
  }
  const trimmed = text.trim();
  let body: unknown;
  if (trimmed.startsWith(ENTRY_PAIRING_URI_PREFIX)) {
    const encoded = trimmed.slice(ENTRY_PAIRING_URI_PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
      throw entryError("pairing_invite_invalid", "Pairing payload is not base64url.");
    }
    try {
      body = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw entryError("pairing_invite_invalid", "Pairing payload does not decode to JSON.");
    }
  } else {
    try {
      body = JSON.parse(trimmed);
    } catch {
      throw entryError("pairing_invite_invalid", "Pairing payload is neither a pairing URI nor JSON.");
    }
  }
  const invite = parsePairingInvite(body);
  if (!invite) {
    throw entryError("pairing_invite_invalid", "Pairing payload does not satisfy the invite schema.");
  }
  const now = (options.now ?? (() => Date.now()))();
  if (Date.parse(invite.expiresAt) <= now) {
    throw entryError("pairing_expired", "Pairing invite has expired.");
  }
  return invite;
}

/**
 * Map a validated invite + fresh device identity to the wire
 * `endpoint-trust-binding` shape. The binding is what the endpoint validates
 * at enrollment; `capabilityGrantRef` names the grant the endpoint admin
 * staged for this invite (never the grant itself).
 */
export function inviteToTrustBinding(input: {
  readonly invite: PairingInvite;
  readonly devicePublicKey: string;
  readonly deviceFingerprint: string;
  readonly capabilityGrantRef: string;
  readonly boundRecoveryKeyId?: string | null;
}): Record<string, unknown> {
  return {
    schemaVersion: PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
    kind: "endpoint-trust-binding",
    pairedIdentityKey: input.devicePublicKey,
    pairedIdentityFingerprint: input.deviceFingerprint,
    mode: input.invite.mode,
    role: "entry",
    trustGeneration: input.invite.recoveryAuthority?.generation ?? 1,
    endpointPrincipalRef: input.invite.endpointPrincipalRef,
    capabilityGrantRef: input.capabilityGrantRef,
    boundRecoveryKeyId: input.boundRecoveryKeyId ?? input.invite.recoveryAuthority?.keyId ?? null
  };
}
