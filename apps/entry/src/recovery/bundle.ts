/**
 * The typed plaintext carried inside an EncryptedRecoverySnapshot.
 *
 * Recoverable objects only: profile identity/reference + display settings,
 * named connection/routing configuration with prior trusted peer identity
 * references (as *candidates* requiring current endpoint validation), and
 * non-secret MCP registration preferences plus snapshot metadata.
 *
 * Never serialized into a bundle: device/session private keys, TLS keys,
 * credentials, grants, upstream secrets, authority/revocation records as
 * truth. `assertBundleRecoverable` enforces the contract's forbidden-key
 * list before encryption — plaintext is secret by construction, and a
 * forbidden key is a bug, not a feature.
 */
import {
  containsForbiddenSnapshotKeys
} from "@meshrix/contracts/private-relay";
import { entryError } from "../errors.ts";

export const ENTRY_BUNDLE_SCHEMA = "v0.0.1:entry:recovery-bundle-1";
export const ENTRY_BUNDLE_KIND = "entry-recovery-bundle";
const MAX_TEXT_BYTES = 256;
const MAX_CONNECTIONS = 64;

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max = MAX_TEXT_BYTES): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && Buffer.byteLength(trimmed, "utf8") <= max ? trimmed : null;
}

function opaqueId(value: unknown): string | null {
  const text = boundedText(value, 128);
  return text && OPAQUE_ID.test(text) ? text : null;
}

function revisionNumber(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && expected.every((key, i) => key === actual[i]);
}

export interface BundleConnection {
  /** Local connection identifier (opaque, non-secret). */
  readonly connectionId: string;
  /** Human-facing name shown in the connection list. */
  readonly displayLabel: string;
  readonly routeId: string;
  readonly tenantId: string;
  readonly mode: "personal" | "enterprise";
  /** Endpoint SPKI pin — the trust anchor to re-validate, not a grant. */
  readonly endpointSpkiPin: string;
  readonly principalRef: string;
  /** Relay service base URL for reaching this endpoint's relay route. */
  readonly relayService: string;
  readonly vaultId: string;
  readonly trustGeneration: number;
  readonly admissionGeneration: number;
  readonly revocationRevision: number;
  /** Enrolled recovery authority reference observed at last contact. */
  readonly recoveryAuthority: { readonly keyId: string; readonly generation: number } | null;
}

export interface EntryRecoveryBundle {
  readonly schemaVersion: string;
  readonly kind: typeof ENTRY_BUNDLE_KIND;
  readonly createdAt: string;
  readonly profileRef: string;
  readonly displayLabel: string;
  readonly connections: readonly BundleConnection[];
  /** Non-secret MCP registration/display preferences. */
  readonly pairingPreferences: { readonly mcpDisplayMode?: string } | null;
}

function parseAuthority(value: unknown): BundleConnection["recoveryAuthority"] {
  if (value === null) return null;
  if (!hasExactKeys(value, ["keyId", "generation"])) return undefined as never;
  const keyId = opaqueId(value.keyId);
  const generation = revisionNumber(value.generation);
  if (!keyId || !generation || generation < 1) return undefined as never;
  return Object.freeze({ keyId, generation });
}

function parseConnection(value: unknown): BundleConnection | null {
  if (!hasExactKeys(value, [
    "connectionId", "displayLabel", "routeId", "tenantId", "mode",
    "endpointSpkiPin", "principalRef", "relayService", "vaultId",
    "trustGeneration", "admissionGeneration", "revocationRevision",
    "recoveryAuthority"
  ])) return null;
  const connectionId = opaqueId(value.connectionId);
  const displayLabel = boundedText(value.displayLabel);
  const routeId = opaqueId(value.routeId);
  const tenantId = opaqueId(value.tenantId);
  const mode = value.mode === "personal" || value.mode === "enterprise" ? value.mode : null;
  const endpointSpkiPin = boundedText(value.endpointSpkiPin, 96);
  const principalRef = opaqueId(value.principalRef);
  const relayService = boundedText(value.relayService, 512);
  const vaultId = opaqueId(value.vaultId);
  const trustGeneration = revisionNumber(value.trustGeneration);
  const admissionGeneration = revisionNumber(value.admissionGeneration);
  const revocationRevision = revisionNumber(value.revocationRevision);
  const recoveryAuthority = parseAuthority(value.recoveryAuthority);
  if (!connectionId || displayLabel === null || !routeId || !tenantId || !mode
    || !endpointSpkiPin || !principalRef || !relayService || !vaultId
    || !trustGeneration || !admissionGeneration || revocationRevision === null
    || recoveryAuthority === undefined) {
    return null;
  }
  return Object.freeze({
    connectionId, displayLabel, routeId, tenantId, mode, endpointSpkiPin,
    principalRef, relayService, vaultId, trustGeneration, admissionGeneration,
    revocationRevision, recoveryAuthority
  });
}

