/**
 * Import and export helpers for checkpoint trees.
 * Import lands trees in the Pactium checkpoint projection and reuses substrate
 * proof material — it never computes local Merkle roots.
 */

import {
  finishCheckpointTree,
  loadCheckpointTree,
  startCheckpointTree,
  upsertCheckpointNode
} from "./checkpoint-tree-projection.mjs";
import {
  normalizeLicoPactiumRuntime,
  resolveLicoPactiumDataDir
} from "./pactium-substrate-preflight.mjs";

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

/**
 * Export a Pactium-backed checkpoint tree projection.
 *
 * @param {object} options
 * @param {string} options.userDataPath
 * @param {string} options.treeId
 * @param {object} [options.pactiumRuntime]
 * @returns {Promise<{ tree: object|null, records: object[], proofRefs: object[] }>}
 */
export async function exportCheckpointTreeProjection({
  userDataPath = "",
  treeId = "",
  pactiumRuntime = null
} = {}) {
  const dataDir = resolveLicoPactiumDataDir(userDataPath);
  const runtime = normalizeLicoPactiumRuntime({ dataDir, pactiumRuntime });
  const tree = await loadCheckpointTree({
    userDataPath: dataDir,
    treeId,
    pactiumRuntime: runtime
  });
  if (!tree) {
    return { tree: null, records: [], proofRefs: [] };
  }
  const records = Object.values(asObject(tree.nodes)).map((node) => ({ ...node }));
  const proofRefs = asArray(tree.events)
    .map((event) => asObject(event?.pactium))
    .filter((proof) => text(proof.ledgerEventId) || text(proof.envelopeId));
  return { tree, records, proofRefs };
}

/**
 * Import checkpoint tree records into the Pactium checkpoint projection.
 * Local Merkle roots are not computed; proof refs come from substrate operations.
 *
 * @param {object} options
 * @param {string} options.userDataPath
 * @param {string} options.treeId
 * @param {object[]} [options.records]
 * @param {object} [options.metadata]
 * @param {object} [options.pactiumRuntime]
 * @returns {Promise<{ imported: number, skipped: number, errors: object[], tree: object, proofRefs: object[] }>}
 */
export async function importCheckpointTreeProjection({
  userDataPath = "",
  treeId = "",
  records = [],
  metadata = {},
  resumePolicy = null,
  pactiumRuntime = null
} = {}) {
  if (!Array.isArray(records)) {
    throw new Error("records must be an array");
  }
  const dataDir = resolveLicoPactiumDataDir(userDataPath);
  const runtime = normalizeLicoPactiumRuntime({ dataDir, pactiumRuntime });
  const normalizedTreeId = text(treeId);
  if (!normalizedTreeId) {
    throw new Error("treeId is required");
  }

  let imported = 0;
  let skipped = 0;
  const errors = [];

  const tree = await startCheckpointTree({
    userDataPath: dataDir,
    treeId: normalizedTreeId,
    rootNodeId: "root",
    rootLabel: "Imported root",
    metadata: {
      ...asObject(metadata),
      importSource: "checkpoint-tree-projection-import"
    },
    resumePolicy: resumePolicy || undefined,
    pactiumRuntime: runtime
  });

  const existingNodeIds = new Set(Object.keys(asObject(tree.nodes)));

  for (let index = 0; index < records.length; index += 1) {
    const record = asObject(records[index]);
    const nodeId = text(record.nodeId || record.id);
    if (!nodeId) {
      errors.push({ index, message: "nodeId is required" });
      continue;
    }
    if (existingNodeIds.has(nodeId) && nodeId !== text(tree.rootNodeId, "root")) {
      skipped += 1;
      continue;
    }
    try {
      const objectRefs = asArray(record.objectRefs);
      await upsertCheckpointNode({
        userDataPath: dataDir,
        treeId: normalizedTreeId,
        nodeId,
        parentId: text(record.parentId, text(tree.rootNodeId, "root")),
        label: text(record.label || record.effectKind, nodeId),
        status: text(record.status, "completed"),
        metadata: {
          ...asObject(record.metadata),
          // Preserve prior refs as metadata only — never as a local Merkle authority.
          importedObjectRefs: objectRefs,
          importedActor: text(record.actor),
          importedEffectKind: text(record.effectKind)
        },
        pactiumRuntime: runtime
      });
      existingNodeIds.add(nodeId);
      imported += 1;
    } catch (error) {
      errors.push({
        index,
        message: `Upsert failed: ${error?.message || String(error)}`
      });
    }
  }

  const finished = await finishCheckpointTree({
    userDataPath: dataDir,
    treeId: normalizedTreeId,
    status: errors.length > 0 ? "failed" : "completed",
    pactiumRuntime: runtime
  });

  const proofRefs = asArray(finished.events)
    .map((event) => asObject(event?.pactium))
    .filter((proof) => text(proof.ledgerEventId) || text(proof.envelopeId));

  return {
    imported,
    skipped,
    errors,
    tree: finished,
    proofRefs
  };
}
