/**
 * Compile-time boundary fixtures for the upload-workspace materialization
 * model.
 *
 * This file is typechecked by `tsconfig.tests.json` and is never executed.
 * Negative cases assert that contradictory durable states, publication
 * variants and port shapes fail to compile; positive cases keep the intended
 * shapes anchored for the engine, the transaction store and the provider.
 */
import {
  createUploadWorkspaceMaterialization
} from "../../packages/server-runtime/src/jobs/upload-workspace-materialization/index.ts";
import type {
  MaterializationAdmittedState,
  MaterializationAuditPort,
  MaterializationAuthorityPort,
  MaterializationCompletedResult,
  MaterializationCompletedState,
  MaterializationCustodyReadPort,
  MaterializationDurableState,
  MaterializationEvidencePendingState,
  MaterializationProofPort,
  MaterializationPublicationIntentState,
  MaterializationResolvedOperation,
  MaterializationResourcePort,
  MaterializationTransactionPort,
  MaterializationWorkspacePort,
  PublicationIntent,
  PublicationPrepared,
  PublicationReservation
} from "../../packages/server-runtime/src/jobs/upload-workspace-materialization/model.ts";

import {
  createUploadWorkspaceMaterializationRuntime,
  type CreateMaterializationRuntimeOptions
} from "../../packages/server-runtime/src/jobs/upload-workspace-materialization/runtime.ts";
import { createUploadWorkspaceMaterializationProvider } from "../../packages/server-runtime/src/composition/upload-workspace-materialization-provider.ts";

declare const admittedState: MaterializationAdmittedState;
declare const publicationIntent: PublicationIntent;
declare const publicationReserved: PublicationReservation;
declare const publicationPrepared: PublicationPrepared;
declare const completedResult: MaterializationCompletedResult;
declare const transactionStore: MaterializationTransactionPort;
declare const authorityPort: MaterializationAuthorityPort;
declare const custodyReadPort: MaterializationCustodyReadPort;
declare const resourcePort: MaterializationResourcePort;
declare const workspacePort: MaterializationWorkspacePort;
declare const auditPort: MaterializationAuditPort;
declare const proofPort: MaterializationProofPort;
declare const resolveOperation: (
  operationId: string
) => MaterializationResolvedOperation;

export const admitted: MaterializationAdmittedState = admittedState;
export const intent: PublicationIntent = publicationIntent;
export const preparedPublication: PublicationPrepared = publicationPrepared;
export const completed: MaterializationCompletedResult = completedResult;

export function acceptedEnginePorts() : void {
  createUploadWorkspaceMaterialization({ authorityPort, custodyReadPort, resourcePort, workspacePort, transactionStore, resolveOperation, auditPort, proofPort });
}

export function rejectedStates() : void {
  // @ts-expect-error a published state requires its committed effect and checkpoint result
  const publishedWithoutEffect: MaterializationDurableState = { ...admittedState, stage: "published" };
  // @ts-expect-error a completed state requires the durable completed result
  const completedWithCheckpoint: MaterializationCompletedState = { ...admittedState, stage: "completed", status: "completed" };
  // @ts-expect-error an admitted state is effect-free and never carries a publication
  const admittedWithPublication: MaterializationAdmittedState = { ...admittedState, publication: publicationPrepared };
  // @ts-expect-error a publication intent cannot carry reservation evidence
  const intentWithReservation: PublicationIntent = { ...publicationIntent, reservationDigest: "reserved" };
  // @ts-expect-error a publication reservation cannot carry a proof digest
  const reservedWithProof: PublicationReservation = { ...publicationReserved, proofDigest: "proof" };
  // @ts-expect-error a settlement state requires its settlement evidence
  const pendingWithoutEvidence: MaterializationEvidencePendingState = { ...admittedState, stage: "evidence_pending" };
  // @ts-expect-error a publication intent state keeps the intent variant
  const intentWithPreparedPublication: MaterializationPublicationIntentState = { ...admittedState, stage: "publication_intent", status: "running", publication: publicationPrepared };
}

export function rejectedPorts() : void {
  // @ts-expect-error the transaction contract requires the full durable command surface
  createUploadWorkspaceMaterialization({ authorityPort, custodyReadPort, resourcePort, workspacePort, transactionStore: { get: async () => null }, resolveOperation, auditPort, proofPort });
  // @ts-expect-error the authority port must revalidate current authority
  createUploadWorkspaceMaterialization({ authorityPort: { revalidate: true }, custodyReadPort, resourcePort, workspacePort, transactionStore, resolveOperation, auditPort, proofPort });
  // @ts-expect-error the workspace port must expose withRequest
  createUploadWorkspaceMaterialization({ authorityPort, custodyReadPort, resourcePort, workspacePort: {}, transactionStore, resolveOperation, auditPort, proofPort });
  // @ts-expect-error the transaction contract does not expose arbitrary commands
  transactionStore.someUnknownCommand({});
}

// Production runtime wiring has the same checked boundaries as the engine.
declare const runtimeOptions: CreateMaterializationRuntimeOptions;
export function runtimeBoundaries(): void {
  void createUploadWorkspaceMaterializationRuntime(runtimeOptions);
  // @ts-expect-error a storage port cannot silently lose its transaction methods
  void createUploadWorkspaceMaterializationRuntime({ ...runtimeOptions, transactionStore: { get: async () => null } });
  // @ts-expect-error a queue owner must return an awaitable close barrier
  void createUploadWorkspaceMaterializationRuntime({ ...runtimeOptions, queueApplicationPort: { registerQueue: async () => ({ close: false }) } });
  // @ts-expect-error composition cannot silently omit runtime dependencies
  void createUploadWorkspaceMaterializationProvider({ workspaceMaterializationPort: {} });
}
