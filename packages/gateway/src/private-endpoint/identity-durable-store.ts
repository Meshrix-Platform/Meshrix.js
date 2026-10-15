import { closeSync, chmodSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isAccountStepUpPermitId, isPairingPeerIdentity } from "@meshrix/contracts/account";
import { peerIdForRouteDevice } from "@meshrix/contracts/private-relay";
import type {
  EndpointDeviceRecord,
  EndpointIdentityDurablePort,
  EndpointGrantOperationRecord,
  EndpointInvitationRecord,
  EndpointPairingOperationRecord,
  RecoveryAuthorityRecord
} from "./identity-store.ts";

function endpointConfigError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const MAX_STATE_BYTES = 4 * 1024 * 1024;

interface EndpointIdentitySnapshot {
  readonly schemaVersion: 1;
  readonly devices: readonly EndpointDeviceRecord[];
  readonly recoveryAuthorities: readonly RecoveryAuthorityRecord[];
  readonly invitations: readonly EndpointInvitationRecord[];
  readonly pairingOperations: readonly EndpointPairingOperationRecord[];
  readonly grantOperations: readonly EndpointGrantOperationRecord[];
  readonly revocationRevisions: Readonly<Record<string, number>>;
}

/** One atomic, owner-only snapshot for endpoint trust and one-use pairing state. */
export function createFileEndpointIdentityDurablePort(path: string): EndpointIdentityDurablePort {
  let snapshot = readSnapshot(path);
  return Object.freeze({
    loadDevices: () => snapshot.devices,
    loadRecoveryAuthorities: () => snapshot.recoveryAuthorities,
    loadInvitations: () => snapshot.invitations,
    loadPairingOperations: () => snapshot.pairingOperations,
    loadGrantOperations: () => snapshot.grantOperations,
    loadRevocationRevision: (tenantId: string) => snapshot.revocationRevisions[tenantId],
    loadRevocationRevisions: () => snapshot.revocationRevisions,
    saveState(state: Parameters<NonNullable<EndpointIdentityDurablePort["saveState"]>>[0]) {
      const next = validateSnapshot({ schemaVersion: 1, ...state });
      writeSnapshot(path, next);
      // Keep readers on this port instance current; consumers receive frozen
      // values and the next identity-store save still writes one coherent set.
      snapshot = next;
    }
  });
}

function readSnapshot(path: string): EndpointIdentitySnapshot {
  if (!existsSync(path)) return emptySnapshot();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw endpointConfigError("private_endpoint_state_unreadable", "The private endpoint identity state is not readable.");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) {
    throw endpointConfigError("private_endpoint_state_invalid", "The private endpoint identity state exceeds its size bound.");
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return validateSnapshot(parsed);
  } catch (error) {
    if ((error as { code?: unknown })?.code === "private_endpoint_state_invalid") throw error;
    throw endpointConfigError("private_endpoint_state_invalid", "The private endpoint identity state is malformed.");
  }
}

function emptySnapshot(): EndpointIdentitySnapshot {
  return Object.freeze({
    schemaVersion: 1,
    devices: Object.freeze([]),
    recoveryAuthorities: Object.freeze([]),
    invitations: Object.freeze([]),
    pairingOperations: Object.freeze([]),
    grantOperations: Object.freeze([]),
    revocationRevisions: Object.freeze({})
  });
}

