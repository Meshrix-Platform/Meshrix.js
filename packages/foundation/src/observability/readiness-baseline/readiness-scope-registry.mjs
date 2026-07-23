export const READINESS_SCOPES = Object.freeze({
  baseline: [
    {
      scopeId: "docs-config-consistency",
      label: "Documentation and Configuration Consistency",
      description:
        "README, Docker Compose, SERVER.md, Node version consistency verified.",
      baselineV0_1Required: true,
      productionRequired: true,
      requiredEvidence: [
        "server:verify:docs-governance",
        "server:verify:language-policy"
      ]
    },
    {
      scopeId: "state-machine-core",
      label: "State Machine Core Engine",
      description:
        "Pure transition engine, validateStateMachineDefinition, transitionState, error codes, redaction helper.",
      baselineV0_1Required: true,
      productionRequired: true,
      requiredEvidence: [
        "state-machine-core.test",
        "state-machine-verifier"
      ]
    },
    {
      scopeId: "state-machine-schema",
      label: "Machine-Readable State Machine Schema",
      description:
        "JSON schema for machine definitions, definition-schema.mjs validator.",
      baselineV0_1Required: true,
      productionRequired: true,
      requiredEvidence: [
        "state-machine-definition-schema.test",
        "C1-schema-validation"
      ]
    },
    {
      scopeId: "state-machine-verifier",
      label: "State Machine Definition Verifier",
      description:
        "Static C1/C2/C3 completeness verification: matrix totality, reachability, terminal, guards, secrets, invariants.",
      baselineV0_1Required: true,
      productionRequired: true,
      requiredEvidence: [
        "server:verify:state-machines",
        "verifier unit tests"
      ]
    },
    {
      scopeId: "operation.narrow",
      label: "Operation Narrow Path State Machine",
      description:
        "received -> normalized -> policy_checked -> proof_started -> executing -> checkpoint/audit_recorded -> completed.",
      baselineV0_1Required: true,
      productionRequired: true,
      requiredEvidence: [
        "operation.narrow.json",
        "operation-state-machine-integration.test"
      ]
    },
    {
      scopeId: "production-readiness-baseline",
      label: "Production Readiness Baseline",
      description:
        "Baseline v0.1 readiness report with scope registry and guard evaluator.",
      baselineV0_1Required: true,
      productionRequired: true,
      requiredEvidence: [
        "production.readiness.lifecycle.json",
        "production-readiness-lifecycle-state-machine.test",
        "readiness-scope-registry",
        "guard-evaluator"
      ]
    },
    {
      scopeId: "proof-artifacts",
      label: "Proof Artifacts and Evidence Ledger",
      description:
        "Machine-readable verification reports, traceability matrix, proof summaries.",
      baselineV0_1Required: true,
      productionRequired: true,
      requiredEvidence: [
        "build/reports/state-machines/latest.json",
        "docs/STATE-MACHINE-TRACEABILITY.md"
      ]
    }
  ],

  productionOnly: [
    {
      scopeId: "backup-restore",
      label: "Backup / Restore",
      description:
        "Production backup/restore with manifest integrity, preview-before-apply, append-only proof.",
      baselineV0_1Required: false,
      productionRequired: true,
      backlogRef: "P0-08",
      statusWhenOutOfBaseline: "not_in_baseline_v0_1"
    },
    {
      scopeId: "durable-workflow",
      label: "Durable Workflow Execution",
      description:
        "Long-running workflow state machines with retry, signal, timer, compensation.",
      baselineV0_1Required: false,
      productionRequired: true,
      backlogRef: "P0-03",
      statusWhenOutOfBaseline: "not_in_baseline_v0_1"
    },
    {
      scopeId: "upgrade-migration",
      label: "Upgrade / Migration",
      description:
        "Schema migration, feature profile builds, connector migration gates.",
      baselineV0_1Required: false,
      productionRequired: true,
      backlogRef: "P0-08",
      statusWhenOutOfBaseline: "not_in_baseline_v0_1"
    },
    {
      scopeId: "tool-permission",
      label: "Tool Permission and Security Policy",
      description:
        "2-3-5 security model, tool grant, risk policy, CSRF hardening, authorization governance.",
      baselineV0_1Required: false,
      productionRequired: true,
      backlogRef: "P0-07",
      statusWhenOutOfBaseline: "not_in_baseline_v0_1"
    },
    {
      scopeId: "session-thread",
      label: "Session Thread and Context",
      description:
        "Session fork/compare/merge proposal, context bundles, agent sync.",
      baselineV0_1Required: false,
      productionRequired: true,
      backlogRef: "P1-01",
      statusWhenOutOfBaseline: "not_in_baseline_v0_1"
    },
    {
      scopeId: "upload-session",
      label: "Upload Session Lifecycle",
      description: "LSM-style ingest, chunking, CAS for upload sessions.",
      baselineV0_1Required: false,
      productionRequired: true,
      backlogRef: "P0-03",
      statusWhenOutOfBaseline: "not_in_baseline_v0_1"
    },
    {
      scopeId: "mcp-grant-connector",
      label: "MCP Grant and Connector Lifecycle",
      description:
        "MCP grant handshake, token rotate/revoke, connector versions.",
      baselineV0_1Required: false,
      productionRequired: true,
      backlogRef: "P0-07",
      statusWhenOutOfBaseline: "not_in_baseline_v0_1"
    },
    {
      scopeId: "tool-policy-lifecycle",
      label: "Tool Policy Lifecycle",
      description: "Tool registration, grant policy, approval preview, audit, and rollback.",
      baselineV0_1Required: false,
      productionRequired: true,
      backlogRef: "P1-04",
      statusWhenOutOfBaseline: "not_in_baseline_v0_1"
    },
    {
      scopeId: "context-bundle",
      label: "Context Bundle Compilation",
      description:
        "Authorized context compilation, compression, egress policy enforcement.",
      baselineV0_1Required: false,
      productionRequired: true,
      backlogRef: "P1-01",
      statusWhenOutOfBaseline: "not_in_baseline_v0_1"
    },
    {
      scopeId: "security-session-secret",
      label: "Security Session / Secret Binding",
      description:
        "Secret lifecycle, session token binding, credential rotation.",
      baselineV0_1Required: false,
      productionRequired: true,
      backlogRef: "P0-07",
      statusWhenOutOfBaseline: "not_in_baseline_v0_1"
    },
    {
      scopeId: "audit-retention",
      label: "Audit Export / Retention",
      description:
        "Audit export with redaction, retention policies, compliance reporting.",
      baselineV0_1Required: false,
      productionRequired: true,
      backlogRef: "P0-07",
      statusWhenOutOfBaseline: "not_in_baseline_v0_1"
    },
    {
      scopeId: "workspace-asset.lifecycle",
      label: "Workspace Asset Lifecycle",
      description:
        "Full workspace asset lifecycle from raw to derived to contributed.",
      baselineV0_1Required: false,
      productionRequired: true,
      backlogRef: "P0-00-02",
      statusWhenOutOfBaseline: "not_in_baseline_v0_1"
    },
  ],

  allScopes() {
    return [...READINESS_SCOPES.baseline, ...READINESS_SCOPES.productionOnly];
  },

  baselineScopes() {
    return READINESS_SCOPES.baseline;
  },

  getScope(scopeId) {
    return READINESS_SCOPES.allScopes().find((s) => s.scopeId === scopeId) || null;
  }
});
