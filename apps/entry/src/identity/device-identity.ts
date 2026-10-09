/**
 * Device identity lifecycle for the installed entry.
 *
 * A device identity is a fresh random Ed25519 pair; the private key lives only
 * behind the selected CustodyAdapter (OS store or encrypted file), the public
 * key + SPKI fingerprint are the enrolled wire identity. Nothing in this
 * module persists plaintext private material outside the custody boundary.
 */
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { entryError } from "../errors.ts";
import {
  generateEd25519,
  publicKeyFingerprint,
  randomOpaqueId,
  rawPublicKeyBase64Url,
  signEd25519
} from "../keys.ts";
import type { CustodyAdapter } from "./custody-types.ts";

export interface DeviceIdentity {
  readonly deviceId: string;
  /** Raw 32-byte Ed25519 public key, base64url — the paired identity key. */
  readonly publicKey: string;
  /** `fp.<sha256(spki)>` fingerprint for pairing display and binding. */
  readonly fingerprint: string;
}

export interface DeviceCustodyOptions {
  readonly custody: CustodyAdapter;
  /** Custody ref prefix; final ref is `${refPrefix}.<deviceId>`-shaped. */
  readonly refPrefix?: string;
}

function custodyRef(prefix: string, deviceId: string): string {
  // Custody refs are `[a-z0-9._-]`; device ids are opaque-id safe already.
  return `${prefix}.${deviceId.replace(/[^a-z0-9._-]/giu, "-").toLowerCase()}`;
}

/**
 * Generate a fresh device identity and place its private key into custody.
 * Returns public identity material only — the private key is never returned.
 */
export async function enrollDeviceIdentity(options: DeviceCustodyOptions & {
  readonly deviceId?: string;
}): Promise<DeviceIdentity> {
  const deviceId = options.deviceId ?? randomOpaqueId("dev.entry", 12);
  const pair = generateEd25519();
  const pkcs8 = pair.privateKey.export({ format: "der", type: "pkcs8" });
  await options.custody.storeSecret({
    ref: custodyRef(options.refPrefix ?? "dev", deviceId),
    secret: new Uint8Array(pkcs8)
  });
  return Object.freeze({
    deviceId,
    publicKey: rawPublicKeyBase64Url(pair.publicKey),
    fingerprint: publicKeyFingerprint(pair.publicKey)
  });
}

/** Load a device private key from custody; null when no key is enrolled. */
export async function loadDevicePrivateKey(
  options: DeviceCustodyOptions & { deviceId: string }
): Promise<KeyObject | null> {
  const secret = await options.custody.loadSecret({
    ref: custodyRef(options.refPrefix ?? "dev", options.deviceId)
  });
  if (!secret) return null;
  try {
    return createPrivateKey({ format: "der", type: "pkcs8", key: Buffer.from(secret) });
  } catch {
    throw entryError("custody_payload_invalid", `Custodied key for ${options.deviceId} is not PKCS#8 Ed25519.`);
  }
}

/** Sign a transcript with a custodied device key. Fails closed when absent. */
export async function signWithDeviceKey(
  options: DeviceCustodyOptions & { deviceId: string },
  transcript: Uint8Array | string
): Promise<string> {
  const privateKey = await loadDevicePrivateKey(options);
  if (!privateKey) {
    throw entryError("custody_unavailable", `No custodied device key for ${options.deviceId}.`);
  }
  return signEd25519(privateKey, transcript);
}

/** Re-derive the public identity for a custodied device key. */
export async function deviceIdentityFromCustody(
  options: DeviceCustodyOptions & { deviceId: string }
): Promise<DeviceIdentity | null> {
  const privateKey = await loadDevicePrivateKey(options);
  if (!privateKey) return null;
  const publicKey = createPublicKey(privateKey);
  return Object.freeze({
    deviceId: options.deviceId,
    publicKey: rawPublicKeyBase64Url(publicKey),
    fingerprint: publicKeyFingerprint(publicKey)
  });
}

export async function deleteDeviceKey(options: DeviceCustodyOptions & { deviceId: string }): Promise<void> {
  await options.custody.deleteSecret({ ref: custodyRef(options.refPrefix ?? "dev", options.deviceId) });
}
