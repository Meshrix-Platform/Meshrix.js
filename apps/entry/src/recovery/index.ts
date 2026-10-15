export {
  ENTRY_BUNDLE_KIND,
  ENTRY_BUNDLE_SCHEMA,
  assertBundleRecoverable,
  buildEntryRecoveryBundle,
  mergeRecoveryBundles,
  parseEntryRecoveryBundle,
  type BundleConnection,
  type EntryRecoveryBundle
} from "./bundle.ts";
export {
  ENTRY_RECOVERY_FORMAT_VERSION,
  ENTRY_RECOVERY_SECRET_BYTES,
  ENTRY_RECOVERY_TEXT_PREFIX,
  base32Decode,
  base32Encode,
  formatRecoveryText,
  generateRecoveryKey,
  parseRecoveryText,
  type RecoveryKeyMaterial
} from "./recovery-key.ts";
export {
  ENTRY_SNAPSHOT_FORMAT_VERSION,
  InMemorySnapshotJournal,
  SnapshotSynchronizer,
  createSnapshotSynchronizer,
  type FetchOutcome,
  type PublishOutcome,
  type SnapshotJournal,
  type PendingSnapshotWrite,
  type SnapshotJournalPort
} from "./snapshot-sync.ts";
export {
  RECOVERY_LABEL_BACKUP_ENCRYPTION,
  RECOVERY_LABEL_BACKUP_WRITER,
  RECOVERY_LABEL_SIGNING,
  deriveRecoveryMaterial,
  openRecoverySnapshot,
  sealRecoverySnapshot,
  snapshotAad,
  type AeadEnvelopeFields,
  type DerivedRecoveryKey,
  type RecoveryMaterial
} from "./recovery-crypto.ts";
export {
  EntryRecoverySession,
  createEntryRecoverySession,
  type RecoveryBootstrapInput,
  type RecoveryBootstrapOutcome,
  type RecoveryEndpointPort
} from "./recovery-session.ts";
export {
  EntryRecoveryService,
  createEntryRecoveryService,
  type FreshRecoveryOutcome,
  type RecoveryServiceOptions
} from "./recovery-service.ts";
export {
  FetchVaultTransport,
  RecoveryVaultClient,
  createRecoveryVaultClient,
  type VaultFetchOutcome,
  type VaultSigningMaterial,
  type VaultSnapshotView,
  type VaultTransport,
  type VaultTransportResponse,
  type VaultWriteOutcome
} from "./vault-client.ts";
export {
  InMemoryRotationStore,
  RecoveryRotationManager,
  createRecoveryRotationManager,
  type EndpointAckState,
  type RecoveryRotation,
  type RotationDurablePort,
  type RotationEndpointStatus,
  type RotationState
} from "./rotation.ts";
