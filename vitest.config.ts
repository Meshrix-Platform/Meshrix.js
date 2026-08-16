import fs from "node:fs";
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

const webRoot = path.resolve(__dirname, "apps", "console");
const serialTestPatterns = [
  "tests/vitest/server/job-manager*.test.ts",
  "tests/vitest/server/upload-custody-workspace-materialization.test.ts",
];
const workerThreadTestPatterns = [
  "tests/vitest/server/operation-audit-retention.test.ts",
];

const testFilePatterns = [
  "tests/acceptance/**/*.{test,spec}.{ts,tsx}",
  "tests/vitest/**/*.{test,spec}.{ts,tsx}",
  "tests/server/**/*.{test,spec}.{ts,tsx}",
  "tests/unit/routing/**/*.{test,spec}.{ts,tsx}",
  "tests/unit/security/**/*.{test,spec}.{ts,tsx}",
  "tests/unit/serialization/**/*.{test,spec}.{ts,tsx}",
  "tests/unit/server-runtime/**/*.{test,spec}.{ts,tsx}",
  "tests/contract/domains/**/*.{test,spec}.{ts,tsx}",
  "tests/contract/protocols/**/*.{test,spec}.{ts,tsx}",
  "plugins/*/tests/**/*.{test,spec}.{ts,tsx}",
];
const excludedTestPatterns = [
  "tests/vitest/server/server-verifier-coverage-extra.test.ts",
  "tests/contract/client/**",
  "tests/contract/foundation/**",
  "tests/unit/foundation/**",
];


const WORKSPACE_PACKAGE_DIRS: [string, string][] = [
  ["contracts", "packages/contracts"],
  ["foundation", "packages/foundation"],
  ["agents", "packages/agents"],
  ["capabilities", "packages/capabilities"],
  ["protocols", "packages/protocols"],
  ["server-runtime", "packages/server-runtime"],
  ["ui-console", "packages/ui-console"],
];

function escapeRegExp(value: string) : string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Tests import and mock the same modules through both `#meshrix/*` (package
// "imports") and `@meshrix/*` (workspace package "exports") specifiers. Map
// every exports subpath onto its `source` file so importers and vi.mock
// declarations always resolve to one module id; the `default` branch points
// at compiled dist that may be stale. Bare `@meshrix/<pkg>` imports are not
// aliased (no src/index.ts exists) and keep the package entry behavior.
function workspaceSourceAliases() : { find: any; replacement: string }[] {
  const exact: { find: any; replacement: string }[] = [];
  const patterns: [string, { find: any; replacement: string }][] = [];
  for (const [name, dir] of WORKSPACE_PACKAGE_DIRS) {
    const manifest: any = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, dir, "package.json"), "utf8"),
    );
    for (const [key, value] of Object.entries<any>(manifest.exports || {})) {
      const source: any = value && typeof value === "object" ? value.source : null;
      if (typeof source !== "string" || !source.startsWith("./")) continue;
      if (key.includes("*")) {
        const [keyPrefix, keySuffix = ""]: string[] = key.slice(1).split("*");
        const [targetPrefix, targetSuffix = ""]: string[] = source.split("*");
        const find: any = new RegExp(
          `^${escapeRegExp(`@meshrix/${name}${keyPrefix}`)}(.+)${escapeRegExp(keySuffix)}$`,
        );
        const replacement: string =
          path.resolve(__dirname, dir, targetPrefix) + `/$1${targetSuffix}`;
        patterns.push([key, { find, replacement }]);
      } else {
        exact.push({
          find: `@meshrix/${name}${key.slice(1)}`,
          replacement: path.resolve(__dirname, dir, source),
        });
      }
    }
  }
  patterns.sort((left: any, right: any) : any => right[0].length - left[0].length);
  return [...exact, ...patterns.map((entry: any) : any => entry[1])];
}

