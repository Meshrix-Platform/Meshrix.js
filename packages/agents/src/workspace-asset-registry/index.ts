import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import {
  WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION,
  WORKSPACE_ASSET_REGISTRY_PROTOCOL_VERSION,
  asArray,
  asObject,
  assetRefFrom,
  contentRefFrom,
  dbPathFor,
  displayNameFrom,
  ensureSchema,
  firstString,
  hydrateAsset,
  hydrateLink,
  hydrateProjection,
  hydrateReceipt,
  hydrateRevision,
  linkRefFrom,
  maybeCall,
  normalizeAssetKind,
  normalizeCanonicalState,
  normalizeWorkspaceId,
  normalizedFileItems,
  nowIso,
  projectionRefFrom,
  receiptItemsFrom,
  receiptRefFrom,
  revisionRefFrom,
  workspaceAssetCanonicalJson,
  stringifyJson,
  text
} from "./support.ts";
import type { UnknownRecord } from "./support.ts";

interface AgentWorkspacePort {
  listWorkspaces(input: UnknownRecord): unknown | Promise<unknown>;
  listWorkspaceFiles(input: UnknownRecord): unknown | Promise<unknown>;
}

interface ContributionRegistryPort {
  listContributions(): unknown | Promise<unknown>;
}

interface BackfillInput extends UnknownRecord {
  agentWorkspace?: AgentWorkspacePort;
  contributionRegistry?: ContributionRegistryPort;
}

interface BackfillSummary extends UnknownRecord {
  files: number;
  contributions: number;
  codeChanges: number;
  assets: unknown[];
  count?: number;
}

export interface WorkspaceAssetRegistry {
  readonly protocolVersion: typeof WORKSPACE_ASSET_REGISTRY_PROTOCOL_VERSION;
  readonly filePath: string;
  recordAssetMutation(input?: UnknownRecord): UnknownRecord;
  getAsset(input?: UnknownRecord): UnknownRecord | null;
  listAssets(input?: UnknownRecord): UnknownRecord;
  listReceipts(input?: UnknownRecord): UnknownRecord;
  listLineage(input?: UnknownRecord): UnknownRecord;
  backfill(input?: BackfillInput): Promise<UnknownRecord>;
  isClosed(): boolean;
  close(): void;
}

export {
  WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION,
  WORKSPACE_ASSET_REGISTRY_PROTOCOL_VERSION
} from "./support.ts";