export function parseEntryRecoveryBundle(value: unknown): EntryRecoveryBundle | null {
  if (!hasExactKeys(value, [
    "schemaVersion", "kind", "createdAt", "profileRef", "displayLabel",
    "connections", "pairingPreferences"
  ])) return null;
  if (value.schemaVersion !== ENTRY_BUNDLE_SCHEMA || value.kind !== ENTRY_BUNDLE_KIND) return null;
  const createdAt = boundedText(value.createdAt, 64);
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) return null;
  const profileRef = opaqueId(value.profileRef);
  const displayLabel = boundedText(value.displayLabel);
  if (!profileRef || displayLabel === null) return null;
  if (!Array.isArray(value.connections) || value.connections.length > MAX_CONNECTIONS) return null;
  const connections: BundleConnection[] = [];
  const seenIds = new Set<string>();
  for (const entry of value.connections) {
    const connection = parseConnection(entry);
    if (!connection || seenIds.has(connection.connectionId)) return null;
    seenIds.add(connection.connectionId);
    connections.push(connection);
  }
  let pairingPreferences: EntryRecoveryBundle["pairingPreferences"] = null;
  if (value.pairingPreferences !== null) {
    if (!isRecord(value.pairingPreferences)) return null;
    const mcpDisplayMode = value.pairingPreferences.mcpDisplayMode;
    pairingPreferences = {
      mcpDisplayMode: typeof mcpDisplayMode === "string" ? boundedText(mcpDisplayMode, 64) ?? undefined : undefined
    };
  }
  return Object.freeze({
    schemaVersion: ENTRY_BUNDLE_SCHEMA,
    kind: ENTRY_BUNDLE_KIND,
    createdAt,
    profileRef,
    displayLabel,
    connections: Object.freeze(connections),
    pairingPreferences
  });
}

/** Fail loudly when a caller hands us material the contract forbids. */
export function assertBundleRecoverable(bundle: unknown): void {
  if (containsForbiddenSnapshotKeys(bundle)) {
    throw entryError(
      "snapshot_malformed",
      "Recovery bundles must not contain secrets, keys, grants or upstream material."
    );
  }
}

export function buildEntryRecoveryBundle(input: {
  readonly profileRef: string;
  readonly displayLabel: string;
  readonly connections: readonly BundleConnection[];
  readonly pairingPreferences?: EntryRecoveryBundle["pairingPreferences"];
  readonly now?: () => number;
}): EntryRecoveryBundle {
  const candidate = {
    schemaVersion: ENTRY_BUNDLE_SCHEMA,
    kind: ENTRY_BUNDLE_KIND,
    createdAt: new Date((input.now ?? (() => Date.now()))()).toISOString(),
    profileRef: input.profileRef,
    displayLabel: input.displayLabel,
    connections: input.connections.map((connection) => ({ ...connection })),
    pairingPreferences: input.pairingPreferences ?? null
  };
  const parsed = parseEntryRecoveryBundle(candidate);
  if (!parsed) {
    throw entryError("snapshot_malformed", "Recovery bundle does not satisfy the entry schema.");
  }
  assertBundleRecoverable(parsed);
  return parsed;
}

/** Merge two decryptable bundles on CAS conflict — never a blind overwrite. */
export function mergeRecoveryBundles(
  local: EntryRecoveryBundle,
  remote: EntryRecoveryBundle,
  options: { now?: () => number } = {}
): EntryRecoveryBundle {
  const merged = new Map<string, BundleConnection>();
  for (const connection of remote.connections) merged.set(connection.connectionId, connection);
  for (const connection of local.connections) {
    const existing = merged.get(connection.connectionId);
    if (!existing || connection.trustGeneration >= existing.trustGeneration) {
      merged.set(connection.connectionId, connection);
    }
  }
  const winner = Date.parse(local.createdAt) >= Date.parse(remote.createdAt) ? local : remote;
  return buildEntryRecoveryBundle({
    profileRef: winner.profileRef,
    displayLabel: winner.displayLabel,
    connections: [...merged.values()],
    pairingPreferences: winner.pairingPreferences,
    now: options.now
  });
}
