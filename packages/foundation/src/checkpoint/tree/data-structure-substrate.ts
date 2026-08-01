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
  PACTIUM_SCHEMA_VERSION
} from "pactium";
import {
  clamp,
  clampLimit,
  escapeRegExp,
  normalizeWhitespace,
  truncateText,
  uniqueNormalizedStrings
} from "./text-normalization-substrate.ts";
import {
  assertPactiumFreshDataDir,
  classifyProtocolSubstrateStorageArtifact,
  createMeshrixPactiumRuntime,
  PROTOCOL_SUBSTRATE_STORAGE_CATEGORY,
  resolveMeshrixPactiumDataDir
} from "./pactium-substrate-preflight.ts";

export const DATA_STRUCTURE_SUBSTRATE_PROTOCOL_VERSION: any = "v0.0.1:storage:data-structure-substrate-1";

export {
  classifyProtocolSubstrateStorageArtifact,
  PROTOCOL_SUBSTRATE_STORAGE_CATEGORY
};

const storageArtifactClassifiers: readonly any[] = Object.freeze([
  classifyProtocolSubstrateStorageArtifact
]);

function withUserDataPath(userDataPath?: any, input: Record<string, any> = {}) : any {
  const next: any = input || {};
  return {
    ...next,
    userDataPath
  };
}

export function createDataStructureSubstrate({ userDataPath = "" }: Record<string, any> = {}) : any {
  const dataDir: any = resolveMeshrixPactiumDataDir(userDataPath);
  assertPactiumFreshDataDir({ userDataPath: dataDir });
  const pactiumRuntime: any = createMeshrixPactiumRuntime({ dataDir });
  const checkpointTreeProjection: Readonly<Record<string, any>> = Object.freeze({
    checkpointTreeId,
    checkpointTreeSummary,
    deleteCheckpointTree(input: Record<string, any> = {}) : any {
      return deleteCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    diffCheckpointTree(input: Record<string, any> = {}) : any {
      return diffCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    finishCheckpointTree(input: Record<string, any> = {}) : any {
      return finishCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    listCheckpointTrees(input: Record<string, any> = {}) : any {
      return listCheckpointTrees({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    loadCheckpointTree(input: Record<string, any> = {}) : any {
      return loadCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    previewCheckpointRestore(input: Record<string, any> = {}) : any {
      return previewCheckpointRestore({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    queryCheckpointScope(input: Record<string, any> = {}) : any {
      return queryCheckpointScope({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    restoreCheckpointTree(input: Record<string, any> = {}) : any {
      return restoreCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    startCheckpointTree(input: Record<string, any> = {}) : any {
      return startCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    upsertCheckpointNode(input: Record<string, any> = {}) : any {
      return upsertCheckpointNode({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    }
  });

  const textNormalizationSubstrate: Readonly<Record<string, any>> = Object.freeze({
    clamp,
    clampLimit,
    escapeRegExp,
    normalizeWhitespace,
    truncateText,
    uniqueNormalizedStrings
  });

  const merkleStateSubstrate: any = createPactiumStateSubstrate({ userDataPath: dataDir, pactiumRuntime });

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
    close() : any {
      return pactiumRuntime.close?.() || Promise.resolve();
    },
    listCapabilities() : any {
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
              "lsmIngest"
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
              "classifyProtocolSubstrateStorageArtifact"
            ]
          }
        ]
      };
    }
  });
}
