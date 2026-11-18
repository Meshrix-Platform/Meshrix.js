/**
 * OTel Semantic Convention Fields — Meshrix.js Baseline
 *
 * SINGLE SOURCE OF TRUTH for OpenTelemetry-aligned field names used across
 * Meshrix.js observability touchpoints.  All loggers, tracers, audit reports,
 * and metrics SHOULD reference these exported constants rather than
 * hard-coding string literals.
 *
 * Fields follow the OpenTelemetry semantic conventions where applicable
 * and extend them with "meshrix.*" namespaced attributes for Meshrix.js-specific
 * concepts not covered by the standard.
 *
 * USAGE:
 *   import { OTEL_SEMANTIC_FIELDS } from "../core/devops/observability/otel-semantic-fields.ts";
 *
 *   runtimeLogger.info("operation.proof.lifecycle", {
 *     [OTEL_SEMANTIC_FIELDS.serviceName]: "meshrix-server",
 *     [OTEL_SEMANTIC_FIELDS.meshrixOperationId]: operation.id,
 *   });
 *
 * REGISTRATION FLOW:
 *   Add new fields here → run verify-observability-semantics to confirm coverage
 */

export const OTEL_SEMANTIC_FIELDS: Readonly<Record<string, any>> = Object.freeze({
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

  // ── Meshrix.js extensions ─────────────────────────────────────────────────
  meshrixOperationId: "meshrix.operation.id",
  meshrixWorkspaceId: "meshrix.workspace.id",
  meshrixCapabilityId: "meshrix.capability.id",
  meshrixReceiptId: "meshrix.receipt.id",
  meshrixCommandName: "meshrix.command.name",
  meshrixAuditReportId: "meshrix.audit.report_id",
});