export function createWorkspaceAssetRegistry({ userDataPath = "" }: { userDataPath?: string } = {}): WorkspaceAssetRegistry {
  const filePath = dbPathFor(userDataPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let db: Database.Database | null = null;
  try {
    db = openSqliteDatabase(filePath) as Database.Database;
    ensureSchema(db);
    return createWorkspaceAssetRegistryFromDatabase({ db, filePath });
  } catch (error: unknown) {
    try {
      db?.close?.();
    } catch {
      // Preserve the construction failure after attempting owned-resource cleanup.
    }
    throw error;
  }
}

function createWorkspaceAssetRegistryFromDatabase({ db, filePath }: { db: Database.Database; filePath: string }): WorkspaceAssetRegistry {
  let closed = false;

  const upsertAssetStmt = db.prepare(`
    INSERT INTO workspace_assets (
      asset_ref, workspace_id, asset_kind, canonical_state, data_class,
      display_name, current_revision_ref, created_at, updated_at, metadata_json
    )
    VALUES (
      @assetRef, @workspaceId, @assetKind, @canonicalState, @dataClass,
      @displayName, @currentRevisionRef, @createdAt, @updatedAt, @metadataJson
    )
    ON CONFLICT(asset_ref) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      asset_kind = excluded.asset_kind,
      canonical_state = excluded.canonical_state,
      data_class = excluded.data_class,
      display_name = excluded.display_name,
      current_revision_ref = excluded.current_revision_ref,
      updated_at = excluded.updated_at,
      metadata_json = excluded.metadata_json
  `);
  const insertRevisionStmt = db.prepare(`
    INSERT INTO workspace_asset_revisions (
      revision_ref, asset_ref, workspace_id, source_ref_json, content_ref_json,
      target_ref_json, content_hash, byte_size, media_type, ledger_event_id,
      checkpoint_ref, state, created_at
    )
    VALUES (
      @revisionRef, @assetRef, @workspaceId, @sourceRefJson, @contentRefJson,
      @targetRefJson, @contentHash, @byteSize, @mediaType, @ledgerEventId,
      @checkpointRef, @state, @createdAt
    )
  `);
  const upsertProjectionStmt = db.prepare(`
    INSERT INTO workspace_asset_projections (
      projection_ref, asset_ref, workspace_id, target_kind, target_ref_json,
      external_ref_json, status, receipt_refs_json, updated_at
    )
    VALUES (
      @projectionRef, @assetRef, @workspaceId, @targetKind, @targetRefJson,
      @externalRefJson, @status, @receiptRefsJson, @updatedAt
    )
    ON CONFLICT(projection_ref) DO UPDATE SET
      target_ref_json = excluded.target_ref_json,
      external_ref_json = excluded.external_ref_json,
      status = excluded.status,
      receipt_refs_json = excluded.receipt_refs_json,
      updated_at = excluded.updated_at
  `);
  const insertReceiptStmt = db.prepare(`
    INSERT OR IGNORE INTO workspace_asset_receipts (
      receipt_ref, asset_ref, workspace_id, ledger_event_id, downstream_operation_id,
      receipt_type, receipt_json, audit_id, created_at
    )
    VALUES (
      @receiptRef, @assetRef, @workspaceId, @ledgerEventId, @downstreamOperationId,
      @receiptType, @receiptJson, @auditId, @createdAt
    )
  `);
  const insertLinkStmt = db.prepare(`
    INSERT OR IGNORE INTO workspace_asset_links (
      link_ref, asset_ref, linked_ref, link_type, metadata_json, created_at
    )
    VALUES (@linkRef, @assetRef, @linkedRef, @linkType, @metadataJson, @createdAt)
  `);
  const selectAssetStmt = db.prepare<unknown[], UnknownRecord>("SELECT * FROM workspace_assets WHERE asset_ref = ?");
  const selectRevisionStmt = db.prepare<unknown[], UnknownRecord>("SELECT * FROM workspace_asset_revisions WHERE revision_ref = ?");
  const listAssetRevisionsStmt = db.prepare<unknown[], UnknownRecord>(`
    SELECT * FROM workspace_asset_revisions
    WHERE asset_ref = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);
  const listAssetProjectionsStmt = db.prepare<unknown[], UnknownRecord>(`
    SELECT * FROM workspace_asset_projections
    WHERE asset_ref = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `);
  const listAssetReceiptsStmt = db.prepare<unknown[], UnknownRecord>(`
    SELECT * FROM workspace_asset_receipts
    WHERE asset_ref = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);
  const listAssetLinksStmt = db.prepare<unknown[], UnknownRecord>(`
    SELECT * FROM workspace_asset_links
    WHERE asset_ref = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);
  const listAssetsStmt = db.prepare<UnknownRecord, UnknownRecord>(`
    SELECT * FROM workspace_assets
    WHERE (@workspaceId = '' OR workspace_id = @workspaceId)
      AND (@assetKind = '' OR asset_kind = @assetKind)
      AND (@canonicalState = '' OR canonical_state = @canonicalState)
      AND (
        @targetKind = ''
        OR asset_ref IN (
          SELECT asset_ref FROM workspace_asset_projections WHERE target_kind = @targetKind
        )
      )
    ORDER BY updated_at DESC
    LIMIT @limit
  `);
  const mutationTx = db.transaction((input: UnknownRecord = {}): UnknownRecord => {
    const workspaceId = normalizeWorkspaceId(input);
    const assetKind = normalizeAssetKind(input.assetKind || input.kind);
    const canonicalState = normalizeCanonicalState(input.canonicalState || input.state);
    const dataClass = text(input.dataClass || asObject(input.policy).dataClass || "internal") || "internal";
    const targetRef = asObject(input.targetRef || input.target);
    const sourceRef = asObject(input.sourceRef || input.source);
    const contentRef = contentRefFrom(input);
    const targetKind = text(input.targetKind || targetRef.kind || sourceRef.kind || assetKind);
    const assetRef = assetRefFrom({
      ...input,
      workspaceId,
      assetKind,
      targetKind,
      targetRef,
      sourceRef
    });
    const ledgerEventId = text(input.ledgerEventId || input.ledgerId);
    const checkpoint = asObject(input.checkpoint);
    const checkpointRef = text(input.checkpointRef || checkpoint.checkpointId || checkpoint.nodeId || checkpoint.checkpointNodeId || "");
    const revisionRef = text(input.revisionRef) || revisionRefFrom({
      assetRef,
      ledgerEventId,
      checkpointRef,
      contentHash: contentRef.contentHash,
      state: canonicalState
    });
    const timestamp = nowIso();
    const displayName = displayNameFrom({ ...input, assetKind, targetRef, sourceRef });
    const metadata = asObject(input.metadata);
    upsertAssetStmt.run({
      assetRef,
      workspaceId,
      assetKind,
      canonicalState,
      dataClass,
      displayName,
      currentRevisionRef: revisionRef,
      createdAt: text(input.createdAt || timestamp),
      updatedAt: timestamp,
      metadataJson: stringifyJson(metadata)
    });
    insertRevisionStmt.run({
      revisionRef,
      assetRef,
      workspaceId,
      sourceRefJson: stringifyJson(sourceRef),
      contentRefJson: stringifyJson(contentRef),
      targetRefJson: stringifyJson(targetRef),
      contentHash: contentRef.contentHash,
      byteSize: contentRef.byteSize,
      mediaType: contentRef.mediaType,
      ledgerEventId,
      checkpointRef,
      state: canonicalState,
      createdAt: timestamp
    });

    const receiptRefs: string[] = [];
    for (const item of receiptItemsFrom(input)) {
      const receiptType = text(item.receiptType || item.type || "receipt") || "receipt";
      const receipt = item.receipt !== undefined ? item.receipt : item;
      const receiptRef = text(item.receiptRef) || receiptRefFrom({
        assetRef,
        ledgerEventId,
        downstreamOperationId: input.downstreamOperationId,
        receiptType,
        receipt,
        nonce: workspaceAssetCanonicalJson(receipt)
      });
      insertReceiptStmt.run({
        receiptRef,
        assetRef,
        workspaceId,
        ledgerEventId,
        downstreamOperationId: text(input.downstreamOperationId || ""),
        receiptType,
        receiptJson: stringifyJson(receipt),
        auditId: text(input.auditId || item.auditId || ""),
        createdAt: timestamp
      });
      receiptRefs.push(receiptRef);
    }

    const projectionRef = text(input.projectionRef) || projectionRefFrom({
      assetRef,
      targetKind,
      targetRef,
      externalRef: input.externalRef || {}
    });
    upsertProjectionStmt.run({
      projectionRef,
      assetRef,
      workspaceId,
      targetKind,
      targetRefJson: stringifyJson(targetRef),
      externalRefJson: stringifyJson(asObject(input.externalRef)),
      status: text(input.projectionStatus || canonicalState || "active"),
      receiptRefsJson: stringifyJson(receiptRefs),
      updatedAt: timestamp
    });

    for (const link of asArray(input.links)) {
      if (!link || typeof link !== "object") continue;
      const linkRecord = link as UnknownRecord;
      const linkedRef = text(linkRecord.linkedRef || linkRecord.assetRef || linkRecord.sourceRef || linkRecord.targetRef || "");
      const linkType = text(linkRecord.linkType || linkRecord.type || "lineage");
      if (!linkedRef || !linkType) continue;
      insertLinkStmt.run({
        linkRef: text(linkRecord.linkRef) || linkRefFrom({ assetRef, linkedRef, linkType }),
        assetRef,
        linkedRef,
        linkType,
        metadataJson: stringifyJson(asObject(linkRecord.metadata)),
        createdAt: timestamp
      });
    }

    return {
      protocolVersion: WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION,
      registryProtocolVersion: WORKSPACE_ASSET_REGISTRY_PROTOCOL_VERSION,
      assetRef,
      revisionRef,
      canonicalState,
      ledgerEventId,
      receiptRefs,
      routeDecision: asObject(input.routeDecision),
      asset: hydrateAsset(selectAssetStmt.get(assetRef)),
      revision: hydrateRevision(selectRevisionStmt.get(revisionRef)),
      projectionRef
    };
  });

  function recordAssetMutation(input: UnknownRecord = {}): UnknownRecord {
    return mutationTx(input);
  }

  function getAsset(input: UnknownRecord = {}): UnknownRecord | null {
    const assetRef = text(input.assetRef || input.assetId || input.id || input);
    const asset = hydrateAsset(selectAssetStmt.get(assetRef));
    if (!asset) return null;
    const revisionLimit = Math.max(1, Math.min(Number(input.revisionLimit || 20), 100));
    const projectionLimit = Math.max(1, Math.min(Number(input.projectionLimit || 20), 100));
    return {
      ...asset,
      revisions: listAssetRevisionsStmt.all(assetRef, revisionLimit).map(hydrateRevision),
      projections: listAssetProjectionsStmt.all(assetRef, projectionLimit).map(hydrateProjection),
      receipts: listAssetReceiptsStmt.all(assetRef, Math.max(1, Math.min(Number(input.receiptLimit || 20), 100))).map(hydrateReceipt),
      lineageLinks: listAssetLinksStmt.all(assetRef, 100).map(hydrateLink)
    };
  }

  function listAssets(input: UnknownRecord = {}): UnknownRecord {
    const limit = Math.max(1, Math.min(Number(input.limit || 100), 500));
    const items = listAssetsStmt.all({
      workspaceId: normalizeWorkspaceId(input),
      assetKind: text(input.assetKind || ""),
      canonicalState: text(input.canonicalState || ""),
      targetKind: text(input.targetKind || ""),
      limit
    }).map(hydrateAsset);
    return {
      protocolVersion: WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION,
      registryProtocolVersion: WORKSPACE_ASSET_REGISTRY_PROTOCOL_VERSION,
      items,
      count: items.length
    };
  }

  function listReceipts(input: UnknownRecord = {}): UnknownRecord {
    const assetRef = text(input.assetRef || input.assetId || input.id || "");
    const limit = Math.max(1, Math.min(Number(input.limit || 100), 500));
    if (assetRef) {
      const items = listAssetReceiptsStmt.all(assetRef, limit).map(hydrateReceipt);
      return {
        protocolVersion: WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION,
        items,
        count: items.length
      };
    }
    const workspaceId = normalizeWorkspaceId(input);
    const stmt = db.prepare<UnknownRecord, UnknownRecord>(`
      SELECT * FROM workspace_asset_receipts
      WHERE (@workspaceId = '' OR workspace_id = @workspaceId)
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    const items = stmt.all({ workspaceId, limit }).map(hydrateReceipt);
    return {
      protocolVersion: WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION,
      items,
      count: items.length
    };
  }

  function listLineage(input: UnknownRecord = {}): UnknownRecord {
    const assetRef = text(input.assetRef || input.assetId || input.id || "");
    if (!assetRef) {
      return {
        protocolVersion: WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION,
        items: [],
        count: 0
      };
    }
    const items = listAssetLinksStmt.all(assetRef, Math.max(1, Math.min(Number(input.limit || 100), 500))).map(hydrateLink);
    return {
      protocolVersion: WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION,
      items,
      count: items.length
    };
  }

  async function backfill(input: BackfillInput = {}): Promise<UnknownRecord> {
    const agentWorkspace = input.agentWorkspace;
    const contributionRegistry = input.contributionRegistry;
    const workspaceIdFilter = text(input.workspaceId || "");
    const limit = Math.max(1, Math.min(Number(input.limit || 500), 5000));
    const timestamp = nowIso();
    const accessibleWorkspaceIds = new Set<string>();
    const summary: BackfillSummary = {
      protocolVersion: WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION,
      registryProtocolVersion: WORKSPACE_ASSET_REGISTRY_PROTOCOL_VERSION,
      ok: true,
      backfilledAt: timestamp,
      files: 0,
      contributions: 0,
      codeChanges: 0,
      assets: []
    };

    if (agentWorkspace && typeof agentWorkspace.listWorkspaces === "function" && typeof agentWorkspace.listWorkspaceFiles === "function") {
      const workspaceList = asObject(await maybeCall<unknown>(() => agentWorkspace.listWorkspaces({
        actorUserId: input.actorUserId,
        userId: input.userId,
        subjectId: input.subjectId,
        username: input.username,
        roleId: input.roleId,
        scopes: input.scopes,
        allowedWorkspaceIds: input.allowedWorkspaceIds,
        canAccessAll: input.canAccessAll === true,
        limit: Math.min(limit, 500),
        includeSummary: false
      }), { workspaces: [] }));
      const workspaces = asArray(workspaceList.workspaces)
        .filter((workspace): workspace is UnknownRecord => Boolean(workspace) && typeof workspace === "object" && !Array.isArray(workspace))
        .filter((workspace) => !workspaceIdFilter || workspace.workspaceId === workspaceIdFilter);
      for (const workspace of workspaces) {
        const workspaceId = text(workspace.workspaceId);
        if (workspaceId) {
          accessibleWorkspaceIds.add(workspaceId);
        }
      }
      for (const workspace of workspaces) {
        const workspaceId = text(workspace.workspaceId);
        const filePayload = asObject(await maybeCall<unknown>(() => agentWorkspace.listWorkspaceFiles({
          actorUserId: input.actorUserId,
          userId: input.userId,
          subjectId: input.subjectId,
          username: input.username,
          roleId: input.roleId,
          scopes: input.scopes,
          allowedWorkspaceIds: input.allowedWorkspaceIds,
          canAccessAll: input.canAccessAll === true,
          workspaceId,
          recursive: true,
          includeDirectories: false,
          includeFiles: true,
          includeHash: true,
          limit
        }), { files: [] }));
        for (const file of normalizedFileItems(filePayload)) {
          const registered = recordAssetMutation({
            workspaceId,
            assetKind: "file",
            canonicalState: "canonical",
            dataClass: "internal",
            displayName: file.path,
            targetKind: "workspaceFolder",
            targetRef: {
              kind: "workspaceFolder",
              path: file.path
            },
            sourceRef: {
              kind: "backfill",
              sourceType: "workspaceFile"
            },
            content: {
              contentHash: file.contentHash,
              byteSize: file.byteSize,
              mediaType: file.mediaType
            },
            ledgerEventId: "",
            downstreamOperationId: "workspace.asset.backfill",
            receipts: [{
              receiptType: "backfill",
              receipt: {
                kind: "workspace_file_backfill",
                path: file.path,
                capturedAt: timestamp
              }
            }],
            metadata: {
              backfill: true
            }
          });
          summary.files += 1;
          summary.assets.push(registered.workspaceAsset || registered.assetRef);
        }
      }
    }

    if (contributionRegistry && typeof contributionRegistry.listContributions === "function") {
      const contributions = asArray(await maybeCall<unknown>(() => contributionRegistry.listContributions(), []))
        .filter((item): item is UnknownRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .filter((item) => {
          const contributionWorkspaceId = normalizeWorkspaceId(item);
          if (!contributionWorkspaceId) {
            return false;
          }
          if (workspaceIdFilter && contributionWorkspaceId !== workspaceIdFilter) {
            return false;
          }
          return input.canAccessAll === true || accessibleWorkspaceIds.has(contributionWorkspaceId);
        })
        .slice(0, limit);
      for (const contribution of contributions) {
        const contributionId = firstString(contribution.contributionId, contribution.id, contribution.assetId);
        if (!contributionId) continue;
        recordAssetMutation({
          workspaceId: normalizeWorkspaceId(contribution),
          assetKind: "workspaceContribution",
          canonicalState: contribution.status === "published" || contribution.status === "adopted" ? "canonical" : "pending",
          dataClass: firstString(contribution.dataClass, "internal"),
          displayName: firstString(contribution.title, contribution.name, contributionId),
          targetKind: "workspaceContribution",
          targetRef: {
            kind: "workspaceContribution",
            contributionId
          },
          sourceRef: {
            kind: "backfill",
            sourceType: "workspaceContribution"
          },
          downstreamOperationId: "workspace.asset.backfill",
          receipts: [{
            receiptType: "backfill",
            receipt: {
              kind: "workspace_contribution_backfill",
              contributionId,
              status: contribution.status || "",
              capturedAt: timestamp
            }
          }],
          metadata: {
            backfill: true
          }
        });
        summary.contributions += 1;
      }
    }

    summary.count = summary.files + summary.contributions + summary.codeChanges;
    return summary;
  }

  return {
    protocolVersion: WORKSPACE_ASSET_REGISTRY_PROTOCOL_VERSION,
    filePath,
    recordAssetMutation,
    getAsset,
    listAssets,
    listReceipts,
    listLineage,
    backfill,
    isClosed(): boolean {
      return closed || db.open === false;
    },
    close(): void {
      if (closed || db.open === false) return;
      db.close();
      closed = true;
    }
  };
}
