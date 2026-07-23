/**
 * OTel Semantic Convention Fields — LicoMesh Baseline
 *
 * SINGLE SOURCE OF TRUTH for OpenTelemetry-aligned field names used across
 * LicoMesh observability touchpoints.  All loggers, tracers, audit reports,
 * and metrics SHOULD reference these exported constants rather than
 * hard-coding string literals.
 *
 * Fields follow the OpenTelemetry semantic conventions where applicable
 * and extend them with "lico.*" namespaced attributes for LicoMesh-specific
 * concepts not covered by the standard.
 *
 * USAGE:
 *   import { OTEL_SEMANTIC_FIELDS } from "../core/devops/observability/otel-semantic-fields.mjs";
 *
 *   runtimeLogger.info("operation.proof.lifecycle", {
 *     [OTEL_SEMANTIC_FIELDS.serviceName]: "licomesh-server",
 *     [OTEL_SEMANTIC_FIELDS.licoOperationId]: operation.id,
 *   });
 *
 * REGISTRATION FLOW:
 *   Add new fields here → run verify-observability-semantics to confirm coverage
 */

export const OTEL_SEMANTIC_FIELDS = Object.freeze({
  // ── Service ─────────────────────────────────────────────────────────────
  serviceName: "service.name",
  serviceVersion: "service.version",

  // ── Process ─────────────────────────────────────────────────────────────
  processPid: "process.pid",
  processCommand: "process.command",

  // ── CI ──────────────────────────────────────────────────────────────────
  ciWorkflowName: "ci.workflow.name",
  ciJobName: "ci.job.name",

  // ── VCS ─────────────────────────────────────────────────────────────────
  vcsRepositoryUrl: "vcs.repository.url",
  vcsRefHeadName: "vcs.ref.head.name",
  vcsRefHeadRevision: "vcs.ref.head.revision",

  // ── MCP ─────────────────────────────────────────────────────────────────
  mcpMethodName: "mcp.method.name",

  // ── Gen AI ──────────────────────────────────────────────────────────────
  genAiOperationName: "gen_ai.operation.name",

  // ── LicoMesh extensions ─────────────────────────────────────────────────
  licoOperationId: "lico.operation.id",
  licoWorkspaceId: "lico.workspace.id",
  licoCapabilityId: "lico.capability.id",
  licoReceiptId: "lico.receipt.id",
  licoCommandName: "lico.command.name",
  licoAuditReportId: "lico.audit.report_id",
});
