/**
 * Canonical explicit package-script catalog and classification metadata.
 * Consumer helpers and pattern projection remain in package-script-registry.ts.
 */

export const SCRIPT_CATEGORIES: Readonly<Record<string, any>> = Object.freeze({
  verifier: "Verification scripts (server:verify:* and repository gates)",
  startup: "Startup and runtime development scripts",
  packaging: "Packaging / build / composition scripts",
  "mcp-installer": "MCP gateway installer / discovery / doctor scripts",
  "network-service": "Network service integration",
  maintenance: "Maintenance / devops scripts (doctor, locate, reconcile, rebuild)",
  "version-control": "Version maintenance, naming, registry verification",
  test: "Test runner and test profiles (test:*, server:test:*)",
  hygiene: "Repository hygiene and audit scripts",
});

/**
 * @typedef {"hygiene"|"unit"|"integration"|"external"|"release"} ScriptTier
 * @typedef {"none"|"build-output"|"runtime-data"|"network"|"docker"|"network-service"|"source-write"|"destructive"} ScriptSideEffect
 *
 * @typedef {Object} ScriptEntry
 * @property {string} scriptName - package.json script name
 * @property {string} command - The npm command (always "npm run")
 * @property {string} category - From SCRIPT_CATEGORIES
 * @property {string} subsystem - Architectural subsystem
 * @property {string} owner - Team/role responsible
 * @property {ScriptTier} tier - Test/governance tier
 * @property {ScriptSideEffect} sideEffects - What the script produces
 * @property {boolean} requiresFreshContainer - Needs a clean runtime env
 * @property {string} ciProfile - Which CI profile(s) this belongs to
 * @property {string} expectedDurationClass - fast|standard|long|extended
 * @property {string[]} inputs - Expected input files/patterns
 * @property {string[]} outputs - Expected output files/patterns
 */

