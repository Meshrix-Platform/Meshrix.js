import {
  AGENT_SESSION_THREAD_VERSION,
  AGENT_WORKSPACE_PROTOCOL_VERSION,
  asArray,
  asObject,
  compactSessionEvent,
  compactWorkspaceLayer,
  hydrateSession,
  hydrateSessionEvent,
  hydrateWorkspace,
  nowIso,
  normalizeText,
  parseJson,
  stableId,
  stableJson,
  stringifyJson,
  truncateText
} from "./agent-workspace-support.mjs";

export function createAgentWorkspaceSessionApi({
  db,
  selectSessionStmt,
  selectSessionEventStmt,
  selectMaxSessionSequenceStmt,
  insertSessionEventStmt,
  updateSessionStatsStmt,
  updateWorkspaceTimeStmt,
  insertSessionStmt,
  selectWorkspaceRootSessionStmt,
  listSessionsStmt,
  listSessionsByStatusStmt,
  listSessionsByWorkspaceStmt,
  listSessionsByWorkspaceStatusStmt,
  selectSessionEventsStmt,
  selectSessionEventsUntilStmt,
  selectLastSessionEventStmt,
  countChildSessionsStmt,
  updateSessionStatusStmt,
  canAccessWorkspaceId,
  canAccessWorkspace,
  getWorkspaceRow
} = {}) {
  function sessionWorkspaceSummary(workspaceId) {
    const workspace = hydrateWorkspace(getWorkspaceRow(String(workspaceId || "")));
    return workspace
      ? {
          workspaceId: workspace.workspaceId,
          title: workspace.title,
          currentGeneration: workspace.currentGeneration
        }
      : null;
  }

  function sessionListItem(session, options = {}) {
    const lastEvent = options.includeLastEvent === false || !session.lastEventId
      ? null
      : hydrateSessionEvent(selectSessionEventStmt.get(session.lastEventId));
    return {
      ...session,
      workspace: sessionWorkspaceSummary(session.workspaceId),
      lastEvent: lastEvent ? compactSessionEvent(lastEvent) : null
    };
  }

  function appendSessionEvent(input = {}) {
    const sessionId = String(input.sessionId || input.session_id || "").trim();
    const current = hydrateSession(selectSessionStmt.get(sessionId));
    if (!current) {
      return null;
    }
    if (!canAccessWorkspaceId(current.workspaceId, input)) {
      return null;
    }
    const timestamp = input.createdAt || nowIso();
    const sequence = Number(selectMaxSessionSequenceStmt.get(sessionId)?.sequence || 0) + 1;
    const type = normalizeText(input.type || input.eventType || input.event_type || "session_event") || "session_event";
    const title = normalizeText(input.title || type).slice(0, 300);
    const summary = truncateText(input.summary || input.description || title, 2000);
    const parentEventId = String(input.parentEventId || input.parent_event_id || current.lastEventId || "").trim();
    const payload = {
      ...asObject(input.payload),
      appendOnly: true
    };
    const eventId =
      String(input.eventId || input.event_id || "").trim() ||
      stableId("session_event", sessionId, type, title, summary, sequence, timestamp);
    insertSessionEventStmt.run(
      eventId,
      sessionId,
      current.workspaceId,
      parentEventId,
      type,
      title,
      summary,
      stringifyJson(payload),
      String(input.createdBy || input.actorUserId || input.agentId || "").trim(),
      timestamp,
      sequence
    );
    updateSessionStatsStmt.run(eventId, sequence, timestamp, sessionId);
    updateWorkspaceTimeStmt.run(timestamp, current.workspaceId);
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      sessionProtocolVersion: AGENT_SESSION_THREAD_VERSION,
      session: hydrateSession(selectSessionStmt.get(sessionId)),
      event: hydrateSessionEvent(selectSessionEventStmt.get(eventId))
    };
  }

  function insertSessionRecord(input = {}) {
    const timestamp = input.createdAt || nowIso();
    const workspaceId = String(input.workspaceId || input.workspace_id || "").trim();
    const sessionId =
      String(input.sessionId || input.session_id || "").trim() ||
      stableId("session", workspaceId, input.title || "", input.parentSessionId || "", timestamp);
    insertSessionStmt.run(
      sessionId,
      workspaceId,
      normalizeText(input.title || "工作会话") || "工作会话",
      normalizeText(input.objective || "").slice(0, 2000),
      String(input.status || "active").trim() || "active",
      String(input.parentSessionId || input.parent_session_id || "").trim(),
      String(input.forkedFromEventId || input.forked_from_event_id || "").trim(),
      Number(input.branchIndex || input.branch_index || 0),
      stringifyJson(asArray(input.lineage), []),
      stringifyJson(asObject(input.context), {}),
      stringifyJson(asObject(input.metadata), {}),
      String(input.createdBy || input.actorUserId || input.agentId || "").trim(),
      timestamp,
      input.updatedAt || timestamp,
      String(input.lastEventId || "").trim(),
      Number(input.eventCount || 0),
      1
    );
    return hydrateSession(selectSessionStmt.get(sessionId));
  }

  function createSession(input = {}) {
    const workspaceId = String(input.workspaceId || input.workspace_id || "").trim();
    const workspace = hydrateWorkspace(getWorkspaceRow(workspaceId));
    if (!workspace) {
      return { ok: false, error: "工作空间不存在" };
    }
    if (!canAccessWorkspace(workspace, input)) {
      return { ok: false, error: "工作空间不可访问" };
    }
    const session = insertSessionRecord({
      ...input,
      workspaceId,
      context: {
        workspaceId,
        ...asObject(input.context)
      },
      metadata: {
        ...asObject(input.metadata),
        appendOnly: true
      }
    });
    let event = null;
    if (input.initialEvent !== false) {
      const result = appendSessionEvent({
        ...input,
        sessionId: session.sessionId,
        type: input.initialEventType || "session_created",
        title: "会话创建",
        summary: input.objective || session.objective || session.title,
        payload: {
          workspaceId,
          parentSessionId: session.parentSessionId,
          forkedFromEventId: session.forkedFromEventId
        }
      });
      event = result?.event || null;
    }
    return {
      ok: true,
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      sessionProtocolVersion: AGENT_SESSION_THREAD_VERSION,
      session: hydrateSession(selectSessionStmt.get(session.sessionId)),
      event
    };
  }

  function ensureRootSessionForWorkspace(workspace) {
    if (!workspace?.workspaceId) {
      return null;
    }
    const existing = hydrateSession(selectWorkspaceRootSessionStmt.get(workspace.workspaceId));
    if (existing) {
      return existing;
    }
    const timestamp = workspace.createdAt || nowIso();
    const result = createSession({
      sessionId: stableId("session", workspace.workspaceId, "root"),
      workspaceId: workspace.workspaceId,
      title: `${workspace.title || workspace.workspaceId} / 主会话`,
      objective: workspace.objective || "",
      actorUserId: workspace.ownerUserId || "",
      userId: workspace.ownerUserId || "",
      createdBy: workspace.ownerUserId || "",
      createdAt: timestamp,
      metadata: {
        rootSession: true,
        generatedFromWorkspace: true
      }
    });
    return result.session || null;
  }

  function ensureRootSessionsForVisibleWorkspaces(input = {}) {
    if (input.ensureRoots === false || input.seedRoots === false) {
      return;
    }
    const workspaceRows = db.prepare("SELECT * FROM aw_workspaces ORDER BY updated_at DESC LIMIT 500").all();
    for (const workspace of workspaceRows.map(hydrateWorkspace)) {
      if (canAccessWorkspace(workspace, input)) {
        ensureRootSessionForWorkspace(workspace);
      }
    }
  }

  function listSessions(input = {}) {
    ensureRootSessionsForVisibleWorkspaces(input);
    const limit = Math.max(1, Math.min(Number(input.limit || 100), 500));
    const status = String(input.status || "").trim();
    const workspaceId = String(input.workspaceId || input.workspace_id || "").trim();
    let rows;
    if (workspaceId && status) {
      rows = listSessionsByWorkspaceStatusStmt.all(workspaceId, status, limit);
    } else if (workspaceId) {
      rows = listSessionsByWorkspaceStmt.all(workspaceId, limit);
    } else if (status) {
      rows = listSessionsByStatusStmt.all(status, limit);
    } else {
      rows = listSessionsStmt.all(limit);
    }
    const sessions = rows
      .map(hydrateSession)
      .filter((session) => canAccessWorkspaceId(session.workspaceId, input))
      .map((session) => sessionListItem(session, { includeLastEvent: input.includeLastEvent !== false }));
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      sessionProtocolVersion: AGENT_SESSION_THREAD_VERSION,
      sharingMode: "team-shared",
      appendOnly: true,
      sessions,
      count: sessions.length
    };
  }

  function getSession(input = {}) {
    const sessionId = typeof input === "string" ? input : String(input.sessionId || input.session_id || "").trim();
    const options = typeof input === "string" ? {} : input;
    const session = hydrateSession(selectSessionStmt.get(sessionId));
    if (!session || !canAccessWorkspaceId(session.workspaceId, options)) {
      return null;
    }
    const limit = Math.max(1, Math.min(Number(options.eventLimit || options.limit || 200), 1000));
    const includeEvents = options.includeEvents !== false;
    const workspace = hydrateWorkspace(getWorkspaceRow(session.workspaceId));
    return {
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      sessionProtocolVersion: AGENT_SESSION_THREAD_VERSION,
      appendOnly: true,
      session: sessionListItem(session),
      workspace: workspace ? compactWorkspaceLayer(workspace) : null,
      events: includeEvents
        ? selectSessionEventsStmt.all(session.sessionId, limit).map(hydrateSessionEvent)
        : []
    };
  }

  function cloneSessionEvents({ sourceSessionId, targetSessionId, cutoffSequence }) {
    const sourceRows = selectSessionEventsUntilStmt.all(sourceSessionId, cutoffSequence);
    const idMap = new Map();
    for (const row of sourceRows) {
      idMap.set(row.event_id, stableId("session_event", targetSessionId, row.event_id, row.sequence));
    }
    for (const row of sourceRows) {
      const payload = parseJson(row.payload_json, {});
      insertSessionEventStmt.run(
        idMap.get(row.event_id),
        targetSessionId,
        row.workspace_id,
        idMap.get(row.parent_event_id) || "",
        row.event_type,
        row.title,
        row.summary,
        stringifyJson({
          ...payload,
          clonedFromEventId: row.event_id,
          clonedFromSessionId: sourceSessionId
        }),
        row.created_by,
        row.created_at,
        row.sequence
      );
    }
    return {
      rows: sourceRows.length,
      lastEventId: sourceRows.length ? idMap.get(sourceRows[sourceRows.length - 1].event_id) : ""
    };
  }

  const forkSessionTx = db.transaction((input = {}) => {
    const sourceId = String(input.sessionId || input.sourceSessionId || input.session_id || "").trim();
    const source = hydrateSession(selectSessionStmt.get(sourceId));
    if (!source) {
      return { ok: false, error: "会话不存在" };
    }
    if (!canAccessWorkspaceId(source.workspaceId, input)) {
      return { ok: false, error: "工作空间不可访问" };
    }
    const forkSourceEventId = String(input.fromEventId || input.forkedFromEventId || source.lastEventId || "").trim();
    const sourceEvent = forkSourceEventId
      ? hydrateSessionEvent(selectSessionEventStmt.get(forkSourceEventId))
      : hydrateSessionEvent(selectLastSessionEventStmt.get(source.sessionId));
    if (forkSourceEventId && (!sourceEvent || sourceEvent.sessionId !== source.sessionId)) {
      return { ok: false, error: "分叉事件不属于该会话" };
    }
    const cutoffSequence = sourceEvent?.sequence || Number(selectMaxSessionSequenceStmt.get(source.sessionId)?.sequence || 0);
    const branchIndex = Number(countChildSessionsStmt.get(source.sessionId)?.count || 0) + 1;
    const timestamp = nowIso();
    const nextSession = insertSessionRecord({
      sessionId: input.newSessionId || input.targetSessionId || stableId("session", source.sessionId, cutoffSequence, branchIndex, timestamp),
      workspaceId: source.workspaceId,
      title: input.title || `${source.title} / 分叉 ${branchIndex}`,
      objective: input.objective || source.objective,
      status: "active",
      parentSessionId: source.sessionId,
      forkedFromEventId: sourceEvent?.eventId || "",
      branchIndex,
      lineage: [...asArray(source.lineage), source.sessionId],
      context: {
        ...asObject(source.context),
        ...asObject(input.context)
      },
      metadata: {
        ...asObject(source.metadata),
        ...asObject(input.metadata),
        appendOnly: true,
        forkedFromSessionId: source.sessionId,
        forkedFromEventId: sourceEvent?.eventId || "",
        forkedAt: timestamp
      },
      createdBy: input.createdBy || input.actorUserId || "",
      createdAt: timestamp,
      updatedAt: timestamp,
      eventCount: 0,
      lastEventId: ""
    });
    const clone = cloneSessionEvents({
      sourceSessionId: source.sessionId,
      targetSessionId: nextSession.sessionId,
      cutoffSequence
    });
    updateSessionStatsStmt.run(clone.lastEventId, clone.rows, timestamp, nextSession.sessionId);
    const forkEvent = appendSessionEvent({
      ...input,
      sessionId: nextSession.sessionId,
      type: "session_forked",
      title: "会话分叉",
      summary: `从 ${source.title || source.sessionId} 分叉`,
      parentEventId: clone.lastEventId,
      payload: {
        sourceSessionId: source.sessionId,
        sourceEventId: sourceEvent?.eventId || "",
        copiedEventCount: clone.rows,
        branchIndex
      }
    })?.event;
    return {
      ok: true,
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      sessionProtocolVersion: AGENT_SESSION_THREAD_VERSION,
      appendOnly: true,
      sourceSession: source,
      session: hydrateSession(selectSessionStmt.get(nextSession.sessionId)),
      event: forkEvent,
      fork: {
        parentSessionId: source.sessionId,
        forkedFromEventId: sourceEvent?.eventId || "",
        copiedEventCount: clone.rows,
        branchIndex
      }
    };
  });

  function forkSession(input = {}) {
    return forkSessionTx(input);
  }

  function sessionEventCompareKey(event = {}) {
    const payload = asObject(event.payload);
    const clonedFromEventId = String(payload.clonedFromEventId || "").trim();
    if (clonedFromEventId) {
      return `event:${clonedFromEventId}`;
    }
    if (event.eventId) {
      return `event:${event.eventId}`;
    }
    return stableId(
      "session_event_key",
      event.type,
      event.title,
      event.summary,
      stableJson(payload)
    );
  }

  function sessionEventConflictTarget(event = {}) {
    const payload = asObject(event.payload);
    return String(
      payload.targetId ||
        payload.artifactId ||
        payload.assetId ||
        payload.documentId ||
        payload.submissionId ||
        payload.decisionId ||
        payload.path ||
        ""
    ).trim();
  }

  function sessionEventPublicDiff(event = {}) {
    return {
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
      title: event.title,
      summary: truncateText(event.summary, 600),
      targetId: sessionEventConflictTarget(event),
      createdBy: event.createdBy || "",
      createdAt: event.createdAt || ""
    };
  }

  function compareSessions(input = {}) {
    const leftSessionId = String(input.leftSessionId || input.sessionId || input.sourceSessionId || "").trim();
    const rightSessionId = String(input.rightSessionId || input.targetSessionId || input.compareWithSessionId || "").trim();
    const left = hydrateSession(selectSessionStmt.get(leftSessionId));
    const right = hydrateSession(selectSessionStmt.get(rightSessionId));
    if (!left || !right) {
      return { ok: false, error: "会话不存在" };
    }
    if (!canAccessWorkspaceId(left.workspaceId, input) || !canAccessWorkspaceId(right.workspaceId, input)) {
      return { ok: false, error: "工作空间不可访问" };
    }
    const leftEvents = selectSessionEventsStmt.all(left.sessionId, 5000).map(hydrateSessionEvent);
    const rightEvents = selectSessionEventsStmt.all(right.sessionId, 5000).map(hydrateSessionEvent);
    const leftByKey = new Map(leftEvents.map((event) => [sessionEventCompareKey(event), event]));
    const rightByKey = new Map(rightEvents.map((event) => [sessionEventCompareKey(event), event]));
    const commonKeys = [...leftByKey.keys()].filter((key) => rightByKey.has(key));
    const leftOnly = leftEvents.filter((event) => !rightByKey.has(sessionEventCompareKey(event)));
    const rightOnly = rightEvents.filter((event) => !leftByKey.has(sessionEventCompareKey(event)));
    const rightOnlyByTarget = new Map();
    for (const event of rightOnly) {
      const target = sessionEventConflictTarget(event);
      if (target) {
        rightOnlyByTarget.set(target, event);
      }
    }
    const conflicts = [];
    for (const event of leftOnly) {
      const target = sessionEventConflictTarget(event);
      if (!target || !rightOnlyByTarget.has(target)) {
        continue;
      }
      const other = rightOnlyByTarget.get(target);
      if (stableJson(event.payload) !== stableJson(other.payload) || event.summary !== other.summary || event.type !== other.type) {
        conflicts.push({
          targetId: target,
          left: sessionEventPublicDiff(event),
          right: sessionEventPublicDiff(other),
          resolution: "merge_proposal_required"
        });
      }
    }
    const maxLen = Math.max(leftEvents.length, rightEvents.length);
    let divergence = null;
    for (let index = 0; index < maxLen; index += 1) {
      const leftKey = leftEvents[index] ? sessionEventCompareKey(leftEvents[index]) : "";
      const rightKey = rightEvents[index] ? sessionEventCompareKey(rightEvents[index]) : "";
      if (leftKey !== rightKey) {
        divergence = {
          leftSequence: leftEvents[index]?.sequence || 0,
          rightSequence: rightEvents[index]?.sequence || 0,
          leftEventId: leftEvents[index]?.eventId || "",
          rightEventId: rightEvents[index]?.eventId || ""
        };
        break;
      }
    }
    return {
      ok: true,
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      sessionProtocolVersion: AGENT_SESSION_THREAD_VERSION,
      comparisonId: stableId("session_compare", left.sessionId, left.lastEventId, right.sessionId, right.lastEventId),
      appendOnly: true,
      leftSession: sessionListItem(left),
      rightSession: sessionListItem(right),
      summary: {
        commonEventCount: commonKeys.length,
        leftOnlyCount: leftOnly.length,
        rightOnlyCount: rightOnly.length,
        conflictCount: conflicts.length,
        divergence
      },
      leftOnly: leftOnly.map(sessionEventPublicDiff),
      rightOnly: rightOnly.map(sessionEventPublicDiff),
      conflicts
    };
  }

  function createSessionMergeProposal(input = {}) {
    const targetSessionId = String(input.targetSessionId || input.sessionId || input.leftSessionId || "").trim();
    const sourceSessionId = String(input.sourceSessionId || input.rightSessionId || input.mergeFromSessionId || "").trim();
    const comparison = compareSessions({
      ...input,
      leftSessionId: targetSessionId,
      rightSessionId: sourceSessionId
    });
    if (!comparison.ok) {
      return comparison;
    }
    const proposalId = stableId(
      "session_merge_proposal",
      targetSessionId,
      sourceSessionId,
      comparison.comparisonId,
      stableJson(input.resolutionHints || {})
    );
    const eventResult = appendSessionEvent({
      ...input,
      sessionId: targetSessionId,
      type: "session_merge_proposal",
      title: input.title || "会话合并提案",
      summary: input.summary || `提议将 ${sourceSessionId} 合并到 ${targetSessionId}`,
      payload: {
        proposalId,
        targetSessionId,
        sourceSessionId,
        comparisonId: comparison.comparisonId,
        conflictCount: comparison.summary.conflictCount,
        leftOnlyCount: comparison.summary.leftOnlyCount,
        rightOnlyCount: comparison.summary.rightOnlyCount,
        conflicts: comparison.conflicts,
        resolutionHints: asObject(input.resolutionHints),
        autoMergeApplied: false,
        requiresDecision: true
      }
    });
    return {
      ok: true,
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      sessionProtocolVersion: AGENT_SESSION_THREAD_VERSION,
      appendOnly: true,
      proposal: {
        proposalId,
        targetSessionId,
        sourceSessionId,
        status: "proposed",
        autoMergeApplied: false,
        requiresDecision: true,
        conflictCount: comparison.summary.conflictCount
      },
      comparison,
      event: eventResult?.event || null,
      session: eventResult?.session || null
    };
  }

  function archiveSession(input = {}) {
    const sessionId = String(input.sessionId || input.session_id || "").trim();
    const session = hydrateSession(selectSessionStmt.get(sessionId));
    if (!session) {
      return { ok: false, error: "会话不存在" };
    }
    if (!canAccessWorkspaceId(session.workspaceId, input)) {
      return { ok: false, error: "工作空间不可访问" };
    }
    const eventResult = appendSessionEvent({
      ...input,
      sessionId,
      type: "session_archived",
      title: input.title || "会话归档",
      summary: input.summary || input.reason || "会话已归档。",
      payload: {
        reason: String(input.reason || "").trim(),
        archivedPreviousStatus: session.status,
        appendOnly: true
      }
    });
    const timestamp = nowIso();
    updateSessionStatusStmt.run("archived", timestamp, sessionId);
    updateWorkspaceTimeStmt.run(timestamp, session.workspaceId);
    return {
      ok: true,
      protocolVersion: AGENT_WORKSPACE_PROTOCOL_VERSION,
      sessionProtocolVersion: AGENT_SESSION_THREAD_VERSION,
      appendOnly: true,
      session: hydrateSession(selectSessionStmt.get(sessionId)),
      event: eventResult?.event || null
    };
  }


  return {
    appendSessionEvent,
    createSession,
    ensureRootSessionForWorkspace,
    listSessions,
    getSession,
    forkSession,
    compareSessions,
    createSessionMergeProposal,
    archiveSession
  };
}
