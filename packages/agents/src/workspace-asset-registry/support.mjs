import crypto from "node:crypto";
import { ServerConfig } from "@lico/foundation/config/server-config";
import path from "node:path";
import { canonicalJson } from "@lico/contracts/serialization/canonical-json";

export const WORKSPACE_ASSET_REGISTRY_PROTOCOL_VERSION = "v0.0.1:workspace:asset-registry-1";
export const WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION = "v0.0.1:workspace:asset-operation-1";

export function nowIso() {
  return new Date().toISOString();
}

export function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

export function text(value) {
  return String(value ?? "").trim();
}

function stableProjection(value) {
  if (Buffer.isBuffer(value)) {
    return {
      type: "buffer",
      byteLength: value.length,
      sha256: crypto.createHash("sha256").update(value).digest("hex")
    };
  }
  if (Array.isArray(value)) return value.map(stableProjection);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stableProjection(entry)]));
  }
  return value;
}

export function workspaceAssetCanonicalJson(value) {
  return canonicalJson(stableProjection(value));
}

export function stableId(prefix, value, length = 24) {
  return `${prefix}_${crypto.createHash("sha256").update(workspaceAssetCanonicalJson(value)).digest("hex").slice(0, length)}`;
}

export function stringifyJson(value) {
  return JSON.stringify(value ?? {});
}

export function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

export function uniqueStrings(values = []) {
  return [...new Set(asArray(values).map(text).filter(Boolean))];
}

export function dbPathFor(userDataPath = "") {
  const root = userDataPath || ServerConfig.getDataDir();
  return path.join(root, "workspace-assets", "workspace-assets.sqlite");
}

export function normalizeWorkspaceId(input = {}) {
  return text(input.workspaceId || input.workspaceRef || input.workspace || "default");
}

export function normalizeAssetKind(value = "") {
  const normalized = text(value || "file");
  if (normalized === "code" || normalized === "code_change" || normalized === "codeChange") return "codeChange";
  if (normalized === "contribution") return "workspaceContribution";
  return normalized;
}

export function normalizeCanonicalState(value = "") {
  const normalized = text(value || "canonical");
  if (["canonical", "pending", "review", "projected", "source", "archived"].includes(normalized)) return normalized;
  return "canonical";
}

export function targetKey({ workspaceId, assetKind, targetKind, targetRef, sourceRef, displayName }) {
  return {
    workspaceId,
    assetKind,
    targetKind: text(targetKind || asObject(targetRef).kind || asObject(sourceRef).kind),
    targetRef: asObject(targetRef),
    sourceRef: asObject(sourceRef),
    displayName: text(displayName)
  };
}

export function assetRefFrom(input = {}) {
  const provided = text(input.assetRef || input.assetId);
  if (provided) return provided;
  return stableId("workspace_asset", targetKey(input));
}

export function contentRefFrom(input = {}) {
  const content = asObject(input.content);
  return {
    contentRef: text(content.contentRef || input.contentRef || ""),
    contentHash: text(content.contentHash || content.sha256 || input.contentHash || input.sha256 || ""),
    byteSize: Number(content.byteSize ?? content.sizeBytes ?? input.byteSize ?? input.sizeBytes ?? 0) || 0,
    mediaType: text(content.mediaType || content.mimeType || input.mediaType || input.contentType || "")
  };
}

export function receiptRefFrom(input = {}) {
  return stableId("workspace_asset_receipt", {
    assetRef: input.assetRef,
    ledgerEventId: input.ledgerEventId,
    downstreamOperationId: input.downstreamOperationId,
    receiptType: input.receiptType,
    receipt: input.receipt,
    nonce: input.nonce || ""
  });
}

export function revisionRefFrom(input = {}) {
  return stableId("workspace_asset_revision", {
    assetRef: input.assetRef,
    ledgerEventId: input.ledgerEventId,
    checkpointRef: input.checkpointRef,
    contentHash: input.contentHash,
    state: input.state,
    nonce: input.nonce || crypto.randomUUID()
  });
}

export function projectionRefFrom(input = {}) {
  return stableId("workspace_asset_projection", {
    assetRef: input.assetRef,
    targetKind: input.targetKind,
    targetRef: input.targetRef,
    externalRef: input.externalRef
  });
}

export function linkRefFrom(input = {}) {
  return stableId("workspace_asset_link", {
    assetRef: input.assetRef,
    linkedRef: input.linkedRef,
    linkType: input.linkType
  });
}

