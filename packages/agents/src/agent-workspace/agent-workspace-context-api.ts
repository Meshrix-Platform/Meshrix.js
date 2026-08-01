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

export function createAgentWorkspaceContextApi({
  db,
  rootPath,
  selectWorkspaceRawStmt,
  selectSessionStmt,
  canAccessWorkspace,
  canAccessWorkspaceId,
  workspaceAccess,
  getWorkspace,
  createRun,
  createArtifact
}: Record<string, any> = {}) : any {
  function resolveWorkspaceChain(workspaceId?: any, _seen: any = new Set<any>()) : any {
    if (_seen.has(workspaceId)) {
      throw new Error(`工作空间继承链存在循环: ${Array.from(_seen).join(" → ")} → ${workspaceId}`);
    }
    _seen.add(workspaceId);
    const row: any = selectWorkspaceRawStmt.get(workspaceId);
    if (!row) return [];
    const ws: any = hydrateWorkspace(row);
    const ancestors: any = ws.parentWorkspaceId
      ? resolveWorkspaceChain(ws.parentWorkspaceId, _seen)
      : [];
    return [...ancestors, ws];
  }

  /**
   * Walk the chain root→target, merge profiles: child overrides parent scalars.
   * gatewayScope arrays are merged using + / - notation.
   */
  function resolveWorkspaceProfile(workspaceId?: any) : any {
    const chain: any = resolveWorkspaceChain(workspaceId);
    let merged: Record<string, any> = {
      contextProfileId: "",
      toolGrantId: "",
      modelAlias: "",
      gatewayScope: { includeSourceIds: [], excludeSourceIds: [] }
    };
    for (const ws of chain) {
      const p: any = ws.profile || {};
      if (p.contextProfileId) merged.contextProfileId = p.contextProfileId;
      if (p.toolGrantId) merged.toolGrantId = p.toolGrantId;
      if (p.modelAlias) merged.modelAlias = p.modelAlias;
      const scope: any = p.gatewayScope || {};
      if (Array.isArray(scope.includeSourceIds)) {
        merged.gatewayScope.includeSourceIds = [
          ...merged.gatewayScope.includeSourceIds,
          ...scope.includeSourceIds
        ];
      }
      if (Array.isArray(scope.excludeSourceIds)) {
        merged.gatewayScope.excludeSourceIds = [
          ...merged.gatewayScope.excludeSourceIds,
          ...scope.excludeSourceIds
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
  function resolveWorkspaceSourceIds(workspaceId?: any, _visited: any = new Set<any>()) : any {
    if (_visited.has(workspaceId)) return [];  // break cycles in shared graph
    _visited.add(workspaceId);

    const chain: any = resolveWorkspaceChain(workspaceId);
    const sourceSet: any = new Set<any>();
    const excludeSet: any = new Set<any>();

    for (const ws of chain) {
      // Add each level's owned sources
      for (const id of ws.ownedSourceIds) sourceSet.add(id);
      // Apply explicit include/exclude in the profile at this level
      const scope: any = (ws.profile || {}).gatewayScope || {};
      for (const id of (scope.includeSourceIds || [])) sourceSet.add(id);
      for (const id of (scope.excludeSourceIds || [])) excludeSet.add(id);
    }

    // Remove explicitly excluded
    for (const id of excludeSet) sourceSet.delete(id);

    // Add sources from accessible (shared) workspaces
    const target: any = chain[chain.length - 1];
    if (target) {
      for (const sharedId of target.accessibleWorkspaceIds) {
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
  function getWorkspaceContext(workspaceId?: any, options: Record<string, any> = {}) : any {
    const targetRow: any = selectWorkspaceRawStmt.get(String(workspaceId || ""));
    if (!canAccessWorkspace(hydrateWorkspace(targetRow), options)) {
      return null;
    }
    const chain: any = resolveWorkspaceChain(workspaceId);
    if (chain.length === 0) return null;
    const profile: any = resolveWorkspaceProfile(workspaceId);
    const sourceIds: any = resolveWorkspaceSourceIds(workspaceId);
    const target: any = chain[chain.length - 1];
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      workspaceId,
      sharingMode: "team-shared",
      currentGeneration: target.currentGeneration,
      chainGenerations: chain.map((ws?: any) : any => ({
        workspaceId: ws.workspaceId,
        generation: ws.currentGeneration
      })),
      contextFingerprint: stableHash(
        "workspace-context",
        chain.map((ws?: any) : any => `${ws.workspaceId}:${ws.currentGeneration}`).join("|"),
        stringifyJson(profile),
        sourceIds.join("|")
      ),
      inheritanceChain: chain.map((ws?: any) : any => ({
        workspaceId: ws.workspaceId,
        title: ws.title,
      })),
      gatewaySourceIds: sourceIds,
      contextProfileId: profile.contextProfileId,
      toolGrantId: profile.toolGrantId,
      modelAlias: profile.modelAlias,
    };
  }

  function getSessionContext(sessionId?: any, options: Record<string, any> = {}) : any {
    const session: any = hydrateSession(selectSessionStmt.get(String(sessionId || "")));
    if (!session || !canAccessWorkspaceId(session.workspaceId, options)) {
      return null;
    }
    const workspaceContext: any = getWorkspaceContext(session.workspaceId, options);
    if (!workspaceContext) {
      return null;
    }
    const sessionContext: any = asObject(session.context);
    const explicitSourceIds: any = asArray(sessionContext.gatewaySourceIds || sessionContext.sourceIds);
    const contextProfileId: any = String(sessionContext.contextProfileId || workspaceContext.contextProfileId || "");
    const modelAlias: any = String(sessionContext.modelAlias || sessionContext.alias || workspaceContext.modelAlias || "");
    const toolGrantId: any = String(sessionContext.toolGrantId || sessionContext.grantId || workspaceContext.toolGrantId || "");
    const gatewaySourceIds: any = explicitSourceIds.length ? explicitSourceIds : workspaceContext.gatewaySourceIds;
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

  function exportWorkspaceContextBundle(workspaceId?: any, options: Record<string, any> = {}) : any {
    const context: any = getWorkspaceContext(workspaceId, options);
    if (!context) {
      return null;
    }
    const includePrivate: any = options.includePrivate === true;
    const includeBundle: any = options.includeBundle !== false;
    const compress: any = options.compress !== false;
    const maxItems: any = boundedInteger(options.maxItems, 12, 1, 100);
    const contentPreviewChars: any = boundedInteger(options.contentPreviewChars, 600, 0, 4000);
    const snapshot: any = getWorkspace({
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
    const chain: any = resolveWorkspaceChain(workspaceId);
    const bundle: Record<string, any> = {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      bundleVersion: AGENT_WORKSPACE_CONTEXT_BUNDLE_VERSION,
      generatedAt: nowIso(),
      workspace: compactWorkspaceLayer(snapshot.workspace),
      summary: snapshot.summary || {},
      context,
      resolvedProfile: resolveWorkspaceProfile(workspaceId),
      inheritanceChain: chain.map(compactWorkspaceLayer),
      options: {
        includePrivate,
        maxItems,
        contentPreviewChars
      },
      recent: {
        runs: asArray(snapshot.runs).slice(0, maxItems).map(compactRun),
        submissions: asArray(snapshot.submissions).slice(0, maxItems).map(compactSubmission),
        artifacts: asArray(snapshot.artifacts)
          .slice(0, maxItems)
          .map((artifact?: any) : any => compactArtifact(artifact, { contentPreviewChars })),
        issues: asArray(snapshot.issues).slice(0, maxItems).map(compactIssue),
        decisions: asArray(snapshot.decisions).slice(0, maxItems).map(compactDecision),
        privateStates: includePrivate
          ? asArray(snapshot.privateStates).slice(0, maxItems).map(compactPrivateState)
          : []
      }
    };
    bundle.handoffMarkdown = buildWorkspaceHandoffMarkdown(bundle);

    const jsonText: any = stableJson(bundle);
    const uncompressedBytes: any = Buffer.byteLength(jsonText, "utf8");
    const compressedBuffer: any = compress ? gzipSync(Buffer.from(jsonText, "utf8")) : null;
    const compressedBytes: any = compressedBuffer?.length || 0;
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

  function restoreWorkspaceContextBundle(workspaceId?: any, input: Record<string, any> = {}, options: Record<string, any> = {}) : any {
    const targetWorkspaceId: any = String(workspaceId || input.workspaceId || input.targetWorkspaceId || "").trim();
    const targetRow: any = selectWorkspaceRawStmt.get(targetWorkspaceId);
    if (!targetRow) {
      return { ok: false, error: "工作空间不存在" };
    }
    const targetWorkspace: any = hydrateWorkspace(targetRow);
    if (!canAccessWorkspace(targetWorkspace, options)) {
      return { ok: false, error: "工作空间不可访问" };
    }

    let bundle: any;
    try {
      bundle = decodeWorkspaceContextBundle(input);
    } catch (error: any) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "工作空间上下文压缩包解析失败。"
      };
    }
    if (bundle?.bundleVersion !== AGENT_WORKSPACE_CONTEXT_BUNDLE_VERSION) {
      return { ok: false, error: "工作空间上下文压缩包版本不匹配。" };
    }

    const bundleHash: any = stableHash("workspace-context-bundle", stableJson(bundle));
    const expectedHash: any = String(
      input.bundleHash ||
        input.expectedBundleHash ||
        input.contextBundle?.bundleHash ||
        input.context_bundle?.bundleHash ||
        ""
    ).trim();
    if (expectedHash && expectedHash !== bundleHash) {
      return { ok: false, error: "工作空间上下文压缩包 hash 校验失败。" };
    }

    const context: any = asObject(bundle.context);
    const resolvedProfile: any = asObject(bundle.resolvedProfile);
    const profileGatewayScope: any = asObject(resolvedProfile.gatewayScope);
    const requestedRestoredSourceIds: any = uniqueStrings(asArray(context.gatewaySourceIds).length
      ? asArray(context.gatewaySourceIds)
      : asArray(profileGatewayScope.includeSourceIds));
    const currentlyAccessibleSourceIds: any = new Set<any>(resolveWorkspaceSourceIds(targetWorkspaceId));
    const access: any = workspaceAccess(options);
    const canImportRequestedSourceIds: any = access.canAccessAll === true;
    const restoredSourceIds: any = canImportRequestedSourceIds
      ? requestedRestoredSourceIds
      : requestedRestoredSourceIds.filter((sourceId?: any) : any => currentlyAccessibleSourceIds.has(sourceId));
    const skippedSourceIds: any = requestedRestoredSourceIds.filter((sourceId?: any) : any => !restoredSourceIds.includes(sourceId));
    const profilePatch: Record<string, any> = {
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
    const swapResult: any = hotSwapProfile(targetWorkspaceId, profilePatch, options);
    if (!swapResult.ok) {
      return swapResult;
    }

    const sourceWorkspace: any = asObject(bundle.workspace);
    const timestamp: any = nowIso();
    const runId: any = stableId("context_restore_run", targetWorkspaceId, bundleHash);
    const artifactId: any = stableId("context_restore_artifact", targetWorkspaceId, bundleHash);
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
        restoredArtifactCount: asArray(bundle.recent?.artifacts).length,
        restoredRunCount: asArray(bundle.recent?.runs).length
      },
      artifactIds: [artifactId],
      startedAt: timestamp,
      completedAt: timestamp
    });
    const handoffMarkdown: any = normalizeText(bundle.handoffMarkdown)
      ? bundle.handoffMarkdown
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

  function setWorkspaceParent(childId?: any, parentId?: any, options: Record<string, any> = {}) : any {
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
      const chainOfParent: any = resolveWorkspaceChain(parentId);
      if (chainOfParent.some((ws?: any) : any => ws.workspaceId === childId)) {
        return { ok: false, error: "设置会导致继承链循环" };
      }
    }
    const ts: any = nowIso();
    db.prepare(
      "UPDATE aw_workspaces SET parent_workspace_id = ?, current_generation = current_generation + 1, updated_at = ? WHERE workspace_id = ?"
    ).run(parentId || null, ts, childId);
    return { ok: true, workspace: projectWorkspace(hydrateWorkspace(selectWorkspaceRawStmt.get(childId))) };
  }

  function hotSwapProfile(workspaceId?: any, profilePatch?: any, options: Record<string, any> = {}) : any {
    const row: any = selectWorkspaceRawStmt.get(workspaceId);
    if (!row) return { ok: false, error: "工作空间不存在" };
    if (!canAccessWorkspace(hydrateWorkspace(row), options)) {
      return { ok: false, error: "工作空间不可访问" };
    }
    const existing: any = hydrateWorkspace(row);
    const existingProfile: any = existing.profile || {};

    const newProfile: Record<string, any> = {
      ...existingProfile,
      ...profilePatch,
      gatewayScope: {
        ...(existingProfile.gatewayScope || {}),
        ...(profilePatch.gatewayScope || {}),
      }
    };

    const ts: any = nowIso();
    db.prepare(
      "UPDATE aw_workspaces SET profile_json = ?, current_generation = current_generation + 1, updated_at = ? WHERE workspace_id = ?"
    ).run(stringifyJson(newProfile), ts, workspaceId);

    const updated: any = hydrateWorkspace(selectWorkspaceRawStmt.get(workspaceId));
    return { ok: true, workspace: projectWorkspace(updated), newGeneration: updated.currentGeneration };
  }

  function setOwnedSourceIds(workspaceId?: any, sourceIds?: any, options: Record<string, any> = {}) : any {
    const row: any = selectWorkspaceRawStmt.get(workspaceId);
    if (!row) return { ok: false, error: "工作空间不存在" };
    if (!canAccessWorkspace(hydrateWorkspace(row), options)) {
      return { ok: false, error: "工作空间不可访问" };
    }
    const unique: any[] = [...new Set<any>(asArray(sourceIds).filter(Boolean))];
    const ts: any = nowIso();
    db.prepare(
      "UPDATE aw_workspaces SET owned_source_ids_json = ?, current_generation = current_generation + 1, updated_at = ? WHERE workspace_id = ?"
    ).run(stringifyJson(unique), ts, workspaceId);
    return { ok: true, workspace: projectWorkspace(hydrateWorkspace(selectWorkspaceRawStmt.get(workspaceId))) };
  }

  function shareWorkspace(sourceId?: any, targetId?: any, options: Record<string, any> = {}) : any {
    if (!selectWorkspaceRawStmt.get(sourceId)) return { ok: false, error: "来源工作空间不存在" };
    const targetRow: any = selectWorkspaceRawStmt.get(targetId);
    if (!targetRow) return { ok: false, error: "目标工作空间不存在" };
    if (!canAccessWorkspaceId(sourceId, options) || !canAccessWorkspace(hydrateWorkspace(targetRow), options)) {
      return { ok: false, error: "工作空间不可访问" };
    }
    if (sourceId === targetId) return { ok: false, error: "不能共享给自身" };
    const target: any = hydrateWorkspace(targetRow);
    const existing: any = new Set<any>(target.accessibleWorkspaceIds);
    if (existing.has(sourceId)) return { ok: true, workspace: projectWorkspace(target), alreadyShared: true };
    existing.add(sourceId);
    const ts: any = nowIso();
    db.prepare(
      "UPDATE aw_workspaces SET accessible_workspace_ids_json = ?, current_generation = current_generation + 1, updated_at = ? WHERE workspace_id = ?"
    ).run(JSON.stringify([...existing]), ts, targetId);
    return { ok: true, workspace: projectWorkspace(hydrateWorkspace(selectWorkspaceRawStmt.get(targetId))) };
  }

  function unshareWorkspace(sourceId?: any, targetId?: any, options: Record<string, any> = {}) : any {
    const targetRow: any = selectWorkspaceRawStmt.get(targetId);
    if (!targetRow) return { ok: false, error: "目标工作空间不存在" };
    if (!canAccessWorkspaceId(sourceId, options) || !canAccessWorkspace(hydrateWorkspace(targetRow), options)) {
      return { ok: false, error: "工作空间不可访问" };
    }
    const target: any = hydrateWorkspace(targetRow);
    const updated: any = target.accessibleWorkspaceIds.filter((id?: any) : any => id !== sourceId);
    if (updated.length === target.accessibleWorkspaceIds.length) {
      return { ok: true, workspace: projectWorkspace(target), wasShared: false };
    }
    const ts: any = nowIso();
    db.prepare(
      "UPDATE aw_workspaces SET accessible_workspace_ids_json = ?, current_generation = current_generation + 1, updated_at = ? WHERE workspace_id = ?"
    ).run(JSON.stringify(updated), ts, targetId);
    return { ok: true, workspace: projectWorkspace(hydrateWorkspace(selectWorkspaceRawStmt.get(targetId))), wasShared: true };
  }

  function deleteWorkspace(workspaceId?: any, options: Record<string, any> = {}) : any {
    const workspaceRow: any = selectWorkspaceRawStmt.get(workspaceId);
    const workspace: any = hydrateWorkspace(workspaceRow);
    if (!workspace || !canAccessWorkspace(workspace, options)) {
      return { ok: false, error: "工作空间不存在或无权限" };
    }
    const foldersRoot: any = path.resolve(rootPath || "", "folders");
    const fsPath: any = path.resolve(workspace.fsPath || "");
    const relativeWorkspacePath: any = path.relative(foldersRoot, fsPath);
    const expectedFolderName: any = stableId("workspace-folder", workspaceId);
    if (!workspace.fsPath ||
        !relativeWorkspacePath ||
        relativeWorkspacePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeWorkspacePath) ||
        relativeWorkspacePath !== expectedFolderName) {
      return { ok: false, error: "工作空间存储边界无效", code: "workspace_storage_boundary_invalid" };
    }
    const parentPath: any = foldersRoot;
    const deleteSuffix: any = stableId("delete", workspaceId, nowIso());
    const quarantinePath: any = path.join(parentPath, `.${path.basename(fsPath)}.deleting-${deleteSuffix}`);
    let movedToQuarantine: any = false;
    try {
      if (fs.existsSync(fsPath)) {
        fs.renameSync(fsPath, quarantinePath);
        movedToQuarantine = true;
      }
    } catch {
      return { ok: false, error: "无法隔离工作空间存储", code: "workspace_storage_quarantine_failed" };
    }

    try {
      db.transaction(() : any => {
      const sharedRows: any = db.prepare(
        "SELECT workspace_id, accessible_workspace_ids_json FROM aw_workspaces WHERE workspace_id <> ?"
      ).all(workspaceId);
      const updateShared: any = db.prepare(
        "UPDATE aw_workspaces SET accessible_workspace_ids_json = ?, current_generation = current_generation + 1, updated_at = ? WHERE workspace_id = ?"
      );
      for (const row of sharedRows) {
        const current: any = asArray(JSON.parse(row.accessible_workspace_ids_json || "[]"));
        const next: any = current.filter((id?: any) : any => id !== workspaceId);
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
