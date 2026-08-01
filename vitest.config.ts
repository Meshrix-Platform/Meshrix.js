import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

const webRoot = path.resolve(__dirname, "apps", "console");
const jobManagerTestPattern = "tests/vitest/server/job-manager*.test.ts";
const testFilePatterns = [
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

export default defineConfig({
  plugins: [vue()],
  resolve: {
    conditions: ["source"],
    alias: {
      "@": webRoot,
      "@components": path.resolve(webRoot, "components"),
      "@composables": path.resolve(webRoot, "composables"),
      "@views": path.resolve(webRoot, "views"),
      "@lib": path.resolve(webRoot, "lib"),
      "@router": path.resolve(webRoot, "router"),
      "@types": path.resolve(webRoot, "types"),
    },
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
          exclude: [...excludedTestPatterns, jobManagerTestPattern],
        },
      },
      {
        extends: true,
        test: {
          name: "job-manager-serial",
          include: [jobManagerTestPattern],
          exclude: excludedTestPatterns,
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
