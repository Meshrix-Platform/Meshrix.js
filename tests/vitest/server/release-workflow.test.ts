import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("standard npm release workflow", () => {
  it("publishes one selected tag through acceptance, npm, and GitHub Release", () => {
    const workflow = read(".github/workflows/release.yml");
    const ci = read(".github/workflows/ci.yml");
    const definition = JSON.parse(read("tools/registry/release-definition.registry.json"));
    const uploadArtifactAction = ci.match(/uses: (actions\/upload-artifact@[^\s]+)/)?.[1];

    expect(workflow).toContain('tags: ["v*"]');
    expect(workflow).toContain("workflow_dispatch: {}");
    expect(workflow).toContain("ref: ${{ github.ref }}");
    expect(workflow).toContain("RELEASE_TAG: ${{ github.ref_name }}");
    expect(workflow).toContain(`node-version: "${definition.github.nodeVersion}"`);
    expect(workflow).toContain("environment: release-candidate");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("registry-url: https://registry.npmjs.org");
    expect(workflow).toContain("Use the repository-configured npm CLI for Trusted Publishing");
    expect(workflow).toContain("release-definition.registry.json");
    expect(workflow).toContain("npm run release:prepare -- --check --tag \"$RELEASE_TAG\"");
    expect(workflow).toContain("npm run ci:local -- --scope release");
    expect(workflow).toContain("npm run release:publish-npm -- --artifact-dir build/release/npm-set");
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}");
    expect(workflow).toContain('NPM_CONFIG_PROVENANCE: "true"');
    expect(workflow).toContain('if gh release view "$RELEASE_TAG"');
    expect(workflow).toContain("gh release create \"$RELEASE_TAG\"");
    expect(workflow).toContain("if: ${{ always() }}");
    expect(uploadArtifactAction).toBe("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(workflow).toContain(`uses: ${uploadArtifactAction}`);
    expect(workflow).toContain("build/ci-diagnostics/release-local-ci/results.json");
    expect(workflow).toContain("build/local-ci/");

    expect(ci).not.toContain('tags: ["v*"]');
    expect(ci).toContain("if: ${{ github.event_name != 'pull_request' }}");
  });
});
