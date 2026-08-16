const ERROR_SPECS = Object.freeze({
  unauthorized: { type: "authentication", status: 401, retryable: false },
  rate_limited: { type: "admission", status: 429, retryable: true },
  quota_exceeded: { type: "quota", status: 429, retryable: false },
  budget_exceeded: { type: "quota", status: 429, retryable: false },
  invalid_request: { type: "internal", status: 400, retryable: false },
  model_not_found: { type: "model", status: 404, retryable: false },
  provider_unavailable: { type: "provider", status: 503, retryable: true },
  cancelled: { type: "cancelled", status: 499, retryable: false },
  settlement_uncertain: { type: "overload", status: 409, retryable: true },
  internal_error: { type: "internal", status: 500, retryable: false }
});

export function stableError(code, message, requestId) {
  const spec = ERROR_SPECS[code];
  if (!spec) {
    throw new TypeError(`Unknown stable error code: ${code}`);
  }
  return {
    status: spec.status,
    error: {
      type: spec.type,
      code,
      message: String(message || code),
      requestId: String(requestId || ""),
      retryable: spec.retryable
    }
  };
}

export function openAiError(payload) {
  return {
    error: {
      message: payload.error.message,
      type: payload.error.code,
      param: null,
      code: payload.error.code
    }
  };
}

export function anthropicError(payload) {
  return {
    type: "error",
    error: {
      type: payload.error.type,
      message: payload.error.message
    },
    request_id: payload.error.requestId
  };
}
