import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  AGENT_SESSION_THREAD_VERSION,
  AGENT_WORKSPACE_CONTEXT_BUNDLE_VERSION,
  AGENT_WORKSPACE_PROTOCOL_VERSION,
  asArray,
  asObject,
  boundedInteger,
  buildWorkspaceHandoffMarkdown,
  compactArtifact,
  compactDecision,
  compactIssue,
  compactPrivateState,
  compactRun,
  compactSubmission,
  compactWorkspaceLayer,
  decodeWorkspaceContextBundle,
  hydrateSession,
  hydrateWorkspace,
  projectWorkspace,
  nowIso,
  normalizeText,
  stableHash,
  stableId,
  stableJson,
  stringifyJson,
  uniqueStrings
} from "./agent-workspace-support.ts";

type JsonRecord = Record<string, unknown>;
interface WorkspaceRow {
  workspace_id: string; title: string; objective: string; status: string; owner_user_id?: string | null;
  metadata_json?: string | null; created_at: string; updated_at: string; parent_workspace_id?: string | null;
  profile_json?: string | null; owned_source_ids_json?: string | null; accessible_workspace_ids_json?: string | null;
  current_generation?: number | null; fs_path?: string | null;
}
interface SessionRow {
  session_id: string; workspace_id: string; title: string; objective?: string | null; status?: string | null;
  parent_session_id?: string | null; forked_from_event_id?: string | null; branch_index?: number | null;
  lineage_json?: string | null; context_json?: string | null; metadata_json?: string | null; created_by?: string | null;
  created_at: string; updated_at: string; last_event_id?: string | null; event_count?: number | null; append_only?: number | null;
}
interface SharedWorkspaceRow { workspace_id: string; accessible_workspace_ids_json?: string | null }
interface Statement<Row = unknown> { get(...parameters: unknown[]): Row | undefined; all(...parameters: unknown[]): Row[]; run(...parameters: unknown[]): unknown }
interface ContextDatabase { prepare(sql: string): Statement; transaction<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result }
type Workspace = NonNullable<ReturnType<typeof hydrateWorkspace>>;
interface GatewayScope { includeSourceIds: string[]; excludeSourceIds: string[] }
export interface WorkspaceProfile extends JsonRecord { contextProfileId: string; toolGrantId: string; modelAlias: string; gatewayScope: GatewayScope }
export interface WorkspaceContext extends JsonRecord {
  protocolVersion: string; workspaceId: string; currentGeneration: number;
  chainGenerations: Array<{ workspaceId: string; generation: number }>;
  contextFingerprint: string; inheritanceChain: Array<{ workspaceId: string; title: string }>;
  gatewaySourceIds: string[]; contextProfileId: string; toolGrantId: string; modelAlias: string;
}
interface WorkspaceAccess { canAccessAll?: boolean; [key: string]: unknown }
export interface ContextBundle extends JsonRecord {
  bundleVersion: string; generatedAt: string; context: WorkspaceContext; resolvedProfile: WorkspaceProfile;
  recent: { runs: unknown[]; submissions: unknown[]; artifacts: unknown[]; issues: unknown[]; decisions: unknown[]; privateStates: unknown[] };
  handoffMarkdown?: unknown;
}

function statement<Row>(value: unknown, name: string): Statement<Row> {
  const candidate = asObject(value);
  if (typeof candidate.get !== "function" || typeof candidate.all !== "function" || typeof candidate.run !== "function") {
    throw new TypeError(`Agent workspace context dependency ${name} must be a SQLite statement.`);
  }
  return candidate as unknown as Statement<Row>;
}

function database(value: unknown): ContextDatabase {
  const candidate = asObject(value);
  if (typeof candidate.prepare !== "function" || typeof candidate.transaction !== "function") {
    throw new TypeError("Agent workspace context dependency db must be a SQLite database.");
  }
  return candidate as unknown as ContextDatabase;
}

function provider<Provider extends (...args: never[]) => unknown>(value: unknown, name: string): Provider {
  if (typeof value !== "function") throw new TypeError(`Agent workspace context dependency ${name} must be a function.`);
  return value as Provider;
}