export default defineConfig({
  plugins: [vue()],
  resolve: {
    conditions: ["source"],
    externalConditions: ["source", "node", "module-sync"],
    alias: [
      { find: "@", replacement: webRoot },
      { find: "@components", replacement: path.resolve(webRoot, "components") },
      { find: "@composables", replacement: path.resolve(webRoot, "composables") },
      { find: "@views", replacement: path.resolve(webRoot, "views") },
      { find: "@lib", replacement: path.resolve(webRoot, "lib") },
      { find: "@router", replacement: path.resolve(webRoot, "router") },
      { find: "@types", replacement: path.resolve(webRoot, "types") },
      { find: "#meshrix/ui-console/bridge-http", replacement: path.resolve(__dirname, "packages/ui-console/src/bridge-http.ts") },
      { find: "#meshrix/ui-console/page-refresh", replacement: path.resolve(__dirname, "packages/ui-console/src/page-refresh.ts") },
      { find: "#meshrix/ui-console/rpc-client", replacement: path.resolve(__dirname, "packages/ui-console/src/rpc-client.ts") },
      { find: "#meshrix/ui-console/error-message", replacement: path.resolve(__dirname, "packages/ui-console/src/error-message.ts") },
      { find: "#meshrix/ui-console/binary-checkbox", replacement: path.resolve(__dirname, "packages/ui-console/src/BinaryCheckbox.vue") },
      { find: "#meshrix/ui-console/workspaces-view-context", replacement: path.resolve(__dirname, "packages/ui-console/src/workspaces-view-context.ts") },
      { find: "#meshrix/ui-console/server-console-shell-context", replacement: path.resolve(__dirname, "packages/ui-console/src/server-console-shell-context.ts") },
      { find: "#meshrix/ui-console/console-format-utils", replacement: path.resolve(__dirname, "packages/ui-console/src/console-format-utils.ts") },
      { find: "#meshrix/ui-console/console-client-display-utils", replacement: path.resolve(__dirname, "packages/ui-console/src/console-client-display-utils.ts") },
      { find: "#meshrix/ui-console/option-bar", replacement: path.resolve(__dirname, "packages/ui-console/src/OptionBar.vue") },
      { find: "#meshrix/ui-console/status-pill", replacement: path.resolve(__dirname, "packages/ui-console/src/StatusPill.vue") },
      { find: "#meshrix/server-config", replacement: path.resolve(__dirname, "packages/foundation/src/config/server-config.ts") },
      { find: "#meshrix/server-env", replacement: path.resolve(__dirname, "packages/foundation/src/config/server-env.ts") },
      { find: "#meshrix/settings", replacement: path.resolve(__dirname, "packages/server-runtime/src/composition/settings.ts") },
      { find: "#meshrix/product-api", replacement: path.resolve(__dirname, "packages/server-runtime/src/composition/product-api.ts") },
      { find: "#meshrix/state-coordinator", replacement: path.resolve(__dirname, "packages/foundation/src/storage/state-coordinator.ts") },
      { find: "#meshrix/client-strings", replacement: path.resolve(__dirname, "packages/foundation/src/security/client-strings.ts") },
      { find: "#meshrix/platform-registry", replacement: path.resolve(__dirname, "packages/server-runtime/src/composition/platform-registry.ts") },
      { find: "#meshrix/http-utils", replacement: path.resolve(__dirname, "packages/protocols/http/http-utils.ts") },
      { find: "#meshrix/http-response", replacement: path.resolve(__dirname, "packages/foundation/src/http/http-response.ts") },
      { find: "#meshrix/local-path-boundary", replacement: path.resolve(__dirname, "packages/foundation/src/security/local-path-boundary.ts") },
      { find: "#meshrix/runtime-logger", replacement: path.resolve(__dirname, "packages/foundation/src/observability/runtime-logger.ts") },
      { find: "#meshrix/authorization-engine", replacement: path.resolve(__dirname, "packages/foundation/src/security/authorization/authorization-engine.ts") },
      { find: "#meshrix/operation-registry", replacement: path.resolve(__dirname, "packages/contracts/src/operations/operation-registry.ts") },
      { find: "#meshrix/trusted-client-ip", replacement: path.resolve(__dirname, "packages/foundation/src/security/trusted-client-ip.ts") },
      { find: "#meshrix/server-runtime/console-domain-services", replacement: path.resolve(__dirname, "packages/server-runtime/src/composition/console-domain/services.ts") },
      { find: "#meshrix/server-runtime/console-domain-operation-executor", replacement: path.resolve(__dirname, "packages/server-runtime/src/composition/console-domain/operation-executor.ts") },
      { find: "#meshrix/capabilities/operation-permission-core/index", replacement: path.resolve(__dirname, "packages/capabilities/src/operation-permission-core/index.ts") },
      { find: "#meshrix/contracts", replacement: path.resolve(__dirname, "packages/contracts/src") },
      { find: "#meshrix/foundation", replacement: path.resolve(__dirname, "packages/foundation/src") },
      { find: "#meshrix/agents", replacement: path.resolve(__dirname, "packages/agents/src") },
      { find: "#meshrix/capabilities", replacement: path.resolve(__dirname, "packages/capabilities/src") },
      { find: "#meshrix/protocols", replacement: path.resolve(__dirname, "packages/protocols") },
      { find: "#meshrix/server-runtime", replacement: path.resolve(__dirname, "packages/server-runtime/src") },
      { find: "#meshrix/ui-console", replacement: path.resolve(__dirname, "packages/ui-console/src") },
      ...workspaceSourceAliases(),
    ],
  },
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    // Script-style verifier/contract files are executed by tests/run.ts via
    // tools/registry/tests.registry.json, not by Vitest's file discovery.
    pool: "forks",
    projects: [
      {
        extends: true,
        test: {
          name: "parallel",
          include: testFilePatterns,
          exclude: [...excludedTestPatterns, ...serialTestPatterns, ...workerThreadTestPatterns],
        },
      },
      {
        extends: true,
        test: {
          name: "serial",
          include: serialTestPatterns,
          exclude: excludedTestPatterns,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "worker-threads",
          include: workerThreadTestPatterns,
          exclude: excludedTestPatterns,
          pool: "threads",
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      reportsDirectory: "build/coverage/node-vue",
      all: true,
      include: [
        "apps/server/**/*.ts",
        "apps/console/**/*.ts",
        "apps/console/**/*.vue",
        "packages/**/*.ts",
      ],
      exclude: [
        "tools/server-scripts/**",
        "packages/foundation/config/**/*.json",
        "server/protocols/**/*.md",
        "apps/console/public/**",
        "apps/console/**/*.d.ts",
        "apps/console/index.html",
      ],
    },
  },
});
