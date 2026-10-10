/**
 * Narrow IPC contract between the sandboxed renderer and the trusted main
 * process.
 *
 * One invoke channel (`meshrix-entry`) carries `{op, args}` envelopes; a
 * second channel (`meshrix-entry:state`) pushes redacted snapshots. The op
 * set is closed — the preload whitelists exactly these names and the contract
 * test asserts parity between the two lists.
 *
 * Secrets never travel as state. The only sensitive payloads are the two
 * deliberate exceptions:
 *   - `recovery.revealKey` returns the freshly generated recovery text exactly
 *     once inside the pending save window;
 *   - `recovery.importText` accepts the user's recovery text as an argument,
 *     consumed by the main process and never echoed into state.
 */
export const GUI_IPC_INVOKE_CHANNEL = "meshrix-entry";
export const GUI_IPC_STATE_CHANNEL = "meshrix-entry:state";

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
