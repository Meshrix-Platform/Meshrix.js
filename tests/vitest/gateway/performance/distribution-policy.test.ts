import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { INTERNAL_SOURCE_PACKAGE_EXCLUDED_PATHS } from "../../../../tools/server-scripts/lib/source-package-contract.ts";

const root = resolve(import.meta.dirname, "../../../..");
describe("benchmark product boundary policy (not artifact evidence)", () => {
  it("excludes only the development entry and retains production build inputs", async () => {
    const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    expect(manifest.workspaces).not.toContain("../Meshrix.js-Benchmark/packages/node-benchmark");
    expect(manifest.dependencies?.["meshrix-node-benchmark"]).toBeUndefined();
    expect(manifest.devDependencies?.["meshrix-node-benchmark"]).toBeUndefined();
    expect(manifest.files).toContain("!tools/server-scripts/benchmark-gateway.ts");
    expect(manifest.files).toContain("!dist/tools/server-scripts/benchmark-gateway.*");
    expect(INTERNAL_SOURCE_PACKAGE_EXCLUDED_PATHS).toContain("tools/server-scripts/benchmark-gateway.ts");
    const compiler = JSON.parse(await readFile(resolve(root, "tsconfig.node.json"), "utf8"));
    expect(compiler.exclude).toContain("tools/server-scripts/benchmark-gateway.ts");
    const docker = await readFile(resolve(root, "Dockerfile"), "utf8");
    expect(docker).toMatch(/RUN npm run build:node && rm -f tools\/server-scripts\/benchmark-gateway\.ts/u);
    expect(docker).toMatch(/RUN npm run build && rm -f tools\/server-scripts\/benchmark-gateway\.ts/u);
  });
});
