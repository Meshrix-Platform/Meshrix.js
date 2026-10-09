/**
 * Encrypted file custody fallback.
 *
 * Used when no protected OS store applies (non-macOS/Windows hosts, explicit
 * caller choice, CI). Each ref maps to one JSON file under `dataDir` holding
 * AES-256-GCM ciphertext. The wrapping key is HKDF-SHA-256(wrapSecret, salt,
 * "meshrix/entry/custody-file/v1") with a fresh random salt per entry.
 *
 * Honest boundary: the file adapter cannot bootstrap secrecy by itself — the
 * caller supplies `wrapSecret` (32 bytes; in the product it is derived from
 * the user-held recovery key material or held in an OS store). Persisting a
 * raw device key next to the data it protects would be pretend custody, so
 * this adapter refuses to run without an explicit wrap secret.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { entryError } from "../errors.ts";
import { hkdfLabel } from "../keys.ts";
import { assertCustodyRef, type CustodyAdapter } from "./custody-types.ts";

export const ENTRY_CUSTODY_FILE_SCHEMA = "v0.0.1:entry:custody-file-1";
export const ENTRY_CUSTODY_FILE_LABEL = "meshrix/entry/custody-file/v1";

const WRAP_SECRET_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;

interface CustodyFileBody {
  schemaVersion: string;
  kind: "entry-custody-file";
  ref: string;
  salt: string;
  nonce: string;
  ciphertext: string;
}

function custodyPath(dataDir: string, ref: string): string {
  return path.join(dataDir, `${assertCustodyRef(ref)}.custody.json`);
}

function aadFor(ref: string): Buffer {
  return Buffer.from(`meshrix.entry.custody-file|${ref}`, "utf8");
}

export class FileCustodyAdapter implements CustodyAdapter {
  readonly kind = "file";
  readonly #dataDir: string;
  readonly #wrapSecret: Uint8Array;

  constructor(options: { dataDir: string; wrapSecret: Uint8Array }) {
    if (options.wrapSecret.byteLength !== WRAP_SECRET_BYTES) {
      throw entryError(
        "custody_payload_invalid",
        `File custody requires a ${WRAP_SECRET_BYTES}-byte wrap secret.`
      );
    }
    this.#dataDir = options.dataDir;
    this.#wrapSecret = Buffer.from(options.wrapSecret);
  }

  async available(): Promise<boolean> {
    try {
      await fs.mkdir(this.#dataDir, { recursive: true, mode: 0o700 });
      await fs.chmod(this.#dataDir, 0o700).catch(() => undefined);
      await fs.access(this.#dataDir, fs.constants?.W_OK ?? 2);
      return true;
    } catch {
      return false;
    }
  }

  async storeSecret(input: { ref: string; secret: Uint8Array }): Promise<void> {
    const ref = assertCustodyRef(input.ref);
    if (!(await this.available())) {
      throw entryError("custody_unavailable", `File custody directory ${this.#dataDir} is not writable.`);
    }
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const key = hkdfLabel(this.#wrapSecret, ENTRY_CUSTODY_FILE_LABEL, 32);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.concat([aadFor(ref), salt]));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(input.secret)), cipher.final()]);
    const tag = cipher.getAuthTag();
    const body: CustodyFileBody = {
      schemaVersion: ENTRY_CUSTODY_FILE_SCHEMA,
      kind: "entry-custody-file",
      ref,
      salt: salt.toString("base64url"),
      nonce: iv.toString("base64url"),
      ciphertext: Buffer.concat([ciphertext, tag]).toString("base64url")
    };
    const file = custodyPath(this.#dataDir, ref);
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
    await fs.chmod(file, 0o600).catch(() => undefined);
  }

  async loadSecret(input: { ref: string }): Promise<Uint8Array | null> {
    const ref = assertCustodyRef(input.ref);
    let raw: string;
    try {
      raw = await fs.readFile(custodyPath(this.#dataDir, ref), "utf8");
    } catch (error) {
      if ((error as { code?: unknown })?.code === "ENOENT") return null;
      throw error;
    }
    let body: CustodyFileBody;
    try {
      const parsed = JSON.parse(raw) as CustodyFileBody;
      if (
        parsed?.schemaVersion !== ENTRY_CUSTODY_FILE_SCHEMA
        || parsed.kind !== "entry-custody-file"
        || parsed.ref !== ref
        || typeof parsed.salt !== "string"
        || typeof parsed.nonce !== "string"
        || typeof parsed.ciphertext !== "string"
      ) {
        throw new Error("shape");
      }
      body = parsed;
    } catch {
      throw entryError("custody_payload_invalid", `Custody file for ${ref} is malformed.`);
    }
    const salt = Buffer.from(body.salt, "base64url");
    const iv = Buffer.from(body.nonce, "base64url");
    const payload = Buffer.from(body.ciphertext, "base64url");
    if (salt.byteLength !== SALT_BYTES || iv.byteLength !== IV_BYTES || payload.byteLength < 16) {
      throw entryError("custody_payload_invalid", `Custody file for ${ref} has invalid fields.`);
    }
    const key = hkdfLabel(this.#wrapSecret, ENTRY_CUSTODY_FILE_LABEL, 32);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.concat([aadFor(ref), salt]));
    decipher.setAuthTag(payload.subarray(payload.byteLength - 16));
    try {
      return Buffer.concat([decipher.update(payload.subarray(0, payload.byteLength - 16)), decipher.final()]);
    } catch {
      throw entryError(
        "custody_decrypt_failed",
        `Custody file for ${ref} failed authentication — wrong wrap secret or tampered file.`
      );
    }
  }

  async deleteSecret(input: { ref: string }): Promise<void> {
    const ref = assertCustodyRef(input.ref);
    await fs.rm(custodyPath(this.#dataDir, ref), { force: true });
  }
}

export function createFileCustodyAdapter(options: {
  dataDir: string;
  wrapSecret: Uint8Array;
}): FileCustodyAdapter {
  return new FileCustodyAdapter(options);
}
