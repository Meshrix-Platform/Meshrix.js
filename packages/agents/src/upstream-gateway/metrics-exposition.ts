/**
 * Prometheus text exposition (format `text/plain; version=0.0.4`) for the
 * upstream-gateway metric snapshot returned by `registry.getMetrics()`.
 *
 * This is the framework's OpenTelemetry-compatible export surface: any OTel
 * Collector's `prometheus` receiver can scrape the rendered body directly, so
 * operators get a vendor-neutral pull endpoint without a bundled push client
 * or protobuf dependency in the framework.
 *
 * Naming follows the `meshrix_upstream_*` snake_case convention already used
 * by the private-relay `meshrix_relay_*` counters. Label values carry bounded
 * vocabularies only — service ids, numeric status codes and fixed gauges —
 * never payloads, inputs, credential material or caller identity, matching
 * the dimension limits `recordMetric` already enforces upstream.
 */

import type { UpstreamGatewayMetrics } from "./registry-types.ts";

function escapeLabelValue(value: string) : string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n");
}

function finiteCount(value: unknown) : number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Render a metrics snapshot as Prometheus 0.0.4 text. Emitted series:
 * - `meshrix_upstream_forward_total` (counter): global total plus one
 *   `{service=...}` sample per bounded service bucket.
 * - `meshrix_upstream_forward_failures_total` (counter): global failures.
 * - `meshrix_upstream_forward_status_total{status=...}` (counter): forwards
 *   grouped by upstream status code or `"failed"`/`"unknown"`.
 * - `meshrix_upstream_metric_dimensions_shed_total` (counter): bucket
 *   dimensions dropped by the cardinality limit — operators watch this to
 *   know when the vocabulary bound is actively shedding.
 * - `meshrix_upstream_runtime_{traffic_buckets,endpoint_cursors,
 *   endpoint_circuits,mcp_tool_cache_entries}` (gauge): bounded in-memory
 *   state sizes.
 */
export function renderUpstreamGatewayMetricsExposition(metrics: UpstreamGatewayMetrics) : string {
  const lines: string[] = [];

  lines.push("# HELP meshrix_upstream_forward_total Forwarded upstream operations.");
  lines.push("# TYPE meshrix_upstream_forward_total counter");
  lines.push(`meshrix_upstream_forward_total ${finiteCount(metrics.totalForwardCount)}`);
  for (const [serviceId, count] of Object.entries(metrics.byService || {})) {
    lines.push(`meshrix_upstream_forward_total{service="${escapeLabelValue(serviceId)}"} ${finiteCount(count)}`);
  }

  lines.push("# HELP meshrix_upstream_forward_failures_total Failed upstream operations.");
  lines.push("# TYPE meshrix_upstream_forward_failures_total counter");
  lines.push(`meshrix_upstream_forward_failures_total ${finiteCount(metrics.totalFailureCount)}`);

  lines.push("# HELP meshrix_upstream_forward_status_total Forwards grouped by upstream status.");
  lines.push("# TYPE meshrix_upstream_forward_status_total counter");
  for (const [status, count] of Object.entries(metrics.byStatus || {})) {
    lines.push(`meshrix_upstream_forward_status_total{status="${escapeLabelValue(status)}"} ${finiteCount(count)}`);
  }

  lines.push("# HELP meshrix_upstream_metric_dimensions_shed_total Metric bucket dimensions dropped by cardinality bounds.");
  lines.push("# TYPE meshrix_upstream_metric_dimensions_shed_total counter");
  lines.push(`meshrix_upstream_metric_dimensions_shed_total ${finiteCount(metrics.shedMetricDimensions)}`);

  const state = metrics.boundedRuntimeState || ({} as Record<string, unknown>);
  const gauges: ReadonlyArray<readonly [string, string, unknown]> = [
    ["meshrix_upstream_runtime_traffic_buckets", "Active endpoint traffic buckets.", state.trafficBucketCount],
    ["meshrix_upstream_runtime_endpoint_cursors", "Tracked endpoint cursors.", state.endpointCursorCount],
    ["meshrix_upstream_runtime_endpoint_circuits", "Tracked endpoint circuits.", state.endpointCircuitCount],
    ["meshrix_upstream_runtime_mcp_tool_cache_entries", "Cached MCP tool projections.", state.mcpToolCacheCount]
  ];
  for (const [name, help, value] of gauges) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${finiteCount(value)}`);
  }

  return `${lines.join("\n")}\n`;
}
