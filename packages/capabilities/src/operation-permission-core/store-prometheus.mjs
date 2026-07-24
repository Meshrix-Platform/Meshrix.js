import { prometheusSample } from "./store-metrics-utils.mjs";

export function createMetricsPrometheus({ metricsHealth }) {
  function metricsPrometheus(options = {}) {
  const health = metricsHealth(options);
  const lines = [
    "# HELP meshrix_operation_permission_window_seconds Metrics aggregation window in seconds.",
    "# TYPE meshrix_operation_permission_window_seconds gauge",
    prometheusSample("meshrix_operation_permission_window_seconds", health.window.windowSeconds),
    "# HELP meshrix_operation_permission_health_status Health status as one-hot gauges by status label.",
    "# TYPE meshrix_operation_permission_health_status gauge",
    ...["ok", "warn", "critical"].map((status) =>
      prometheusSample("meshrix_operation_permission_health_status", health.status === status ? 1 : 0, { status })
    ),
    "# HELP meshrix_operation_permission_health_breaches_total Number of active health threshold breaches.",
    "# TYPE meshrix_operation_permission_health_breaches_total gauge",
    prometheusSample("meshrix_operation_permission_health_breaches_total", health.breaches.length),
    "# HELP meshrix_operation_permission_requests_total HTTP request metric events in the window.",
    "# TYPE meshrix_operation_permission_requests_total gauge",
    prometheusSample("meshrix_operation_permission_requests_total", health.requests.total),
    prometheusSample("meshrix_operation_permission_requests_success_total", health.requests.successTotal),
    prometheusSample("meshrix_operation_permission_requests_client_error_total", health.requests.clientErrorTotal),
    prometheusSample("meshrix_operation_permission_requests_server_error_total", health.requests.serverErrorTotal),
    prometheusSample(
      "meshrix_operation_permission_requests_completion_failure_total",
      health.requests.completionFailureTotal
    ),
    "# HELP meshrix_operation_permission_requests_per_minute HTTP request rate in the window.",
    "# TYPE meshrix_operation_permission_requests_per_minute gauge",
    prometheusSample("meshrix_operation_permission_requests_per_minute", health.requests.requestsPerMinute),
    "# HELP meshrix_operation_permission_request_error_rate HTTP request error ratios in the window.",
    "# TYPE meshrix_operation_permission_request_error_rate gauge",
    prometheusSample("meshrix_operation_permission_request_error_rate", health.requests.serverErrorRate, {
      kind: "server"
    }),
    prometheusSample("meshrix_operation_permission_request_error_rate", health.requests.clientErrorRate, {
      kind: "client"
    }),
    prometheusSample("meshrix_operation_permission_request_error_rate", health.requests.completionFailureRate, {
      kind: "completion"
    }),
    "# HELP meshrix_operation_permission_request_transfer_bytes_total HTTP request and response transfer bytes.",
    "# TYPE meshrix_operation_permission_request_transfer_bytes_total gauge",
    prometheusSample(
      "meshrix_operation_permission_request_transfer_bytes_total",
      health.requests.transferBytesTotal
    ),
    "# HELP meshrix_operation_permission_request_transfer_bytes_per_second HTTP transfer byte rate.",
    "# TYPE meshrix_operation_permission_request_transfer_bytes_per_second gauge",
    prometheusSample(
      "meshrix_operation_permission_request_transfer_bytes_per_second",
      health.requests.transferBytesPerSecond
    ),
    "# HELP meshrix_operation_permission_request_duration_ms HTTP request duration quantiles in milliseconds.",
    "# TYPE meshrix_operation_permission_request_duration_ms gauge",
    prometheusSample("meshrix_operation_permission_request_duration_ms", health.requests.durationPercentiles.p50Ms, {
      quantile: "0.5"
    }),
    prometheusSample("meshrix_operation_permission_request_duration_ms", health.requests.durationPercentiles.p95Ms, {
      quantile: "0.95"
    }),
    prometheusSample("meshrix_operation_permission_request_duration_ms", health.requests.durationPercentiles.p99Ms, {
      quantile: "0.99"
    }),
    "# HELP meshrix_operation_permission_tool_calls_total Tool call metric events in the window.",
    "# TYPE meshrix_operation_permission_tool_calls_total gauge",
    prometheusSample("meshrix_operation_permission_tool_calls_total", health.toolCalls.total),
    prometheusSample("meshrix_operation_permission_tool_calls_ok_total", health.toolCalls.okTotal),
    prometheusSample("meshrix_operation_permission_tool_calls_denied_total", health.toolCalls.deniedTotal),
    prometheusSample("meshrix_operation_permission_tool_calls_failure_total", health.toolCalls.failureTotal),
    prometheusSample("meshrix_operation_permission_tool_calls_timeout_total", health.toolCalls.timeoutTotal),
    prometheusSample(
      "meshrix_operation_permission_tool_calls_rate_limited_total",
      health.toolCalls.rateLimitedTotal
    ),
    "# HELP meshrix_operation_permission_tool_calls_per_minute Tool call rate in the window.",
    "# TYPE meshrix_operation_permission_tool_calls_per_minute gauge",
    prometheusSample("meshrix_operation_permission_tool_calls_per_minute", health.toolCalls.callsPerMinute),
    "# HELP meshrix_operation_permission_tool_call_rate Tool call failure and denial ratios.",
    "# TYPE meshrix_operation_permission_tool_call_rate gauge",
    prometheusSample("meshrix_operation_permission_tool_call_rate", health.toolCalls.failureRate, {
      kind: "failure"
    }),
    prometheusSample("meshrix_operation_permission_tool_call_rate", health.toolCalls.deniedRate, {
      kind: "denied"
    }),
    "# HELP meshrix_operation_permission_tool_transfer_bytes_total Tool input and result transfer bytes.",
    "# TYPE meshrix_operation_permission_tool_transfer_bytes_total gauge",
    prometheusSample("meshrix_operation_permission_tool_transfer_bytes_total", health.toolCalls.transferBytesTotal),
    "# HELP meshrix_operation_permission_tool_transfer_bytes_per_second Tool transfer byte rate.",
    "# TYPE meshrix_operation_permission_tool_transfer_bytes_per_second gauge",
    prometheusSample(
      "meshrix_operation_permission_tool_transfer_bytes_per_second",
      health.toolCalls.transferBytesPerSecond
    ),
    "# HELP meshrix_operation_permission_tool_call_duration_ms Tool call duration quantiles in milliseconds.",
    "# TYPE meshrix_operation_permission_tool_call_duration_ms gauge",
    prometheusSample("meshrix_operation_permission_tool_call_duration_ms", health.toolCalls.durationPercentiles.p50Ms, {
      quantile: "0.5"
    }),
    prometheusSample("meshrix_operation_permission_tool_call_duration_ms", health.toolCalls.durationPercentiles.p95Ms, {
      quantile: "0.95"
    }),
    prometheusSample("meshrix_operation_permission_tool_call_duration_ms", health.toolCalls.durationPercentiles.p99Ms, {
      quantile: "0.99"
    }),
    "# HELP meshrix_operation_permission_top_tool_calls_total Top tool calls by tool id.",
    "# TYPE meshrix_operation_permission_top_tool_calls_total gauge",
    ...health.toolCalls.topTools.map((item) =>
      prometheusSample("meshrix_operation_permission_top_tool_calls_total", item.total, { tool_id: item.toolId })
    ),
    "# HELP meshrix_operation_permission_top_tool_transfer_bytes_total Top tool transfer bytes by tool id.",
    "# TYPE meshrix_operation_permission_top_tool_transfer_bytes_total gauge",
    ...health.toolCalls.topTools.map((item) =>
      prometheusSample("meshrix_operation_permission_top_tool_transfer_bytes_total", item.transferBytesTotal, {
        tool_id: item.toolId
      })
    ),
    "# HELP meshrix_operation_permission_top_tool_transfer_bytes_per_second Top tool transfer byte rate by tool id.",
    "# TYPE meshrix_operation_permission_top_tool_transfer_bytes_per_second gauge",
    ...health.toolCalls.topTools.map((item) =>
      prometheusSample("meshrix_operation_permission_top_tool_transfer_bytes_per_second", item.transferBytesPerSecond, {
        tool_id: item.toolId
      })
    ),
    "# HELP meshrix_operation_permission_top_tool_duration_ms Top tool p95 duration in milliseconds by tool id.",
    "# TYPE meshrix_operation_permission_top_tool_duration_ms gauge",
    ...health.toolCalls.topTools.map((item) =>
      prometheusSample("meshrix_operation_permission_top_tool_duration_ms", item.durationPercentiles.p95Ms, {
        tool_id: item.toolId,
        quantile: "0.95"
      })
    ),
    "# HELP meshrix_operation_permission_top_route_requests_total Top request counts by route.",
    "# TYPE meshrix_operation_permission_top_route_requests_total gauge",
    ...health.requests.topRoutes.map((item) =>
      prometheusSample("meshrix_operation_permission_top_route_requests_total", item.total, {
        transport: item.transport,
        method: item.method,
        route: item.route
      })
    ),
    "# HELP meshrix_operation_permission_top_route_transfer_bytes_total Top route transfer bytes.",
    "# TYPE meshrix_operation_permission_top_route_transfer_bytes_total gauge",
    ...health.requests.topRoutes.map((item) =>
      prometheusSample("meshrix_operation_permission_top_route_transfer_bytes_total", item.transferBytesTotal, {
        transport: item.transport,
        method: item.method,
        route: item.route
      })
    ),
    "# HELP meshrix_operation_permission_top_route_transfer_bytes_per_second Top route transfer byte rate.",
    "# TYPE meshrix_operation_permission_top_route_transfer_bytes_per_second gauge",
    ...health.requests.topRoutes.map((item) =>
      prometheusSample("meshrix_operation_permission_top_route_transfer_bytes_per_second", item.transferBytesPerSecond, {
        transport: item.transport,
        method: item.method,
        route: item.route
      })
    ),
    "# HELP meshrix_operation_permission_top_route_duration_ms Top route p95 duration in milliseconds.",
    "# TYPE meshrix_operation_permission_top_route_duration_ms gauge",
    ...health.requests.topRoutes.map((item) =>
      prometheusSample("meshrix_operation_permission_top_route_duration_ms", item.durationPercentiles.p95Ms, {
        transport: item.transport,
        method: item.method,
        route: item.route,
        quantile: "0.95"
      })
    )
  ];
  return `${lines.join("\n")}\n`;
  }
  return metricsPrometheus;
}
