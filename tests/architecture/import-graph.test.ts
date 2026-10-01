#!/usr/bin/env node
/**
 * import-graph.test.ts — Architecture Graph Verification Test
 *
 * Imports the registry-driven verifier and asserts no constraint violations.
 * Run via: node tests/architecture/import-graph.test.ts
 *
 * This is the canonical test for the architecture graph verifier. It drives
 * both the live repository scan and the analyzer's focused normal/violating
 * fixtures for edge classification, runtime cycles, and public facades.
 */

import assert from "node:assert/strict";

import {
  classifyImportEntries,
  collectEntryClosure,
  componentOf,
  extractImportEntries,
  extractImportSpecifiers,
  findFacadeBoundaryViolations,
  findStaticRuntimeCycles,
  isProductionConsumerPath,
  layerDependencyViolation,
  matchingDependencyConstraints,
  normalizeLayers,
  runArchitectureGraph
} from "../../tools/verifiers/architecture-graph.ts";

function runtimeEdge(from?: any, to?: any, classification: any = "runtime") : any {
  return { from, to, specifier: to, classification };
}

async function test() : Promise<any> {
  console.log("[test:architecture-graph] Running registry-driven architecture verifier...");

  const result: any = await runArchitectureGraph({ verbose: false });

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

  assert.deepEqual(
    classifyImportEntries(`
      import value from "static-runtime";
      import type { OnlyType } from "type-import";
      import { type NamedType, type OtherType } from "named-type-only";
      import { type MixedType, runtimeValue } from "mixed-import";
      import DefaultValue, { type DefaultNamed } from "default-type-mixed";
      export { type ReExportedType } from "type-reexport";
      export type { DeclaredType } from "declared-type-reexport";
      export { type MixedReExport, reExportedValue } from "mixed-reexport";
      export * from "star-reexport";
      export { named } from "named-reexport";
      type Query = typeof import("type-query");
      type Imported = import("import-type").Thing;
      const lazy = async () => import("lazy-dynamic");
      import "side-effect";
    `),
    [
      { specifier: "static-runtime", dynamic: false, classification: "runtime" },
      { specifier: "type-import", dynamic: false, classification: "type-only" },
      { specifier: "named-type-only", dynamic: false, classification: "type-only" },
      { specifier: "mixed-import", dynamic: false, classification: "runtime" },
      { specifier: "default-type-mixed", dynamic: false, classification: "runtime" },
      { specifier: "type-reexport", dynamic: false, classification: "type-only" },
      { specifier: "mixed-reexport", dynamic: false, classification: "runtime" },
      { specifier: "star-reexport", dynamic: false, classification: "runtime" },
      { specifier: "named-reexport", dynamic: false, classification: "runtime" },
      { specifier: "type-query", dynamic: true, classification: "type-only" },
      { specifier: "import-type", dynamic: true, classification: "type-only" },
      { specifier: "lazy-dynamic", dynamic: true, classification: "dynamic" },
      { specifier: "side-effect", dynamic: false, classification: "runtime" },
      { specifier: "declared-type-reexport", dynamic: false, classification: "type-only" }
    ],
    "edge classification must separate static runtime, type-only (including named type specifiers and type queries), and dynamic imports"
  );

  assert.deepEqual(
    findStaticRuntimeCycles([
      runtimeEdge("packages/a/src/one.ts", "packages/b/src/two.ts"),
      runtimeEdge("packages/b/src/two.ts", "packages/c/src/three.ts")
    ]),
    [],
    "an acyclic static runtime graph must report no cycle"
  );
  assert.deepEqual(
    findStaticRuntimeCycles([
      runtimeEdge("packages/a/src/one.ts", "packages/b/src/two.ts"),
      runtimeEdge("packages/b/src/two.ts", "packages/c/src/three.ts"),
      runtimeEdge("packages/c/src/three.ts", "packages/a/src/one.ts")
    ]),
    [[
      "packages/a/src/one.ts",
      "packages/b/src/two.ts",
      "packages/c/src/three.ts"
    ]],
    "a real static runtime cycle must be reported with its concrete file paths"
  );
  assert.deepEqual(
    findStaticRuntimeCycles([
      runtimeEdge("packages/a/src/one.ts", "packages/b/src/two.ts", "type-only"),
      runtimeEdge("packages/b/src/two.ts", "packages/c/src/three.ts", "type-only"),
      runtimeEdge("packages/c/src/three.ts", "packages/a/src/one.ts", "type-only")
    ]),
    [],
    "type-only cycles must not be reported as runtime cycles"
  );
  assert.deepEqual(
    findStaticRuntimeCycles([
      runtimeEdge("packages/a/src/one.ts", "packages/b/src/two.ts"),
      runtimeEdge("packages/b/src/two.ts", "packages/a/src/one.ts", "dynamic")
    ]),
    [],
    "lazy dynamic edges must not enter the static runtime cycle analysis"
  );
  assert.deepEqual(
    findStaticRuntimeCycles([
      runtimeEdge("packages/a/src/one.ts", "packages/b/src/two.ts"),
      runtimeEdge("packages/b/src/two.ts", "packages/a/src/one.ts")
    ]),
    [["packages/a/src/one.ts", "packages/b/src/two.ts"]],
    "a mixed type/value re-export classified as runtime must still participate in cycle detection"
  );

  const publicTargets: any = [
    "packages/foundation/src/config/server-env.ts",
    "packages/foundation/src/module-system/*.ts",
    "packages/ui-console/src/browser-window.ts"
  ];
  const enforcedFiles: any = new Set<any>([
    "apps/console/views/ExampleView.vue",
    "packages/agents/src/example-consumer.ts",
    "tools/server-scripts/lib/runtime-plugin-selection.ts"
  ]);
  assert.equal(
    isProductionConsumerPath("apps/console/views/ExampleView.vue"),
    true,
    "application production sources must be enforced consumers"
  );
  assert.equal(
    isProductionConsumerPath("plugins/example/verifiers/check.ts"),
    false,
    "plugin verifiers must remain owned white-box inspection"
  );
  assert.equal(
    isProductionConsumerPath("packages/contracts/src/fixtures/example.ts"),
    false,
    "package fixtures must remain owned white-box inspection"
  );
  assert.deepEqual(
    findFacadeBoundaryViolations({
      edges: [{
        from: "apps/console/views/ExampleView.vue",
        to: "packages/ui-console/src/browser-window.ts",
        specifier: "@meshrix/ui-console/browser-window",
        kind: "package"
      }],
      enforcedFiles,
      publicTargets
    }),
    [],
    "cross-package imports through a declared package export must stay allowed"
  );
  assert.deepEqual(
    findFacadeBoundaryViolations({
      edges: [{
        from: "apps/console/views/ExampleView.vue",
        to: "packages/ui-console/src/browser-window.ts",
        specifier: "../../../packages/ui-console/src/browser-window.ts",
        kind: "relative"
      }],
      enforcedFiles,
      publicTargets
    }).map((violation?: any) : any => violation.rule),
    ["production-package-relative-import"],
    "a source-relative import into another package must be rejected"
  );
  assert.deepEqual(
    findFacadeBoundaryViolations({
      edges: [
        {
          from: "apps/console/views/ExampleView.vue",
          to: "packages/foundation/src/module-system/plugin-registry.ts",
          specifier: "#meshrix/foundation/module-system/plugin-registry",
          kind: "package-import"
        },
        {
          from: "tools/server-scripts/lib/runtime-plugin-selection.ts",
          to: "packages/foundation/src/config/server-env.ts",
          specifier: "#meshrix/foundation/config/server-env",
          kind: "package-import"
        }
      ],
      enforcedFiles,
      publicTargets
    }),
    [],
    "registered aliases resolving to declared public targets must stay allowed"
  );
  assert.deepEqual(
    findFacadeBoundaryViolations({
      edges: [{
        from: "apps/console/views/ExampleView.vue",
        to: "packages/ui-console/src/private-helpers.ts",
        specifier: "#meshrix/ui-console/private-helpers",
        kind: "package-import"
      }],
      enforcedFiles,
      publicTargets
    }).map((violation?: any) : any => violation.rule),
    ["package-import-bypasses-public-facade"],
    "an alias resolving outside the declared public targets must be rejected as a facade bypass"
  );
  assert.deepEqual(
    findFacadeBoundaryViolations({
      edges: [{
        from: "packages/agents/src/example-consumer.ts",
        to: "packages/agents/src/private-helper.ts",
        specifier: "./private-helper",
        kind: "relative"
      }],
      enforcedFiles,
      publicTargets
    }),
    [],
    "same-package private helpers must stay legal"
  );
  assert.deepEqual(
    findFacadeBoundaryViolations({
      edges: [{
        from: "plugins/example/verifiers/check.ts",
        to: "packages/ui-console/src/browser-window.ts",
        specifier: "../../../packages/ui-console/src/browser-window.ts",
        kind: "relative"
      }],
      enforcedFiles,
      publicTargets
    }),
    [],
    "test, verifier, and generator white-box reads must remain owned inspection"
  );
  assert.deepEqual(
    findFacadeBoundaryViolations({
      edges: [{
        from: "tools/server-scripts/lib/runtime-plugin-selection.ts",
        to: "packages/foundation/src/config/server-env.ts",
        specifier: "../../../packages/foundation/src/config/server-env.ts",
        kind: "relative"
      }],
      enforcedFiles,
      publicTargets
    }).map((violation?: any) : any => violation.rule),
    ["production-package-relative-import"],
    "a declared shipped runtime entry closure must obey the same public facade rule"
  );

  const closure: any = collectEntryClosure(["tools/server-scripts/start-server.ts"], [
    runtimeEdge("tools/server-scripts/start-server.ts", "apps/server/runtime/http-server.ts"),
    runtimeEdge("apps/server/runtime/http-server.ts", "packages/server-runtime/src/example.ts", "dynamic"),
    runtimeEdge("packages/server-runtime/src/example.ts", "packages/foundation/src/type-only.ts", "type-only")
  ]);
  assert.deepEqual(
    [...closure].sort(),
    [
      "apps/server/runtime/http-server.ts",
      "packages/server-runtime/src/example.ts",
      "tools/server-scripts/start-server.ts"
    ],
    "the shipped entry closure follows static and dynamic edges but not type-only edges"
  );
  assert.equal(componentOf("apps/console/views/ExampleView.vue"), "apps/console");
  assert.equal(componentOf("plugins/example/verifiers/check.ts"), "plugins/example");
  assert.equal(componentOf("tools/server-scripts/start-server.ts"), "tools");

  assert.throws(
    () : any => normalizeLayers({ layers: [] }),
    /at least one layer/u,
    "an empty dependency registry must fail closed"
  );
  assert.throws(
    () : any => normalizeLayers({
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

  const contractsLayer: any = normalizeLayers().find((layer?: any) : any => layer.id === "contracts");
  assert.ok(contractsLayer, "Contracts must remain a declared dependency layer");
  assert.deepEqual(
    contractsLayer.allowedDependsOn,
    [],
    "Contracts must not declare any workspace dependency"
  );
  assert.ok(
    contractsLayer.forbiddenDependsOn.includes("foundation"),
    "Contracts must explicitly forbid the undefined reverse dependency on Foundation"
  );
  assert.equal(
    layerDependencyViolation({
      from: "packages/contracts/src/example.ts",
      to: "packages/foundation/src/example.ts",
      specifier: "@meshrix/foundation/example",
      fromLayer: "contracts",
      toLayer: "foundation"
    }, normalizeLayers())?.rule,
    "contracts-must-not-depend-on-foundation",
    "a Contracts import of Foundation must be rejected"
  );
  assert.equal(
    layerDependencyViolation({
      from: "packages/foundation/src/example.ts",
      to: "packages/contracts/src/example.ts",
      specifier: "@meshrix/contracts/example",
      fromLayer: "foundation",
      toLayer: "contracts"
    }, normalizeLayers()),
    null,
    "Foundation depending on Contracts must stay allowed"
  );

  assert.equal(graph.summary.unresolvedImportCount, 0, "all internal imports must resolve");
  assert.equal(
    graph.summary.manifestDependencyViolationCount,
    0,
    "workspace runtime imports must be declared in their package manifests"
  );
  assert.ok(
    graph.constraints.some((constraint?: any) : any => constraint.rule === "agents-dependencies-must-be-allowlisted"),
    "allowlist constraints must be enforced"
  );
  assert.equal(
    violations.filter((violation?: any) : any => violation.rule.endsWith("layer-unclassified")).length,
    0,
    "all scanned production sources and internal targets must be classified"
  );
  assert.ok(
    graph.edges.some((edge?: any) : any => (
      edge.from === "apps/server/runtime/http-server.ts" &&
      edge.specifier === "#meshrix/server-runtime/composition/http-application-assembly" &&
      edge.to === "packages/server-runtime/src/composition/http-application-assembly.ts"
    )),
    "the HTTP application adapter must delegate provider wiring to the server composition assembly"
  );
  assert.ok(
    graph.nodes.some((node?: any) : any => node.layer === "ui-console"),
    "UI console adapter must be represented as an explicit layer"
  );
  assert.equal(
    graph.edges.some((edge?: any) : any => edge.fromLayer === "ui-console" && edge.toLayer === "server-runtime"),
    false,
    "UI console must consume settings and discovery through composition-injected ports instead of importing server-runtime"
  );
  assert.ok(
    graph.constraints.some((constraint?: any) : any => (
      constraint.rule === "server-runtime-must-not-depend-on-plugins" &&
      constraint.forbiddenLayer === "plugins"
    )),
    "server runtime must explicitly forbid reverse dependencies on optional plugins"
  );
  assert.ok(
    graph.constraints.some((constraint?: any) : any => (
      constraint.rule === "plugin-console-must-not-depend-on-apps" &&
      constraint.forbiddenLayer === "apps"
    )),
    "plugin console adapters must consume public packages instead of console app implementation paths"
  );
  const pluginPublicPackageConstraint: any = graph.constraints.find((constraint?: any) : any => (
    constraint.rule === "plugin-production-relative-imports-use-public-packages"
  ));
  assert.ok(pluginPublicPackageConstraint, "plugin relative implementation import policy must be registry-backed");
  const runtimeCompositionConstraint: any = graph.constraints.find((constraint?: any) : any => (
    constraint.rule === "server-runtime-cross-layer-wiring-requires-composition"
  ));
  assert.ok(runtimeCompositionConstraint, "server runtime cross-layer wiring policy must be registry-backed");
  const uiProviderConstraint: any = graph.constraints.find((constraint?: any) : any => (
    constraint.rule === "ui-console-stateful-providers-require-composition"
  ));
  assert.ok(uiProviderConstraint, "UI stateful provider construction policy must be registry-backed");
  const controllerSecurityConstraint: any = graph.constraints.find((constraint?: any) : any => (
    constraint.rule === "http-controllers-require-composed-security-ports"
  ));
  assert.ok(controllerSecurityConstraint, "HTTP controller security authority policy must be registry-backed");
  const syntheticRuntimeConstraint: Record<string, any> = {
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
      from: "packages/server-runtime/src/state/example.ts",
      fromLayer: "server-runtime",
      to: "packages/agents/src/example.ts",
      specifier: "#meshrix/agents/example"
    }, [syntheticRuntimeConstraint]).map((constraint?: any) : any => constraint.id),
    [syntheticRuntimeConstraint.id],
    "cross-layer wiring outside server composition must match the registered constraint"
  );
  assert.deepEqual(
    matchingDependencyConstraints({
      from: "packages/server-runtime/src/composition/example.ts",
      fromLayer: "server-runtime",
      to: "packages/agents/src/example.ts",
      specifier: "#meshrix/agents/example"
    }, [syntheticRuntimeConstraint]),
    [],
    "server composition must remain the explicit cross-layer wiring boundary"
  );
  assert.deepEqual(
    matchingDependencyConstraints({
      from: "packages/ui-console/src/example.ts",
      fromLayer: "ui-console",
      to: "packages/agents/src/workspace-governance/index.ts",
      specifier: "@meshrix/agents/workspace-governance/index"
    }, [{
      id: "ui-console-stateful-providers-require-composition",
      fromPattern: "packages/ui-console/src/**",
      fromLayers: ["ui-console"],
      specifierKinds: ["package"],
      forbiddenTargets: ["packages/agents/src/workspace-governance/**"],
      severity: "error"
    }]).map((constraint?: any) : any => constraint.id),
    ["ui-console-stateful-providers-require-composition"],
    "UI console sources must receive stateful provider ports instead of importing their factories"
  );
  assert.deepEqual(
    matchingDependencyConstraints({
      from: "packages/protocols/http/controllers/example.ts",
      fromLayer: "protocols",
      to: "packages/foundation/src/security/security-permissions-provider.ts",
      specifier: "#meshrix/foundation/security/security-permissions-provider"
    }, [{
      id: "http-controllers-require-composed-security-ports",
      fromPattern: "packages/protocols/http/controllers/**",
      fromLayers: ["protocols"],
      specifierKinds: ["package-import"],
      forbiddenTargets: ["packages/foundation/src/security/security-permissions-provider.ts"],
      severity: "error"
    }]).map((constraint?: any) : any => constraint.id),
    ["http-controllers-require-composed-security-ports"],
    "HTTP controllers must receive the composed security authority port"
  );
  const syntheticConstraint: Record<string, any> = {
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
    }, [syntheticConstraint]).map((constraint?: any) : any => constraint.id),
    [syntheticConstraint.id],
    "relative plugin imports into monorepo implementation roots must match the registered constraint"
  );
  assert.deepEqual(
    matchingDependencyConstraints({
      from: "plugins/example/console/View.vue",
      fromLayer: "plugin-console",
      to: "packages/ui-console/src/page-refresh.ts",
      specifier: "@meshrix/ui-console/page-refresh"
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
    constraintFindings.filter((finding?: any) : any => finding.rule === syntheticConstraint.id),
    [],
    "all live plugin production imports must use public package exports"
  );
  assert.deepEqual(
    constraintFindings.filter((finding?: any) : any => [
      "ui-console-stateful-providers-require-composition",
      "http-controllers-require-composed-security-ports"
    ].includes(finding.rule)),
    [],
    "all live UI and HTTP controller provider wiring must flow through composition"
  );
  assert.equal(
    graph.edges.some((edge?: any) : any => (
      ["contracts", "foundation", "agents", "capabilities", "protocols", "server-runtime", "ui-console", "apps"].includes(edge.fromLayer) &&
      ["plugins", "plugin-console", "plugin-verifiers", "plugin-tests"].includes(edge.toLayer)
    )),
    false,
    "core production layers must not import optional plugin implementation layers"
  );
  const crossPluginImplementationEdges: any = graph.edges.filter((edge?: any) : any => {
    if (edge.fromLayer !== "plugins" || edge.toLayer !== "plugins") return false;
    const fromPlugin: any = String(edge.from || "").split("/")[1] || "";
    const toPlugin: any = String(edge.to || "").split("/")[1] || "";
    return fromPlugin && toPlugin && fromPlugin !== toPlugin;
  });
  assert.deepEqual(
    crossPluginImplementationEdges,
    [],
    "optional plugins must use public contracts and manifest dependencies instead of another plugin's implementation"
  );

  assert.ok(
    graph.edges.some((edge?: any) : any => edge.family === "workspace-package" && edge.specifier.startsWith("@meshrix/")),
    "the graph must cover @meshrix/* workspace package imports"
  );
  assert.ok(
    graph.summary.relativeEdgeCount > 0,
    "architecture graph reports must count relative edges"
  );
  assert.ok(
    graph.summary.packageImportEdgeCount > 0,
    "architecture graph reports must count #meshrix/* package-import edges"
  );
  assert.ok(
    graph.summary.workspacePackageEdgeCount > 0,
    "architecture graph reports must count @meshrix/* workspace-package edges"
  );
  assert.ok(
    graph.summary.staticRuntimeEdgeCount > 0,
    "architecture graph reports must count static runtime edges"
  );
  assert.ok(
    graph.summary.typeOnlyEdgeCount > 0,
    "architecture graph reports must count type-only edges"
  );
  assert.ok(
    graph.summary.dynamicInternalEdgeCount > 0,
    "architecture graph reports must count dynamic internal edges"
  );
  assert.equal(
    graph.summary.staticRuntimeEdgeCount + graph.summary.typeOnlyEdgeCount + graph.summary.dynamicInternalEdgeCount,
    graph.summary.totalEdges,
    "every resolved edge must carry exactly one classification"
  );
  assert.equal(
    graph.edges.every((edge?: any) : any => ["runtime", "type-only", "dynamic"].includes(edge.classification)),
    true,
    "edge classifications must be static runtime, type-only, or dynamic"
  );
  assert.equal(
    graph.summary.runtimeCycleCount,
    0,
    "the static runtime graph must remain acyclic"
  );
  assert.deepEqual(
    result.runtimeCycles,
    [],
    "no static runtime cycle may be reported for the current repository"
  );
  assert.equal(
    graph.summary.facadeViolationCount,
    0,
    "production consumers must not bypass package public facades"
  );
  assert.deepEqual(
    result.facadeViolations,
    [],
    "no production private-boundary bypass may be reported for the current repository"
  );
  assert.deepEqual(
    violations.filter((violation?: any) : any => [
      "static-runtime-import-cycle",
      "production-package-relative-import",
      "package-import-bypasses-public-facade"
    ].includes(violation.rule)),
    [],
    "no runtime cycle or facade bypass rule may be violated"
  );
  assert.ok(
    graph.runtimeEntryRoots.includes("tools/server-scripts/start-server.ts"),
    "the shipped start-server entry must be declared from package.json bin metadata"
  );
  assert.ok(
    graph.runtimeEntryRoots.includes("apps/server/bin/meshrix.ts"),
    "every declared bin entry must contribute its source runtime root"
  );
  const runtimeEntryClosure: any = new Set<any>(graph.runtimeEntryClosure);
  assert.ok(
    runtimeEntryClosure.has("tools/server-scripts/lib/runtime-plugin-selection.ts"),
    "the shipped startup closure must include the runtime plugin selection helper"
  );
  assert.ok(
    runtimeEntryClosure.has("apps/server/runtime/http-server.ts"),
    "the shipped startup closure must include the server HTTP runtime"
  );
  assert.deepEqual(
    graph.edges.filter((edge?: any) : any => (
      runtimeEntryClosure.has(edge.from) &&
      edge.kind === "relative" &&
      String(edge.to).startsWith("packages/") &&
      componentOf(edge.from) !== componentOf(edge.to)
    )),
    [],
    "the shipped runtime entry closure must consume packages only through public subpaths or registered aliases"
  );
  assert.ok(
    graph.edges.some((edge?: any) : any => (
      edge.from === "apps/console/composables/approvalFlowViewContext.ts" &&
      edge.to === "apps/console/composables/console-approval-flow-view-controller.ts" &&
      edge.classification === "type-only"
    )),
    "the Console type-only relation must be classified out of the static runtime graph"
  );
  assert.ok(
    graph.edges.some((edge?: any) : any => (
      edge.from === "apps/console/router/index.ts" &&
      String(edge.to).endsWith("views/ApprovalFlowView.vue") &&
      edge.classification === "dynamic"
    )),
    "lazy Console route relations must be classified as dynamic edges"
  );

  console.log(`  Nodes: ${graph.summary.totalNodes}`);
  console.log(`  Edges: ${graph.summary.totalEdges}`);
  console.log(`  Relative: ${graph.summary.relativeEdgeCount}`);
  console.log(`  #meshrix/*: ${graph.summary.packageImportEdgeCount}`);
  console.log(`  @meshrix/*: ${graph.summary.workspacePackageEdgeCount}`);
  console.log(`  Static runtime: ${graph.summary.staticRuntimeEdgeCount}`);
  console.log(`  Type-only: ${graph.summary.typeOnlyEdgeCount}`);
  console.log(`  Dynamic: ${graph.summary.dynamicInternalEdgeCount}`);
  console.log(`  Runtime cycles: ${graph.summary.runtimeCycleCount}`);
  console.log(`  Facade violations: ${graph.summary.facadeViolationCount}`);
  console.log(`  Runtime entry roots: ${graph.summary.runtimeEntryRootCount}`);
  console.log(`  Entry closure nodes: ${graph.summary.runtimeEntryClosureNodeCount}`);
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

test().catch((error?: any) : any => {
  process.exitCode = 1;
  console.error(error);
});
