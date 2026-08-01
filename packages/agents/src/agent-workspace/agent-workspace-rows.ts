import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ACCEPTED_SUBMISSION_TYPES,
  REVIEW_ONLY_TYPES,
  asArray,
  asObject,
  normalizeEvidenceRefs,
  parseJson
} from "./agent-workspace-core.ts";

export function hydrateWorkspace(row?: any) : any {
  if (!row) {
    return null;
  }
  return {
    workspaceId: row.workspace_id,
    title: row.title,
    objective: row.objective,
    status: row.status,
    ownerUserId: row.owner_user_id || "",
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Inheritance & profile fields (populated after schema evolution)
    parentWorkspaceId: row.parent_workspace_id || null,
    profile: parseJson(row.profile_json, {}),
    ownedSourceIds: parseJson(row.owned_source_ids_json, []),
    accessibleWorkspaceIds: parseJson(row.accessible_workspace_ids_json, []),
    currentGeneration: Number(row.current_generation || 1),
    fsPath: row.fs_path || "",
  };
}

/**
 * Project the persisted workspace aggregate onto its public protocol shape.
 * Physical custody paths are an adapter concern and must never cross the
 * workspace API boundary.
 */
export function projectWorkspace(workspace?: any) : any {
  if (!workspace) {
    return null;
  }
  const { fsPath: _privateFsPath, ...projected } = workspace;
  return projected;
}

