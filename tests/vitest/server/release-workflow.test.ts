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
    expect(workflow).toContain("runs-on: macos-15");
    expect(workflow).toContain("ref: ${{ github.ref }}");
    expect(workflow).toContain("RELEASE_TAG: ${{ github.ref_name }}");
    expect(workflow).toContain(`node-version: "${definition.github.nodeVersion}"`);
    expect(workflow).toContain("registry-url: https://registry.npmjs.org");
    expect(workflow).toContain("Use the repository-configured npm CLI for Trusted Publishing");
    expect(workflow).toContain("release-definition.registry.json");

    // The release splits qualification from publication: the verify job runs
    // dependency installation, build and tests without OIDC authority, while the
    // publish job alone holds `id-token: write` and only publishes the archives
    // the verify job qualified and retained.
    const verifyStart = workflow.indexOf("  verify:");
    const publishStart = workflow.indexOf("  publish:");
    expect(verifyStart).toBeGreaterThanOrEqual(0);
    expect(publishStart).toBeGreaterThan(verifyStart);
    const verifySection = workflow.slice(verifyStart, publishStart);
    const publishSection = workflow.slice(publishStart);

    // Only tag refs may qualify or publish: workflow_dispatch can name a
    // tag-shaped branch, so both jobs must require `github.ref_type == 'tag'`
    // and the privileged job must prove the checkout is the tagged commit.
    const tagGuard = "if: ${{ github.ref_type == 'tag' }}";
    expect(verifySection).toContain(tagGuard);
    expect(publishSection).toContain(tagGuard);
    expect(publishSection).toContain('test "$(git rev-parse HEAD)" = "${{ github.sha }}"');

    expect(verifySection).not.toContain("id-token: write");
    expect(verifySection.indexOf("npm install --global")).toBeLessThan(verifySection.indexOf("run: npm ci"));
    expect(verifySection).toContain("npm exec --offline -- playwright install --with-deps chromium");
    expect(verifySection).toContain("npm run release:prepare -- --check --tag \"$RELEASE_TAG\"");
    expect(verifySection).toContain("npm run ci:local -- --report build/ci-diagnostics/release-local-ci/results.json");
    expect(verifySection).toContain("release-npm-set-${{ github.sha }}");

    expect(publishSection).toContain("needs: verify");
    expect(publishSection).toContain("environment: release-candidate");
    expect(publishSection).toContain("contents: write");
    expect(publishSection).toContain("id-token: write");
    expect(publishSection).not.toContain("run: npm ci");
    expect(publishSection).toContain("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093");
    expect(publishSection).toContain("release-npm-set-${{ github.sha }}");
    expect(publishSection).toContain("node tools/server-scripts/publish-release-set.ts --artifact-dir build/release/npm-set");
    // Trusted Publishing: the release workflow publishes through its OIDC
    // identity and must not carry a long-lived npm token secret.
    expect(workflow).not.toContain("NPM_BOOTSTRAP_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).toContain('NPM_CONFIG_PROVENANCE: "true"');
    expect(workflow).toContain('if gh release view "$RELEASE_TAG"');
    expect(workflow).toContain("gh release create \"$RELEASE_TAG\"");
    expect(workflow).toContain("if: ${{ always() }}");
    expect(uploadArtifactAction).toBe("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(workflow).toContain(`uses: ${uploadArtifactAction}`);
    expect(workflow).toContain("build/ci-diagnostics/release-local-ci/results.json");
    expect(workflow).toContain("build/local-ci/");
    expect(workflow).toContain("build/reports/npm-package-installability.json");
    expect(workflow).toContain("build/acceptance-evidence/failures/");

    expect(ci).not.toContain('tags: ["v*"]');
    expect(ci).toContain("if: ${{ github.event_name != 'pull_request' }}");
  });

  it("runs both CI jobs with the release definition's Node and npm versions", () => {
    const ci = read(".github/workflows/ci.yml");
    const definition = JSON.parse(read("tools/registry/release-definition.registry.json"));
    const npmCliSetup = `npm install --global "npm@$(node -p 'require("./tools/registry/release-definition.registry.json").github.npmCliVersion')"`;

    for (const [job, nextJob] of [
      ["pull-request-verify", "engineering"],
      ["engineering", "dependency-review"],
    ]) {
      const start = ci.indexOf(`  ${job}:`);
      const end = ci.indexOf(`  ${nextJob}:`, start + 1);
      const section = ci.slice(start, end === -1 ? undefined : end);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(section).toContain(`node-version: "${definition.github.nodeVersion}"`);
      expect(section).toContain(npmCliSetup);
      expect(section).toContain("npm exec --offline -- playwright install --with-deps chromium");
      expect(section.indexOf(npmCliSetup)).toBeLessThan(section.indexOf("run: npm ci"));
      expect(section).toContain("if: ${{ always() }}");
      expect(section).toContain("build/reports/npm-package-installability.json");
    }
  });
});
