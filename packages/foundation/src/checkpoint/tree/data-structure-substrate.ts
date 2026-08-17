import {
  checkpointTreeId,
  checkpointTreeSummary,
  deleteCheckpointTree,
  diffCheckpointTree,
  finishCheckpointTree,
  listCheckpointTrees,
  loadCheckpointTree,
  previewCheckpointRestore,
  queryCheckpointScope,
  restoreCheckpointTree,
  startCheckpointTree,
  upsertCheckpointNode,
  CHECKPOINT_TREE_PROJECTION_PROVIDER
} from "./checkpoint-tree-projection.ts";
import {
  MERKLE_STATE_SUBSTRATE_PROVIDER,
  createPactiumStateSubstrate
} from "./merkle-state-substrate.ts";
import {
  PACTIUM_PACKAGE_VERSION,
  PACTIUM_PROTOCOL,
  PACTIUM_SCHEMA_VERSION,
  PROTOCOL_STORAGE_CATEGORY,
  assertCurrentDataDir,
  classifyProtocolStorageArtifact
} from "pactium";
import {
  clamp,
  clampLimit,
  escapeRegExp,
  normalizeWhitespace,
  truncateText,
  uniqueNormalizedStrings
} from "./text-normalization-substrate.ts";
import { createMeshrixPactiumRuntime, resolveMeshrixPactiumDataDir } from "./pactium-runtime.ts";
import type { CheckpointProjectionInput } from "./types.ts";

export const DATA_STRUCTURE_SUBSTRATE_PROTOCOL_VERSION = "v0.0.1:storage:data-structure-substrate-1";

export {
  classifyProtocolStorageArtifact,
  PROTOCOL_STORAGE_CATEGORY
};

const storageArtifactClassifiers: readonly typeof classifyProtocolStorageArtifact[] = Object.freeze([
  classifyProtocolStorageArtifact
]);

function withUserDataPath(userDataPath: string, input: CheckpointProjectionInput = {}): CheckpointProjectionInput {
  const next = input || {};
  return {
    ...next,
    userDataPath
  };
}

export function createDataStructureSubstrate({ userDataPath = "" }: { userDataPath?: string } = {}) {
  const dataDir = resolveMeshrixPactiumDataDir(userDataPath);
  assertCurrentDataDir({ dataDir });
  const pactiumRuntime = createMeshrixPactiumRuntime({ dataDir });
  const checkpointTreeProjection = Object.freeze({
    checkpointTreeId,
    checkpointTreeSummary,
    deleteCheckpointTree(input: CheckpointProjectionInput = {}) {
      return deleteCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    diffCheckpointTree(input: CheckpointProjectionInput = {}) {
      return diffCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    finishCheckpointTree(input: CheckpointProjectionInput = {}) {
      return finishCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    listCheckpointTrees(input: CheckpointProjectionInput = {}) {
      return listCheckpointTrees({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    loadCheckpointTree(input: CheckpointProjectionInput = {}) {
      return loadCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    previewCheckpointRestore(input: CheckpointProjectionInput = {}) {
      return previewCheckpointRestore({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    queryCheckpointScope(input: CheckpointProjectionInput = {}) {
      return queryCheckpointScope({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    restoreCheckpointTree(input: CheckpointProjectionInput = {}) {
      return restoreCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    startCheckpointTree(input: CheckpointProjectionInput = {}) {
      return startCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    upsertCheckpointNode(input: CheckpointProjectionInput = {}) {
      return upsertCheckpointNode({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    }
  });

  const textNormalizationSubstrate = Object.freeze({
    clamp,
    clampLimit,
    escapeRegExp,
    normalizeWhitespace,
    truncateText,
    uniqueNormalizedStrings
  });

  const merkleStateSubstrate = createPactiumStateSubstrate({ userDataPath: dataDir, pactiumRuntime });

  return Object.freeze({
    protocol: PACTIUM_PROTOCOL,
    schema: PACTIUM_SCHEMA_VERSION,
    protocolVersion: DATA_STRUCTURE_SUBSTRATE_PROTOCOL_VERSION,
    provider: "pactium",
    providerProtocolVersion: PACTIUM_PROTOCOL,
    providerPackageVersion: PACTIUM_PACKAGE_VERSION,
    pactiumRuntime,
    providerCapabilities: Object.freeze({
      checkpointTreeProjection: CHECKPOINT_TREE_PROJECTION_PROVIDER,
      merkleStateSubstrate: MERKLE_STATE_SUBSTRATE_PROVIDER
    }),
    checkpointTreeProjection,
    merkleStateSubstrate,
    textNormalizationSubstrate,
    storageArtifactClassifiers,
    close()  {
      return pactiumRuntime.close?.() || Promise.resolve();
    },
    listCapabilities()  {
      return {
        protocolVersion: DATA_STRUCTURE_SUBSTRATE_PROTOCOL_VERSION,
        provider: "pactium",
        providerProtocolVersion: PACTIUM_PROTOCOL,
        providerPackageVersion: PACTIUM_PACKAGE_VERSION,
        capabilities: [
          {
            id: "checkpoint-tree-projection",
            kind: "projection",
            operations: [
              "checkpointTreeId",
              "startCheckpointTree",
              "upsertCheckpointNode",
              "finishCheckpointTree",
              "listCheckpointTrees",
              "loadCheckpointTree",
              "diffCheckpointTree",
              "queryCheckpointScope",
              "previewCheckpointRestore",
              "restoreCheckpointTree",
              "deleteCheckpointTree"
            ]
          },
          {
            id: "merkle-state-substrate",
            kind: "algorithm-substrate",
            operations: [
              "canonicalCodec",
              "cas",
              "merkleDag",
              "merkleIndex",
              "eventLog",
              "stateCommit",
              "uploadManifest"
            ]
          },
          {
            id: "text-normalization-substrate",
            kind: "pure-algorithm-substrate",
            operations: [
              "normalizeWhitespace",
              "truncateText",
              "clamp",
              "clampLimit",
              "escapeRegExp",
              "uniqueNormalizedStrings"
            ]
          },
          {
            id: "protocol-substrate-storage-classifier",
            kind: "storage-artifact-classifier",
            operations: [
              "classifyProtocolStorageArtifact"
            ]
          }
        ]
      };
    }
  });
}
