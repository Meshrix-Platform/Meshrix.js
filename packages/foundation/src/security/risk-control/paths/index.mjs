export const RISK_CONTROL_PATHS = Object.freeze([
  {
    pathId: "client-mcp-ingress-request",
    label: "Client MCP ingress request",
    controls: Object.freeze([
      "client.registration.admit",
      "client.agent-identity.bind",
      "client.mcp-grant.authorize",
      "client.operation-permission.authorize",
      "client.high-risk-confirmation.approve",
      "client.path-safety.execute",
      "client.access-receipt.audit"
    ])
  },
  {
    pathId: "tool-grant-request",
    label: "Tool grant request",
    controls: Object.freeze([
      "client.mcp-grant.authorize",
      "client.opaque-key.bind",
      "platform.capability-verify.authorize",
      "platform.binding-verify.authorize",
      "platform.operation-permission.authorize",
      "platform.operation-proof.audit"
    ])
  },
  {
    pathId: "local-workspace-file-access",
    label: "Local workspace file access",
    controls: Object.freeze([
      "client.registration.admit",
      "client.agent-identity.bind",
      "client.workspace-scope.authorize",
      "client.data-class.authorize",
      "client.high-risk-confirmation.approve",
      "client.path-safety.execute",
      "client.file-validation.execute",
      "client.access-receipt.audit",
      "platform.audit.audit"
    ])
  },
  {
    pathId: "server-api-egress-request",
    label: "Server API egress request",
    controls: Object.freeze([
      "server.upstream-service.admit",
      "server.provider-credential.bind",
      "server.egress-policy.authorize",
      "server.capability-route.authorize",
      "server.rate-limit.execute",
      "server.timeout-retry.execute",
      "server.response-normalization.execute",
      "server.provider-state-semantics.execute",
      "server.provider-receipt.audit",
      "server.egress-audit.audit",
      "server.redacted-provider-log.audit"
    ])
  },
  {
    pathId: "platform-self-governance-request",
    label: "Platform self-governance request",
    controls: Object.freeze([
      "platform.console-auth.admit",
      "platform.binding-guard.bind",
      "platform.capability-kernel.authorize",
      "platform.risk-policy.approve",
      "platform.operation-proof.execute",
      "platform.audit.audit"
    ])
  }
]);
