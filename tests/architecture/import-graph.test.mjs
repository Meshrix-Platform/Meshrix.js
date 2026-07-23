#!/usr/bin/env node
/**
 * import-graph.test.mjs — Architecture Graph Verification Test
 *
 * Imports the registry-driven verifier and asserts no constraint violations.
 * Run via: node tests/architecture/import-graph.test.mjs
 *
 * This is the canonical test for the architecture graph verifier.
 */

import assert from "node:assert/strict";

import {
  extractImportEntries,
  extractImportSpecifiers,
  matchingDependencyConstraints,
  normalizeLayers,
  runArchitectureGraph
} from "../../tools/verifiers/architecture-graph.mjs";

async function test() {
  console.log("[test:architecture-graph] Running registry-driven architecture verifier...");

  const result = await runArchitectureGraph({ verbose: false });

  const { constraintFindings, graph, violations } = result;

  assert.deepEqual(
    extractImportSpecifiers(`
      // import "comment-only";
      const source = 'import "string-only"';
      import value from "real-static";
      export { other } from "real-export";
      await import("real-dynamic");
    `),
    ["real-static", "real-export", "real-dynamic"],
    "import extraction must ignore comments and ordinary strings"
  );
  assert.deepEqual(
    extractImportEntries(`
      import value from "real-static";
      await import("real-dynamic");
    `),
    [
      { specifier: "real-static", dynamic: false },
      { specifier: "real-dynamic", dynamic: true }
    ],
    "import extraction must distinguish static and dynamic imports"
  );
  assert.throws(
    () => normalizeLayers({ layers: [] }),
    /at least one layer/u,
    "an empty dependency registry must fail closed"
  );
  assert.throws(
    () => normalizeLayers({
      layers: [{
        id: "only",
        directory: "packages/only",
        allowedDependsOn: ["missing"],
        forbiddenDependsOn: ["missing"]
      }]
    }),
    /unknown layer|reference itself|both allows and forbids/u,
    "unknown or contradictory layer references must fail closed"
  );
  assert.equal(graph.summary.unresolvedImportCount, 0, "all internal imports must resolve");
  assert.equal(
    graph.summary.manifestDependencyViolationCount,
    0,
    "workspace runtime imports must be declared in their package manifests"
  );
  assert.ok(
    graph.constraints.some((constraint) => constraint.rule === "agents-dependencies-must-be-allowlisted"),
    "allowlist constraints must be enforced"
  );
  assert.equal(
    violations.filter((violation) => violation.rule.endsWith("layer-unclassified")).length,
    0,
    "all scanned production sources and internal targets must be classified"
  );
  assert.ok(
    graph.edges.some((edge) => (
      edge.from === "apps/server/runtime/http-server.mjs" &&
      edge.specifier === "#lico/server-runtime/composition/http-application-assembly" &&
      edge.to === "packages/server-runtime/src/composition/http-application-assembly.mjs"
    )),
    "the HTTP application adapter must delegate provider wiring to the server composition assembly"
  );
  assert.ok(
    graph.nodes.some((node) => node.layer === "ui-console"),
    "UI console adapter must be represented as an explicit layer"
  );
  assert.equal(
    graph.edges.some((edge) => edge.fromLayer === "ui-console" && edge.toLayer === "server-runtime"),
    false,
    "UI console must consume settings and discovery through composition-injected ports instead of importing server-runtime"
  );
  assert.ok(
    graph.constraints.some((constraint) => (
      constraint.rule === "server-runtime-must-not-depend-on-plugins" &&
      constraint.forbiddenLayer === "plugins"
    )),
    "server runtime must explicitly forbid reverse dependencies on optional plugins"
  );
  assert.ok(
    graph.constraints.some((constraint) => (
      constraint.rule === "plugin-console-must-not-depend-on-apps" &&
      constraint.forbiddenLayer === "apps"
    )),
    "plugin console adapters must consume public packages instead of console app implementation paths"
  );
  const pluginPublicPackageConstraint = graph.constraints.find((constraint) => (
    constraint.rule === "plugin-production-relative-imports-use-public-packages"
  ));
  assert.ok(pluginPublicPackageConstraint, "plugin relative implementation import policy must be registry-backed");
  const runtimeCompositionConstraint = graph.constraints.find((constraint) => (
    constraint.rule === "server-runtime-cross-layer-wiring-requires-composition"
  ));
  assert.ok(runtimeCompositionConstraint, "server runtime cross-layer wiring policy must be registry-backed");
  const uiProviderConstraint = graph.constraints.find((constraint) => (
    constraint.rule === "ui-console-stateful-providers-require-composition"
  ));
  assert.ok(uiProviderConstraint, "UI stateful provider construction policy must be registry-backed");
  const controllerSecurityConstraint = graph.constraints.find((constraint) => (
    constraint.rule === "http-controllers-require-composed-security-ports"
  ));
  assert.ok(controllerSecurityConstraint, "HTTP controller security authority policy must be registry-backed");
  const syntheticRuntimeConstraint = {
    id: "server-runtime-cross-layer-wiring-requires-composition",
    fromPattern: "packages/server-runtime/src/**",
    excludedFromPatterns: ["packages/server-runtime/src/composition/**"],
    fromLayers: ["server-runtime"],
    specifierKinds: ["relative", "package", "package-import"],
    forbiddenTargets: ["packages/agents/**", "packages/capabilities/**", "packages/protocols/**"],
    severity: "error"
  };
  assert.deepEqual(
    matchingDependencyConstraints({
      from: "packages/server-runtime/src/state/example.mjs",
      fromLayer: "server-runtime",
      to: "packages/agents/src/example.mjs",
      specifier: "#lico/agents/example"
    }, [syntheticRuntimeConstraint]).map((constraint) => constraint.id),
    [syntheticRuntimeConstraint.id],
    "cross-layer wiring outside server composition must match the registered constraint"
  );
  assert.deepEqual(
    matchingDependencyConstraints({
      from: "packages/server-runtime/src/composition/example.mjs",
      fromLayer: "server-runtime",
      to: "packages/agents/src/example.mjs",
      specifier: "#lico/agents/example"
    }, [syntheticRuntimeConstraint]),
    [],
    "server composition must remain the explicit cross-layer wiring boundary"
  );
  assert.deepEqual(
    matchingDependencyConstraints({
      from: "packages/ui-console/src/example.mjs",
      fromLayer: "ui-console",
      to: "packages/agents/src/workspace-governance/index.mjs",
      specifier: "@lico/agents/workspace-governance/index"
    }, [{
      id: "ui-console-stateful-providers-require-composition",
      fromPattern: "packages/ui-console/src/**",
      fromLayers: ["ui-console"],
      specifierKinds: ["package"],
      forbiddenTargets: ["packages/agents/src/workspace-governance/**"],
      severity: "error"
    }]).map((constraint) => constraint.id),
    ["ui-console-stateful-providers-require-composition"],
    "UI console sources must receive stateful provider ports instead of importing their factories"
  );
  assert.deepEqual(
    matchingDependencyConstraints({
      from: "packages/protocols/http/controllers/example.mjs",
      fromLayer: "protocols",
      to: "packages/foundation/src/security/security-permissions-provider.mjs",
      specifier: "#lico/foundation/security/security-permissions-provider"
    }, [{
      id: "http-controllers-require-composed-security-ports",
      fromPattern: "packages/protocols/http/controllers/**",
      fromLayers: ["protocols"],
      specifierKinds: ["package-import"],
      forbiddenTargets: ["packages/foundation/src/security/security-permissions-provider.mjs"],
      severity: "error"
    }]).map((constraint) => constraint.id),
    ["http-controllers-require-composed-security-ports"],
    "HTTP controllers must receive the composed security authority port"
  );
  const syntheticConstraint = {
    id: "plugin-production-relative-imports-use-public-packages",
    fromPattern: "plugins/**",
    fromLayers: ["plugins", "plugin-console"],
    specifierKinds: ["relative"],
    forbiddenTargets: ["apps/**", "packages/**", "tools/**"],
    severity: "error"
  };
  assert.deepEqual(
    matchingDependencyConstraints({
      from: "plugins/example/console/View.vue",
      fromLayer: "plugin-console",
      to: "packages/ui-console/src/page-refresh.ts",
      specifier: "../../../packages/ui-console/src/page-refresh"
    }, [syntheticConstraint]).map((constraint) => constraint.id),
    [syntheticConstraint.id],
    "relative plugin imports into monorepo implementation roots must match the registered constraint"
  );
  assert.deepEqual(
    matchingDependencyConstraints({
      from: "plugins/example/console/View.vue",
      fromLayer: "plugin-console",
      to: "packages/ui-console/src/page-refresh.ts",
      specifier: "@lico/ui-console/page-refresh"
    }, [syntheticConstraint]),
    [],
    "public package exports must remain allowed even when they resolve into a workspace package"
  );
  assert.deepEqual(
    matchingDependencyConstraints({
      from: "plugins/example/tests/view.test.ts",
      fromLayer: "plugin-tests",
      to: "packages/ui-console/src/page-refresh.ts",
      specifier: "../../../packages/ui-console/src/page-refresh"
    }, [syntheticConstraint]),
    [],
    "plugin tests and verifiers must remain outside the production import constraint"
  );
  assert.deepEqual(
    constraintFindings.filter((finding) => finding.rule === syntheticConstraint.id),
    [],
    "all live plugin production imports must use public package exports"
  );
  assert.deepEqual(
    constraintFindings.filter((finding) => [
      "ui-console-stateful-providers-require-composition",
      "http-controllers-require-composed-security-ports"
    ].includes(finding.rule)),
    [],
    "all live UI and HTTP controller provider wiring must flow through composition"
  );
  assert.equal(
    graph.edges.some((edge) => (
      ["contracts", "foundation", "agents", "capabilities", "protocols", "server-runtime", "ui-console", "apps"].includes(edge.fromLayer) &&
      ["plugins", "plugin-console", "plugin-verifiers", "plugin-tests"].includes(edge.toLayer)
    )),
    false,
    "core production layers must not import optional plugin implementation layers"
  );
  const crossPluginImplementationEdges = graph.edges.filter((edge) => {
    if (edge.fromLayer !== "plugins" || edge.toLayer !== "plugins") return false;
    const fromPlugin = String(edge.from || "").split("/")[1] || "";
    const toPlugin = String(edge.to || "").split("/")[1] || "";
    return fromPlugin && toPlugin && fromPlugin !== toPlugin;
  });
  assert.deepEqual(
    crossPluginImplementationEdges,
    [],
    "optional plugins must use public contracts and manifest dependencies instead of another plugin's implementation"
  );

  assert.ok(
    graph.edges.some((edge) => edge.family === "workspace-package" && edge.specifier.startsWith("@lico/")),
    "the graph must cover @lico/* workspace package imports"
  );
  assert.ok(
    graph.summary.relativeEdgeCount > 0,
    "architecture graph reports must count relative edges"
  );
  assert.ok(
    graph.summary.packageImportEdgeCount > 0,
    "architecture graph reports must count #lico/* package-import edges"
  );
  assert.ok(
    graph.summary.workspacePackageEdgeCount > 0,
    "architecture graph reports must count @lico/* workspace-package edges"
  );
  assert.ok(
    Number.isInteger(graph.summary.dynamicInternalEdgeCount),
    "architecture graph reports must count dynamic internal edges"
  );
  assert.equal(
    graph.summary.relativeEdgeCount +
      graph.summary.packageImportEdgeCount +
      graph.summary.workspacePackageEdgeCount +
      graph.edges.filter((edge) => !["relative", "package-import", "workspace-package"].includes(edge.family)).length,
    graph.summary.totalEdges,
    "every resolved edge must belong to a counted specifier family"
  );
  assert.equal(
    violations.filter((violation) => violation.rule === "unsupported-import-specifier-family").length,
    0,
    "no current production import specifier family may be silently ignored"
  );

  console.log(`  Nodes: ${graph.summary.totalNodes}`);
  console.log(`  Edges: ${graph.summary.totalEdges}`);
  console.log(`  Relative: ${graph.summary.relativeEdgeCount}`);
  console.log(`  #lico/*: ${graph.summary.packageImportEdgeCount}`);
  console.log(`  @lico/*: ${graph.summary.workspacePackageEdgeCount}`);
  console.log(`  Dynamic: ${graph.summary.dynamicInternalEdgeCount}`);
  console.log(`  Constraints: ${graph.constraints.length} rules`);
  console.log(`  Violations: ${violations.length}`);
  console.log(`  Exceptions: ${graph.summary.exceptionCount}`);
  console.log(`  Registry-driven: ${graph.registryDriven}`);

  if (violations.length > 0) {
    console.error(`\nFAILED: ${violations.length} constraint violation(s) found:\n`);
    for (const v of violations) {
      console.error(`  - ${v.rule}: ${v.from} -> ${v.to} (${v.specifier})`);
      if (v.message) console.error(`    ${v.message}`);
    }
    process.exitCode = 1;
    throw new Error(`Architecture constraint violations: ${violations.length}`);
  }

  console.log("\nPASSED: No architecture constraint violations.");
  console.log("       All registry-driven dependency rules satisfied.\n");
}

test().catch((error) => {
  process.exitCode = 1;
  console.error(error);
});
