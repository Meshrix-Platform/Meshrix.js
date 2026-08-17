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
import type { PactiumLedger, PactiumLedgerHead, PactiumRecord } from "pactium";

export const PLUGIN_TRANSPARENCY_LEDGER_PROVIDER = "pactium.plugin-transparency-ledger";

interface TransparencyLog extends PactiumLedger {
  createInclusionProof(index?: number, head?: PactiumLedgerHead | null): Promise<PactiumRecord>;
  createConsistencyProof(oldHead: PactiumRecord, newHead?: PactiumLedgerHead | null): Promise<PactiumRecord>;
  getHead(id?: string): Promise<PactiumLedgerHead>;
  getLeaf(index?: number): Promise<PactiumRecord | null>;
}

interface TransparencyLedgerOptions {
  dataDir?: string;
  pluginId?: string;
  ledgerId?: string;
  inMemory?: boolean;
  storageBackend?: string;
  signer?: string | PactiumRecord;
}

interface AppendDigestLeafInput {
  leafDigest?: string;
  rosterMetadataHash?: string;
  tenantId?: string;
  accountId?: string;
  workspaceId?: string;
  endpointId?: string;
  createdAt?: string;
}

function text(value: unknown, fallback = ""): string {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function asRecord(value: unknown): PactiumRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as PactiumRecord : {};
}

function isLedgerHead(value: unknown): value is PactiumLedgerHead {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PactiumLedgerHead>;
  return typeof candidate.protocol === "string" &&
    typeof candidate.schema === "string" &&
    typeof candidate.size === "number" &&
    typeof candidate.rootHash === "string" &&
    typeof candidate.root === "string";
}

function requireTransparencyLog(value: PactiumLedger): TransparencyLog {
  const candidate = value as Partial<TransparencyLog>;
  if (
    typeof candidate.createInclusionProof !== "function" ||
    typeof candidate.createConsistencyProof !== "function" ||
    typeof candidate.getHead !== "function" ||
    typeof candidate.getLeaf !== "function"
  ) {
    throw new Error("Pactium transparency log does not expose the required proof interface.");
  }
  return candidate as TransparencyLog;
}

export function createPluginTransparencyLedger({
  dataDir = "",
  pluginId = "plugin",
  ledgerId = "",
  inMemory = false,
  storageBackend = "auto",
  signer = "auto"
}: TransparencyLedgerOptions = {}) {
  const resolvedPluginId = text(pluginId, "plugin");
  const resolvedLedgerId = text(ledgerId, `plugin:${resolvedPluginId}:transparency`);
  const root = inMemory ? "" : path.join(text(dataDir), "transparency-ledger");
  if (!inMemory) {
    if (!text(dataDir)) throw new Error("createPluginTransparencyLedger requires dataDir for durable ledgers.");
    fs.mkdirSync(root, { recursive: true });
  }
  const storage = createStoragePort({
    ...(inMemory ? { inMemory: true } : { dataDir: root }),
    storageBackend: inMemory ? "json" : storageBackend
  });
  const log = requireTransparencyLog(createLedgerTransparencyLog({ storage, ledgerId: resolvedLedgerId, signer }));

  async function appendDigestLeaf(input: AppendDigestLeafInput = {}) {
    const digest = text(input.leafDigest);
    if (!digest) throw new Error("leafDigest is required for transparency ledger append.");
    const appendResult = await log.append({
      factType: "plugin.endpoint-directory-digest",
      leafDigest: digest,
      rosterMetadataHash: text(input.rosterMetadataHash),
      tenantId: text(input.tenantId),
      accountId: text(input.accountId),
      workspaceId: text(input.workspaceId),
      endpointId: text(input.endpointId),
      createdAt: text(input.createdAt) || new Date().toISOString()
    });
    const entry = asRecord(appendResult.entry);
    const head = isLedgerHead(appendResult.head) ? appendResult.head : await log.head();
    return {
      provider: PLUGIN_TRANSPARENCY_LEDGER_PROVIDER,
      protocol: PACTIUM_PROTOCOL,
      ledgerId: resolvedLedgerId,
      index: Number(entry.index ?? -1),
      eventId: text(entry.eventId),
      leafHash: text(entry.leafHash),
      leafDigest: digest,
      rosterMetadataHash: text(input.rosterMetadataHash),
      head,
      inclusionProof: appendResult.inclusionProof ?? null,
      consistencyProof: appendResult.consistencyProof ?? null,
      tenantId: text(input.tenantId),
      accountId: text(input.accountId),
      workspaceId: text(input.workspaceId),
      endpointId: text(input.endpointId),
      createdAt: text(input.createdAt) || text(entry.timestamp)
    };
  }

  return Object.freeze({
    provider: PLUGIN_TRANSPARENCY_LEDGER_PROVIDER,
    protocol: PACTIUM_PROTOCOL,
    pluginId: resolvedPluginId,
    ledgerId: resolvedLedgerId,
    dataDir: root || "(in-memory)",
    emptyTreeHash,
    appendDigestLeaf,
    createInclusionProof: (index?: number, head: PactiumLedgerHead | null = null) => log.createInclusionProof(index, head),
    createConsistencyProof: (oldHead: PactiumRecord = {}, newHead: PactiumLedgerHead | null = null) => {
      const size = Number(oldHead.size || 0);
      return log.createConsistencyProof({
        ...oldHead,
        size,
        rootHash: text(oldHead.rootHash) || (size === 0 ? emptyTreeHash() : "")
      }, newHead);
    },
    getHead: (id = "current") => log.getHead(id),
    getLeaf: (index?: number) => log.getLeaf(index),
    verifyInclusion: (proofInput: PactiumRecord = {}) => verifyLedgerInclusionProof(proofInput),
    verifyConsistency: (proofInput: PactiumRecord = {}) => verifyLedgerConsistencyProof(proofInput),
    async doctor() {
      const head = await log.getHead();
      return {
        ok: true,
        provider: PLUGIN_TRANSPARENCY_LEDGER_PROVIDER,
        ledgerId: resolvedLedgerId,
        size: Number(head.size || 0),
        rootHash: text(head.rootHash),
        headId: text(head.headId)
      };
    },
    async close(): Promise<void> {
      await storage.close();
    }
  });
}

export function projectionLeafFromAppend(
  appendResult: PactiumRecord = {},
  endpointRecord: PactiumRecord = {}
) {
  const head = asRecord(appendResult.head);
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
    ledgerHeadId: text(head.headId),
    ledgerRootHash: text(head.rootHash),
    ledgerSize: Number(head.size || 0)
  };
}
