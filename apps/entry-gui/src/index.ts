/**
 * @meshrix/entry-gui — installed macOS/Windows entry product.
 *
 * Public surface for tests and tooling: the secret-free state contract, the
 * deterministic model, the IPC envelope and the main-process product service.
 * The Electron bootstrap (`main/electron-entry.ts`) and the sandboxed
 * preload (`preload/index.cjs`) are runtime entry points, not library
 * exports.
 */
export * from "./shared/gui-state.ts";
export * from "./shared/gui-model.ts";
export * from "./shared/ipc-contract.ts";
export {
  EntryProductService,
  createEntryProductService,
  type EntryProductServiceOptions,
  type EntrySessionLike,
  type EntryTransportLike,
  type LiveSession,
  type PairingChannelLike,
  type RecoveryChannelFactoryInput,
  type RecoveryChannelLike
} from "./main/product-service.ts";
export {
  EntryConfigStore,
  emptyEntryGuiConfig,
  parseEntryGuiConfig,
  ENTRY_GUI_CONFIG_SCHEMA,
  type EntryGuiConfig,
  type StoredConnection,
  type StoredRecovery,
  type StoredRotation,
  type StoredSnapshotJournal
} from "./main/config-store.ts";
export {
  HttpPairingChannel,
  createHttpPairingChannel,
  type PairingEnrollmentExtras
} from "./main/pairing-channel.ts";
export {
  issueDeviceCertificate,
  custodyDeviceSigner,
  ed25519SpkiPinFromRaw,
  type IssuedDeviceCertificate
} from "./main/device-cert.ts";
export {
  buildMcpStdioSnippet,
  managedMcpConfigPath,
  writeManagedMcpConfig,
  type McpSnippetInput
} from "./main/mcp-config.ts";
export {
  ownedPathsFor,
  type EntryLifecyclePaths
} from "./main/lifecycle.ts";