/** @type {Readonly<Record<string, ScriptEntry>>} */
const RAW_SCRIPT_REGISTRY: Readonly<Record<string, any>> = Object.freeze({
  // ── Startup / runtime ──────────────────────────────────────────────────────
  "server:start": {
    scriptName: "server:start", command: "npm run server:start", category: "startup", subsystem: "server",
    owner: "platform", tier: "integration", sideEffects: "runtime-data",
    requiresFreshContainer: false, ciProfile: "none", expectedDurationClass: "extended",
    inputs: [], outputs: [],
  },
  "server:restart": {
    scriptName: "server:restart", command: "npm run server:restart", category: "startup", subsystem: "server",
    owner: "platform", tier: "integration", sideEffects: "runtime-data",
    requiresFreshContainer: false, ciProfile: "none", expectedDurationClass: "extended",
    inputs: ["tools/scripts/restart-dev.ts", "tools/scripts/start-all.ts", "tools/scripts/clean-existing-service.ts"], outputs: [],
  },
  "start:compose": {
    scriptName: "start:compose", command: "npm run start:compose", category: "startup", subsystem: "server",
    owner: "platform", tier: "integration", sideEffects: "docker",
    requiresFreshContainer: false, ciProfile: "none", expectedDurationClass: "extended",
    inputs: ["tools/server-scripts/instance-lifecycle.ts", "docker-compose.yml"], outputs: [],
  },
  "stop:compose": {
    scriptName: "stop:compose", command: "npm run stop:compose", category: "startup", subsystem: "server",
    owner: "platform", tier: "integration", sideEffects: "docker",
    requiresFreshContainer: false, ciProfile: "none", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/instance-lifecycle.ts", "docker-compose.yml"], outputs: [],
  },
  "start:compose:ui": {
    scriptName: "start:compose:ui", command: "npm run start:compose:ui", category: "startup", subsystem: "server",
    owner: "platform", tier: "integration", sideEffects: "docker",
    requiresFreshContainer: false, ciProfile: "none", expectedDurationClass: "extended",
    inputs: ["tools/server-scripts/instance-lifecycle.ts", "docker-compose.yml"], outputs: [],
  },
  "stop:compose:ui": {
    scriptName: "stop:compose:ui", command: "npm run stop:compose:ui", category: "startup", subsystem: "server",
    owner: "platform", tier: "integration", sideEffects: "docker",
    requiresFreshContainer: false, ciProfile: "none", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/instance-lifecycle.ts", "docker-compose.yml"], outputs: [],
  },
  "start:offline": {
    scriptName: "start:offline", command: "npm run start:offline", category: "startup", subsystem: "server",
    owner: "platform", tier: "integration", sideEffects: "docker",
    requiresFreshContainer: false, ciProfile: "none", expectedDurationClass: "extended",
    inputs: ["tools/server-scripts/instance-lifecycle.ts", "tools/server-scripts/offline-delivery-local-up.ts"], outputs: [],
  },
  "stop:offline": {
    scriptName: "stop:offline", command: "npm run stop:offline", category: "startup", subsystem: "server",
    owner: "platform", tier: "integration", sideEffects: "docker",
    requiresFreshContainer: false, ciProfile: "none", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/instance-lifecycle.ts"], outputs: [],
  },
  "restart:compose": {
    scriptName: "restart:compose", command: "npm run restart:compose", category: "startup", subsystem: "server",
    owner: "platform", tier: "integration", sideEffects: "docker",
    requiresFreshContainer: false, ciProfile: "none", expectedDurationClass: "extended",
    inputs: ["tools/server-scripts/instance-lifecycle.ts", "docker-compose.yml"], outputs: [],
  },
  "restart:compose:ui": {
    scriptName: "restart:compose:ui", command: "npm run restart:compose:ui", category: "startup", subsystem: "server",
    owner: "platform", tier: "integration", sideEffects: "docker",
    requiresFreshContainer: false, ciProfile: "none", expectedDurationClass: "extended",
    inputs: ["tools/server-scripts/instance-lifecycle.ts", "docker-compose.yml"], outputs: [],
  },
  "restart:offline": {
    scriptName: "restart:offline", command: "npm run restart:offline", category: "startup", subsystem: "server",
    owner: "platform", tier: "integration", sideEffects: "docker",
    requiresFreshContainer: false, ciProfile: "none", expectedDurationClass: "extended",
    inputs: ["tools/server-scripts/instance-lifecycle.ts"], outputs: [],
  },
  "pack:offline": {
    scriptName: "pack:offline", command: "npm run pack:offline", category: "packaging", subsystem: "server",
    owner: "platform", tier: "release", sideEffects: "docker",
    requiresFreshContainer: false, ciProfile: "none", expectedDurationClass: "extended",
    inputs: [
      "tools/server-scripts/offline-delivery-pack.ts",
      "tools/server-scripts/offline-delivery-producer.ts",
      "tools/server-scripts/offline-delivery-vm-target.ts"
    ], outputs: ["build/offline-delivery-bundle"],
  },

  // ── Build / packaging ──────────────────────────────────────────────────────

  // ── MCP installer ──────────────────────────────────────────────────────────
  "server:stress:mcp-gateway": {
    scriptName: "server:stress:mcp-gateway", command: "npm run server:stress:mcp-gateway", category: "verifier", subsystem: "mcp-gateway",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "performance", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/stress-mcp-gateway.ts", "packages/protocols/mcp/**", "packages/agents/src/upstream-gateway/**"], outputs: ["build/reports/mcp-gateway-load.json"],
  },
  "server:stress:mcp-gateway-observed": {
    scriptName: "server:stress:mcp-gateway-observed", command: "npm run server:stress:mcp-gateway-observed", category: "verifier", subsystem: "mcp-gateway",
    owner: "platform", tier: "integration", sideEffects: "runtime-data",
    requiresFreshContainer: false, ciProfile: "performance", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/observe-mcp-gateway-load.ts", "tools/server-scripts/stress-mcp-gateway.ts", "tools/server-scripts/lib/gateway-performance-observation.ts", "tools/server-scripts/lib/runtime-performance-observation-contract.ts", "tools/server-scripts/lib/runtime-performance-observer-preload.ts"], outputs: ["build/reports/gateway-performance-observation.json"],
  },
  "server:stress:gateway-platform": {
    scriptName: "server:stress:gateway-platform", command: "npm run server:stress:gateway-platform", category: "verifier", subsystem: "gateway-platform",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "performance", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/stress-gateway-platform-profile.ts", "tools/server-scripts/lib/release-evidence-readiness.ts", "tools/server-scripts/lib/release-evidence-freshness.ts", "tools/server-scripts/lib/upstream-fixture-transit-evidence.ts"], outputs: ["build/reports/gateway-platform-profile.json"],
  },
  "server:verify:resource-discipline": {
    scriptName: "server:verify:resource-discipline", command: "npm run server:verify:resource-discipline", category: "verifier", subsystem: "resource-discipline",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "core", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "package-lock.json",
      "docs/RUNBOOK.md",
      "docs/functionality/OPERATIONS-OBSERVABILITY.md",
      "apps/server/runtime/**",
      "packages/**",
      "tests/vitest/server/resource-discipline-policy.test.ts",
      "tests/vitest/server/job-pipeline-upload-session-persistence.test.ts",
      "tests/vitest/server/upload-custody-workspace-materialization.test.ts",
      "tools/server-scripts/verify-resource-discipline.ts",
      "tools/server-scripts/verify-runtime-memory-leaks.ts",
      "tools/server-scripts/lib/resource-discipline-analysis.ts",
      "tools/server-scripts/lib/resource-discipline-policy.ts",
      "tools/server-scripts/lib/runtime-memory-profiler-preload.ts",
      "tools/server-scripts/lib/resource-high-risk-workload-child.ts",
      "tools/registry/tests.registry.json"
    ], outputs: ["build/reports/runtime-resource-discipline.json"],
  },
  "server:verify:memory-leaks": {
    scriptName: "server:verify:memory-leaks", command: "npm run server:verify:memory-leaks", category: "verifier", subsystem: "resource-discipline",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "core", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "package-lock.json",
      "apps/server/runtime/**",
      "packages/**",
      "tools/server-scripts/start-server.ts",
      "tools/server-scripts/verify-runtime-memory-leaks.ts",
      "tools/server-scripts/lib/resource-discipline-analysis.ts",
      "tools/server-scripts/lib/resource-discipline-policy.ts",
      "tools/server-scripts/lib/runtime-memory-profiler-preload.ts",
      "tools/server-scripts/lib/resource-high-risk-workload-child.ts"
    ], outputs: ["build/reports/runtime-resource-discipline.json"],
  },

  // ── Release closure verifiers ─────────────────────────────────────────────
  "verify:acceptance": {
    scriptName: "verify:acceptance", command: "npm run verify:acceptance", category: "verifier", subsystem: "platform-acceptance",
    owner: "platform", tier: "release", sideEffects: "destructive",
    requiresFreshContainer: true, ciProfile: "release", expectedDurationClass: "extended",
    inputs: [
      "tools/server-scripts/verify-platform-acceptance.ts",
      "tools/server-scripts/lib/platform-acceptance-command-catalog.ts",
      "tools/server-scripts/lib/platform-acceptance-contract.ts",
      "tools/server-scripts/lib/platform-acceptance-generation-store.ts",
      "tools/server-scripts/lib/platform-acceptance-plan-receipts.ts",
      "tools/server-scripts/lib/platform-acceptance-reducer.ts",
      "tools/server-scripts/lib/platform-acceptance-requirement-evidence.ts"
    ],
    outputs: [
      "build/acceptance-evidence/**",
      "build/acceptance-proof-ledger/**",
      "build/reports/**"
    ],
  },
  "verify:acceptance:plan": {
    scriptName: "verify:acceptance:plan", command: "npm run verify:acceptance:plan", category: "verifier", subsystem: "platform-acceptance",
    owner: "platform", tier: "release", sideEffects: "none",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "tools/server-scripts/verify-platform-acceptance.ts",
      "tools/server-scripts/lib/platform-acceptance-command-catalog.ts",
      "tools/server-scripts/lib/platform-acceptance-reducer.ts",
      "tools/server-scripts/lib/platform-acceptance-contract.ts",
      "tools/server-scripts/lib/platform-acceptance-report-catalog.ts",
      "tools/server-scripts/lib/private-deployment-internal-platform-e2e-catalog.ts"
    ], outputs: [],
  },
  "verify:acceptance:standards": {
    scriptName: "verify:acceptance:standards", command: "npm run verify:acceptance:standards", category: "verifier", subsystem: "release-acceptance",
    owner: "platform", tier: "release", sideEffects: "none",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "tools/registry/release-acceptance-standards.registry.json",
      "tools/registry/schema/release-acceptance-standards.schema.json",
      "tools/server-scripts/verify-release-acceptance-standards.ts",
      ".github/workflows/release.yml",
      ".github/workflows/real-machine-validation.yml"
    ], outputs: [],
  },
  "verify:real-machine": {
    scriptName: "verify:real-machine", command: "npm run verify:real-machine", category: "verifier", subsystem: "real-machine-validation",
    owner: "platform", tier: "external", sideEffects: "destructive",
    requiresFreshContainer: false, ciProfile: "none", expectedDurationClass: "extended",
    inputs: [
      "tools/registry/release-acceptance-standards.registry.json",
      "tools/server-scripts/verify-real-machine-validation.ts",
      "tools/server-scripts/lib/real-machine-validation-workflow.ts",
      "tools/server-scripts/real-machine-target-phase.ts",
      "tools/server-scripts/real-machine-targets/*.commands.json",
      "tools/server-scripts/verify-real-machine-source-run.ts",
      "tools/server-scripts/verify-real-machine-workflow-inputs.ts",
      "tools/server-scripts/resolve-real-machine-candidate.ts",
      "tools/server-scripts/cleanup-real-machine-secrets.ts",
      ".github/workflows/real-machine-validation.yml",
      "docker-compose.yml",
      "docker-compose.enterprise.yml"
    ], outputs: ["build/real-machine-validation/**"],
  },
  "verify:cross-system-offline-transfer": {
    scriptName: "verify:cross-system-offline-transfer", command: "npm run verify:cross-system-offline-transfer", category: "verifier", subsystem: "release-acceptance",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "standard",
    inputs: [
      "tools/server-scripts/verify-cross-system-offline-transfer-evidence.ts",
      "tools/registry/release-definition.registry.json"
    ], outputs: ["build/reports/cross-system-offline-transfer.json"],
  },
  "verify:enterprise-single-node:ubuntu-container": {
    scriptName: "verify:enterprise-single-node:ubuntu-container",
    command: "npm run verify:enterprise-single-node:ubuntu-container",
    category: "verifier",
    subsystem: "platform-acceptance",
    owner: "platform",
    tier: "release",
    sideEffects: "docker",
    requiresFreshContainer: true,
    ciProfile: "release",
    expectedDurationClass: "extended",
    inputs: [
      "package-lock.json",
      "tools/containers/enterprise-single-node-acceptance.Dockerfile",
      "tools/plan/rebuild-current-plan-baseline.ts",
      "tools/plan/reduce-end-to-end-release-receipt.ts",
      "tools/server-scripts/verify-cross-system-offline-transfer-evidence.ts",
      "tools/server-scripts/verify-enterprise-single-node-ubuntu-container.ts"
    ],
    outputs: [
      "build/plan-proof-ledger/**",
      "build/reports/enterprise-single-node-ubuntu/**",
      "build/reports/cross-system-offline-transfer.json"
    ],
  },
  "verify:version-registry": {
    scriptName: "verify:version-registry", command: "npm run verify:version-registry", category: "version-control", subsystem: "version-governance",
    owner: "platform", tier: "hygiene", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "core", expectedDurationClass: "fast",
    inputs: [
      "packages/foundation/src/version-control/version-registry.json",
      "packages/foundation/src/version-control/version-registry.schema.json",
      "packages/foundation/src/version-control/version-scan.ts",
      "tools/server-scripts/verify-version-registry.ts"
    ], outputs: ["build/reports/version-registry/latest.json"],
  },
  "verify:node-runtime-supply-chain": {
    scriptName: "verify:node-runtime-supply-chain", command: "npm run verify:node-runtime-supply-chain", category: "verifier", subsystem: "runtime-supply-chain",
    owner: "platform-security", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "security", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "package-lock.json",
      "tools/server-scripts/verify-node-runtime-supply-chain.ts"
    ], outputs: ["build/reports/node-runtime-supply-chain.json"],
  },
  "release:prepare": {
    scriptName: "release:prepare", command: "npm run release:prepare", category: "version-control", subsystem: "release-package-version",
    owner: "platform", tier: "release", sideEffects: "source-write",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "package.json",
      "package-lock.json",
      "CHANGELOG.md",
      "apps/*/package.json",
      "packages/*/package.json",
      "packages/protocols/mcp/adapter/gateway-installer/package.json",
      "tools/server-scripts/prepare-release.ts"
    ], outputs: [
      "package.json",
      "package-lock.json",
      "CHANGELOG.md",
      "apps/*/package.json",
      "packages/*/package.json",
      "packages/protocols/mcp/adapter/gateway-installer/package.json"
    ],
  },
  "release:package-server-source": {
    scriptName: "release:package-server-source", command: "npm run release:package-server-source", category: "packaging", subsystem: "server-source-package",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "package-lock.json",
      "Dockerfile",
      "docker-compose.yml",
      "apps/**",
      "packages/**",
      "plugins/plugin.schema.json",
      "content/**",
      "tools/**",
      "tools/server-scripts/package-server-source.ts",
      "tools/server-scripts/lib/mcp-release-reproducible-archives.ts"
    ], outputs: ["build/packages/*.tar.gz", "build/packages/*.sha256"],
  },
  "release:publish-npm": {
    scriptName: "release:publish-npm", command: "npm run release:publish-npm", category: "packaging", subsystem: "npm-release-set",
    owner: "platform", tier: "release", sideEffects: "network",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "package-lock.json",
      "apps/*/package.json",
      "packages/*/package.json",
      "packages/protocols/mcp/adapter/gateway-installer/package.json",
      "tools/server-scripts/publish-release-set.ts",
      "tools/server-scripts/prepare-release.ts",
      "tools/server-scripts/lib/npm-cli-invocation.ts"
    ], outputs: [],
  },
  "release:prepare-node-runtime-source-evidence": {
    scriptName: "release:prepare-node-runtime-source-evidence", command: "npm run release:prepare-node-runtime-source-evidence", category: "packaging", subsystem: "runtime-supply-chain",
    owner: "platform-security", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "package.json",
      "tools/release/node-runtime.lock.json",
      "tools/server-scripts/prepare-node-runtime-source-evidence.ts",
      "packages/foundation/src/config/server-config.ts"
    ], outputs: ["build/release/node-runtime-source/**"],
  },
  "release:generate-provenance": {
    scriptName: "release:generate-provenance", command: "npm run release:generate-provenance", category: "packaging", subsystem: "supply-chain",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "package.json",
      "package-lock.json",
      "tools/server-scripts/generate-provenance.ts",
      "build/reports/**",
      "build/composition-presets.json"
    ], outputs: ["build/reports/provenance.json"],
  },
  "verify:npm-package-installability": {
    scriptName: "verify:npm-package-installability", command: "npm run verify:npm-package-installability", category: "packaging", subsystem: "npm-release-set",
    owner: "platform", tier: "release", sideEffects: "docker",
    requiresFreshContainer: true, ciProfile: "release", expectedDurationClass: "extended",
    inputs: [
      "package.json",
      "package-lock.json",
      "Dockerfile",
      "packages/foundation/config/deployment/index.json",
      "apps/server/bin/**",
      "packages/**",
      "tools/server-scripts/verify-npm-package-installability.ts",
      "tools/server-scripts/lib/lock-backed-npm-registry.ts"
    ], outputs: ["build/reports/npm-package-installability.json"],
  },
  "verify:better-plan": {
    scriptName: "verify:better-plan", command: "npm run verify:better-plan", category: "verifier", subsystem: "documentation",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: ["tools/server-scripts/verify-better-plan.ts", "tools/registry/fact-source-authority.registry.json", "README.md", "README.zh-CN.md", "docs/README.md", "docs/RUNBOOK.md", "docs/examples/README.md", "docs/COMPATIBILITY.md", "docs/architecture/ARCHITECTURE.md", "docs/architecture/EXECUTION-SANDBOX.md", "docs/protocols/PROTOCOLS.md", "docs/functionality/**", "docs/architecture/STATE-MACHINES.md"], outputs: ["build/reports/better-plan.json"],
  },
  "plan:next": {
    scriptName: "plan:next", command: "npm run plan:next", category: "maintenance", subsystem: "planning",
    owner: "platform", tier: "hygiene", sideEffects: "none",
    requiresFreshContainer: false, ciProfile: "core", expectedDurationClass: "fast",
    inputs: ["docs/plans/Manifest.json", "docs/plans/end-to-end-release/DependencyMap.json", "docs/plans/**/Checkpoints.json", "tools/plan/*.ts"], outputs: [],
  },
  "verify:composition-source-package": {
    scriptName: "verify:composition-source-package", command: "npm run verify:composition-source-package", category: "packaging", subsystem: "release-source",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "tools/server-scripts/package-server-source.ts",
      "tools/server-scripts/lib/mcp-release-reproducible-archives.ts",
      "tools/server-scripts/verify-composition-source.ts",
      "tools/server-scripts/verify-composition-source-package.ts"
    ], outputs: ["build/reports/composition-source-package.json"],
  },
  "verify:release-authority-baseline": {
    scriptName: "verify:release-authority-baseline", command: "npm run verify:release-authority-baseline", category: "verifier", subsystem: "release",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "tools/registry/release-authority-baseline.registry.json",
      "tools/registry/schema/release-authority-baseline.schema.json",
      "tools/verifiers/registry-release-authority-baseline.ts",
      "tools/server-scripts/verify-release-authority-baseline.ts",
      "tools/server-scripts/lib/platform-acceptance-command-catalog.ts",
      "tools/server-scripts/lib/platform-acceptance-report-catalog.ts",
      "tools/registry/capability-acceptance.registry.json",
      "tools/registry/fact-source-authority.registry.json"
    ],
    outputs: ["build/reports/release-authority-baseline.json"],
  },
  "verify:release-definition": {
    scriptName: "verify:release-definition", command: "npm run verify:release-definition", category: "verifier", subsystem: "release",
    owner: "platform", tier: "release", sideEffects: "none",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "tools/registry/release-definition.registry.json",
      "tools/registry/schema/release-definition.schema.json",
      "tools/server-scripts/verify-release-definition.ts",
      "package.json",
      "package-lock.json"
    ],
    outputs: [],
  },
  "verify:release-journey": {
    scriptName: "verify:release-journey", command: "npm run verify:release-journey", category: "verifier", subsystem: "release",
    owner: "platform", tier: "release", sideEffects: "docker",
    requiresFreshContainer: true, ciProfile: "release", expectedDurationClass: "extended",
    inputs: [
      "tools/server-scripts/verify-release-journey.ts",
      "tools/server-scripts/lib/release-journey-*.ts",
      "tools/server-scripts/lib/mcp-proxy-stdio-client.ts",
      "tools/server-scripts/lib/upstream-service-publishing-evidence.ts",
      "tools/server-scripts/lib/upstream-service-publishing-html.ts",
      "tools/generators/generate-upstream-service-publishing-report-template.ts",
      "docs/examples/upstream-service-publishing-report-template.html",
      "packages/protocols/mcp/adapter/gateway-installer/**",
      "docker-compose.yml",
      "Dockerfile",
      "docs/examples/file-parser-format-convert.upstream.json",
      "tools/server-scripts/lib/release-journey-fixture.ts"
    ],
    outputs: [
      "build/reports/release-journey.json",
      "build/reports/upstream-service-publishing.html",
      "build/reports/upstream-service-publishing/screenshots/**"
    ],
  },
  "verify:runtime-refactor-convergence": {
    scriptName: "verify:runtime-refactor-convergence", command: "npm run verify:runtime-refactor-convergence", category: "verifier", subsystem: "runtime",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "audit", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "packages/agents/src/upstream-gateway/registry-runtime.ts",
      "packages/agents/src/agent-workspace/agent-workspace-file-state.ts",
      "packages/foundation/src/security/authorization/authorization-engine.ts",
      "packages/server-runtime/src/routing/operation-route-index.ts",
      "packages/server-runtime/src/composition/dispatch-operation-proof-lifecycle.ts",
      "packages/server-runtime/src/composition/console-domain/operation-executor.ts",
      "tools/server-scripts/verify-runtime-refactor-convergence.ts"
    ], outputs: ["build/reports/runtime-refactor-convergence/convergence.json"],
  },
  "verify:runtime-capacity-convergence": {
    scriptName: "verify:runtime-capacity-convergence", command: "npm run verify:runtime-capacity-convergence", category: "verifier", subsystem: "runtime",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "audit", expectedDurationClass: "extended",
    inputs: [
      "package.json",
      "docs/plans/end-to-end-release/Plan.md",
      "tools/registry/runtime-capacity-profile.registry.json",
      "tools/registry/runtime-capacity-workload-catalog.registry.json",
      "tools/registry/sqlite-owner-migration.registry.json",
      "tools/server-scripts/verify-runtime-capacity-convergence.ts",
      "tools/verifiers/runtime-capacity-workload-catalog.ts"
    ], outputs: [
      "build/reports/runtime-capacity-convergence/convergence.json",
      "build/reports/runtime-capacity-convergence/stages/*.json"
    ],
  },
  "verify:upstream-service-publishing-candidate": {
    scriptName: "verify:upstream-service-publishing-candidate",
    command: "npm run verify:upstream-service-publishing-candidate",
    category: "verifier",
    subsystem: "release",
    owner: "platform",
    tier: "release",
    sideEffects: "build-output",
    requiresFreshContainer: false,
    ciProfile: "release",
    expectedDurationClass: "fast",
    inputs: [
      "tools/registry/release-definition.registry.json",
      "tools/server-scripts/verify-upstream-service-publishing-candidate.ts",
      "tools/server-scripts/lib/upstream-service-publishing-candidate-receipt.ts",
      "build/reports/upstream-service-publishing.json",
      "build/reports/release-journey.json",
      "build/reports/upstream-service-publishing/upstream-service-basic-config.json",
      "build/reports/upstream-service-publishing.html",
      "build/reports/upstream-service-publishing/screenshots/**"
    ],
    outputs: [
      "build/reports/upstream-service-publishing-candidate.json"
    ],
  },
  "verify:upstream-service-report-template": {
    scriptName: "verify:upstream-service-report-template", command: "npm run verify:upstream-service-report-template", category: "verifier", subsystem: "release",
    owner: "platform", tier: "hygiene", sideEffects: "none",
    requiresFreshContainer: false, ciProfile: "hygiene", expectedDurationClass: "fast",
    inputs: [
      "docs/examples/upstream-service-publishing-report-template.html",
      "tools/generators/generate-upstream-service-publishing-report-template.ts",
      "tools/server-scripts/lib/upstream-service-publishing-html.ts"
    ],
    outputs: [],
  },
  "generate:upstream-service-publishing-report": {
    scriptName: "generate:upstream-service-publishing-report", command: "npm run generate:upstream-service-publishing-report", category: "verifier", subsystem: "release",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "tools/generators/generate-upstream-service-publishing-report.ts",
      "tools/server-scripts/lib/upstream-service-publishing-html.ts",
      "build/reports/upstream-service-publishing.json",
      "build/reports/release-journey.json",
      "build/reports/upstream-service-publishing/upstream-service-basic-config.json"
    ],
    outputs: ["build/reports/upstream-service-publishing.html"],
  },
  "server:verify:deployment-flow:podman": {
    scriptName: "server:verify:deployment-flow:podman", command: "npm run server:verify:deployment-flow:podman", category: "verifier", subsystem: "deployment",
    owner: "platform", tier: "external", sideEffects: "docker",
    requiresFreshContainer: true, ciProfile: "external", expectedDurationClass: "extended",
    inputs: [
      "tools/server-scripts/verify-deployment-container-flow.ts",
      "docker-compose.yml",
      "Dockerfile"
    ],
    outputs: ["build/reports/deployment-container-flow-podman.json"],
  },
  "verify:upstream-service-publishing": {
    scriptName: "verify:upstream-service-publishing", command: "npm run verify:upstream-service-publishing", category: "verifier", subsystem: "upstream-gateway",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "apps/server/runtime/http-server.ts",
      "packages/agents/src/upstream-gateway/**",
      "packages/contracts/src/mcp-catalog-delivery.ts",
      "packages/protocols/mcp/adapter/http-mcp-adapter*.ts",
      "packages/server-runtime/src/state/sse-connection-state.ts",
      "tools/server-scripts/verify-upstream-service-publishing.ts",
      "tools/server-scripts/lib/mcp-catalog-protocol-peer.ts",
      "tools/server-scripts/lib/upstream-service-publishing-evidence.ts"
    ], outputs: ["build/reports/upstream-service-publishing.json"],
  },
  "verify:upstream-gateway-external": {
    scriptName: "verify:upstream-gateway-external", command: "npm run verify:upstream-gateway-external", category: "network-service", subsystem: "upstream-gateway",
    owner: "platform", tier: "external", sideEffects: "network-service",
    requiresFreshContainer: false, ciProfile: "external", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/verify-upstream-gateway-external-compatibility.ts", "packages/agents/src/upstream-gateway/**"], outputs: ["build/reports/upstream-gateway-external-compatibility.json"],
  },
  "verify:upstream-fixture-transit": {
    scriptName: "verify:upstream-fixture-transit", command: "npm run verify:upstream-fixture-transit", category: "verifier", subsystem: "upstream-gateway",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/verify-upstream-fixture-transit.ts", "tools/server-scripts/upstream-fixture-service.ts", "tools/server-scripts/lib/upstream-fixture-service.ts", "tools/server-scripts/lib/upstream-fixture-transit-evidence.ts", "tools/server-scripts/lib/upstream-fixture-grant.ts", "tools/server-scripts/lib/verifier-inprocess-mcp-adapter.ts", "tools/server-scripts/lib/upstream-gateway-verifier-publication.ts", "packages/agents/src/upstream-gateway/**", "packages/protocols/mcp/upstream-mcp-*.ts", "packages/foundation/src/security/secrets/**"], outputs: ["build/reports/upstream-fixture-transit.json"],
  },
  "verify:downstream-agent-tool-loop": {
    scriptName: "verify:downstream-agent-tool-loop", command: "npm run verify:downstream-agent-tool-loop", category: "verifier", subsystem: "downstream-gateway",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/verify-downstream-agent-tool-loop.ts", "tools/server-scripts/upstream-fixture-service.ts", "tools/server-scripts/lib/upstream-fixture-service.ts", "tools/server-scripts/lib/downstream-agent-tool-loop-evidence.ts", "tools/server-scripts/lib/mcp-neutral-peer-identity-support.ts", "tools/server-scripts/lib/upstream-fixture-grant.ts", "tools/server-scripts/lib/mcp-proxy-stdio-client.ts", "tools/server-scripts/lib/upstream-gateway-verifier-publication.ts", "packages/agents/src/upstream-gateway/**", "packages/protocols/mcp/upstream-mcp-*.ts", "packages/protocols/mcp/adapter/http-mcp-adapter*.ts", "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts", "packages/protocols/mcp/adapter/gateway-installer/lib/**", "packages/capabilities/src/operation-permission-core/**", "packages/foundation/src/security/secrets/**"], outputs: ["build/reports/downstream-agent-tool-loop.json"],
  },
  "verify:mcp-release-portable-assembly": {
    scriptName: "verify:mcp-release-portable-assembly", command: "npm run verify:mcp-release-portable-assembly", category: "verifier", subsystem: "downstream-mcp",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/verify-mcp-release-portable-assembly.ts", "tools/server-scripts/lib/mcp-release-portable.ts", "tools/server-scripts/lib/mcp-release-reproducible-archives.ts", "tools/server-scripts/lib/mcp-release-common.ts", "packages/protocols/mcp/adapter/gateway-installer/**", "packages/protocols/mcp/adapter/native-installer/**"], outputs: ["build/reports/mcp-release-portable-assembly.json"],
  },
  "verify:mcp-final-release-asset": {
    scriptName: "verify:mcp-final-release-asset", command: "npm run verify:mcp-final-release-asset", category: "verifier", subsystem: "downstream-mcp",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: ["build/release/mcp/**", "tools/server-scripts/verify-mcp-final-release-asset.ts"], outputs: ["build/reports/mcp-final-release-asset.json"],
  },
  "verify:mcp-proxy-transport": {
    scriptName: "verify:mcp-proxy-transport", command: "npm run verify:mcp-proxy-transport", category: "verifier", subsystem: "downstream-mcp",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/verify-mcp-proxy-transport.ts", "tools/server-scripts/lib/mcp-neutral-peer-identity-support.ts", "tools/server-scripts/lib/mcp-neutral-peer-protocol-support.ts", "tools/server-scripts/lib/mcp-proxy-stdio-client.ts", "tools/server-scripts/lib/mcp-proxy-transport-evidence.ts", "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts", "packages/protocols/mcp/adapter/gateway-installer/lib/**", "packages/capabilities/src/operation-permission-core/**"], outputs: ["build/reports/mcp-proxy-transport.json"],
  },
  "verify:path-abstraction-audit": {
    scriptName: "verify:path-abstraction-audit", command: "npm run verify:path-abstraction-audit", category: "verifier", subsystem: "path-boundary",
    owner: "platform-security", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "security", expectedDurationClass: "fast",
    inputs: ["tools/server-scripts/verify-path-abstraction-audit.ts", "packages/foundation/src/security/local-path-boundary.ts", "packages/foundation/src/module-system/plugin-data-capability.ts", "packages/agents/src/agent-workspace/**"], outputs: ["build/reports/path-abstraction-audit.json"],
  },
  "verify:controlled-execution-sandbox": {
    scriptName: "verify:controlled-execution-sandbox", command: "npm run verify:controlled-execution-sandbox", category: "verifier", subsystem: "execution-sandbox",
    owner: "platform-security", tier: "release", sideEffects: "docker",
    requiresFreshContainer: true, ciProfile: "security", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/verify-controlled-execution-sandbox.ts", "tools/server-scripts/verify-execution-sandbox-oci-conformance.ts", "tools/server-scripts/verify-opaque-sandbox-custody.ts", "tools/verifiers/execution-launcher-boundary.ts", "packages/foundation/src/execution-sandbox/**", "packages/foundation/src/storage/**", "packages/server-runtime/src/execution-sandbox/**"], outputs: ["build/reports/controlled-execution-sandbox.json", "build/reports/execution-sandbox-oci-conformance.json", "build/reports/opaque-sandbox-custody.json", "build/reports/execution-launcher-boundary.json"],
  },
  "verify:controlled-execution-convergence": {
    scriptName: "verify:controlled-execution-convergence", command: "npm run verify:controlled-execution-convergence", category: "verifier", subsystem: "execution-sandbox",
    owner: "platform-security", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "security", expectedDurationClass: "fast",
    inputs: ["tools/server-scripts/verify-controlled-execution-convergence.ts", "tools/server-scripts/lib/controlled-execution-convergence-reducer.ts", "tools/server-scripts/verify-release-candidate-identity.ts", "tools/plan/plan-evidence-verifier.ts", "docs/plans/end-to-end-release/Plan.md", "docs/plans/end-to-end-release/Checkpoints.json", "docs/plans/end-to-end-release/DependencyMap.json", "build/reports/controlled-execution-sandbox.json", "build/reports/execution-sandbox-oci-conformance.json", "build/reports/opaque-sandbox-custody.json", "build/reports/execution-launcher-boundary.json"], outputs: ["build/reports/controlled-execution-convergence-final.json"],
  },
  "verify:security-alert-lifecycle": {
    scriptName: "verify:security-alert-lifecycle", command: "npm run verify:security-alert-lifecycle", category: "verifier", subsystem: "security",
    owner: "platform-security", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "security", expectedDurationClass: "fast",
    inputs: ["tools/server-scripts/verify-security-alert-lifecycle.ts", "packages/foundation/src/security/security-alerts.ts"], outputs: ["build/reports/security-alert-lifecycle.json"],
  },
  "verify:console-redundancy": {
    scriptName: "verify:console-redundancy", command: "npm run verify:console-redundancy", category: "verifier", subsystem: "console",
    owner: "frontend", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: ["tools/server-scripts/verify-console-redundancy.ts", "apps/console/**", "packages/ui-console/**"], outputs: ["build/reports/console-redundancy.json"],
  },
  "verify:console-admin-browser-visual": {
    scriptName: "verify:console-admin-browser-visual", command: "npm run verify:console-admin-browser-visual", category: "verifier", subsystem: "console",
    owner: "frontend", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "long",
    inputs: [
      "tools/server-scripts/verify-console-admin-browser-visual.ts",
      "tools/server-scripts/lib/console-admin-browser-assertions.ts",
      "tools/server-scripts/lib/console-admin-browser-fixture.ts",
      "apps/console/**",
      "packages/ui-console/**",
      "plugins/*/console/**",
      "build/dist/**"
    ], outputs: [
      "build/reports/console-admin-browser-visual.json",
      "build/reports/console-admin-browser-visual-screenshots/**"
    ],
  },
  "verify:skills": {
    scriptName: "verify:skills", command: "npm run verify:skills", category: "verifier", subsystem: "repository",
    owner: "platform", tier: "hygiene", sideEffects: "none",
    requiresFreshContainer: false, ciProfile: "hygiene", expectedDurationClass: "fast",
    inputs: ["skills/**", "tools/validate-skills.mjs"], outputs: [],
  },
  "verify:repo-organization": {
    scriptName: "verify:repo-organization", command: "npm run verify:repo-organization", category: "verifier", subsystem: "repository",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "package.json",
      ".github/workflows/**",
      "tools/registry/repo-layout.registry.json",
      "tools/registry/schema/repo-layout.schema.json",
      "tools/registry/tests.registry.json",
      "tools/registry/architecture-layout-facade.ts",
      "tools/server-scripts/verify-repo-organization.ts",
      "tools/server-scripts/lib/repo-organization-ast-advisory.ts",
      "apps/**",
      "packages/**",
      "plugins/plugin.schema.json",
      "tools/**",
      "tests/**"
    ], outputs: ["build/reports/repo-organization.json"],
  },

  // ── External service ──────────────────────────────────────────────────────

  // ── Maintenance / devops ──────────────────────────────────────────────────
  "server:doctor": {
    scriptName: "server:doctor", command: "npm run server:doctor", category: "maintenance", subsystem: "server",
    owner: "platform", tier: "hygiene", sideEffects: "none",
    requiresFreshContainer: false, ciProfile: "hygiene", expectedDurationClass: "fast",
    inputs: ["tools/server-scripts/doctor.ts"], outputs: [],
  },
  "server:locate": {
    scriptName: "server:locate", command: "npm run server:locate", category: "maintenance", subsystem: "storage",
    owner: "platform", tier: "hygiene", sideEffects: "none",
    requiresFreshContainer: false, ciProfile: "hygiene", expectedDurationClass: "fast",
    inputs: ["tools/server-scripts/locate-storage.ts"], outputs: [],
  },
  "server:reconcile": {
    scriptName: "server:reconcile", command: "npm run server:reconcile", category: "maintenance", subsystem: "storage",
    owner: "platform", tier: "integration", sideEffects: "runtime-data",
    requiresFreshContainer: false, ciProfile: "core", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/reconcile-storage.ts"], outputs: [],
  },
  // ── Runtime downloads ──────────────────────────────────────────────────────

  // ── Version control ────────────────────────────────────────────────────────

  // ── Feature profile ────────────────────────────────────────────────────────

  // ── Skills / gates ─────────────────────────────────────────────────────────

  // ── Governance / Provenance ─────────────────────────────────────────────────
  "server:verify": {
    scriptName: "server:verify", command: "npm run server:verify", category: "verifier", subsystem: "server",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "audit", expectedDurationClass: "extended",
    inputs: [
      "package.json",
      "tools/server-scripts/verify-server-runtime.ts",
      "tools/server-scripts/lib/server-regression-command-runner.ts",
      "tools/scripts/package-script-registry.ts",
      "tools/scripts/package-script-registry-catalog.ts"
    ], outputs: ["build/reports/server-runtime-verification.json"],
  },
  "server:verify:headless": {
    scriptName: "server:verify:headless", command: "npm run server:verify:headless", category: "verifier", subsystem: "server",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "audit", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "tools/server-scripts/verify-server-headless.ts",
      "tools/server-scripts/lib/server-regression-command-runner.ts",
      "tools/server-scripts/verify-public-boundary.ts",
      "tools/server-scripts/verify-strategy-management.ts",
      "tools/server-scripts/verify-model-gateway-plugin.ts",
      "tools/server-scripts/verify-model-gateway-detachment.ts",
      "tools/server-scripts/verify-external-gateway-plugin.ts"
    ], outputs: ["build/reports/server-headless-verification.json"],
  },
  "server:verify:checkpoints": {
    scriptName: "server:verify:checkpoints", command: "npm run server:verify:checkpoints", category: "verifier", subsystem: "workspace",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "audit", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "tools/server-scripts/verify-server-checkpoints.ts",
      "tools/server-scripts/lib/server-regression-command-runner.ts",
      "tools/server-scripts/verify-workspace-file-ops.ts",
      "tools/server-scripts/verify-workspace-checkpoint-protocol.ts"
    ], outputs: ["build/reports/server-checkpoints-verification.json"],
  },
  "server:verify:upload-workspace-materialization": {
    scriptName: "server:verify:upload-workspace-materialization", command: "npm run server:verify:upload-workspace-materialization", category: "verifier", subsystem: "jobs",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "audit", expectedDurationClass: "fast",
    inputs: [
      "package.json",
      "packages/server-runtime/src/jobs/upload-workspace-materialization.ts",
      "packages/server-runtime/src/state/upload-session-store.ts",
      "packages/agents/src/agent-workspace/agent-workspace-file-write-api.ts",
      "tools/server-scripts/verify-upload-workspace-materialization.ts"
    ], outputs: ["build/reports/upload-workspace-materialization.json"],
  },
  "server:verify:ops": {
    scriptName: "server:verify:ops", command: "npm run server:verify:ops", category: "verifier", subsystem: "operations",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "audit", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "tools/server-scripts/verify-server-ops.ts",
      "tools/server-scripts/lib/server-regression-command-runner.ts",
      "tools/server-scripts/verify-backup-restore.ts",
      "tools/server-scripts/verify-storage-production-restore-drill.ts",
      "tools/server-scripts/verify-job-work-queue.ts",
      "tools/server-scripts/verify-work-queue-conformance.ts",
      "tools/server-scripts/verify-deployment-index.ts"
    ], outputs: ["build/reports/server-ops-verification.json"],
  },
  "server:verify:rebuild": {
    scriptName: "server:verify:rebuild", command: "npm run server:verify:rebuild", category: "verifier", subsystem: "state-rebuild",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "audit", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "tools/server-scripts/verify-server-rebuild.ts",
      "tools/server-scripts/lib/server-regression-command-runner.ts",
      "tools/server-scripts/verify-job-work-queue.ts",
      "tools/server-scripts/verify-work-queue-conformance.ts",
      "tools/server-scripts/verify-tag-management.ts",
      "tools/server-scripts/verify-operation-permission-universal-tag-policy.ts"
    ], outputs: ["build/reports/server-rebuild-verification.json"],
  },
  "server:verify:script-registry": {
    scriptName: "server:verify:script-registry", command: "npm run server:verify:script-registry", category: "verifier", subsystem: "tests",
    owner: "platform", tier: "hygiene", sideEffects: "none",
    requiresFreshContainer: false, ciProfile: "hygiene", expectedDurationClass: "fast",
    inputs: [
      "package.json",
	      "tests/verify-script-registry.ts",
	      "tools/registry/tests.registry.json",
      "tools/registry/fact-source-authority.registry.json",
      "tools/registry/schema/fact-source-authority.schema.json",
      "tools/scripts/package-script-registry.ts",
      "tools/scripts/package-script-registry-catalog.ts",
      "tools/server-scripts/verify-server-runtime.ts",
      "tools/server-scripts/verify-server-headless.ts",
      "tools/server-scripts/verify-server-checkpoints.ts",
      "tools/server-scripts/verify-server-ops.ts",
      "tools/server-scripts/verify-server-rebuild.ts",
      "tools/server-scripts/lib/server-regression-command-runner.ts",
	      "tools/server-scripts/lib/platform-acceptance-report-catalog.ts",
	      "tools/server-scripts/lib/platform-acceptance-command-catalog.ts",
	      "tools/server-scripts/lib/platform-acceptance-reducer.ts",
	      "tools/server-scripts/lib/private-deployment-internal-platform-e2e-catalog.ts",
	      "tools/server-scripts/verify-platform-acceptance.ts",
      "tools/server-scripts/production-readiness-gate.ts",
      "tools/server-scripts/verify-private-deployment-internal-platform-e2e.ts",
      "tools/server-scripts/verify-upstream-fixture-transit.ts",
      "tools/server-scripts/verify-downstream-agent-tool-loop.ts",
      "tools/server-scripts/stress-gateway-platform-profile.ts",
      "tools/server-scripts/lib/verifier-termination-signals.ts",
      "tools/server-scripts/verify-mcp-proxy-transport.ts",
	      "tools/server-scripts/lib/release-evidence-readiness.ts",
	      "tools/server-scripts/lib/release-evidence-freshness.ts",
	      "tools/server-scripts/lib/upstream-fixture-transit-evidence.ts",
      "tools/server-scripts/lib/downstream-agent-tool-loop-evidence.ts",
      "tools/server-scripts/lib/mcp-proxy-transport-evidence.ts",
	      "tools/server-scripts/verify-observability-semantics.ts",
      "packages/protocols/mcp/adapter/mcp-release-targets.ts",
      "packages/protocols/mcp/adapter/http-mcp-adapter-constants.ts",
      "packages/protocols/mcp/adapter/gateway-installer/lib/cli/constants.ts",
      "tools/server-scripts/verify-mcp-release-target-scope.ts"
    ], outputs: ["build/reports/script-registry.json"],
  },
  "server:verify:state-machines": {
    scriptName: "server:verify:state-machines", command: "npm run server:verify:state-machines", category: "verifier", subsystem: "state-machine",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "tools/server-scripts/verify-state-machines.ts",
      "packages/foundation/src/workflow/state-machine/definitions/**",
      "packages/foundation/src/workflow/state-machine/verification/**",
      "tools/registry/state-machines/state-machine-integrity.registry.json"
    ], outputs: ["build/reports/state-machines/latest.json", "build/reports/state-machines/latest.md"],
  },
  "server:verify:protocol-boundary": {
    scriptName: "server:verify:protocol-boundary", command: "npm run server:verify:protocol-boundary", category: "verifier", subsystem: "architecture",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "tools/server-scripts/verify-protocol-boundary.ts",
      "packages/protocols/**",
      "apps/server/runtime/http-server-routes.ts",
      "packages/server-runtime/src/composition/mcp-identity-provider.ts",
      "packages/server-runtime/src/composition/mcp-notification-bus-binding.ts",
      "packages/server-runtime/src/composition/discovery-config.ts"
    ], outputs: ["build/reports/protocol-boundary.json"],
  },
  "server:deployment-index": {
    scriptName: "server:deployment-index", command: "npm run server:deployment-index", category: "maintenance", subsystem: "deployment",
    owner: "platform", tier: "hygiene", sideEffects: "none",
    requiresFreshContainer: false, ciProfile: "core", expectedDurationClass: "fast",
    inputs: [
      "packages/foundation/config/deployment/index.json",
      "tools/server-scripts/deployment-index.ts"
    ], outputs: [],
  },
  "server:verify:strategy-management-browser": {
    scriptName: "server:verify:strategy-management-browser", command: "npm run server:verify:strategy-management-browser", category: "verifier", subsystem: "strategy-management",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "core", expectedDurationClass: "standard",
    inputs: [
      "build/dist/**",
      "apps/server/runtime/http-server.ts",
      "apps/console/views/admin/StrategyManagementView.vue",
      "apps/console/lib/strategy-management.ts",
      "tools/server-scripts/verify-strategy-management-browser.ts",
      "tools/server-scripts/lib/console-admin-browser-fixture.ts"
    ], outputs: ["build/reports/strategy-management-browser.json"],
  },
  "verify:capability-acceptance-machines": {
    scriptName: "verify:capability-acceptance-machines", command: "npm run verify:capability-acceptance-machines", category: "verifier", subsystem: "state-machine",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "tools/server-scripts/verify-capability-acceptance-machines.ts",
      "tools/server-scripts/lib/plugin-runtime-capability-bindings.ts",
      "tools/registry/capability-acceptance.registry.json",
      "tools/registry/capability-acceptance-checkpoints/*.json",
      "packages/foundation/src/workflow/state-machine/definitions/acceptance/**",
      "packages/foundation/src/module-system/plugin-registry.ts",
      "plugins/*/plugin.json",
      "apps/server/runtime/http-server.ts",
      "packages/server-runtime/src/composition/http-application-assembly.ts",
      "packages/server-runtime/src/composition/server-runtime-providers.ts",
      "packages/protocols/http/controllers/system-controller.ts",
      "packages/protocols/mcp/adapter/http-mcp-adapter-replies.ts",
      "packages/server-runtime/src/composition/console-domain/operation-executor.ts"
    ], outputs: ["build/reports/capability-acceptance-machines.json"],
  },
  "verify:plugin-bundle-protocol": {
    scriptName: "verify:plugin-bundle-protocol", command: "npm run verify:plugin-bundle-protocol", category: "verifier", subsystem: "module-system",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "tools/server-scripts/verify-plugin-bundle-protocol.ts",
      "packages/contracts/src/plugins",
      "packages/foundation/src/module-system/plugin-package-tar.ts",
      "packages/foundation/src/module-system/plugin-package-validator.ts",
      "packages/foundation/src/module-system/plugin-package-custody.ts",
      "packages/foundation/src/module-system/plugin-package-acquisition-port.ts",
      "packages/foundation/src/module-system/plugin-package-lifecycle.ts",
      "packages/server-runtime/src/composition/plugin-contribution-transaction.ts",
      "tests/vitest/server/plugin-package-protocol.test.ts"
    ], outputs: ["build/reports/plugin-bundle-protocol.json"],
  },
  "verify:plugin-runtime": {
    scriptName: "verify:plugin-runtime", command: "npm run verify:plugin-runtime", category: "verifier", subsystem: "module-system",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "tools/server-scripts/verify-plugin-bundle-protocol.ts",
      "tools/server-scripts/verify-plugin-runtime.ts",
      "tools/server-scripts/start-server.ts",
      "tools/server-scripts/lib/plugin-runtime-capability-bindings.ts",
      "tools/server-scripts/lib/runtime-plugin-selection.ts",
      "packages/foundation/src/module-system/plugin-registry.ts",
      "packages/foundation/src/module-system/plugin-runtime.ts",
      "packages/foundation/src/module-system/plugin-package-lifecycle.ts",
      "packages/foundation/src/module-system/mount-config.ts",
      "packages/foundation/src/module-system/mount-manager.ts",
      "packages/contracts/src/plugins",
      "packages/server-runtime/src/composition/plugin-contribution-transaction.ts",
      "apps/server/runtime/http-server.ts",
      "packages/server-runtime/src/composition/http-application-assembly.ts",
      "packages/server-runtime/src/composition/server-runtime-providers.ts",
      "packages/protocols/http/controllers/system-controller.ts",
      "packages/protocols/mcp/adapter/http-mcp-adapter-replies.ts",
      "packages/server-runtime/src/composition/console-domain/operation-executor.ts",
      "plugins/plugin.schema.json",
      "plugins/*/plugin.json"
    ], outputs: ["build/reports/plugin-bundle-protocol.json", "build/reports/plugin-runtime.json"],
  },
  "verify:local-services": {
    scriptName: "verify:local-services", command: "npm run verify:local-services", category: "verifier", subsystem: "services",
    owner: "platform", tier: "unit", sideEffects: "none",
    requiresFreshContainer: false, ciProfile: "core", expectedDurationClass: "fast",
    inputs: [
      "tools/plugins/verify-local-services.mjs",
      "services/file-parser/format-convert/**",
      "services/skill-hub/**"
    ], outputs: [],
  },
  "verify:local-runtime-plugins": {
    scriptName: "verify:local-runtime-plugins", command: "npm run verify:local-runtime-plugins", category: "verifier", subsystem: "module-system",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "core", expectedDurationClass: "fast",
    inputs: [
      "tools/plugins/verify-local-runtime-plugins.mjs",
      "tools/plugins/**",
      "plugins/shared-space/**",
      "plugins/skill-hub/**",
      "plugins/coding/github/**",
      "plugins/registry/plugins.json",
      "packages/contracts/src/plugins/**",
      "packages/foundation/src/module-system/**",
      "tests/plugins/**"
    ], outputs: ["build/plugins/**"],
  },
  "verify:local-client-adapters": {
    scriptName: "verify:local-client-adapters", command: "npm run verify:local-client-adapters", category: "verifier", subsystem: "module-system",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "core", expectedDurationClass: "fast",
    inputs: [
      "tools/plugins/verify-local-client-adapters.mjs",
      "tools/plugins/**",
      "plugins/agents/**",
      "tests/plugins/**"
    ], outputs: ["build/client-adapters/**"],
  },
  "verify:local-extension-package-closure": {
    scriptName: "verify:local-extension-package-closure", command: "npm run verify:local-extension-package-closure", category: "verifier", subsystem: "module-system",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "core", expectedDurationClass: "standard",
    inputs: [
      "tools/plugins/verify-local-extension-package-closure.mjs",
      "services/**",
      "plugins/**",
      "tests/plugins/**",
      "package.json",
      "THIRD_PARTY_NOTICES.md"
    ], outputs: [],
  },
  "server:verify:architecture-graph": {
    scriptName: "server:verify:architecture-graph", command: "npm run server:verify:architecture-graph", category: "verifier", subsystem: "tests",
    owner: "platform", tier: "hygiene", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "hygiene", expectedDurationClass: "standard",
    inputs: ["apps/server/**", "packages/**", "plugins/plugin.schema.json", "apps/console/**", "tools/**"], outputs: ["build/reports/architecture-graph.json", "build/reports/architecture-graph.md"],
  },
});

