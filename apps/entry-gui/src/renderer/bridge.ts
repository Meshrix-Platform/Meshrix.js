/**
 * Renderer-side typed bridge over `window.meshrixEntry` (the preload API).
 * The preload exposes exactly the allowlisted ops; this wrapper carries the
 * types so views never hand-build envelopes.
 */
import type { GuiState } from "../shared/gui-state.ts";
import type { GuiIpcResult, GuiOp } from "../shared/ipc-contract.ts";

declare global {
  interface Window {
    meshrixEntry?: {
      invoke(op: GuiOp, args?: unknown): Promise<GuiIpcResult>;
      onState(callback: (state: GuiState) => void): () => void;
      ops: readonly string[];
    };
  }
}

export function bridgeAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.meshrixEntry?.invoke === "function";
}

export async function invoke<T = unknown>(op: GuiOp, args?: unknown): Promise<GuiIpcResult<T>> {
  const api = window.meshrixEntry;
  if (!api) {
    return { ok: false, error: { code: "bridge_unavailable", message: "The trusted bridge is not present; run inside the packaged app." } };
  }
  return api.invoke(op, args) as Promise<GuiIpcResult<T>>;
}

export function onState(callback: (state: GuiState) => void): () => void {
  return window.meshrixEntry?.onState(callback) ?? (() => undefined);
}
