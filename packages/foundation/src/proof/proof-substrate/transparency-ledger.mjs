import fs from "node:fs";
import path from "node:path";
import {
  PACTIUM_PROTOCOL,
  createLedgerTransparencyLog,
  createStoragePort,
  emptyTreeHash,
  verifyLedgerConsistencyProof,
  verifyLedgerInclusionProof
} from "pactium";

export const PLUGIN_TRANSPARENCY_LEDGER_PROVIDER = "pactium.plugin-transparency-ledger";

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

/**
 * Create a plugin-scoped Pactium transparency ledger.
 * Storage lives under the plugin data directory so plugin removal drops the ledger.
 * Leaf facts carry digests only — never plaintext client material.
 */
export function createPluginTransparencyLedger({
  dataDir = "",
  pluginId = "plugin",
  ledgerId = "",
  inMemory = false,
  storageBackend = "auto",
  signer = "auto"
} = {}) {
  const resolvedPluginId = text(pluginId, "plugin");
  const resolvedLedgerId = text(ledgerId, `plugin:${resolvedPluginId}:transparency`);
  const root = inMemory
    ? ""
    : path.join(text(dataDir), "transparency-ledger");
  if (!inMemory) {
    if (!text(dataDir)) {
      throw new Error("createPluginTransparencyLedger requires dataDir for durable ledgers.");
    }
    fs.mkdirSync(root, { recursive: true });
  }
  const storage = createStoragePort({
    ...(inMemory ? { inMemory: true } : { dataDir: root }),
    storageBackend: inMemory ? "json" : storageBackend
  });
  const log = createLedgerTransparencyLog({
    storage,
    ledgerId: resolvedLedgerId,
    signer
  });

  async function appendDigestLeaf({
    leafDigest = "",
    rosterMetadataHash = "",
    tenantId = "",
    accountId = "",
    workspaceId = "",
    endpointId = "",
    createdAt = ""
  } = {}) {
    const digest = text(leafDigest);
    if (!digest) {
      throw new Error("leafDigest is required for transparency ledger append.");
    }
    const appendResult = await log.append({
      factType: "plugin.endpoint-directory-digest",
      leafDigest: digest,
      rosterMetadataHash: text(rosterMetadataHash),
      tenantId: text(tenantId),
      accountId: text(accountId),
      workspaceId: text(workspaceId),
      endpointId: text(endpointId),
      createdAt: text(createdAt) || new Date().toISOString()
    });
    const head = appendResult.head || await log.head();
    return {
      provider: PLUGIN_TRANSPARENCY_LEDGER_PROVIDER,
      protocol: PACTIUM_PROTOCOL,
      ledgerId: resolvedLedgerId,
      index: Number(appendResult.entry?.index ?? -1),
      eventId: text(appendResult.entry?.eventId),
      leafHash: text(appendResult.entry?.leafHash),
      leafDigest: digest,
      rosterMetadataHash: text(rosterMetadataHash),
      head,
      inclusionProof: appendResult.inclusionProof || null,
      consistencyProof: appendResult.consistencyProof || null,
      tenantId: text(tenantId),
      accountId: text(accountId),
      workspaceId: text(workspaceId),
      endpointId: text(endpointId),
      createdAt: text(createdAt) || appendResult.entry?.timestamp || ""
    };
  }

  async function createInclusionProof(index, head = null) {
    return log.createInclusionProof(index, head);
  }

  async function createConsistencyProof(oldHead, newHead = null) {
    const normalizedOld = asObject(oldHead);
    const size = Number(normalizedOld.size || 0);
    const rootHash = text(normalizedOld.rootHash) || (size === 0 ? emptyTreeHash() : "");
    return log.createConsistencyProof({
      ...normalizedOld,
      size,
      rootHash
    }, newHead);
  }

  async function getHead(id = "current") {
    return log.getHead(id);
  }

  async function getLeaf(index) {
    return log.getLeaf(index);
  }

  function verifyInclusion(proofInput = {}) {
    return verifyLedgerInclusionProof(proofInput);
  }

  function verifyConsistency(proofInput = {}) {
    return verifyLedgerConsistencyProof(proofInput);
  }

  return Object.freeze({
    provider: PLUGIN_TRANSPARENCY_LEDGER_PROVIDER,
    protocol: PACTIUM_PROTOCOL,
    pluginId: resolvedPluginId,
    ledgerId: resolvedLedgerId,
    dataDir: root || "(in-memory)",
    emptyTreeHash,
    appendDigestLeaf,
    createInclusionProof,
    createConsistencyProof,
    getHead,
    getLeaf,
    verifyInclusion,
    verifyConsistency,
    async doctor() {
      const head = await getHead();
      return {
        ok: true,
        provider: PLUGIN_TRANSPARENCY_LEDGER_PROVIDER,
        ledgerId: resolvedLedgerId,
        size: Number(head?.size || 0),
        rootHash: text(head?.rootHash),
        headId: text(head?.headId)
      };
    },
    async close() {
      return storage.close?.() || Promise.resolve();
    }
  });
}

export function projectionLeafFromAppend(appendResult = {}, endpointRecord = {}) {
  return {
    index: Number(appendResult.index ?? -1),
    eventId: text(appendResult.eventId),
    tenantId: text(appendResult.tenantId || endpointRecord.tenantId),
    accountId: text(appendResult.accountId || endpointRecord.accountId),
    workspaceId: text(appendResult.workspaceId || endpointRecord.workspaceId),
    endpointId: text(appendResult.endpointId || endpointRecord.endpointId),
    leafHash: text(appendResult.leafHash),
    leafDigest: text(appendResult.leafDigest),
    rosterMetadataHash: text(appendResult.rosterMetadataHash),
    createdAt: text(appendResult.createdAt || endpointRecord.updatedAt),
    ledgerHeadId: text(asObject(appendResult.head).headId),
    ledgerRootHash: text(asObject(appendResult.head).rootHash),
    ledgerSize: Number(asObject(appendResult.head).size || 0)
  };
}
