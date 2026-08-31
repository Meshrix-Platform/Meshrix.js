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
import type { PactiumRecord } from "pactium";
import type { CheckpointEventProof, CheckpointNode, CheckpointTree, MeshrixPactiumRuntime } from "./types.ts";
import { errorMessage, isRecord } from "./types.ts";

interface ExportCheckpointTreeOptions {
  userDataPath?: string;
  treeId?: string;
  pactiumRuntime?: MeshrixPactiumRuntime | null;
}

interface ImportCheckpointTreeOptions extends ExportCheckpointTreeOptions {
  records?: unknown;
  metadata?: unknown;
  resumePolicy?: unknown;
}

function text(value: unknown, fallback = ""): string {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown, fallback: PactiumRecord = {}): PactiumRecord {
  return isRecord(value) ? value : fallback;
}

function proofRefsFor(tree: CheckpointTree): CheckpointEventProof[] {
  return tree.events.flatMap((event) => {
    const proof = event.pactium;
    return proof && (proof.ledgerEventId || proof.envelopeId) ? [proof] : [];
  });
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
}: ExportCheckpointTreeOptions = {}): Promise<{
  tree: CheckpointTree | null;
  records: CheckpointNode[];
  proofRefs: CheckpointEventProof[];
}> {
  const dataDir = resolveMeshrixPactiumDataDir(userDataPath);
  const ownsRuntime = !pactiumRuntime;
  const runtime = normalizeMeshrixPactiumRuntime({ dataDir, pactiumRuntime });
  try {
    const tree = await loadCheckpointTree({
      userDataPath: dataDir,
      treeId,
      pactiumRuntime: runtime
    });
    if (!tree) {
      return { tree: null, records: [], proofRefs: [] };
    }
    const records = Object.values(tree.nodes).map((node) => ({ ...node }));
    const proofRefs = proofRefsFor(tree);
    return { tree, records, proofRefs };
  } finally {
    // A runtime created here owns a storage lifecycle lease; releasing it is
    // required so later restore/maintenance quiescence checks can pass.
    if (ownsRuntime) await runtime.close?.();
  }
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
}: ImportCheckpointTreeOptions = {}): Promise<{
  imported: number;
  skipped: number;
  errors: Array<{ index: number; message: string }>;
  tree: CheckpointTree;
  proofRefs: CheckpointEventProof[];
}> {
  if (!Array.isArray(records)) {
    throw new Error("records must be an array");
  }
  const dataDir = resolveMeshrixPactiumDataDir(userDataPath);
  const ownsRuntime = !pactiumRuntime;
  const runtime = normalizeMeshrixPactiumRuntime({ dataDir, pactiumRuntime });
  try {
    return await importCheckpointTreeProjectionWithRuntime({
      dataDir,
      runtime,
      treeId,
      records,
      metadata,
      resumePolicy
    });
  } finally {
    // A runtime created here owns a storage lifecycle lease; releasing it is
    // required so later restore/maintenance quiescence checks can pass.
    if (ownsRuntime) await runtime.close?.();
  }
}

async function importCheckpointTreeProjectionWithRuntime({
  dataDir,
  runtime,
  treeId = "",
  records = [],
  metadata = {},
  resumePolicy = null
}: {
  dataDir: string;
  runtime: MeshrixPactiumRuntime;
  treeId: string;
  records: unknown[];
  metadata: unknown;
  resumePolicy: unknown;
}): Promise<{
  imported: number;
  skipped: number;
  errors: Array<{ index: number; message: string }>;
  tree: CheckpointTree;
  proofRefs: CheckpointEventProof[];
}> {
  const normalizedTreeId = text(treeId);
  if (!normalizedTreeId) {
    throw new Error("treeId is required");
  }

  let imported = 0;
  let skipped = 0;
  const errors: Array<{ index: number; message: string }> = [];

  const tree = await startCheckpointTree({
    userDataPath: dataDir,
    treeId: normalizedTreeId,
    rootNodeId: "root",
    rootLabel: "Imported root",
    metadata: {
      ...asObject(metadata),
      importSource: "checkpoint-tree-projection-import"
    },
    resumePolicy: isRecord(resumePolicy) ? resumePolicy : undefined,
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
    } catch (error: unknown) {
      errors.push({
        index,
        message: `Upsert failed: ${errorMessage(error)}`
      });
    }
  }

  const finished = await finishCheckpointTree({
    userDataPath: dataDir,
    treeId: normalizedTreeId,
    status: errors.length > 0 ? "failed" : "completed",
    pactiumRuntime: runtime
  });

  const proofRefs = proofRefsFor(finished);

  return {
    imported,
    skipped,
    errors,
    tree: finished,
    proofRefs
  };
}
