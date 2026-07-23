import { gunzipSync } from "node:zlib";
import {
  AGENT_WORKSPACE_CONTEXT_BUNDLE_VERSION,
  CONTEXT_BUNDLE_COMPRESSED_MAX_BYTES,
  CONTEXT_BUNDLE_UNCOMPRESSED_MAX_BYTES,
  asArray,
  asObject,
  boundedInteger,
  normalizeText,
  truncateText
} from "./agent-workspace-core.mjs";

export function submissionSummary(type, payload) {
  return normalizeText(
    payload.claim ||
      payload.summary ||
      payload.title ||
      payload.content ||
      payload.question ||
      payload.status ||
      type
  ).slice(0, 500);
}

export function compactWorkspaceLayer(workspace = {}) {
  return {
    workspaceId: workspace.workspaceId,
    ownerUserId: workspace.ownerUserId || "",
    title: workspace.title,
    objective: truncateText(workspace.objective, 500),
    status: workspace.status,
    parentWorkspaceId: workspace.parentWorkspaceId || null,
    profile: workspace.profile || {},
    ownedSourceIds: asArray(workspace.ownedSourceIds),
    accessibleWorkspaceIds: asArray(workspace.accessibleWorkspaceIds),
    currentGeneration: Number(workspace.currentGeneration || 0),
    updatedAt: workspace.updatedAt || ""
  };
}

export function compactRun(run = {}) {
  return {
    runId: run.runId,
    runType: run.runType,
    status: run.status,
    degraded: Boolean(run.degraded),
    artifactIds: asArray(run.artifactIds),
    error: truncateText(run.error, 500),
    startedAt: run.startedAt || "",
    completedAt: run.completedAt || "",
    updatedAt: run.updatedAt || ""
  };
}

export function compactSubmission(submission = {}) {
  const payload = asObject(submission.payload);
  return {
    submissionId: submission.submissionId,
    runId: submission.runId,
    agentId: submission.agentId,
    type: submission.type,
    status: submission.status,
    confidence: Number(submission.confidence || 0),
    summary: submissionSummary(submission.type, payload),
    evidenceRefs: asArray(submission.evidenceRefs),
    gateReasons: asArray(submission.gate?.reasons),
    updatedAt: submission.updatedAt || ""
  };
}

export function compactArtifact(artifact = {}, options = {}) {
  return {
    artifactId: artifact.artifactId,
    runId: artifact.runId,
    level: artifact.level,
    title: artifact.title,
    status: artifact.status,
    revision: Number(artifact.revision || 0),
    contentPreview: truncateText(artifact.content, options.contentPreviewChars),
    citations: asArray(artifact.citations),
    coverageKeys: Object.keys(asObject(artifact.coverageReport)),
    updatedAt: artifact.updatedAt || ""
  };
}

export function compactIssue(issue = {}) {
  return {
    issueId: issue.issueId,
    runId: issue.runId,
    type: issue.type,
    status: issue.status,
    severity: issue.severity,
    title: issue.title,
    evidenceRefs: asArray(issue.evidenceRefs),
    updatedAt: issue.updatedAt || ""
  };
}

export function compactDecision(decision = {}) {
  return {
    decisionId: decision.decisionId,
    runId: decision.runId,
    status: decision.status,
    title: decision.title,
    payloadKeys: Object.keys(asObject(decision.payload)),
    updatedAt: decision.updatedAt || ""
  };
}

export function compactPrivateState(privateState = {}) {
  return {
    id: privateState.id,
    runId: privateState.runId,
    agentId: privateState.agentId,
    summary: truncateText(privateState.summary, 800),
    stateKeys: Object.keys(asObject(privateState.state)),
    updatedAt: privateState.updatedAt || ""
  };
}

export function compactSessionEvent(event = {}) {
  return {
    eventId: event.eventId,
    sequence: Number(event.sequence || 0),
    type: event.type,
    title: event.title,
    summary: truncateText(event.summary, 600),
    createdBy: event.createdBy || "",
    createdAt: event.createdAt || ""
  };
}

export function buildWorkspaceHandoffMarkdown(bundle = {}) {
  const context = bundle.context || {};
  const summary = bundle.summary || {};
  const recent = bundle.recent || {};
  const lines = [
    "# Workspace Context Bundle",
    `workspaceId: ${bundle.workspace?.workspaceId || ""}`,
    `generation: ${context.currentGeneration || 0}`,
    `contextFingerprint: ${context.contextFingerprint || ""}`,
    `contextProfileId: ${context.contextProfileId || ""}`,
    `modelAlias: ${context.modelAlias || ""}`,
    `toolGrantId: ${context.toolGrantId || ""}`,
    `gatewaySourceCount: ${asArray(context.gatewaySourceIds).length}`,
    `chain: ${asArray(context.chainGenerations).map((item) => `${item.workspaceId}@${item.generation}`).join(" -> ")}`,
    "",
    "## Summary",
    `runs: ${summary.runCount || 0}`,
    `submissions: ${summary.submissionCount || 0}`,
    `acceptedSubmissions: ${summary.acceptedSubmissionCount || 0}`,
    `openIssues: ${summary.openIssueCount || 0}`,
    `artifacts: ${summary.artifactCount || 0}`,
    "",
    "## Recent Runs",
    ...asArray(recent.runs).map((run) => `- ${run.runId} ${run.runType} ${run.status}`),
    "",
    "## Recent Artifacts",
    ...asArray(recent.artifacts).map((artifact) => `- ${artifact.artifactId} ${artifact.status} ${artifact.title}`),
    "",
    "## Open Issues",
    ...asArray(recent.issues)
      .filter((issue) => issue.status !== "resolved")
      .map((issue) => `- ${issue.issueId} ${issue.severity} ${issue.title}`)
  ];
  return lines.join("\n");
}

export function decodeWorkspaceContextBundle(input = {}) {
  const payload = asObject(input.contextBundle || input.context_bundle || input);
  if (payload.bundle?.bundleVersion === AGENT_WORKSPACE_CONTEXT_BUNDLE_VERSION) {
    return payload.bundle;
  }
  if (payload.bundleVersion === AGENT_WORKSPACE_CONTEXT_BUNDLE_VERSION && payload.context) {
    return payload;
  }
  const compressed = asObject(
    payload.compressed ||
      payload.compressedBundle ||
      payload.bundleCompressed ||
      payload.contextBundleCompressed
  );
  const encoded = String(compressed.payload || payload.payload || "").trim();
  const encoding = String(compressed.encoding || payload.encoding || "").trim().toLowerCase();
  if (!encoded) {
    throw new Error("缺少工作空间上下文压缩包。");
  }
  if (!["gzip+base64", "base64+gzip"].includes(encoding)) {
    throw new Error("工作空间上下文压缩包编码不受支持。");
  }
  const compressedBuffer = Buffer.from(encoded, "base64");
  if (compressedBuffer.length > CONTEXT_BUNDLE_COMPRESSED_MAX_BYTES) {
    throw new Error("工作空间上下文压缩包超过大小上限。");
  }
  let decoded;
  try {
    decoded = gunzipSync(compressedBuffer, {
      maxOutputLength: CONTEXT_BUNDLE_UNCOMPRESSED_MAX_BYTES + 1
    });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error("工作空间上下文压缩包超过大小上限。");
    }
    throw error;
  }
  if (decoded.length > CONTEXT_BUNDLE_UNCOMPRESSED_MAX_BYTES) {
    throw new Error("工作空间上下文压缩包超过大小上限。");
  }
  const jsonText = decoded.toString("utf8");
  return JSON.parse(jsonText);
}
