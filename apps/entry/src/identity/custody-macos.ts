/**
 * macOS Keychain custody adapter.
 *
 * Stores each device secret as a generic-password Keychain item via the
 * documented `security` CLI — the narrow native boundary this layer allows:
 *
 *   store:  security add-generic-password    -s <service> -a <account> -w <b64> -U
 *   load:   security find-generic-password   -s <service> -a <account> -w
 *   delete: security delete-generic-password -s <service> -a <account>
 *
 * Documented limitations of this boundary (kept honest rather than faked):
 * - `add-generic-password -w` carries the secret through the process argument
 *   list, transiently visible to same-user process inspection. The `security`
 *   CLI offers no stdin secret channel; the GUI shell may later move to
 *   Security-framework bindings (keychain-swift style SecItem*) without
 *   changing this interface.
 * - First-time writes may surface a Keychain unlock prompt at the OS level;
 *   that is platform behavior, not a code path here.
 */
import { entryError } from "../errors.ts";
import { assertCustodyRef, type CustodyAdapter, type ShellRunner } from "./custody-types.ts";

const DEFAULT_SERVICE = "com.meshrix.entry.device-custody";
const ACCOUNT_PREFIX = "meshrix-entry/";

/** `security` exits 44 (errSecItemNotFound) / prints this on a missing item. */
const NOT_FOUND_MARKERS = [
  "could not be found",
  "errSecItemNotFound",
  "SecKeychainSearchCopyNext"
];

function isNotFound(result: { code: number; stderr: string }): boolean {
  return result.code !== 0
    && (result.code === 44 || NOT_FOUND_MARKERS.some((marker) => result.stderr.includes(marker)));
}

export class MacosKeychainCustody implements CustodyAdapter {
  readonly kind = "macos-keychain";
  readonly #runner: ShellRunner;
  readonly #service: string;

  constructor(options: { runner: ShellRunner; serviceName?: string }) {
    this.#runner = options.runner;
    this.#service = options.serviceName || DEFAULT_SERVICE;
  }

  #account(ref: string): string {
    return `${ACCOUNT_PREFIX}${assertCustodyRef(ref)}`;
  }

  async available(): Promise<boolean> {
    try {
      // Benign read probe: lists keychain search domains, touches no items.
      const result = await this.#runner.run("security", ["list-keychains"]);
      return result.code === 0;
    } catch {
      return false;
    }
  }

  async storeSecret(input: { ref: string; secret: Uint8Array }): Promise<void> {
    const account = this.#account(input.ref);
    const encoded = Buffer.from(input.secret).toString("base64");
    const result = await this.#runner.run("security", [
      "add-generic-password",
      "-s", this.#service,
      "-a", account,
      "-w", encoded,
      "-U",
      "-j", "Meshrix entry device custody"
    ]);
    if (result.code !== 0) {
      throw entryError(
        "custody_backend_error",
        `security add-generic-password failed (exit ${result.code}).`,
        { stderr: result.stderr.trim() || undefined }
      );
    }
  }

  async loadSecret(input: { ref: string }): Promise<Uint8Array | null> {
    const account = this.#account(input.ref);
    const result = await this.#runner.run("security", [
      "find-generic-password",
      "-s", this.#service,
      "-a", account,
      "-w"
    ]);
    if (isNotFound(result)) return null;
    if (result.code !== 0) {
      throw entryError(
        "custody_backend_error",
        `security find-generic-password failed (exit ${result.code}).`,
        { stderr: result.stderr.trim() || undefined }
      );
    }
    const encoded = result.stdout.trim();
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength === 0 || bytes.toString("base64") !== encoded) {
      throw entryError("custody_payload_invalid", `Keychain item for ${account} is not base64 payload.`);
    }
    return new Uint8Array(bytes);
  }

  async deleteSecret(input: { ref: string }): Promise<void> {
    const account = this.#account(input.ref);
    const result = await this.#runner.run("security", [
      "delete-generic-password",
      "-s", this.#service,
      "-a", account
    ]);
    if (result.code !== 0 && !isNotFound(result)) {
      throw entryError(
        "custody_backend_error",
        `security delete-generic-password failed (exit ${result.code}).`,
        { stderr: result.stderr.trim() || undefined }
      );
    }
  }
}

export function createMacosKeychainCustody(options: {
  runner: ShellRunner;
  serviceName?: string;
}): MacosKeychainCustody {
  return new MacosKeychainCustody(options);
}