export function ensureSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS workspace_assets (
      asset_ref TEXT PRIMARY KEY,
      protocol_version TEXT NOT NULL DEFAULT '${WORKSPACE_ASSET_REGISTRY_PROTOCOL_VERSION}',
      workspace_id TEXT NOT NULL,
      asset_kind TEXT NOT NULL,
      canonical_state TEXT NOT NULL,
      data_class TEXT NOT NULL DEFAULT 'internal',
      display_name TEXT NOT NULL DEFAULT '',
      current_revision_ref TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS workspace_asset_revisions (
      revision_ref TEXT PRIMARY KEY,
      asset_ref TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      source_ref_json TEXT NOT NULL DEFAULT '{}',
      content_ref_json TEXT NOT NULL DEFAULT '{}',
      target_ref_json TEXT NOT NULL DEFAULT '{}',
      content_hash TEXT NOT NULL DEFAULT '',
      byte_size INTEGER NOT NULL DEFAULT 0,
      media_type TEXT NOT NULL DEFAULT '',
      ledger_event_id TEXT NOT NULL DEFAULT '',
      checkpoint_ref TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_asset_projections (
      projection_ref TEXT PRIMARY KEY,
      asset_ref TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      target_kind TEXT NOT NULL DEFAULT '',
      target_ref_json TEXT NOT NULL DEFAULT '{}',
      external_ref_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT '',
      receipt_refs_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_asset_receipts (
      receipt_ref TEXT PRIMARY KEY,
      asset_ref TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      ledger_event_id TEXT NOT NULL DEFAULT '',
      downstream_operation_id TEXT NOT NULL DEFAULT '',
      receipt_type TEXT NOT NULL DEFAULT '',
      receipt_json TEXT NOT NULL DEFAULT '{}',
      audit_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_asset_links (
      link_ref TEXT PRIMARY KEY,
      asset_ref TEXT NOT NULL,
      linked_ref TEXT NOT NULL,
      link_type TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_materialization_heads (
      workspace_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_job_materializations (
      idempotency_key TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      upload_receipt_ref TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      owner_subject_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      authorization_ref TEXT NOT NULL,
      approval_ref TEXT NOT NULL DEFAULT '',
      checkpoint_ref TEXT NOT NULL,
      audit_ref TEXT NOT NULL,
      expected_revision INTEGER NOT NULL,
      current_revision INTEGER NOT NULL,
      final_revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      asset_ref TEXT NOT NULL DEFAULT '',
      revision_ref TEXT NOT NULL DEFAULT '',
      receipt_ref TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_assets_workspace ON workspace_assets(workspace_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_assets_kind ON workspace_assets(workspace_id, asset_kind, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_revisions_asset ON workspace_asset_revisions(asset_ref, created_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_projections_asset ON workspace_asset_projections(asset_ref, updated_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_receipts_asset ON workspace_asset_receipts(asset_ref, created_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_links_asset ON workspace_asset_links(asset_ref, created_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_materializations_job ON workspace_job_materializations(job_id, workspace_id);
  `);
}

export function hydrateAsset(row) {
  if (!row) return null;
  return {
    protocolVersion: WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION,
    registryProtocolVersion: row.protocol_version || WORKSPACE_ASSET_REGISTRY_PROTOCOL_VERSION,
    assetRef: row.asset_ref,
    workspaceId: row.workspace_id,
    assetKind: row.asset_kind,
    canonicalState: row.canonical_state,
    dataClass: row.data_class,
    displayName: row.display_name || "",
    currentRevisionRef: row.current_revision_ref || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson(row.metadata_json, {})
  };
}

export function hydrateRevision(row) {
  if (!row) return null;
  return {
    revisionRef: row.revision_ref,
    assetRef: row.asset_ref,
    workspaceId: row.workspace_id,
    sourceRef: parseJson(row.source_ref_json, {}),
    contentRef: parseJson(row.content_ref_json, {}),
    targetRef: parseJson(row.target_ref_json, {}),
    contentHash: row.content_hash || "",
    byteSize: row.byte_size || 0,
    mediaType: row.media_type || "",
    ledgerEventId: row.ledger_event_id || "",
    checkpointRef: row.checkpoint_ref || "",
    state: row.state || "",
    createdAt: row.created_at
  };
}

export function hydrateProjection(row) {
  if (!row) return null;
  return {
    projectionRef: row.projection_ref,
    assetRef: row.asset_ref,
    workspaceId: row.workspace_id,
    targetKind: row.target_kind || "",
    targetRef: parseJson(row.target_ref_json, {}),
    externalRef: parseJson(row.external_ref_json, {}),
    status: row.status || "",
    receiptRefs: parseJson(row.receipt_refs_json, []),
    updatedAt: row.updated_at
  };
}

export function hydrateReceipt(row) {
  if (!row) return null;
  return {
    receiptRef: row.receipt_ref,
    assetRef: row.asset_ref,
    workspaceId: row.workspace_id,
    ledgerEventId: row.ledger_event_id || "",
    downstreamOperationId: row.downstream_operation_id || "",
    receiptType: row.receipt_type || "",
    receipt: parseJson(row.receipt_json, {}),
    auditId: row.audit_id || "",
    createdAt: row.created_at
  };
}

export function hydrateLink(row) {
  if (!row) return null;
  return {
    linkRef: row.link_ref,
    assetRef: row.asset_ref,
    linkedRef: row.linked_ref,
    linkType: row.link_type,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at
  };
}

export function firstString(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return "";
}

export function displayNameFrom(input = {}) {
  const targetRef = asObject(input.targetRef);
  const sourceRef = asObject(input.sourceRef);
  return firstString(
    input.displayName,
    targetRef.path,
    targetRef.filePath,
    targetRef.targetPath,
    sourceRef.path,
    sourceRef.filePath,
    input.assetKind
  );
}

export function receiptItemsFrom(input = {}) {
  const receipts = asArray(input.receipts);
  const normalized = receipts
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      if ("receiptType" in item || "type" in item || "receipt" in item) return [item];
      return Object.entries(item)
        .filter(([, value]) => value !== null && value !== undefined && value !== "")
        .map(([key, value]) => ({
          receiptType: key,
          receipt: value
        }));
    })
    .filter((item) => item && typeof item === "object");
  return normalized;
}

export async function maybeCall(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export function normalizedFileItems(payload = {}) {
  const items = asArray(payload.files || payload.items || payload.entries);
  return items
    .filter((item) => item && typeof item === "object" && item.isDirectory !== true && item.type !== "directory")
    .map((item) => ({
      workspaceId: normalizeWorkspaceId(item),
      path: firstString(item.path, item.relativePath, item.filePath),
      contentHash: firstString(item.contentSha256, item.sha256, item.contentHash),
      byteSize: Number(item.sizeBytes ?? item.byteSize ?? item.size ?? 0) || 0,
      mediaType: firstString(item.mediaType, item.contentType)
    }))
    .filter((item) => item.path);
}
