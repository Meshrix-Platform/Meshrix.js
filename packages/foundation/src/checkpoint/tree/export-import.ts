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
} from "./checkpoint-tree-projection.ts";
import {
  normalizeMeshrixPactiumRuntime,
  resolveMeshrixPactiumDataDir
} from "./pactium-runtime.ts";

function text(value?: any, fallback: any = "") : any {
  const normalized: any = String(value ?? "").trim();
  return normalized || fallback;
}

function asArray(value?: any) : any {
  return Array.isArray(value) ? value : [];
}

function asObject(value?: any, fallback: Record<string, any> | null = {}) : any {
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
}: Record<string, any> = {}) : Promise<any> {
  const dataDir: any = resolveMeshrixPactiumDataDir(userDataPath);
  const runtime: any = normalizeMeshrixPactiumRuntime({ dataDir, pactiumRuntime });
  const tree: any = await loadCheckpointTree({
    userDataPath: dataDir,
    treeId,
    pactiumRuntime: runtime
  });
  if (!tree) {
    return { tree: null, records: [], proofRefs: [] };
  }
  const records: any = (Object.values(asObject(tree.nodes)) as any[]).map((node?: any) : any => ({ ...node }));
  const proofRefs: any = asArray(tree.events)
    .map((event?: any) : any => asObject(event?.pactium))
    .filter((proof?: any) : any => text(proof.ledgerEventId) || text(proof.envelopeId));
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
}: Record<string, any> = {}) : Promise<any> {
  if (!Array.isArray(records)) {
    throw new Error("records must be an array");
  }
  const dataDir: any = resolveMeshrixPactiumDataDir(userDataPath);
  const runtime: any = normalizeMeshrixPactiumRuntime({ dataDir, pactiumRuntime });
  const normalizedTreeId: any = text(treeId);
  if (!normalizedTreeId) {
    throw new Error("treeId is required");
  }

  let imported: any = 0;
  let skipped: any = 0;
  const errors: any[] = [];

  const tree: any = await startCheckpointTree({
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

  const existingNodeIds: any = new Set<any>(Object.keys(asObject(tree.nodes)));

  for (let index: any = 0; index < records.length; index += 1) {
    const record: any = asObject(records[index]);
    const nodeId: any = text(record.nodeId || record.id);
    if (!nodeId) {
      errors.push({ index, message: "nodeId is required" });
      continue;
    }
    if (existingNodeIds.has(nodeId) && nodeId !== text(tree.rootNodeId, "root")) {
      skipped += 1;
      continue;
    }
    try {
      const objectRefs: any = asArray(record.objectRefs);
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
    } catch (error: any) {
      errors.push({
        index,
        message: `Upsert failed: ${error?.message || String(error)}`
      });
    }
  }

  const finished: any = await finishCheckpointTree({
    userDataPath: dataDir,
    treeId: normalizedTreeId,
    status: errors.length > 0 ? "failed" : "completed",
    pactiumRuntime: runtime
  });

  const proofRefs: any = asArray(finished.events)
    .map((event?: any) : any => asObject(event?.pactium))
    .filter((proof?: any) : any => text(proof.ledgerEventId) || text(proof.envelopeId));

  return {
    imported,
    skipped,
    errors,
    tree: finished,
    proofRefs
  };
}
