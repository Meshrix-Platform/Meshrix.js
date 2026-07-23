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
} from "./checkpoint-tree-projection.mjs";
import {
  MERKLE_STATE_SUBSTRATE_PROVIDER,
  createPactiumStateSubstrate
} from "./merkle-state-substrate.mjs";
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
} from "./text-normalization-substrate.mjs";
import {
  assertPactiumFreshDataDir,
  classifyProtocolSubstrateStorageArtifact,
  createLicoPactiumRuntime,
  PROTOCOL_SUBSTRATE_STORAGE_CATEGORY,
  resolveLicoPactiumDataDir
} from "./pactium-substrate-preflight.mjs";

export const DATA_STRUCTURE_SUBSTRATE_PROTOCOL_VERSION = "v0.0.1:storage:data-structure-substrate-1";

export {
  classifyProtocolSubstrateStorageArtifact,
  PROTOCOL_SUBSTRATE_STORAGE_CATEGORY
};

const storageArtifactClassifiers = Object.freeze([
  classifyProtocolSubstrateStorageArtifact
]);

function withUserDataPath(userDataPath, input = {}) {
  const next = input || {};
  return {
    ...next,
    userDataPath
  };
}

export function createDataStructureSubstrate({ userDataPath = "" } = {}) {
  const dataDir = resolveLicoPactiumDataDir(userDataPath);
  assertPactiumFreshDataDir({ userDataPath: dataDir });
  const pactiumRuntime = createLicoPactiumRuntime({ dataDir });
  const checkpointTreeProjection = Object.freeze({
    checkpointTreeId,
    checkpointTreeSummary,
    deleteCheckpointTree(input = {}) {
      return deleteCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    diffCheckpointTree(input = {}) {
      return diffCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    finishCheckpointTree(input = {}) {
      return finishCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    listCheckpointTrees(input = {}) {
      return listCheckpointTrees({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    loadCheckpointTree(input = {}) {
      return loadCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    previewCheckpointRestore(input = {}) {
      return previewCheckpointRestore({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    queryCheckpointScope(input = {}) {
      return queryCheckpointScope({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    restoreCheckpointTree(input = {}) {
      return restoreCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    startCheckpointTree(input = {}) {
      return startCheckpointTree({ ...withUserDataPath(dataDir, input), pactiumRuntime });
    },
    upsertCheckpointNode(input = {}) {
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
    close() {
      return pactiumRuntime.close?.() || Promise.resolve();
    },
    listCapabilities() {
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