export function hydrateRun(row?: any, options: Record<string, any> = {}) : any {
  if (!row) {
    return null;
  }
  const includeDetails: any = options.includeDetails !== false;
  return {
    runId: row.run_id,
    workspaceId: row.workspace_id,
    runType: row.run_type,
    status: row.status,
    input: parseJson(row.input_json, {}),
    steps: includeDetails ? parseJson(row.steps_json, []) : [],
    coverage: includeDetails ? parseJson(row.coverage_json, {}) : {},
    artifactIds: parseJson(row.artifact_ids_json, []),
    error: row.error,
    degraded: Boolean(row.degraded),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

export function hydrateSubmission(row?: any) : any {
  if (!row) {
    return null;
  }
  return {
    submissionId: row.submission_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    agentId: row.agent_id,
    type: row.type,
    status: row.status,
    confidence: Number(row.confidence || 0),
    payload: parseJson(row.payload_json, {}),
    evidenceRefs: parseJson(row.evidence_refs_json, []),
    gate: parseJson(row.gate_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function hydratePrivateState(row?: any) : any {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    agentId: row.agent_id,
    summary: row.summary,
    state: parseJson(row.state_json, {}),
    updatedAt: row.updated_at
  };
}

export function hydrateArtifact(row?: any) : any {
  if (!row) {
    return null;
  }
  return {
    artifactId: row.artifact_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    level: row.level,
    title: row.title,
    content: row.content,
    citations: parseJson(row.citations_json, []),
    coverageReport: parseJson(row.coverage_json, {}),
    revision: Number(row.revision || 1),
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function hydrateIssue(row?: any) : any {
  if (!row) {
    return null;
  }
  return {
    issueId: row.issue_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    type: row.type,
    status: row.status,
    severity: row.severity,
    title: row.title,
    payload: parseJson(row.payload_json, {}),
    evidenceRefs: parseJson(row.evidence_refs_json, []),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function hydrateDecision(row?: any) : any {
  if (!row) {
    return null;
  }
  return {
    decisionId: row.decision_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    status: row.status,
    title: row.title,
    payload: parseJson(row.payload_json, {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function hydrateLock(row?: any) : any {
  if (!row) {
    return null;
  }
  return {
    lockId: row.lock_id,
    workspaceId: row.workspace_id,
    targetType: row.target_type,
    targetId: row.target_id,
    ownerAgentId: row.owner_agent_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
}

export function hydrateSession(row?: any) : any {
  if (!row) {
    return null;
  }
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    title: row.title,
    objective: row.objective || "",
    status: row.status || "active",
    parentSessionId: row.parent_session_id || "",
    forkedFromEventId: row.forked_from_event_id || "",
    branchIndex: Number(row.branch_index || 0),
    lineage: parseJson(row.lineage_json, []),
    context: parseJson(row.context_json, {}),
    metadata: parseJson(row.metadata_json, {}),
    createdBy: row.created_by || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEventId: row.last_event_id || "",
    eventCount: Number(row.event_count || 0),
    appendOnly: row.append_only !== 0
  };
}

export function hydrateSessionEvent(row?: any) : any {
  if (!row) {
    return null;
  }
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    parentEventId: row.parent_event_id || "",
    type: row.event_type,
    title: row.title || "",
    summary: row.summary || "",
    payload: parseJson(row.payload_json, {}),
    createdBy: row.created_by || "",
    createdAt: row.created_at,
    sequence: Number(row.sequence || 0)
  };
}

export function fileMetadataFromStat({ workspaceId, relativePath, absolutePath, stat, includeHash = false }: Record<string, any>) : any {
  const isFile: any = stat.isFile();
  const metadata: Record<string, any> = {
    workspaceId,
    relativePath,
    name: path.posix.basename(relativePath) || "",
    type: stat.isDirectory() ? "directory" : isFile ? "file" : "other",
    sizeBytes: stat.isDirectory() ? 0 : Number(stat.size || 0),
    createdAt: stat.birthtime?.toISOString?.() || "",
    updatedAt: stat.mtime?.toISOString?.() || "",
    contentSha256: ""
  };
  if (includeHash && isFile) {
    metadata.contentSha256 = crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
  }
  return metadata;
}

export function gateSubmission({ existingDuplicate = null, submission, writePolicy = {} }: Record<string, any>) : any {
  const reasons: any[] = [];
  const type: any = String(submission.type || "").trim();
  const payload: any = asObject(submission.payload);
  const evidenceRefs: any = normalizeEvidenceRefs(submission.evidenceRefs, payload);
  const confidence: any = Math.max(0, Math.min(1, Number(submission.confidence || payload.confidence || 0)));
  const allowedTypes: any = new Set<any>(asArray(writePolicy.allowedTypes).filter(Boolean));

  if (!ACCEPTED_SUBMISSION_TYPES.has(type)) {
    reasons.push("unsupported_type");
  }
  if (allowedTypes.size && !allowedTypes.has(type)) {
    reasons.push("role_not_allowed");
  }
  if (existingDuplicate) {
    reasons.push("duplicate_submission");
  }
  if ((type === "claim" || type === "evidenceCard") && evidenceRefs.length === 0) {
    reasons.push("missing_evidence");
  }
  if ((type === "claim" || type === "evidenceCard") && confidence < 0.45) {
    reasons.push("low_confidence");
  }
  if (REVIEW_ONLY_TYPES.has(type)) {
    reasons.push("canonical_change_requires_review");
  }

  let status: any = "proposed";
  if (type === "evidenceRef" && evidenceRefs.length > 0) {
    status = "accepted";
  }
  if (type === "artifact" || type === "taskState" || type === "contextSummary") {
    status = "accepted";
  }
  if (type === "issue" || type === "decisionProposal") {
    status = "proposed";
  }
  if (reasons.includes("duplicate_submission") || reasons.includes("unsupported_type") || reasons.includes("role_not_allowed")) {
    status = "rejected";
  } else if (
    reasons.includes("missing_evidence") ||
    reasons.includes("low_confidence") ||
    reasons.includes("canonical_change_requires_review")
  ) {
    status = "needs_review";
  }

  return {
    status,
    confidence,
    evidenceRefs,
    acceptedByGate: status === "accepted",
    reasons,
    duplicateOf: existingDuplicate?.submission_id || "",
    reviewedRequired: status === "needs_review" || REVIEW_ONLY_TYPES.has(type)
  };
}
