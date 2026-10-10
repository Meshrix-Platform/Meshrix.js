/**
 * Narrow API contract between the Vue renderer and the trusted Node backend
 * service — the exact same boundary the old Electron preload enforced, now
 * carried over the loopback transport instead of `contextBridge`/`ipcMain`.
 *
 * Transport: the backend binds `node:http` on `127.0.0.1` with an ephemeral
 * port and a per-launch bearer token (passed to the service through env, to
 * the renderer through the Tauri `meshrix_bridge_config` command). Two routes
 * implement the contract:
 *   - `POST /meshrix-entry`        — `{op, args}` invoke → `GuiIpcResult`
 *   - `POST /meshrix-entry:state`  — `{after}` long-poll → `GuiStatePush`
 * The op set is closed — the server whitelists exactly these names and the
 * contract test asserts parity between the allowlist and the live transport.
 *
 * Secrets never travel as state. The only sensitive payloads are the two
 * deliberate exceptions:
 *   - `recovery.revealKey` returns the freshly generated recovery text exactly
 *     once inside the pending save window;
 *   - `recovery.importText` accepts the user's recovery text as an argument,
 *     consumed by the service and never echoed into state.
 * The bearer token itself appears only in the `Authorization` request header —
 * never in URLs, logs or the window title.
 */
export const GUI_API_INVOKE_ROUTE = "/meshrix-entry";
export const GUI_API_STATE_ROUTE = "/meshrix-entry:state";

export interface GuiIpcEnvelope<A = unknown> {
  readonly op: GuiOp;
  readonly args?: A;
}

export interface GuiIpcError {
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
}

export type GuiIpcResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GuiIpcError };

/** Long-poll request body for the state route. `after` is the last seen seq. */
export interface GuiStatePollRequest {
  readonly after?: number;
}

/** One pushed redacted snapshot; `seq` is a per-process monotonic counter. */
export interface GuiStatePush<S = unknown> {
  readonly seq: number;
  readonly state: S;
}

export const GUI_OPS = Object.freeze([
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
] as const);

export type GuiOp = (typeof GUI_OPS)[number];

export function isGuiOp(value: unknown): value is GuiOp {
  return typeof value === "string" && (GUI_OPS as readonly string[]).includes(value);
}

export interface PairingSubmitArgs {
  readonly inviteText: string;
  /** Pairing surface base URL (endpoint admin host); defaults to the invite's relayService origin. */
  readonly pairingService?: string;
}

export interface ConnectionArgs {
  readonly connectionId: string;
}

export interface ConnectionRevokeArgs extends ConnectionArgs {
  /** Best-effort remote revocation through the pairing surface. */
  readonly remote?: boolean;
}

export interface RecoveryImportArgs {
  readonly recoveryText: string;
  /** Endpoint service address — required on a fresh install when no default is stored. */
  readonly serviceUrl?: string;
}

export interface RecoveryRevealResult {
  /** The one-shot recovery text. Present exactly once per pending key. */
  readonly recoveryText: string;
  readonly vaultId: string;
  readonly keyId: string;
}

export interface McpSnippetResult {
  readonly snippet: string;
  readonly instructions: string;
  readonly managedPath: string | null;
}

export interface OwnedPathsResult {
  readonly ownedPaths: readonly string[];
  readonly note: string;
}