/** @type {Readonly<Record<string, ScriptEntry>>} */
export const SCRIPT_REGISTRY: any = RAW_SCRIPT_REGISTRY;

/**
 * Scripts that are explicitly allowed to exist without a full registry entry
 * (e.g., composite scripts that chain other registered scripts).
 */
export const UNCLASSIFIED_ALLOWLIST: readonly any[] = Object.freeze([
  "dev",                      // Direct development server entrypoint
  "build",                    // Direct workspace build entrypoint
  "test",                     // Public test profile alias
  "typecheck",                // TypeScript compiler gate
  "verify",                   // Composite local verification gate
  "verify:security",          // run-verifiers security profile
  "verify:docs",              // run-verifiers documentation profile
  "verify:registry",          // Registry validator plus generated artifact check
  "generate:upstream-service-report-template", // Deterministic tracked template writer
  "platform:audit:report",    // Open-platform report alias
  "downstream:mcp:audit:report", // Downstream MCP report alias
  "console:verify",           // Console build and typecheck composite
  "vitest",                   // Vitest runner
  "vitest:coverage",          // Vitest with coverage
  "repo:branch-flow",         // Branch flow verification
  "repo:git-publication",     // Git publication privacy policy fixtures
  "server:prepare:npm-cache",  // Release packaging helper
  "test:audit",               // Audit test profile
  "test:smoke",               // Smoke test profile
]);
