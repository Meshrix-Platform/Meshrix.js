/**
 * Renderer store: the latest redacted snapshot plus convenience invocations.
 * The renderer holds NO secrets — `recovery.revealKey`'s response is the one
 * deliberate exception, kept in component-local state for the one-shot
 * display and cleared when the user confirms or navigates away.
 */
import { computed, reactive, readonly } from "vue";

import type { GuiState } from "../shared/gui-state.ts";
import { GUI_STATE_SCHEMA_VERSION } from "../shared/gui-state.ts";
import { invoke, onState } from "./bridge.ts";

export const emptyState: GuiState = {
  schemaVersion: GUI_STATE_SCHEMA_VERSION,
  appVersion: "0.1.0",
  custody: { tier: "unavailable", available: false, reason: "bridge not connected" },
  lifecycle: { state: "starting", dataDir: "", configPath: "", ownedPaths: [], updatePolicy: "manual" },
  pairing: { phase: "idle", sessionId: null, invite: null, deviceFingerprint: null, refusal: null, enrolledConnectionId: null },
  recovery: {
    state: "not_configured",
    vaultId: null,
    keyId: null,
    generation: null,
    keyRevealed: false,
    backup: { lastSuccessAt: null, lastCommittedRevision: null, lastError: null },
    rotation: null
  },
  recoveryImport: { phase: "idle", detail: null, enrolledConnectionId: null },
  connections: [],
  mcp: { transport: "stdio", snippet: null, configuredPath: null },
  notices: []
};

export const store = reactive({
  state: emptyState as GuiState,
  lastError: null as string | null,
  ready: false
});

/** The latest redacted snapshot — always a complete GuiState (empty until the first push). */
export const state = computed<GuiState>(() => store.state);

let unsubscribe: (() => void) | null = null;

export function startStore(): void {
  if (unsubscribe) return;
  unsubscribe = onState((next) => {
    store.state = next;
    store.ready = true;
  });
  void invoke<GuiState>("state.get").then((result) => {
    if (result.ok) {
      store.state = result.value;
      store.ready = true;
    } else {
      store.lastError = result.error.message;
    }
  });
}

export async function runOp<T = unknown>(op: Parameters<typeof invoke>[0], args?: unknown): Promise<T | null> {
  store.lastError = null;
  const result = await invoke<T>(op, args);
  if (!result.ok) {
    store.lastError = `${result.error.code}: ${result.error.message}`;
    return null;
  }
  return result.value;
}

export const readOnlyStore = readonly(store);
