/**
 * Device TLS certificate minter — the entry's custody-held Ed25519 device key
 * wrapped in a minimal self-signed X.509 certificate.
 *
 * The inner relay channel authenticates the peer by SPKI pin
 * (`sha256(certificate subjectPublicKeyInfo)`), not by CA trust — so the
 * device identity only needs a deterministic, correctly-encoded certificate
 * that carries the same Ed25519 key. Nothing here is a CA substitute: the
 * cert is self-signed, single-purpose and pinned by digest.
 *
 * Implemented as a small DER encoder instead of shelling out so the private
 * key never touches a temp file and signing stays behind the injected
 * custody-backed signer.
 */
import { createHash, type KeyObject, sign as edSign } from "node:crypto";

/** DER-encoded SubjectPublicKeyInfo for a raw 32-byte Ed25519 key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// --- minimal DER helpers -----------------------------------------------------

function derLen(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  if (length <= 0xff) return Buffer.from([0x81, length]);
  if (length <= 0xffff) return Buffer.from([0x82, length >> 8, length & 0xff]);
  return Buffer.from([0x83, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
const oid = (encoded: Buffer) => tlv(0x06, encoded);
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, "utf8"));
const utcTime = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getUTCFullYear();
  if (y < 1950 || y > 2049) throw new Error("UTCTime supports 1950..2049; pick a nearer validity window.");
  const text = `${String(y).slice(2)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, "ascii"));
};
const bitString = (bytes: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), bytes]));
const explicit = (n: number, inner: Buffer) => tlv(0xa0 + n, inner);
const integer = (bytes: Buffer) => {
  // Strip leading zeros; re-pad if the high bit would read as negative.
  let raw = bytes;
  while (raw.length > 1 && raw[0] === 0 && (raw[1] & 0x80) === 0) raw = raw.subarray(1);
  const padded = (raw[0] & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), raw]) : raw;
  return tlv(0x02, padded);
};

const OID_ED25519 = oid(Buffer.from("2b6570", "hex")); // RFC 8410 id-Ed25519
const OID_CN = oid(Buffer.from("550403", "hex"));       // X.520 id-at-commonName

function commonName(cn: string): Buffer {
  return seq(set(seq(OID_CN, utf8(cn))));
}

export interface IssuedDeviceCertificate {
  /** PEM armoring — accepted directly by `tls.connect({ cert })`. */
  readonly certPem: string;
  readonly certDer: Buffer;
  /** `sha256(SPKI DER)` base64url — the inner-channel pin form for this device. */
  readonly spkiPin: string;
}

/**
 * Issue a self-signed Ed25519 device certificate. `signer` signs the TBS
 * bytes and returns the raw 64-byte Ed25519 signature — in production this is
 * the custody-held device key; the key never leaves the caller.
 */
export function issueDeviceCertificate(input: {
  readonly publicKeyRaw: Uint8Array;
  readonly sign: (tbsDer: Uint8Array) => Uint8Array;
  readonly subject?: string;
  readonly serial?: Uint8Array;
  readonly notBefore?: Date;
  readonly notAfter?: Date;
}): IssuedDeviceCertificate {
  if (input.publicKeyRaw.byteLength !== 32) {
    throw new Error("Device certificates wrap a 32-byte Ed25519 public key.");
  }
  const spkiDer = seq(seq(OID_ED25519), bitString(Buffer.from(input.publicKeyRaw)));
  const spkiPin = createHash("sha256").update(spkiDer).digest("base64url");
  const notBefore = input.notBefore ?? new Date();
  const notAfter = input.notAfter ?? new Date(notBefore.getTime() + 2 * 365 * 24 * 3600 * 1000);
  const serial = input.serial
    ? Buffer.from(input.serial)
    : createHash("sha256").update(spkiDer).digest().subarray(0, 16);
  serial[0] &= 0x7f; // serials are positive integers
  const name = commonName(input.subject ?? `meshrix-entry ${spkiPin.slice(0, 16)}`);

  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), // version v3
    integer(serial),
    seq(OID_ED25519),                        // signature algorithm
    name,                                    // issuer (self-signed)
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,                                    // subject
    spkiDer
  );
  const signature = Buffer.from(input.sign(tbs));
  if (signature.byteLength !== 64) {
    throw new Error("Ed25519 signatures are 64 bytes.");
  }
  const certDer = seq(tbs, seq(OID_ED25519), bitString(signature));
  const b64 = certDer.toString("base64");
  const pem = `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/gu)?.join("\n")}\n-----END CERTIFICATE-----\n`;
  return { certPem: pem, certDer, spkiPin };
}

/** The pin an endpoint can derive from a stored raw Ed25519 public key. */
export function ed25519SpkiPinFromRaw(rawPublicKeyBase64Url: string): string | null {
  const raw = Buffer.from(rawPublicKeyBase64Url, "base64url");
  if (raw.byteLength !== 32) return null;
  const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createHash("sha256").update(spkiDer).digest("base64url");
}

/** Convenience signer bound to a custody-loaded KeyObject. */
export function custodyDeviceSigner(privateKey: KeyObject): (tbsDer: Uint8Array) => Uint8Array {
  return (tbsDer) => new Uint8Array(edSign(null, Buffer.from(tbsDer), privateKey));
}
