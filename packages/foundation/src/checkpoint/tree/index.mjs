/**
 * Checkpoint tree facade.
 * Runtime checkpoint authority is the Pactium-backed projection exposed by the
 * data-structure substrate. Local Merkle checkpoint trees are retired.
 */

export {
  CHECKPOINT_TREE_PROJECTION_PROVIDER,
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
  upsertCheckpointNode
} from "./checkpoint-tree-projection.mjs";

export {
  createDataStructureSubstrate,
  DATA_STRUCTURE_SUBSTRATE_PROTOCOL_VERSION
} from "./data-structure-substrate.mjs";

export {
  exportCheckpointTreeProjection,
  importCheckpointTreeProjection
} from "./export-import.mjs";