export function createAgentWorkspaceContextApi(dependencies: unknown = {}) {
  const source = asObject(dependencies);
  const db = database(source.db);
  const rootPath = String(source.rootPath || "");
  const selectWorkspaceRawStmt = statement<WorkspaceRow>(source.selectWorkspaceRawStmt, "selectWorkspaceRawStmt");
  const selectSessionStmt = statement<SessionRow>(source.selectSessionStmt, "selectSessionStmt");
  const canAccessWorkspace = provider<(workspace: Workspace | null, options: JsonRecord) => boolean>(source.canAccessWorkspace, "canAccessWorkspace");
  const canAccessWorkspaceId = provider<(workspaceId: string, options: JsonRecord) => boolean>(source.canAccessWorkspaceId, "canAccessWorkspaceId");
  const workspaceAccess = provider<(options: JsonRecord) => WorkspaceAccess>(source.workspaceAccess, "workspaceAccess");
  const getWorkspace = provider<(options: JsonRecord) => JsonRecord | null>(source.getWorkspace, "getWorkspace");
  const createRun = provider<(input: JsonRecord) => unknown>(source.createRun, "createRun");
  const createArtifact = provider<(input: JsonRecord) => unknown>(source.createArtifact, "createArtifact");

  function resolveWorkspaceChain(workspaceId?: unknown, _seen = new Set<unknown>()): Workspace[] {
    if (_seen.has(workspaceId)) {
      throw new Error(`工作空间继承链存在循环: ${Array.from(_seen).join(" → ")} → ${workspaceId}`);
    }
    _seen.add(workspaceId);
    const row = selectWorkspaceRawStmt.get(workspaceId);
    if (!row) return [];
    const ws = hydrateWorkspace(row);
    if (!ws) return [];
    const ancestors = ws.parentWorkspaceId
      ? resolveWorkspaceChain(ws.parentWorkspaceId, _seen)
      : [];
    return [...ancestors, ws];
  }

  /**
   * Walk the chain root→target, merge profiles: child overrides parent scalars.
   * gatewayScope arrays are merged using + / - notation.
   */
  function resolveWorkspaceProfile(workspaceId?: unknown): WorkspaceProfile {
    const chain = resolveWorkspaceChain(workspaceId);
    const merged: WorkspaceProfile = {
      contextProfileId: "",
      toolGrantId: "",
      modelAlias: "",
      gatewayScope: { includeSourceIds: [], excludeSourceIds: [] }
    };
    for (const ws of chain) {
      const p = asObject(ws.profile);
      if (p.contextProfileId) merged.contextProfileId = String(p.contextProfileId);
      if (p.toolGrantId) merged.toolGrantId = String(p.toolGrantId);
      if (p.modelAlias) merged.modelAlias = String(p.modelAlias);
      const scope = asObject(p.gatewayScope);
      if (Array.isArray(scope.includeSourceIds)) {
        merged.gatewayScope.includeSourceIds = [
          ...merged.gatewayScope.includeSourceIds,
          ...uniqueStrings(scope.includeSourceIds)
        ];
      }
      if (Array.isArray(scope.excludeSourceIds)) {
        merged.gatewayScope.excludeSourceIds = [
          ...merged.gatewayScope.excludeSourceIds,
          ...uniqueStrings(scope.excludeSourceIds)
        ];
      }
    }
    return merged;
  }

  /**
   * Resolve the final set of gateway source IDs visible in this workspace,
   * including inherited sources and accessible (shared) workspaces.
   *
   * Algorithm:
   *   1. Walk root→target, accumulate owned sources at each level
   *   2. Apply include/exclude from each profile layer
   *   3. Add sources from directly accessible workspaces
   *
   * @returns {string[]} distinct source IDs
   */
  function resolveWorkspaceSourceIds(workspaceId?: unknown, _visited = new Set<unknown>()): string[] {
    if (_visited.has(workspaceId)) return [];  // break cycles in shared graph
    _visited.add(workspaceId);

    const chain = resolveWorkspaceChain(workspaceId);
    const sourceSet = new Set<string>();
    const excludeSet = new Set<string>();

    for (const ws of chain) {
      // Add each level's owned sources
      for (const id of asArray(ws.ownedSourceIds)) sourceSet.add(String(id));
      // Apply explicit include/exclude in the profile at this level
      const scope = asObject(asObject(ws.profile).gatewayScope);
      for (const id of asArray(scope.includeSourceIds)) sourceSet.add(String(id));
      for (const id of asArray(scope.excludeSourceIds)) excludeSet.add(String(id));
    }

    // Remove explicitly excluded
    for (const id of excludeSet) sourceSet.delete(id);

    // Add sources from accessible (shared) workspaces
    const target = chain[chain.length - 1];
    if (target) {
      for (const sharedId of asArray(target.accessibleWorkspaceIds)) {
        for (const id of resolveWorkspaceSourceIds(sharedId, _visited)) {
          sourceSet.add(id);
        }
      }
    }

    return Array.from(sourceSet);
  }

  /**
   * Return the fully-resolved runtime context for an agent operating in this workspace.
   * This is the single call an agent needs to set up its gateway context scope, context,
   * tool grant, and model routing.
   */
  function getWorkspaceContext(workspaceId?: unknown, value: unknown = {}): WorkspaceContext | null {
    const options = asObject(value);
    const resolvedWorkspaceId = String(workspaceId || "");
    const targetRow = selectWorkspaceRawStmt.get(resolvedWorkspaceId);
    if (!canAccessWorkspace(hydrateWorkspace(targetRow), options)) {
      return null;
    }
    const chain = resolveWorkspaceChain(resolvedWorkspaceId);
    if (chain.length === 0) return null;
    const profile = resolveWorkspaceProfile(resolvedWorkspaceId);
    const sourceIds = resolveWorkspaceSourceIds(resolvedWorkspaceId);
    const target = chain[chain.length - 1];
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      workspaceId: resolvedWorkspaceId,
      sharingMode: "team-shared",
      currentGeneration: target.currentGeneration,
      chainGenerations: chain.map((ws) => ({
        workspaceId: ws.workspaceId,
        generation: ws.currentGeneration
      })),
      contextFingerprint: stableHash(
        "workspace-context",
        chain.map((ws) => `${ws.workspaceId}:${ws.currentGeneration}`).join("|"),
        stringifyJson(profile),
        sourceIds.join("|")
      ),
      inheritanceChain: chain.map((ws) => ({
        workspaceId: ws.workspaceId,
        title: ws.title,
      })),
      gatewaySourceIds: sourceIds,
      contextProfileId: profile.contextProfileId,
      toolGrantId: profile.toolGrantId,
      modelAlias: profile.modelAlias,
    };
  }

  function getSessionContext(sessionId?: unknown, value: unknown = {}) {
    const options = asObject(value);
    const session = hydrateSession(selectSessionStmt.get(String(sessionId || "")));
    if (!session || !canAccessWorkspaceId(session.workspaceId, options)) {
      return null;
    }
    const workspaceContext = getWorkspaceContext(session.workspaceId, options);
    if (!workspaceContext) {
      return null;
    }
    const sessionContext = asObject(session.context);
    const explicitSourceIds = uniqueStrings(asArray(sessionContext.gatewaySourceIds || sessionContext.sourceIds));
    const contextProfileId = String(sessionContext.contextProfileId || workspaceContext.contextProfileId || "");
    const modelAlias = String(sessionContext.modelAlias || sessionContext.alias || workspaceContext.modelAlias || "");
    const toolGrantId = String(sessionContext.toolGrantId || sessionContext.grantId || workspaceContext.toolGrantId || "");
    const gatewaySourceIds = explicitSourceIds.length ? explicitSourceIds : workspaceContext.gatewaySourceIds;
    return {
      ...workspaceContext,
      workspaceContext,
      sessionProtocolVersion: AGENT_SESSION_THREAD_VERSION,
      agentSessionId: session.sessionId,
      sessionId: session.sessionId,
      sessionTitle: session.title,
      sessionStatus: session.status,
      parentSessionId: session.parentSessionId,
      forkedFromEventId: session.forkedFromEventId,
      sessionEventCount: session.eventCount,
      sessionLastEventId: session.lastEventId,
      sessionLineage: session.lineage,
      sessionAppendOnly: true,
      sessionContext,
      gatewaySourceIds,
      contextProfileId,
      toolGrantId,
      modelAlias,
      contextFingerprint: stableHash(
        "agent-session-context",
        workspaceContext.contextFingerprint,
        session.sessionId,
        session.lastEventId,
        session.eventCount,
        stableJson(sessionContext),
        gatewaySourceIds.join("|"),
        contextProfileId,
        toolGrantId,
        modelAlias
      )
    };
  }

  function exportWorkspaceContextBundle(workspaceId?: unknown, value: unknown = {}) {
    const options = asObject(value);
    const context = getWorkspaceContext(workspaceId, options);
    if (!context) {
      return null;
    }
    const includePrivate = options.includePrivate === true;
    const includeBundle = options.includeBundle !== false;
    const compress = options.compress !== false;
    const maxItems = boundedInteger(options.maxItems, 12, 1, 100);
    const contentPreviewChars = boundedInteger(options.contentPreviewChars, 600, 0, 4000);
    const snapshot = getWorkspace({
      workspaceId,
      actorUserId: options.actorUserId,
      canAccessAll: options.canAccessAll,
      includePrivate,
      includeRunDetails: false,
      runLimit: maxItems,
      submissionLimit: maxItems,
      artifactLimit: maxItems,
      issueLimit: maxItems,
      decisionLimit: maxItems,
      privateStateLimit: includePrivate ? maxItems : 0
    });
    if (!snapshot) {
      return null;
    }
    const chain = resolveWorkspaceChain(workspaceId);
    const bundle: ContextBundle = {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      bundleVersion: AGENT_WORKSPACE_CONTEXT_BUNDLE_VERSION,
      generatedAt: nowIso(),
      workspace: compactWorkspaceLayer(asObject(snapshot.workspace)),
      summary: asObject(snapshot.summary),
      context,
      resolvedProfile: resolveWorkspaceProfile(workspaceId),
      inheritanceChain: chain.map(compactWorkspaceLayer),
      options: {
        includePrivate,
        maxItems,
        contentPreviewChars
      },
      recent: {
        runs: asArray(snapshot.runs).slice(0, maxItems).map((run) => compactRun(asObject(run))),
        submissions: asArray(snapshot.submissions).slice(0, maxItems).map((submission) => compactSubmission(asObject(submission))),
        artifacts: asArray(snapshot.artifacts)
          .slice(0, maxItems)
          .map((artifact) => compactArtifact(asObject(artifact), { contentPreviewChars })),
        issues: asArray(snapshot.issues).slice(0, maxItems).map((issue) => compactIssue(asObject(issue))),
        decisions: asArray(snapshot.decisions).slice(0, maxItems).map((decision) => compactDecision(asObject(decision))),
        privateStates: includePrivate
          ? asArray(snapshot.privateStates).slice(0, maxItems).map((privateState) => compactPrivateState(asObject(privateState)))
          : []
      }
    };
    bundle.handoffMarkdown = buildWorkspaceHandoffMarkdown(bundle);

    const jsonText = stableJson(bundle);
    const uncompressedBytes = Buffer.byteLength(jsonText, "utf8");
    const compressedBuffer = compress ? gzipSync(Buffer.from(jsonText, "utf8")) : null;
    const compressedBytes = compressedBuffer?.length || 0;
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      bundleVersion: AGENT_WORKSPACE_CONTEXT_BUNDLE_VERSION,
      workspaceId,
      generatedAt: bundle.generatedAt,
      currentGeneration: context.currentGeneration,
      contextFingerprint: context.contextFingerprint,
      bundleHash: stableHash("workspace-context-bundle", jsonText),
      restoreEvidence: {
        chainGenerations: context.chainGenerations,
        gatewaySourceCount: asArray(context.gatewaySourceIds).length,
        runCount: asArray(bundle.recent.runs).length,
        submissionCount: asArray(bundle.recent.submissions).length,
        artifactCount: asArray(bundle.recent.artifacts).length,
        issueCount: asArray(bundle.recent.issues).length,
        privateStateCount: asArray(bundle.recent.privateStates).length
      },
      compression: {
        algorithm: compress ? "gzip" : "none",
        uncompressedBytes,
        compressedBytes,
        ratio: compress && uncompressedBytes > 0
          ? Number((compressedBytes / uncompressedBytes).toFixed(4))
          : 1
      },
      compressed: compressedBuffer
        ? {
            encoding: "gzip+base64",
            payload: compressedBuffer.toString("base64")
          }
        : null,
      bundle: includeBundle ? bundle : undefined
    };
  }

  function restoreWorkspaceContextBundle(workspaceId?: unknown, value: unknown = {}, optionValue: unknown = {}) {
    const input = asObject(value);
    const options = asObject(optionValue);
    const targetWorkspaceId = String(workspaceId || input.workspaceId || input.targetWorkspaceId || "").trim();
    const targetRow = selectWorkspaceRawStmt.get(targetWorkspaceId);
    if (!targetRow) {
      return { ok: false, error: "工作空间不存在" };
    }
    const targetWorkspace = hydrateWorkspace(targetRow);
    if (!canAccessWorkspace(targetWorkspace, options)) {
      return { ok: false, error: "工作空间不可访问" };
    }

    let bundle: JsonRecord;
    try {
      bundle = asObject(decodeWorkspaceContextBundle(input));
    } catch (error: unknown) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "工作空间上下文压缩包解析失败。"
      };
    }
    if (bundle?.bundleVersion !== AGENT_WORKSPACE_CONTEXT_BUNDLE_VERSION) {
      return { ok: false, error: "工作空间上下文压缩包版本不匹配。" };
    }

    const bundleHash = stableHash("workspace-context-bundle", stableJson(bundle));
    const contextBundle = asObject(input.contextBundle);
    const legacyContextBundle = asObject(input.context_bundle);
    const expectedHash = String(
      input.bundleHash ||
        input.expectedBundleHash ||
        contextBundle.bundleHash ||
        legacyContextBundle.bundleHash ||
        ""
    ).trim();
    if (expectedHash && expectedHash !== bundleHash) {
      return { ok: false, error: "工作空间上下文压缩包 hash 校验失败。" };
    }

    const context = asObject(bundle.context);
    const resolvedProfile = asObject(bundle.resolvedProfile);
    const profileGatewayScope = asObject(resolvedProfile.gatewayScope);
    const requestedRestoredSourceIds = uniqueStrings(asArray(context.gatewaySourceIds).length
      ? asArray(context.gatewaySourceIds)
      : asArray(profileGatewayScope.includeSourceIds));
    const currentlyAccessibleSourceIds = new Set(resolveWorkspaceSourceIds(targetWorkspaceId));
    const access = workspaceAccess(options);
    const canImportRequestedSourceIds = access.canAccessAll === true;
    const restoredSourceIds = canImportRequestedSourceIds
      ? requestedRestoredSourceIds
      : requestedRestoredSourceIds.filter((sourceId) => currentlyAccessibleSourceIds.has(sourceId));
    const skippedSourceIds = requestedRestoredSourceIds.filter((sourceId) => !restoredSourceIds.includes(sourceId));
    const profilePatch: JsonRecord = {
      ...resolvedProfile,
      contextProfileId: context.contextProfileId || resolvedProfile.contextProfileId || "",
      toolGrantId: context.toolGrantId || resolvedProfile.toolGrantId || "",
      modelAlias: context.modelAlias || resolvedProfile.modelAlias || "",
      gatewayScope: {
        ...profileGatewayScope,
        includeSourceIds: restoredSourceIds,
        excludeSourceIds: asArray(profileGatewayScope.excludeSourceIds)
      }
    };
    const swapResult = hotSwapProfile(targetWorkspaceId, profilePatch, options);
    if (!swapResult.ok) {
      return swapResult;
    }

    const sourceWorkspace = asObject(bundle.workspace);
    const timestamp = nowIso();
    const runId = stableId("context_restore_run", targetWorkspaceId, bundleHash);
    const artifactId = stableId("context_restore_artifact", targetWorkspaceId, bundleHash);
    const recent = asObject(bundle.recent);
    createRun({
      runId,
      workspaceId: targetWorkspaceId,
      runType: "context_bundle_restore",
      status: "completed",
      input: {
        sourceWorkspaceId: sourceWorkspace.workspaceId || context.workspaceId || "",
        sourceContextFingerprint: context.contextFingerprint || "",
        bundleHash,
        skippedGatewaySourceIds: skippedSourceIds
      },
      steps: [
        {
          id: "decode",
          status: "completed",
          at: timestamp
        },
        {
          id: "apply_profile",
          status: "completed",
          at: timestamp
        }
      ],
      coverage: {
        restoredProfile: Boolean(profilePatch.contextProfileId || profilePatch.modelAlias || profilePatch.toolGrantId),
        restoredGatewaySourceCount: restoredSourceIds.length,
        skippedGatewaySourceCount: skippedSourceIds.length,
        restoredArtifactCount: asArray(recent.artifacts).length,
        restoredRunCount: asArray(recent.runs).length
      },
      artifactIds: [artifactId],
      startedAt: timestamp,
      completedAt: timestamp
    });
    const handoffMarkdown = normalizeText(bundle.handoffMarkdown)
      ? String(bundle.handoffMarkdown)
      : buildWorkspaceHandoffMarkdown(bundle);
    createArtifact({
      artifactId,
      workspaceId: targetWorkspaceId,
      runId,
      level: "ContextBundleHandoff",
      title: `Restored context bundle: ${sourceWorkspace.title || sourceWorkspace.workspaceId || "workspace"}`,
      content: handoffMarkdown,
      citations: [],
      coverageReport: {
        bundleHash,
        sourceWorkspaceId: sourceWorkspace.workspaceId || context.workspaceId || "",
        sourceContextFingerprint: context.contextFingerprint || "",
        restoredGatewaySourceCount: restoredSourceIds.length,
        skippedGatewaySourceCount: skippedSourceIds.length
      },
      status: "accepted",
      createdBy: String(options.actorUserId || "context-bundle-restore")
    });

    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      bundleVersion: AGENT_WORKSPACE_CONTEXT_BUNDLE_VERSION,
      ok: true,
      workspace: projectWorkspace(hydrateWorkspace(selectWorkspaceRawStmt.get(targetWorkspaceId))),
      restoredContext: getWorkspaceContext(targetWorkspaceId, options),
      source: {
        workspaceId: sourceWorkspace.workspaceId || context.workspaceId || "",
        contextFingerprint: context.contextFingerprint || "",
        generatedAt: bundle.generatedAt || ""
      },
      bundleHash,
      runId,
      artifactId,
      applied: {
        contextProfileId: profilePatch.contextProfileId,
        toolGrantId: profilePatch.toolGrantId,
        modelAlias: profilePatch.modelAlias,
        gatewaySourceCount: restoredSourceIds.length,
        skippedGatewaySourceCount: skippedSourceIds.length
      }
    };
  }

  function setWorkspaceParent(childValue?: unknown, parentValue?: unknown, optionValue: unknown = {}) {
    const childId = String(childValue || "");
    const parentId = String(parentValue || "");
    const options = asObject(optionValue);
    if (!selectWorkspaceRawStmt.get(childId)) {
      return { ok: false, error: "子工作空间不存在" };
    }
    if (!canAccessWorkspaceId(childId, options)) {
      return { ok: false, error: "工作空间不可访问" };
    }
    if (parentId) {
      if (!selectWorkspaceRawStmt.get(parentId)) {
        return { ok: false, error: "父工作空间不存在" };
      }
      if (!canAccessWorkspaceId(parentId, options)) {
        return { ok: false, error: "父工作空间不可访问" };
      }
      try {
        resolveWorkspaceChain(parentId);
      } catch {
        return { ok: false, error: "设置会导致继承链循环" };
      }
      const chainOfParent = resolveWorkspaceChain(parentId);
      if (chainOfParent.some((ws) => ws.workspaceId === childId)) {
        return { ok: false, error: "设置会导致继承链循环" };
      }
    }
    const ts = nowIso();
    db.prepare(
      "UPDATE aw_workspaces SET parent_workspace_id = ?, current_generation = current_generation + 1, updated_at = ? WHERE workspace_id = ?"
    ).run(parentId || null, ts, childId);
    return { ok: true, workspace: projectWorkspace(hydrateWorkspace(selectWorkspaceRawStmt.get(childId))) };
  }

  function hotSwapProfile(workspaceValue?: unknown, patchValue: unknown = {}, optionValue: unknown = {}) {
    const workspaceId = String(workspaceValue || "");
    const profilePatch = asObject(patchValue);
    const options = asObject(optionValue);
    const row = selectWorkspaceRawStmt.get(workspaceId);
    if (!row) return { ok: false, error: "工作空间不存在" };
    if (!canAccessWorkspace(hydrateWorkspace(row), options)) {
      return { ok: false, error: "工作空间不可访问" };
    }
    const existing = hydrateWorkspace(row);
    if (!existing) return { ok: false, error: "工作空间不存在" };
    const existingProfile = asObject(existing.profile);

    const newProfile: JsonRecord = {
      ...existingProfile,
      ...profilePatch,
      gatewayScope: {
        ...asObject(existingProfile.gatewayScope),
        ...asObject(profilePatch.gatewayScope),
      }
    };

    const ts = nowIso();
    db.prepare(
      "UPDATE aw_workspaces SET profile_json = ?, current_generation = current_generation + 1, updated_at = ? WHERE workspace_id = ?"
    ).run(stringifyJson(newProfile), ts, workspaceId);

    const updated = hydrateWorkspace(selectWorkspaceRawStmt.get(workspaceId));
    return { ok: true, workspace: projectWorkspace(updated), newGeneration: updated?.currentGeneration || 0 };
  }

  function setOwnedSourceIds(workspaceValue?: unknown, sourceIds?: unknown, optionValue: unknown = {}) {
    const workspaceId = String(workspaceValue || "");
    const options = asObject(optionValue);
    const row = selectWorkspaceRawStmt.get(workspaceId);
    if (!row) return { ok: false, error: "工作空间不存在" };
    if (!canAccessWorkspace(hydrateWorkspace(row), options)) {
      return { ok: false, error: "工作空间不可访问" };
    }
    const unique = uniqueStrings(asArray(sourceIds));
    const ts = nowIso();
    db.prepare(
      "UPDATE aw_workspaces SET owned_source_ids_json = ?, current_generation = current_generation + 1, updated_at = ? WHERE workspace_id = ?"
    ).run(stringifyJson(unique), ts, workspaceId);
    return { ok: true, workspace: projectWorkspace(hydrateWorkspace(selectWorkspaceRawStmt.get(workspaceId))) };
  }

  function shareWorkspace(sourceValue?: unknown, targetValue?: unknown, optionValue: unknown = {}) {
    const sourceId = String(sourceValue || "");
    const targetId = String(targetValue || "");
    const options = asObject(optionValue);
    if (!selectWorkspaceRawStmt.get(sourceId)) return { ok: false, error: "来源工作空间不存在" };
    const targetRow = selectWorkspaceRawStmt.get(targetId);
    if (!targetRow) return { ok: false, error: "目标工作空间不存在" };
    if (!canAccessWorkspaceId(sourceId, options) || !canAccessWorkspace(hydrateWorkspace(targetRow), options)) {
      return { ok: false, error: "工作空间不可访问" };
    }
    if (sourceId === targetId) return { ok: false, error: "不能共享给自身" };
    const target = hydrateWorkspace(targetRow);
    if (!target) return { ok: false, error: "目标工作空间不存在" };
    const existing = new Set(uniqueStrings(asArray(target.accessibleWorkspaceIds)));
    if (existing.has(sourceId)) return { ok: true, workspace: projectWorkspace(target), alreadyShared: true };
    existing.add(sourceId);
    const ts = nowIso();
    db.prepare(
      "UPDATE aw_workspaces SET accessible_workspace_ids_json = ?, current_generation = current_generation + 1, updated_at = ? WHERE workspace_id = ?"
    ).run(JSON.stringify([...existing]), ts, targetId);
    return { ok: true, workspace: projectWorkspace(hydrateWorkspace(selectWorkspaceRawStmt.get(targetId))) };
  }

  function unshareWorkspace(sourceValue?: unknown, targetValue?: unknown, optionValue: unknown = {}) {
    const sourceId = String(sourceValue || "");
    const targetId = String(targetValue || "");
    const options = asObject(optionValue);
    const targetRow = selectWorkspaceRawStmt.get(targetId);
    if (!targetRow) return { ok: false, error: "目标工作空间不存在" };
    if (!canAccessWorkspaceId(sourceId, options) || !canAccessWorkspace(hydrateWorkspace(targetRow), options)) {
      return { ok: false, error: "工作空间不可访问" };
    }
    const target = hydrateWorkspace(targetRow);
    if (!target) return { ok: false, error: "目标工作空间不存在" };
    const accessibleWorkspaceIds = uniqueStrings(asArray(target.accessibleWorkspaceIds));
    const updated = accessibleWorkspaceIds.filter((id) => id !== sourceId);
    if (updated.length === accessibleWorkspaceIds.length) {
      return { ok: true, workspace: projectWorkspace(target), wasShared: false };
    }
    const ts = nowIso();
    db.prepare(
      "UPDATE aw_workspaces SET accessible_workspace_ids_json = ?, current_generation = current_generation + 1, updated_at = ? WHERE workspace_id = ?"
    ).run(JSON.stringify(updated), ts, targetId);
    return { ok: true, workspace: projectWorkspace(hydrateWorkspace(selectWorkspaceRawStmt.get(targetId))), wasShared: true };
  }

  function deleteWorkspace(workspaceValue?: unknown, optionValue: unknown = {}) {
    const workspaceId = String(workspaceValue || "");
    const options = asObject(optionValue);
    const workspaceRow = selectWorkspaceRawStmt.get(workspaceId);
    const workspace = hydrateWorkspace(workspaceRow);
    if (!workspace || !canAccessWorkspace(workspace, options)) {
      return { ok: false, error: "工作空间不存在或无权限" };
    }
    const foldersRoot = path.resolve(rootPath || "", "folders");
    const fsPath = path.resolve(workspace.fsPath || "");
    const relativeWorkspacePath = path.relative(foldersRoot, fsPath);
    const expectedFolderName = stableId("workspace-folder", workspaceId);
    if (!workspace.fsPath ||
        !relativeWorkspacePath ||
        relativeWorkspacePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeWorkspacePath) ||
        relativeWorkspacePath !== expectedFolderName) {
      return { ok: false, error: "工作空间存储边界无效", code: "workspace_storage_boundary_invalid" };
    }
    const parentPath = foldersRoot;
    const deleteSuffix = stableId("delete", workspaceId, nowIso());
    const quarantinePath = path.join(parentPath, `.${path.basename(fsPath)}.deleting-${deleteSuffix}`);
    let movedToQuarantine = false;
    try {
      if (fs.existsSync(fsPath)) {
        fs.renameSync(fsPath, quarantinePath);
        movedToQuarantine = true;
      }
    } catch {
      return { ok: false, error: "无法隔离工作空间存储", code: "workspace_storage_quarantine_failed" };
    }

    try {
      db.transaction((): void => {
      const sharedRows = statement<SharedWorkspaceRow>(db.prepare(
        "SELECT workspace_id, accessible_workspace_ids_json FROM aw_workspaces WHERE workspace_id <> ?"
      ), "sharedWorkspaceRows").all(workspaceId);
      const updateShared = db.prepare(
        "UPDATE aw_workspaces SET accessible_workspace_ids_json = ?, current_generation = current_generation + 1, updated_at = ? WHERE workspace_id = ?"
      );
      for (const row of sharedRows) {
        const current = uniqueStrings(asArray(JSON.parse(row.accessible_workspace_ids_json || "[]")));
        const next = current.filter((id) => id !== workspaceId);
        if (next.length !== current.length) updateShared.run(JSON.stringify(next), nowIso(), row.workspace_id);
      }
      db.prepare(
        "UPDATE aw_workspaces SET parent_workspace_id = NULL, current_generation = current_generation + 1, updated_at = ? WHERE parent_workspace_id = ?"
      ).run(nowIso(), workspaceId);
      db.prepare("DELETE FROM aw_session_events WHERE workspace_id = ?").run(workspaceId);
      db.prepare("DELETE FROM aw_sessions WHERE workspace_id = ?").run(workspaceId);
      db.prepare("DELETE FROM aw_locks WHERE workspace_id = ?").run(workspaceId);
      db.prepare("DELETE FROM aw_decisions WHERE workspace_id = ?").run(workspaceId);
      db.prepare("DELETE FROM aw_issues WHERE workspace_id = ?").run(workspaceId);
      db.prepare("DELETE FROM aw_artifacts WHERE workspace_id = ?").run(workspaceId);
      db.prepare("DELETE FROM aw_submissions WHERE workspace_id = ?").run(workspaceId);
      db.prepare("DELETE FROM aw_private_state WHERE workspace_id = ?").run(workspaceId);
      db.prepare("DELETE FROM aw_runs WHERE workspace_id = ?").run(workspaceId);
      db.prepare("DELETE FROM aw_workspaces WHERE workspace_id = ?").run(workspaceId);
      })();
    } catch {
      if (movedToQuarantine) {
        try {
          fs.renameSync(quarantinePath, fsPath);
        } catch {
          return { ok: false, error: "工作空间删除回滚失败", code: "workspace_delete_compensation_failed" };
        }
      }
      return { ok: false, error: "工作空间元数据删除失败", code: "workspace_metadata_delete_failed" };
    }

    if (movedToQuarantine) {
      try {
        fs.rmSync(quarantinePath, { recursive: true, force: false });
      } catch {
        return {
          ok: false,
          deleted: true,
          cleanupPending: true,
          error: "工作空间已删除，但隔离存储清理失败",
          code: "workspace_storage_cleanup_pending"
        };
      }
    }
    return { ok: true, deleted: true };
  }

  return {
    resolveWorkspaceChain,
    resolveWorkspaceProfile,
    resolveWorkspaceSourceIds,
    getWorkspaceContext,
    getSessionContext,
    exportWorkspaceContextBundle,
    restoreWorkspaceContextBundle,
    setWorkspaceParent,
    hotSwapProfile,
    setOwnedSourceIds,
    shareWorkspace,
    unshareWorkspace,
    deleteWorkspace
  };
}
