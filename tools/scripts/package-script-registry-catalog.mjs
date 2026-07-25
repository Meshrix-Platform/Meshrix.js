/**
 * Canonical explicit package-script catalog and classification metadata.
 * Consumer helpers and pattern projection remain in package-script-registry.mjs.
 */

export const SCRIPT_CATEGORIES = Object.freeze({
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
const RAW_SCRIPT_REGISTRY = Object.freeze({
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
    inputs: ["tools/scripts/restart-dev.mjs", "tools/scripts/start-all.mjs", "tools/scripts/clean-existing-service.mjs"], outputs: [],
  },

  // ── Build / packaging ──────────────────────────────────────────────────────

  // ── MCP installer ──────────────────────────────────────────────────────────
  "server:stress:mcp-gateway": {
    scriptName: "server:stress:mcp-gateway", command: "npm run server:stress:mcp-gateway", category: "verifier", subsystem: "mcp-gateway",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "performance", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/stress-mcp-gateway.mjs", "packages/protocols/mcp/**", "packages/agents/src/upstream-gateway/**"], outputs: ["build/reports/mcp-gateway-load.json"],
  },
  "server:stress:mcp-gateway-observed": {
    scriptName: "server:stress:mcp-gateway-observed", command: "npm run server:stress:mcp-gateway-observed", category: "verifier", subsystem: "mcp-gateway",
    owner: "platform", tier: "integration", sideEffects: "runtime-data",
    requiresFreshContainer: false, ciProfile: "performance", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/observe-mcp-gateway-load.mjs", "tools/server-scripts/stress-mcp-gateway.mjs", "tools/server-scripts/lib/gateway-performance-observation.mjs", "tools/server-scripts/lib/runtime-performance-observation-contract.mjs", "tools/server-scripts/lib/runtime-performance-observer-preload.mjs"], outputs: ["build/reports/gateway-performance-observation.json"],
  },
  "server:stress:gateway-platform": {
    scriptName: "server:stress:gateway-platform", command: "npm run server:stress:gateway-platform", category: "verifier", subsystem: "gateway-platform",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "performance", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/stress-gateway-platform-profile.mjs", "tools/server-scripts/lib/release-evidence-readiness.mjs", "tools/server-scripts/lib/release-evidence-freshness.mjs", "tools/server-scripts/lib/upstream-fixture-transit-evidence.mjs"], outputs: ["build/reports/gateway-platform-profile.json"],
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
      "tests/vitest/server/resource-discipline-policy.test.mjs",
      "tests/vitest/server/job-pipeline-upload-session-persistence.test.mjs",
      "tests/vitest/server/upload-workspace-materialization.test.mjs",
      "tools/server-scripts/verify-resource-discipline.mjs",
      "tools/server-scripts/verify-runtime-memory-leaks.mjs",
      "tools/server-scripts/lib/resource-discipline-analysis.mjs",
      "tools/server-scripts/lib/resource-discipline-policy.mjs",
      "tools/server-scripts/lib/runtime-memory-profiler-preload.mjs",
      "tools/server-scripts/lib/resource-high-risk-workload-child.mjs",
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
      "tools/server-scripts/start-server.mjs",
      "tools/server-scripts/verify-runtime-memory-leaks.mjs",
      "tools/server-scripts/lib/resource-discipline-analysis.mjs",
      "tools/server-scripts/lib/resource-discipline-policy.mjs",
      "tools/server-scripts/lib/runtime-memory-profiler-preload.mjs",
      "tools/server-scripts/lib/resource-high-risk-workload-child.mjs"
    ], outputs: ["build/reports/runtime-resource-discipline.json"],
  },

  // ── Release closure verifiers ─────────────────────────────────────────────
  "verify:acceptance": {
    scriptName: "verify:acceptance", command: "npm run verify:acceptance", category: "verifier", subsystem: "platform-acceptance",
    owner: "platform", tier: "release", sideEffects: "destructive",
    requiresFreshContainer: true, ciProfile: "release", expectedDurationClass: "extended",
    inputs: [
      "tools/server-scripts/verify-platform-acceptance.mjs",
      "tools/server-scripts/lib/platform-acceptance-command-catalog.mjs",
      "tools/server-scripts/lib/platform-acceptance-contract.mjs",
      "tools/server-scripts/lib/platform-acceptance-generation-store.mjs",
      "tools/server-scripts/lib/platform-acceptance-plan-receipts.mjs",
      "tools/server-scripts/lib/platform-acceptance-reducer.mjs",
      "tools/server-scripts/lib/platform-acceptance-requirement-evidence.mjs"
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
      "tools/server-scripts/verify-platform-acceptance.mjs",
      "tools/server-scripts/lib/platform-acceptance-command-catalog.mjs",
      "tools/server-scripts/lib/platform-acceptance-reducer.mjs",
      "tools/server-scripts/lib/platform-acceptance-contract.mjs",
      "tools/server-scripts/lib/platform-acceptance-report-catalog.mjs",
      "tools/server-scripts/lib/private-deployment-open-platform-e2e-catalog.mjs"
    ], outputs: [],
  },
  "verify:version-registry": {
    scriptName: "verify:version-registry", command: "npm run verify:version-registry", category: "version-control", subsystem: "version-governance",
    owner: "platform", tier: "hygiene", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "core", expectedDurationClass: "fast",
    inputs: [
      "packages/foundation/src/version-control/version-registry.json",
      "packages/foundation/src/version-control/version-registry.schema.json",
      "packages/foundation/src/version-control/version-scan.mjs",
      "tools/server-scripts/verify-version-registry.mjs"
    ], outputs: ["build/reports/version-registry/latest.json"],
  },
  "verify:node-runtime-supply-chain": {
    scriptName: "verify:node-runtime-supply-chain", command: "npm run verify:node-runtime-supply-chain", category: "verifier", subsystem: "runtime-supply-chain",
    owner: "platform-security", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "security", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "package-lock.json",
      "tools/server-scripts/verify-node-runtime-supply-chain.mjs"
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
      "tools/server-scripts/prepare-release.mjs"
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
      "tools/server-scripts/package-server-source.mjs",
      "tools/server-scripts/lib/mcp-release-reproducible-archives.mjs"
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
      "tools/server-scripts/publish-release-set.mjs",
      "tools/server-scripts/prepare-release.mjs",
      "tools/server-scripts/lib/npm-cli-invocation.mjs"
    ], outputs: [],
  },
  "release:prepare-node-runtime-source-evidence": {
    scriptName: "release:prepare-node-runtime-source-evidence", command: "npm run release:prepare-node-runtime-source-evidence", category: "packaging", subsystem: "runtime-supply-chain",
    owner: "platform-security", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "package.json",
      "tools/release/node-runtime.lock.json",
      "tools/server-scripts/prepare-node-runtime-source-evidence.mjs",
      "packages/foundation/src/config/server-config.mjs"
    ], outputs: ["build/release/node-runtime-source/**"],
  },
  "release:generate-provenance": {
    scriptName: "release:generate-provenance", command: "npm run release:generate-provenance", category: "packaging", subsystem: "supply-chain",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "package.json",
      "package-lock.json",
      "tools/server-scripts/generate-provenance.mjs",
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
      "tools/server-scripts/verify-npm-package-installability.mjs",
      "tools/server-scripts/lib/lock-backed-npm-registry.mjs"
    ], outputs: ["build/reports/npm-package-installability.json"],
  },
  "verify:better-plan": {
    scriptName: "verify:better-plan", command: "npm run verify:better-plan", category: "verifier", subsystem: "documentation",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: ["tools/server-scripts/verify-better-plan.mjs", "tools/registry/fact-source-authority.registry.json", "README.md", "README.zh-CN.md", "docs/README.md", "docs/RUNBOOK.md", "docs/examples/README.md", "docs/COMPATIBILITY.md", "docs/architecture/ARCHITECTURE.md", "docs/architecture/EXECUTION-SANDBOX.md", "docs/protocols/PROTOCOLS.md", "docs/functionality/**", "docs/architecture/STATE-MACHINES.md"], outputs: ["build/reports/better-plan.json"],
  },
  "plan:next": {
    scriptName: "plan:next", command: "npm run plan:next", category: "maintenance", subsystem: "planning",
    owner: "platform", tier: "hygiene", sideEffects: "none",
    requiresFreshContainer: false, ciProfile: "core", expectedDurationClass: "fast",
    inputs: ["docs/plans/Manifest.json", "docs/plans/end-to-end-release/DependencyMap.json", "docs/plans/**/Checkpoints.json", "tools/plan/*.mjs"], outputs: [],
  },
  "verify:composition-source-package": {
    scriptName: "verify:composition-source-package", command: "npm run verify:composition-source-package", category: "packaging", subsystem: "release-source",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "tools/server-scripts/package-server-source.mjs",
      "tools/server-scripts/lib/mcp-release-reproducible-archives.mjs",
      "tools/server-scripts/verify-composition-source.mjs",
      "tools/server-scripts/verify-composition-source-package.mjs"
    ], outputs: ["build/reports/composition-source-package.json"],
  },
  "verify:release-authority-baseline": {
    scriptName: "verify:release-authority-baseline", command: "npm run verify:release-authority-baseline", category: "verifier", subsystem: "release",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "tools/registry/release-authority-baseline.registry.json",
      "tools/registry/schema/release-authority-baseline.schema.json",
      "tools/verifiers/registry-release-authority-baseline.mjs",
      "tools/server-scripts/verify-release-authority-baseline.mjs",
      "tools/server-scripts/lib/platform-acceptance-command-catalog.mjs",
      "tools/server-scripts/lib/platform-acceptance-report-catalog.mjs",
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
      "tools/server-scripts/verify-release-definition.mjs",
      "package.json",
      "package-lock.json"
    ],
    outputs: [],
  },
  "server:verify:deployment-flow:podman": {
    scriptName: "server:verify:deployment-flow:podman", command: "npm run server:verify:deployment-flow:podman", category: "verifier", subsystem: "deployment",
    owner: "platform", tier: "external", sideEffects: "docker",
    requiresFreshContainer: true, ciProfile: "external", expectedDurationClass: "extended",
    inputs: [
      "tools/server-scripts/verify-deployment-container-flow.mjs",
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
      "apps/server/runtime/http-server.mjs",
      "packages/agents/src/upstream-gateway/**",
      "packages/contracts/src/mcp-catalog-delivery.mjs",
      "packages/protocols/mcp/adapter/http-mcp-adapter*.mjs",
      "packages/server-runtime/src/state/sse-connection-state.mjs",
      "tools/server-scripts/verify-upstream-service-publishing.mjs",
      "tools/server-scripts/lib/mcp-catalog-protocol-peer.mjs",
      "tools/server-scripts/lib/upstream-service-publishing-evidence.mjs"
    ], outputs: ["build/reports/upstream-service-publishing.json"],
  },
  "verify:upstream-gateway-external": {
    scriptName: "verify:upstream-gateway-external", command: "npm run verify:upstream-gateway-external", category: "network-service", subsystem: "upstream-gateway",
    owner: "platform", tier: "external", sideEffects: "network-service",
    requiresFreshContainer: false, ciProfile: "external", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/verify-upstream-gateway-external-compatibility.mjs", "packages/agents/src/upstream-gateway/**"], outputs: ["build/reports/upstream-gateway-external-compatibility.json"],
  },
  "verify:upstream-fixture-transit": {
    scriptName: "verify:upstream-fixture-transit", command: "npm run verify:upstream-fixture-transit", category: "verifier", subsystem: "upstream-gateway",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/verify-upstream-fixture-transit.mjs", "tools/server-scripts/upstream-fixture-service.mjs", "tools/server-scripts/lib/upstream-fixture-service.mjs", "tools/server-scripts/lib/upstream-fixture-transit-evidence.mjs", "tools/server-scripts/lib/upstream-fixture-grant.mjs", "tools/server-scripts/lib/verifier-inprocess-mcp-adapter.mjs", "tools/server-scripts/lib/upstream-gateway-verifier-publication.mjs", "packages/agents/src/upstream-gateway/**", "packages/protocols/mcp/upstream-mcp-*.mjs", "packages/foundation/src/security/secrets/**"], outputs: ["build/reports/upstream-fixture-transit.json"],
  },
  "verify:downstream-agent-tool-loop": {
    scriptName: "verify:downstream-agent-tool-loop", command: "npm run verify:downstream-agent-tool-loop", category: "verifier", subsystem: "downstream-gateway",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/verify-downstream-agent-tool-loop.mjs", "tools/server-scripts/upstream-fixture-service.mjs", "tools/server-scripts/lib/upstream-fixture-service.mjs", "tools/server-scripts/lib/downstream-agent-tool-loop-evidence.mjs", "tools/server-scripts/lib/mcp-neutral-peer-identity-support.mjs", "tools/server-scripts/lib/upstream-fixture-grant.mjs", "tools/server-scripts/lib/mcp-proxy-stdio-client.mjs", "tools/server-scripts/lib/upstream-gateway-verifier-publication.mjs", "packages/agents/src/upstream-gateway/**", "packages/protocols/mcp/upstream-mcp-*.mjs", "packages/protocols/mcp/adapter/http-mcp-adapter*.mjs", "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.mjs", "packages/protocols/mcp/adapter/gateway-installer/lib/**", "packages/capabilities/src/operation-permission-core/**", "packages/foundation/src/security/secrets/**"], outputs: ["build/reports/downstream-agent-tool-loop.json"],
  },
  "verify:mcp-client-identity-proof": {
    scriptName: "verify:mcp-client-identity-proof", command: "npm run verify:mcp-client-identity-proof", category: "verifier", subsystem: "security",
    owner: "platform-security", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "security", expectedDurationClass: "fast",
    inputs: ["tools/server-scripts/verify-mcp-client-identity-proof.mjs", "packages/foundation/src/security/process-identity/**", "packages/capabilities/src/operation-permission-core/**"], outputs: ["build/reports/mcp-client-identity-proof.json"],
  },
  "verify:mcp-process-identity-credential-store": {
    scriptName: "verify:mcp-process-identity-credential-store", command: "npm run verify:mcp-process-identity-credential-store", category: "verifier", subsystem: "security",
    owner: "platform-security", tier: "release", sideEffects: "docker",
    requiresFreshContainer: true, ciProfile: "security", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/verify-mcp-process-identity-credential-store.mjs", "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.mjs", "packages/protocols/mcp/adapter/gateway-installer/lib/**", "packages/protocols/mcp/adapter/native-installer/**"], outputs: ["build/reports/mcp-process-identity-credential-store.json"],
  },
  "verify:mcp-windows-process-identity-credential-store": {
    scriptName: "verify:mcp-windows-process-identity-credential-store", command: "npm run verify:mcp-windows-process-identity-credential-store", category: "verifier", subsystem: "security",
    owner: "platform-security", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "security", expectedDurationClass: "fast",
    inputs: ["tools/server-scripts/verify-mcp-windows-process-identity-credential-store.mjs", "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.mjs", "packages/protocols/mcp/adapter/gateway-installer/lib/**"], outputs: ["build/reports/mcp-windows-process-identity-credential-store.json"],
  },
  "verify:mcp-release-portable-assembly": {
    scriptName: "verify:mcp-release-portable-assembly", command: "npm run verify:mcp-release-portable-assembly", category: "verifier", subsystem: "downstream-mcp",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/verify-mcp-release-portable-assembly.mjs", "tools/server-scripts/lib/mcp-release-portable.mjs", "tools/server-scripts/lib/mcp-release-reproducible-archives.mjs", "tools/server-scripts/lib/mcp-release-common.mjs", "packages/protocols/mcp/adapter/gateway-installer/**", "packages/protocols/mcp/adapter/native-installer/**"], outputs: ["build/reports/mcp-release-portable-assembly.json"],
  },
  "verify:mcp-final-release-asset": {
    scriptName: "verify:mcp-final-release-asset", command: "npm run verify:mcp-final-release-asset", category: "verifier", subsystem: "downstream-mcp",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: ["build/release/mcp/**", "tools/server-scripts/verify-mcp-final-release-asset.mjs"], outputs: ["build/reports/mcp-final-release-asset.json"],
  },
  "verify:mcp-proxy-transport": {
    scriptName: "verify:mcp-proxy-transport", command: "npm run verify:mcp-proxy-transport", category: "verifier", subsystem: "downstream-mcp",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/verify-mcp-proxy-transport.mjs", "tools/server-scripts/lib/mcp-neutral-peer-identity-support.mjs", "tools/server-scripts/lib/mcp-neutral-peer-protocol-support.mjs", "tools/server-scripts/lib/mcp-proxy-stdio-client.mjs", "tools/server-scripts/lib/mcp-proxy-transport-evidence.mjs", "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.mjs", "packages/protocols/mcp/adapter/gateway-installer/lib/**", "packages/capabilities/src/operation-permission-core/**"], outputs: ["build/reports/mcp-proxy-transport.json"],
  },
  "verify:path-abstraction-audit": {
    scriptName: "verify:path-abstraction-audit", command: "npm run verify:path-abstraction-audit", category: "verifier", subsystem: "path-boundary",
    owner: "platform-security", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "security", expectedDurationClass: "fast",
    inputs: ["tools/server-scripts/verify-path-abstraction-audit.mjs", "packages/foundation/src/security/local-path-boundary.mjs", "packages/foundation/src/module-system/plugin-data-capability.mjs", "packages/agents/src/agent-workspace/**"], outputs: ["build/reports/path-abstraction-audit.json"],
  },
  "verify:controlled-execution-sandbox": {
    scriptName: "verify:controlled-execution-sandbox", command: "npm run verify:controlled-execution-sandbox", category: "verifier", subsystem: "execution-sandbox",
    owner: "platform-security", tier: "release", sideEffects: "docker",
    requiresFreshContainer: true, ciProfile: "security", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/verify-controlled-execution-sandbox.mjs", "tools/server-scripts/verify-execution-sandbox-oci-conformance.mjs", "tools/server-scripts/verify-opaque-sandbox-custody.mjs", "tools/verifiers/execution-launcher-boundary.mjs", "packages/foundation/src/execution-sandbox/**", "packages/foundation/src/storage/**", "packages/server-runtime/src/execution-sandbox/**"], outputs: ["build/reports/controlled-execution-sandbox.json", "build/reports/execution-sandbox-oci-conformance.json", "build/reports/opaque-sandbox-custody.json", "build/reports/execution-launcher-boundary.json"],
  },
  "verify:controlled-execution-convergence": {
    scriptName: "verify:controlled-execution-convergence", command: "npm run verify:controlled-execution-convergence", category: "verifier", subsystem: "execution-sandbox",
    owner: "platform-security", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "security", expectedDurationClass: "fast",
    inputs: ["tools/server-scripts/verify-controlled-execution-convergence.mjs", "tools/server-scripts/lib/controlled-execution-convergence-reducer.mjs", "tools/plan/current-plan-receipt.mjs", "docs/plans/end-to-end-release/capability-runtime/controlled-execution-convergence/**", "docs/plans/end-to-end-release/DependencyMap.json", "build/reports/controlled-execution-sandbox.json", "build/reports/execution-sandbox-oci-conformance.json", "build/reports/opaque-sandbox-custody.json", "build/reports/execution-launcher-boundary.json"], outputs: ["build/reports/controlled-execution-convergence-final.json"],
  },
  "verify:security-alert-lifecycle": {
    scriptName: "verify:security-alert-lifecycle", command: "npm run verify:security-alert-lifecycle", category: "verifier", subsystem: "security",
    owner: "platform-security", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "security", expectedDurationClass: "fast",
    inputs: ["tools/server-scripts/verify-security-alert-lifecycle.mjs", "packages/foundation/src/security/security-alerts.mjs"], outputs: ["build/reports/security-alert-lifecycle.json"],
  },
  "verify:console-redundancy": {
    scriptName: "verify:console-redundancy", command: "npm run verify:console-redundancy", category: "verifier", subsystem: "console",
    owner: "frontend", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: ["tools/server-scripts/verify-console-redundancy.mjs", "apps/console/**", "packages/ui-console/**"], outputs: ["build/reports/console-redundancy.json"],
  },
  "verify:console-admin-browser-visual": {
    scriptName: "verify:console-admin-browser-visual", command: "npm run verify:console-admin-browser-visual", category: "verifier", subsystem: "console",
    owner: "frontend", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "long",
    inputs: [
      "tools/server-scripts/verify-console-admin-browser-visual.mjs",
      "tools/server-scripts/lib/console-admin-browser-assertions.mjs",
      "tools/server-scripts/lib/console-admin-browser-fixture.mjs",
      "apps/console/**",
      "packages/ui-console/**",
      "plugins/*/console/**",
      "build/dist/**"
    ], outputs: [
      "build/reports/console-admin-browser-visual.json",
      "build/reports/console-admin-browser-visual-screenshots/**"
    ],
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
      "tools/registry/architecture-layout-facade.mjs",
      "tools/server-scripts/verify-repo-organization.mjs",
      "tools/server-scripts/lib/repo-organization-ast-advisory.mjs",
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
    inputs: ["tools/server-scripts/doctor.mjs"], outputs: [],
  },
  "server:locate": {
    scriptName: "server:locate", command: "npm run server:locate", category: "maintenance", subsystem: "storage",
    owner: "platform", tier: "hygiene", sideEffects: "none",
    requiresFreshContainer: false, ciProfile: "hygiene", expectedDurationClass: "fast",
    inputs: ["tools/server-scripts/locate-storage.mjs"], outputs: [],
  },
  "server:reconcile": {
    scriptName: "server:reconcile", command: "npm run server:reconcile", category: "maintenance", subsystem: "storage",
    owner: "platform", tier: "integration", sideEffects: "runtime-data",
    requiresFreshContainer: false, ciProfile: "core", expectedDurationClass: "standard",
    inputs: ["tools/server-scripts/reconcile-storage.mjs"], outputs: [],
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
      "tools/server-scripts/verify-server-runtime.mjs",
      "tools/server-scripts/lib/server-regression-command-runner.mjs",
      "tools/scripts/package-script-registry.mjs",
      "tools/scripts/package-script-registry-catalog.mjs"
    ], outputs: ["build/reports/server-runtime-verification.json"],
  },
  "server:verify:headless": {
    scriptName: "server:verify:headless", command: "npm run server:verify:headless", category: "verifier", subsystem: "server",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "audit", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "tools/server-scripts/verify-server-headless.mjs",
      "tools/server-scripts/lib/server-regression-command-runner.mjs",
      "tools/server-scripts/verify-public-boundary.mjs",
      "tools/server-scripts/verify-strategy-management.mjs",
      "tools/server-scripts/verify-agent-gateway.mjs",
      "tools/server-scripts/verify-model-routing.mjs"
    ], outputs: ["build/reports/server-headless-verification.json"],
  },
  "server:verify:checkpoints": {
    scriptName: "server:verify:checkpoints", command: "npm run server:verify:checkpoints", category: "verifier", subsystem: "workspace",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "audit", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "tools/server-scripts/verify-server-checkpoints.mjs",
      "tools/server-scripts/lib/server-regression-command-runner.mjs",
      "tools/server-scripts/verify-workspace-file-ops.mjs",
      "tools/server-scripts/verify-workspace-checkpoint-protocol.mjs"
    ], outputs: ["build/reports/server-checkpoints-verification.json"],
  },
  "server:verify:upload-workspace-materialization": {
    scriptName: "server:verify:upload-workspace-materialization", command: "npm run server:verify:upload-workspace-materialization", category: "verifier", subsystem: "jobs",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "audit", expectedDurationClass: "fast",
    inputs: [
      "package.json",
      "packages/server-runtime/src/jobs/upload-workspace-materialization.mjs",
      "packages/server-runtime/src/state/upload-session-store.mjs",
      "packages/agents/src/agent-workspace/agent-workspace-file-write-api.mjs",
      "tools/server-scripts/verify-upload-workspace-materialization.mjs"
    ], outputs: ["build/reports/upload-workspace-materialization.json"],
  },
  "server:verify:ops": {
    scriptName: "server:verify:ops", command: "npm run server:verify:ops", category: "verifier", subsystem: "operations",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "audit", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "tools/server-scripts/verify-server-ops.mjs",
      "tools/server-scripts/lib/server-regression-command-runner.mjs",
      "tools/server-scripts/verify-backup-restore.mjs",
      "tools/server-scripts/verify-storage-production-restore-drill.mjs",
      "tools/server-scripts/verify-job-work-queue.mjs",
      "tools/server-scripts/verify-work-queue-conformance.mjs",
      "tools/server-scripts/verify-deployment-index.mjs"
    ], outputs: ["build/reports/server-ops-verification.json"],
  },
  "server:verify:rebuild": {
    scriptName: "server:verify:rebuild", command: "npm run server:verify:rebuild", category: "verifier", subsystem: "state-rebuild",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "audit", expectedDurationClass: "standard",
    inputs: [
      "package.json",
      "tools/server-scripts/verify-server-rebuild.mjs",
      "tools/server-scripts/lib/server-regression-command-runner.mjs",
      "tools/server-scripts/verify-job-work-queue.mjs",
      "tools/server-scripts/verify-work-queue-conformance.mjs",
      "tools/server-scripts/verify-tag-management.mjs",
      "tools/server-scripts/verify-operation-permission-universal-tag-policy.mjs"
    ], outputs: ["build/reports/server-rebuild-verification.json"],
  },
  "server:verify:script-registry": {
    scriptName: "server:verify:script-registry", command: "npm run server:verify:script-registry", category: "verifier", subsystem: "tests",
    owner: "platform", tier: "hygiene", sideEffects: "none",
    requiresFreshContainer: false, ciProfile: "hygiene", expectedDurationClass: "fast",
    inputs: [
      "package.json",
	      "tests/verify-script-registry.mjs",
	      "tools/registry/tests.registry.json",
      "tools/registry/fact-source-authority.registry.json",
      "tools/registry/schema/fact-source-authority.schema.json",
      "tools/scripts/package-script-registry.mjs",
      "tools/scripts/package-script-registry-catalog.mjs",
      "tools/server-scripts/verify-server-runtime.mjs",
      "tools/server-scripts/verify-server-headless.mjs",
      "tools/server-scripts/verify-server-checkpoints.mjs",
      "tools/server-scripts/verify-server-ops.mjs",
      "tools/server-scripts/verify-server-rebuild.mjs",
      "tools/server-scripts/lib/server-regression-command-runner.mjs",
	      "tools/server-scripts/lib/platform-acceptance-report-catalog.mjs",
	      "tools/server-scripts/lib/platform-acceptance-command-catalog.mjs",
	      "tools/server-scripts/lib/platform-acceptance-reducer.mjs",
	      "tools/server-scripts/lib/private-deployment-open-platform-e2e-catalog.mjs",
	      "tools/server-scripts/verify-platform-acceptance.mjs",
      "tools/server-scripts/production-readiness-gate.mjs",
      "tools/server-scripts/verify-private-deployment-open-platform-e2e.mjs",
      "tools/server-scripts/verify-upstream-fixture-transit.mjs",
      "tools/server-scripts/verify-downstream-agent-tool-loop.mjs",
      "tools/server-scripts/stress-gateway-platform-profile.mjs",
      "tools/server-scripts/verify-mcp-process-identity-credential-store.mjs",
      "tools/server-scripts/lib/verifier-termination-signals.mjs",
      "tools/server-scripts/verify-mcp-proxy-transport.mjs",
	      "tools/server-scripts/lib/release-evidence-readiness.mjs",
	      "tools/server-scripts/lib/release-evidence-freshness.mjs",
	      "tools/server-scripts/lib/upstream-fixture-transit-evidence.mjs",
      "tools/server-scripts/lib/downstream-agent-tool-loop-evidence.mjs",
      "tools/server-scripts/lib/mcp-process-identity-credential-store-evidence.mjs",
      "tools/server-scripts/lib/mcp-proxy-transport-evidence.mjs",
	      "tools/server-scripts/verify-observability-semantics.mjs",
      "packages/protocols/mcp/adapter/mcp-release-targets.mjs",
      "packages/protocols/mcp/adapter/http-mcp-adapter-constants.mjs",
      "packages/protocols/mcp/adapter/gateway-installer/lib/cli/constants.mjs",
      "tools/server-scripts/verify-mcp-release-target-scope.mjs"
    ], outputs: ["build/reports/script-registry.json"],
  },
  "server:verify:state-machines": {
    scriptName: "server:verify:state-machines", command: "npm run server:verify:state-machines", category: "verifier", subsystem: "state-machine",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "tools/server-scripts/verify-state-machines.mjs",
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
      "tools/server-scripts/verify-protocol-boundary.mjs",
      "packages/protocols/**",
      "apps/server/runtime/http-server-routes.mjs",
      "packages/server-runtime/src/composition/mcp-identity-provider.mjs",
      "packages/server-runtime/src/composition/mcp-notification-bus-binding.mjs",
      "packages/server-runtime/src/composition/discovery-config.mjs"
    ], outputs: ["build/reports/protocol-boundary.json"],
  },
  "server:deployment-index": {
    scriptName: "server:deployment-index", command: "npm run server:deployment-index", category: "maintenance", subsystem: "deployment",
    owner: "platform", tier: "hygiene", sideEffects: "none",
    requiresFreshContainer: false, ciProfile: "core", expectedDurationClass: "fast",
    inputs: [
      "packages/foundation/config/deployment/index.json",
      "tools/server-scripts/deployment-index.mjs"
    ], outputs: [],
  },
  "server:verify:strategy-management-browser": {
    scriptName: "server:verify:strategy-management-browser", command: "npm run server:verify:strategy-management-browser", category: "verifier", subsystem: "strategy-management",
    owner: "platform", tier: "integration", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "core", expectedDurationClass: "standard",
    inputs: [
      "build/dist/**",
      "apps/server/runtime/http-server.mjs",
      "apps/console/views/admin/StrategyManagementView.vue",
      "apps/console/lib/strategy-management.ts",
      "tools/server-scripts/verify-strategy-management-browser.mjs",
      "tools/server-scripts/lib/console-admin-browser-fixture.mjs"
    ], outputs: ["build/reports/strategy-management-browser.json"],
  },
  "verify:capability-acceptance-machines": {
    scriptName: "verify:capability-acceptance-machines", command: "npm run verify:capability-acceptance-machines", category: "verifier", subsystem: "state-machine",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "tools/server-scripts/verify-capability-acceptance-machines.mjs",
      "tools/server-scripts/lib/plugin-runtime-capability-bindings.mjs",
      "tools/registry/capability-acceptance.registry.json",
      "tools/registry/capability-acceptance-checkpoints/*.json",
      "packages/foundation/src/workflow/state-machine/definitions/acceptance/**",
      "packages/foundation/src/module-system/plugin-registry.mjs",
      "plugins/*/plugin.json",
      "apps/server/runtime/http-server.mjs",
      "packages/server-runtime/src/composition/http-application-assembly.mjs",
      "packages/server-runtime/src/composition/server-runtime-providers.mjs",
      "packages/protocols/http/controllers/system-controller.mjs",
      "packages/protocols/mcp/adapter/http-mcp-adapter-replies.mjs",
      "packages/server-runtime/src/composition/console-domain/operation-executor.mjs"
    ], outputs: ["build/reports/capability-acceptance-machines.json"],
  },
  "verify:plugin-bundle-protocol": {
    scriptName: "verify:plugin-bundle-protocol", command: "npm run verify:plugin-bundle-protocol", category: "verifier", subsystem: "module-system",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "tools/server-scripts/verify-plugin-bundle-protocol.mjs",
      "packages/contracts/src/plugins",
      "packages/foundation/src/module-system/plugin-package-tar.mjs",
      "packages/foundation/src/module-system/plugin-package-validator.mjs",
      "packages/foundation/src/module-system/plugin-package-custody.mjs",
      "packages/foundation/src/module-system/plugin-package-acquisition-port.mjs",
      "packages/foundation/src/module-system/plugin-package-lifecycle.mjs",
      "packages/server-runtime/src/composition/plugin-contribution-transaction.mjs",
      "tests/vitest/server/plugin-package-protocol.test.mjs"
    ], outputs: ["build/reports/plugin-bundle-protocol.json"],
  },
  "verify:plugin-runtime": {
    scriptName: "verify:plugin-runtime", command: "npm run verify:plugin-runtime", category: "verifier", subsystem: "module-system",
    owner: "platform", tier: "release", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "release", expectedDurationClass: "fast",
    inputs: [
      "tools/server-scripts/verify-plugin-bundle-protocol.mjs",
      "tools/server-scripts/verify-plugin-runtime.mjs",
      "tools/server-scripts/start-server.mjs",
      "tools/server-scripts/lib/plugin-runtime-capability-bindings.mjs",
      "tools/server-scripts/lib/runtime-plugin-selection.mjs",
      "packages/foundation/src/module-system/plugin-registry.mjs",
      "packages/foundation/src/module-system/plugin-runtime.mjs",
      "packages/foundation/src/module-system/plugin-package-lifecycle.mjs",
      "packages/foundation/src/module-system/mount-config.mjs",
      "packages/foundation/src/module-system/mount-manager.mjs",
      "packages/contracts/src/plugins",
      "packages/server-runtime/src/composition/plugin-contribution-transaction.mjs",
      "apps/server/runtime/http-server.mjs",
      "packages/server-runtime/src/composition/http-application-assembly.mjs",
      "packages/server-runtime/src/composition/server-runtime-providers.mjs",
      "packages/protocols/http/controllers/system-controller.mjs",
      "packages/protocols/mcp/adapter/http-mcp-adapter-replies.mjs",
      "packages/server-runtime/src/composition/console-domain/operation-executor.mjs",
      "plugins/plugin.schema.json",
      "plugins/*/plugin.json"
    ], outputs: ["build/reports/plugin-bundle-protocol.json", "build/reports/plugin-runtime.json"],
  },
  "server:verify:architecture-graph": {
    scriptName: "server:verify:architecture-graph", command: "npm run server:verify:architecture-graph", category: "verifier", subsystem: "tests",
    owner: "platform", tier: "hygiene", sideEffects: "build-output",
    requiresFreshContainer: false, ciProfile: "hygiene", expectedDurationClass: "standard",
    inputs: ["apps/server/**", "packages/**", "plugins/plugin.schema.json", "apps/console/**", "tools/**"], outputs: ["build/reports/architecture-graph.json", "build/reports/architecture-graph.md"],
  },
});

/** @type {Readonly<Record<string, ScriptEntry>>} */
export const SCRIPT_REGISTRY = RAW_SCRIPT_REGISTRY;

/**
 * Scripts that are explicitly allowed to exist without a full registry entry
 * (e.g., composite scripts that chain other registered scripts).
 */
export const UNCLASSIFIED_ALLOWLIST = Object.freeze([
  "dev",                      // Direct development server entrypoint
  "build",                    // Direct workspace build entrypoint
  "test",                     // Public test profile alias
  "typecheck",                // TypeScript compiler gate
  "verify",                   // Composite local verification gate
  "verify:security",          // run-verifiers security profile
  "verify:docs",              // run-verifiers documentation profile
  "verify:registry",          // Registry validator plus generated artifact check
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
