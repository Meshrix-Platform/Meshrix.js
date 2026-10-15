/**
 * @meshrix/entry-gui — installed macOS/Windows entry product.
 *
 * Public surface for tests and tooling: the secret-free state contract, the
 * deterministic model, the loopback API contract, the main-process product
 * service and the loopback server/client transport. The Node service entry
 * (`main/service-entry.ts`) and the Tauri shell (`src-tauri/`) are runtime
 * entry points, not library exports.
 */
export * from "./shared/gui-state.ts";
export * from "./shared/gui-model.ts";
export * from "./shared/ipc-contract.ts";
export {
  GuiLoopbackClient,
  guiBridgeConfig,
  type GuiBridgeConfig
} from "./shared/loopback-client.ts";
export {
  createEntryGuiLoopbackServer,
  type EntryGuiLoopbackServer,
  type EntryGuiLoopbackServerOptions,
  type EntryGuiServiceApi
} from "./main/loopback-server.ts";
export {
  EntryProductService,
  createEntryProductService,
  type EntryProductServiceOptions,
  type EntrySessionLike,
  type EntryTransportLike,
  type LiveSession,
  type PairingChannelLike,
  type PairingCompletionRelayChannelLike,
  type PairingCompletionRelayChannelFactoryInput,
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
  createHttpPairingChannel
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
