/**
 * Sandboxed preload bridge — the only surface the renderer can reach.
 *
 * `contextIsolation` is on and this file is CommonJS inside a sandboxed
 * preload: no Node imports beyond `electron`'s own modules. The exposed API
 * is a single `window.meshrixEntry` object:
 *   invoke(op, args) → GuiIpcResult   (allowlisted ops only)
 *   onState(callback) → unsubscribe   (redacted snapshots pushed from main)
 *
 * No secret material crosses this bridge as state — `recovery.revealKey` is
 * the single deliberate exception carrying the recovery text exactly once.
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const INVOKE = "meshrix-entry";
const STATE = "meshrix-entry:state";

const OPS = Object.freeze([
  "state.get",
  "pairing.submitInvite",
  "pairing.confirm",
  "pairing.cancel",
  "pairing.reset",
  "connection.refresh",
  "connection.revoke",
  "recovery.beginSetup",
  "recovery.revealKey",
  "recovery.confirmSaved",
  "recovery.beginRotation",
  "recovery.abortRotation",
  "recovery.retryRotation",
  "recovery.importText",
  "mcp.snippet",
  "mcp.writeConfig",
  "lifecycle.ownedPaths",
  "app.stop"
]);

const api = Object.freeze({
  invoke(op, args) {
    if (!OPS.includes(op)) {
      return Promise.resolve({ ok: false, error: { code: "ipc_op_denied", message: "Operation is not in the GUI op allowlist." } });
    }
    return ipcRenderer.invoke(INVOKE, { op, args });
  },
  onState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(STATE, listener);
    return () => ipcRenderer.removeListener(STATE, listener);
  },
  ops: OPS
});

contextBridge.exposeInMainWorld("meshrixEntry", api);