function validateSnapshot(value: unknown): EndpointIdentitySnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1
    || !Array.isArray(value.devices) || !Array.isArray(value.recoveryAuthorities)
    || !Array.isArray(value.invitations) || !Array.isArray(value.pairingOperations) || !Array.isArray(value.grantOperations)
    || !isRecord(value.revocationRevisions)) {
    throw endpointConfigError("private_endpoint_state_invalid", "The private endpoint identity state does not match its schema.");
  }
  const devices = value.devices.map(parseDevice);
  const recoveries = value.recoveryAuthorities.map(parseRecoveryAuthority);
  const invitations = value.invitations.map(parseInvitation);
  const operations = value.pairingOperations.map(parsePairingOperation);
  const grantOperations = value.grantOperations.map(parseGrantOperation);
  if (devices.length > 4096 || recoveries.length > 256 || invitations.length > 4096 || operations.length > 4096 || grantOperations.length > 4096) {
    throw endpointConfigError("private_endpoint_state_invalid", "The private endpoint identity state exceeds its record bound.");
  }
  const revisions: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [tenantId, revision] of Object.entries(value.revocationRevisions)) {
    if (!opaque(tenantId) || !Number.isSafeInteger(revision) || Number(revision) < 0) {
      throw endpointConfigError("private_endpoint_state_invalid", "A persisted revocation revision is invalid.");
    }
    revisions[tenantId] = Number(revision);
  }
  if (new Set(devices.map((entry) => entry.deviceId)).size !== devices.length
    || new Set(invitations.map((entry) => entry.inviteId)).size !== invitations.length
    || new Set(operations.map((entry) => entry.bootstrapId)).size !== operations.length
    || new Set(grantOperations.map((entry) => entry.operationId)).size !== grantOperations.length) {
    throw endpointConfigError("private_endpoint_state_invalid", "Persisted endpoint identity records contain duplicate identifiers.");
  }
  return Object.freeze({
    schemaVersion: 1,
    devices: Object.freeze(devices),
    recoveryAuthorities: Object.freeze(recoveries),
    invitations: Object.freeze(invitations),
    pairingOperations: Object.freeze(operations),
    grantOperations: Object.freeze(grantOperations),
    revocationRevisions: Object.freeze(revisions)
  });
}

function parseDevice(value: unknown): EndpointDeviceRecord {
  if (!isRecord(value) || !opaque(value.deviceId) || !opaque(value.routeId) || !opaque(value.tenantId)
    || typeof value.role !== "string" || typeof value.mode !== "string"
    || typeof value.pairedIdentityKey !== "string" || typeof value.pairedIdentityFingerprint !== "string"
    || typeof value.principalRef !== "string" || typeof value.capabilityGrantRef !== "string"
    || !(value.boundRecoveryKeyId === null || typeof value.boundRecoveryKeyId === "string")
    || !Number.isSafeInteger(value.trustGeneration) || !Number.isSafeInteger(value.admissionGeneration)
    || typeof value.revoked !== "boolean") {
    throw endpointConfigError("private_endpoint_state_invalid", "A persisted device identity is invalid.");
  }
  const expectedPeerId = peerIdForRouteDevice({ tenantId: value.tenantId as string, routeId: value.routeId as string, deviceId: value.deviceId as string });
  if (value.entryPeerIdentity !== undefined
    && (!expectedPeerId || !isValidPairedSignalIdentity(value.entryPeerIdentity, expectedPeerId))) {
    throw endpointConfigError("private_endpoint_state_invalid", "A persisted paired Signal identity does not match its route and device.");
  }
  if (value.accountBinding !== undefined && !isBinding(value.accountBinding)) throw endpointConfigError("private_endpoint_state_invalid", "A persisted device account binding is invalid.");
  if (value.accountScopes !== undefined && (!Array.isArray(value.accountScopes) || !value.accountScopes.every((scope) => typeof scope === "string"))) throw endpointConfigError("private_endpoint_state_invalid", "Persisted account scopes are invalid.");
  if (value.accountGrants !== undefined && (!Array.isArray(value.accountGrants) || !value.accountGrants.every((grant) => isRecord(grant) && opaque(grant.grantRef) && Array.isArray(grant.scopes) && grant.scopes.every((scope) => typeof scope === "string")))) throw endpointConfigError("private_endpoint_state_invalid", "Persisted account grants are invalid.");
  return Object.freeze(structuredClone(value) as unknown as EndpointDeviceRecord);
}

function parseRecoveryAuthority(value: unknown): RecoveryAuthorityRecord {
  if (!isRecord(value) || !opaque(value.recoveryKeyId) || typeof value.principalRef !== "string"
    || typeof value.publicKey !== "string" || !Number.isSafeInteger(value.generation)
    || !["active", "rotating", "revoked", "superseded"].includes(String(value.state))
    || value.accountBinding !== undefined && !isBinding(value.accountBinding)) {
    throw endpointConfigError("private_endpoint_state_invalid", "A persisted recovery authority is invalid.");
  }
  return Object.freeze(structuredClone(value) as unknown as RecoveryAuthorityRecord);
}

