// Per-service publish draft persistence (REQ-016): debounced autosave, a
// beforeunload dirty guard, and per-keyed restore through the shared
// validation chain. The module owns the storage format (key prefix, schema
// version, size cap, value hardening); the view owns the draft form and its
// editor fields. A write failure degrades to manual-save-only with a keyed
// notice — it never throws into the form.
import {
  readBrowserLocalStorageItem,
  removeBrowserLocalStorageItem,
  writeBrowserLocalStorageItem,
} from "@meshrix/ui-console/browser-window";
import { consoleMessages, currentConsoleLocale } from "../i18n/console";

export const PUBLISH_DRAFT_STORAGE_KEY = "meshrix.console.upstream-service-publish-draft";
export const PUBLISH_DRAFT_SCHEMA_VERSION = "v0.0.1:console:upstream-service-publish-draft-1";
export const PUBLISH_DRAFT_MAX_BYTES = 256 * 1024;
/** Debounce window for autosave writes (design choice, publish-draft-autosave §4.1). */
export const PUBLISH_DRAFT_DEBOUNCE_MS = 800;

export interface PublishDraftRecord {
  serviceId: string;
  form: Record<string, unknown>;
}

// Prototype-pollution hardening: depth ≤ 20, arrays ≤ 1000, keys ≤ 1000,
// rejects __proto__/prototype/constructor. Every restored value passes it.
export function isSafePublishDraftValue(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1_000 && value.every((entry: unknown) => isSafePublishDraftValue(entry, depth + 1));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length <= 1_000 && keys.every((key: string) =>
    !["__proto__", "prototype", "constructor"].includes(key) && isSafePublishDraftValue(record[key], depth + 1)
  );
}

/** Reads and validates one keyed slot; throws for poisoned or oversize payloads. */
export function readPublishDraft(key: string): PublishDraftRecord | null {
  const serialized = readBrowserLocalStorageItem(key);
  if (!serialized) return null;
  if (serialized.length > PUBLISH_DRAFT_MAX_BYTES) throw new Error("Saved browser draft is too large.");
  const draft = JSON.parse(serialized) as Record<string, unknown>;
  if (
    draft.schemaVersion !== PUBLISH_DRAFT_SCHEMA_VERSION ||
    typeof draft.serviceId !== "string" ||
    !draft.form || typeof draft.form !== "object" || Array.isArray(draft.form) ||
    !isSafePublishDraftValue(draft.form)
  ) {
    throw new Error("Saved browser draft has an invalid format.");
  }
  return { serviceId: draft.serviceId, form: draft.form as Record<string, unknown> };
}

/** Writes one keyed slot; throws when the payload is too large or storage is unavailable. */
export function writePublishDraft(key: string, serviceId: string, form: Record<string, unknown>): void {
  const serialized = JSON.stringify({
    schemaVersion: PUBLISH_DRAFT_SCHEMA_VERSION,
    serviceId,
    form,
  });
  if (serialized.length > PUBLISH_DRAFT_MAX_BYTES) {
    throw new Error("The form is too large to save in this browser.");
  }
  if (!writeBrowserLocalStorageItem(key, serialized)) {
    throw new Error("Browser storage is unavailable.");
  }
}

export function removePublishDraft(key: string): void {
  removeBrowserLocalStorageItem(key);
}

// The payload's serviceId is derived from the key suffix: a "new:" slot has no
// service id yet (matches the legacy payload where serviceId was "" for new
// drafts), any other slot carries its service id.
function serviceIdForDraftKey(key: string): string {
  const prefix = `${PUBLISH_DRAFT_STORAGE_KEY}:`;
  const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  return suffix.startsWith("new:") ? "" : suffix;
}

export type PublishDraftNoticeTone = "success" | "danger";

export interface PublishDraftAutosaveOptions {
  /** Full storage key of the currently active draft slot. */
  draftKey: () => string;
  /** Current form snapshot (credential REFERENCES only — never plaintext secrets). */
  serialize: () => Record<string, unknown>;
  /** Applies a validated restored form back into the view. */
  restore: (form: Record<string, unknown>) => void | Promise<void>;
  /** True while the current form differs from the last persisted state. */
  isDirty: () => boolean;
  /** Marks the current state as persisted (baseline for the dirty comparison). */
  markClean: () => void;
  /** Surfaces keyed copy; the danger tone reports the degraded-save notice. */
  onNotice: (message: string, tone: PublishDraftNoticeTone) => void;
}

export interface PublishDraftAutosave {
  scheduleSave: () => void;
  saveNow: () => void;
  restoreFor: (draftKey: string) => Promise<boolean>;
  dispose: () => void;
}

function publishDraftCopy(): any {
  const group: any = consoleMessages[currentConsoleLocale.value]?.publishDraft;
  return group || consoleMessages.en.publishDraft;
}

export function createPublishDraftAutosave(options: PublishDraftAutosaveOptions): PublishDraftAutosave {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let degraded = false;
  let guardBound = false;

  function beforeUnloadHandler(event: BeforeUnloadEvent): void {
    // Browser-native prompt only — no copy needed here.
    event.preventDefault();
  }

  function bindGuard(): void {
    if (guardBound) return;
    window.addEventListener("beforeunload", beforeUnloadHandler);
    guardBound = true;
  }

  function releaseGuardIfClean(): void {
    if (!guardBound) return;
    if (options.isDirty()) return;
    window.removeEventListener("beforeunload", beforeUnloadHandler);
    guardBound = false;
  }

  function clearDebounce(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function persist(key: string): boolean {
    try {
      writePublishDraft(key, serviceIdForDraftKey(key), options.serialize());
      return true;
    } catch {
      return false;
    }
  }

  function flush(key: string): void {
    debounceTimer = null;
    if (options.draftKey() !== key) {
      // The draft context moved (another service was selected): the captured
      // form state no longer belongs to this slot — drop the stale write.
      releaseGuardIfClean();
      return;
    }
    releaseGuardIfClean();
    if (degraded) return;
    if (!options.isDirty()) return;
    if (persist(key)) {
      options.markClean();
      releaseGuardIfClean();
      options.onNotice(publishDraftCopy().saved, "success");
    } else {
      degraded = true;
      options.onNotice(publishDraftCopy().storageFailure, "danger");
    }
  }

  function scheduleSave(): void {
    if (!options.isDirty()) {
      clearDebounce();
      releaseGuardIfClean();
      return;
    }
    const key = options.draftKey();
    bindGuard();
    clearDebounce();
    debounceTimer = setTimeout(() => flush(key), PUBLISH_DRAFT_DEBOUNCE_MS);
  }

  function saveNow(): void {
    clearDebounce();
    const key = options.draftKey();
    if (persist(key)) {
      options.markClean();
      releaseGuardIfClean();
      options.onNotice(publishDraftCopy().saved, "success");
    } else {
      degraded = true;
      options.onNotice(publishDraftCopy().storageFailure, "danger");
    }
  }

  async function restoreFor(draftKey: string): Promise<boolean> {
    clearDebounce();
    const draft = readPublishDraft(draftKey);
    if (!draft) {
      // Nothing to restore: the pristine state becomes the clean baseline.
      options.markClean();
      releaseGuardIfClean();
      return false;
    }
    await options.restore(draft.form);
    options.markClean();
    releaseGuardIfClean();
    return true;
  }

  function dispose(): void {
    clearDebounce();
    if (guardBound) {
      window.removeEventListener("beforeunload", beforeUnloadHandler);
      guardBound = false;
    }
  }

  return { scheduleSave, saveNow, restoreFor, dispose };
}
