/**
 * @meshrix/entry — installed macOS/Windows entry identity, custody, pairing
 * and user-held-key recovery state/model layer.
 *
 * This package owns:
 * - protected device-key custody (macOS Keychain / Windows DPAPI / encrypted
 *   file fallback behind one narrow adapter),
 * - the one user-held recovery key (generation, chunked text, import),
 * - automatic encrypted snapshot publication + fresh-profile recovery
 *   bootstrap under current endpoint authority,
 * - explicit trusted pairing invite/session model.
 *
 * It owns no GUI presentation, relay transport or platform escrow — those
 * live in their own nodes/packages.
 */
export * as errors from "./errors.ts";
export {
  entryError,
  isEntryError,
  type EntryError,
  type EntryErrorCode
} from "./errors.ts";
export * from "./keys.ts";
export * from "./transcripts.ts";
export * from "./identity/index.ts";
export * from "./pairing/index.ts";
export * from "./recovery/index.ts";