function parseInvitation(value: unknown): EndpointInvitationRecord {
  if (!isRecord(value) || !opaque(value.inviteId) || typeof value.tokenDigest !== "string"
    || !opaque(value.tenantId) || !opaque(value.routeId) || !opaque(value.endpointDeviceId)
    || typeof value.endpointPinRef !== "string" || typeof value.mode !== "string"
    || !instant(value.issuedAt) || !instant(value.expiresAt)
    || !(value.consumedByOperationId === null || opaque(value.consumedByOperationId))) {
    throw endpointConfigError("private_endpoint_state_invalid", "A persisted pairing invite is invalid.");
  }
  return Object.freeze(structuredClone(value) as unknown as EndpointInvitationRecord);
}

function parsePairingOperation(value: unknown): EndpointPairingOperationRecord {
  if (!isRecord(value) || !opaque(value.bootstrapId) || !opaque(value.entrySessionId) || !opaque(value.inviteId)
    || !opaque(value.challengeId) || typeof value.nonce !== "string" || !isBinding(value.account)
    || !isActionTarget(value.target) || !instant(value.expiresAt)
    || !["challenged", "authorized", "enrolled", "revoked"].includes(String(value.state))) {
    throw endpointConfigError("private_endpoint_state_invalid", "A persisted pairing operation is invalid.");
  }
  if (value.operationId !== undefined && !opaque(value.operationId) || value.permitId !== undefined && !isAccountStepUpPermitId(value.permitId)
    || value.capabilityGrantRef !== undefined && !opaque(value.capabilityGrantRef)) {
    throw endpointConfigError("private_endpoint_state_invalid", "A persisted pairing operation reference is invalid.");
  }
  return Object.freeze(structuredClone(value) as unknown as EndpointPairingOperationRecord);
}

function parseGrantOperation(value: unknown): EndpointGrantOperationRecord {
  if (!isRecord(value) || !opaque(value.operationId) || !isBinding(value.account) || !opaque(value.deviceId)
    || !isActionTarget(value.target) || !instant(value.expiresAt)
    || !["issued", "authorized", "revoked"].includes(String(value.state))) {
    throw endpointConfigError("private_endpoint_state_invalid", "A persisted grant operation is invalid.");
  }
  return Object.freeze(structuredClone(value) as unknown as EndpointGrantOperationRecord);
}

function writeSnapshot(path: string, snapshot: EndpointIdentitySnapshot): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(snapshot);
  if (Buffer.byteLength(payload, "utf8") > MAX_STATE_BYTES) {
    throw endpointConfigError("private_endpoint_state_capacity", "The private endpoint identity state reached its storage bound.");
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, payload, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* no temporary file remains */ }
    throw endpointConfigError("private_endpoint_state_write_failed", "The private endpoint identity state could not be persisted atomically.");
  }
}

function isBinding(value: unknown): value is { accountId: string; authEpoch: number } {
  return isRecord(value) && opaque(value.accountId) && Number.isSafeInteger(value.authEpoch) && Number(value.authEpoch) > 0;
}

function isActionTarget(value: unknown): boolean {
  return isRecord(value) && opaque(value.tenantId) && opaque(value.routeId) && opaque(value.deviceId)
    && typeof value.devicePublicKey === "string" && opaque(value.grantRef)
    && Array.isArray(value.scopes) && value.scopes.length > 0 && value.scopes.every((scope) => typeof scope === "string");
}

function instant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isValidPairedSignalIdentity(value: unknown, peerId: string): boolean {
  if (value === null) return true;
  if (!isPairingPeerIdentity(value, peerId)) return false;
  const identity = Buffer.from(value.identityKey, "base64url");
  return identity.byteLength === 33 && identity.toString("base64url") === value.identityKey;
}

function opaque(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
