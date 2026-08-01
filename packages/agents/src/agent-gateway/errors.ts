const ERROR_DEFINITIONS: Readonly<Record<string, any>> = Object.freeze({
  agent_gateway_invalid_input: {
    statusCode: 400,
    retryable: false,
    stage: "validation",
    message: "Agent gateway input is invalid."
  },
  agent_gateway_not_configured: {
    statusCode: 409,
    retryable: false,
    stage: "configuration",
    message: "The requested model route is not configured."
  },
  agent_gateway_credential_missing: {
    statusCode: 409,
    retryable: false,
    stage: "credential",
    message: "The requested model credential is not configured."
  },
  agent_gateway_credential_invalid: {
    statusCode: 502,
    retryable: false,
    stage: "credential",
    message: "The upstream model rejected its configured credential."
  },
  agent_gateway_egress_denied: {
    statusCode: 403,
    retryable: false,
    stage: "egress",
    message: "The configured model endpoint is not allowed."
  },
  agent_gateway_upstream_rejected: {
    statusCode: 502,
    retryable: false,
    stage: "upstream",
    message: "The upstream model rejected the request."
  },
  agent_gateway_upstream_timeout: {
    statusCode: 504,
    retryable: true,
    stage: "transport",
    message: "The upstream model timed out."
  },
  agent_gateway_upstream_unavailable: {
    statusCode: 503,
    retryable: true,
    stage: "transport",
    message: "The upstream model is temporarily unavailable."
  },
  agent_gateway_candidates_exhausted: {
    statusCode: 503,
    retryable: true,
    stage: "routing",
    message: "No configured model candidate is currently available."
  }
});

export class AgentGatewayError extends Error {
  cause: any;
  code: any;
  name: any;
  retryable: any;
  stage: any;
  statusCode: any;
  constructor(code?: any, overrides: Record<string, any> = {}) {
    const definition: any = ERROR_DEFINITIONS[code] ||
      ERROR_DEFINITIONS.agent_gateway_upstream_unavailable;
    super(String(overrides.message || definition.message));
    this.name = "AgentGatewayError";
    this.code = ERROR_DEFINITIONS[code]
      ? code
      : "agent_gateway_upstream_unavailable";
    this.statusCode = Number(overrides.statusCode || definition.statusCode);
    this.retryable = overrides.retryable === undefined
      ? definition.retryable
      : overrides.retryable === true;
    this.stage = String(overrides.stage || definition.stage);
    if (overrides.cause) {
      this.cause = overrides.cause;
    }
  }
}

export function agentGatewayError(code?: any, overrides: Record<string, any> = {}) : any {
  return new AgentGatewayError(code, overrides);
}

export function agentGatewayHttpError(status?: any) : any {
  const statusCode: any = Number(status || 0);
  if ([401, 403].includes(statusCode)) {
    return agentGatewayError("agent_gateway_credential_invalid");
  }
  if ([408, 504].includes(statusCode)) {
    return agentGatewayError("agent_gateway_upstream_timeout");
  }
  if (statusCode === 429 || statusCode >= 500) {
    return agentGatewayError("agent_gateway_upstream_unavailable");
  }
  return agentGatewayError("agent_gateway_upstream_rejected");
}

export function normalizeAgentGatewayError(error?: any) : any {
  if (error instanceof AgentGatewayError) {
    return error;
  }
  if (error && typeof error === "object" && ERROR_DEFINITIONS[error.code]) {
    return agentGatewayError(error.code, {
      cause: error,
      message: error.message,
      retryable: error.retryable,
      stage: error.stage,
      statusCode: error.statusCode
    });
  }
  if (error?.code === "model_assisted_egress_denied" ||
      /egress|dns|loopback|private address|endpoint policy/i.test(String(error?.message || ""))) {
    return agentGatewayError("agent_gateway_egress_denied", { cause: error });
  }
  if (
    error?.name === "AbortError" ||
    error?.code === "ABORT_ERR" ||
    error?.cause?.name === "AbortError" ||
    error?.cause?.code === "ABORT_ERR"
  ) {
    return agentGatewayError("agent_gateway_upstream_timeout", { cause: error });
  }
  return agentGatewayError("agent_gateway_upstream_unavailable", { cause: error });
}

export function isTransientAgentGatewayError(error?: any) : any {
  return normalizeAgentGatewayError(error).retryable === true;
}

export function publicAgentGatewayError(error?: any) : any {
  const normalized: any = normalizeAgentGatewayError(error);
  return Object.freeze({
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    stage: normalized.stage
  });
}
