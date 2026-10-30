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
    // All jobs qualify the immutable tagged commit, never the movable ref.
    expect(workflow).not.toContain("ref: ${{ github.ref }}");
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).toContain("RELEASE_TAG: ${{ github.ref_name }}");
    expect(workflow).toContain(`node-version: "${definition.github.nodeVersion}"`);
    expect(workflow).toContain("registry-url: https://registry.npmjs.org");
    expect(workflow).toContain("Use the repository-configured npm CLI for Trusted Publishing");
    // The workflow consumes the release definition through the integrity-pinned
    // CLI installer (version and tarball SHA-512 both come from the authority).
    expect(workflow).toContain("install-release-npm-cli.ts");

    // The release splits qualification from publication: the verify job runs
    // dependency installation, build and tests without OIDC authority, while the
    // publish job alone holds `id-token: write` and only publishes the archives
    // the verify job qualified and retained.
    const verifyStart = workflow.indexOf("  verify:");
    const nativeStart = workflow.indexOf("  native-assets:");
    const publishStart = workflow.indexOf("  publish:");
    expect(verifyStart).toBeGreaterThanOrEqual(0);
    expect(nativeStart).toBeGreaterThan(verifyStart);
    expect(publishStart).toBeGreaterThan(nativeStart);
    const verifySection = workflow.slice(verifyStart, nativeStart);
    const nativeSection = workflow.slice(nativeStart, publishStart);
    const publishSection = workflow.slice(publishStart);

    // Only tag refs may qualify or publish: workflow_dispatch can name a
    // tag-shaped branch, so both jobs must require `github.ref_type == 'tag'`
    // and the privileged job must prove the checkout is the tagged commit.
    const tagGuard = "if: ${{ github.ref_type == 'tag' }}";
    expect(verifySection).toContain(tagGuard);
    expect(publishSection).toContain(tagGuard);
    expect(publishSection).toContain('test "$(git rev-parse HEAD)" = "${{ github.sha }}"');
    expect(verifySection).toContain('test "$(git rev-parse HEAD)" = "${{ github.sha }}"');
    expect(nativeSection).toContain('test "$(git rev-parse HEAD)" = "${{ github.sha }}"');

    expect(verifySection).not.toContain("id-token: write");
    expect(verifySection.indexOf("install-release-npm-cli.ts")).toBeLessThan(verifySection.indexOf("run: npm ci"));
    expect(verifySection).toContain("npm exec --offline -- playwright install --with-deps chromium");
    expect(verifySection).toContain("npm run release:prepare -- --check --tag \"$RELEASE_TAG\"");
    expect(verifySection).toContain("npm run ci:local -- --report build/ci-diagnostics/release-local-ci/results.json");
    expect(verifySection).toContain("release-npm-set-${{ github.sha }}");

    // The native-assets job qualifies the Rust client archives on both
    // platforms without OIDC authority, and publication waits for it.
    expect(nativeSection).toContain(tagGuard);
    expect(nativeSection).not.toContain("id-token: write");
    expect(nativeSection).toContain("os: ubuntu-24.04");
    expect(nativeSection).toContain("os: macos-15");
    expect(nativeSection).toContain("npm run build:native-linux-client");
    expect(nativeSection).toContain("npm run build:native-macos-client");
    expect(nativeSection).toContain("verify-native-${{ matrix.platform }}-artifacts.ts");
    expect(nativeSection).toContain("release-native-${{ matrix.platform }}-${{ github.sha }}");

    // The aarch64 probe containers need qemu-user-static binfmt before the
    // verifier runs; installing it before the build matrix keeps an APT
    // failure ahead of the expensive compilation as well.
    const qemuSetup = nativeSection.indexOf("Enable aarch64 container emulation");
    expect(qemuSetup).toBeGreaterThanOrEqual(0);
    expect(nativeSection).toContain("apt-get install -y qemu-user-static");
    expect(nativeSection.indexOf("npm run build:native-linux-client")).toBeGreaterThan(qemuSetup);
    expect(nativeSection.indexOf("verify-native-")).toBeGreaterThan(qemuSetup);

    expect(publishSection).toContain("needs: [verify, native-assets]");
    expect(publishSection).toContain("environment: release-candidate");
    expect(publishSection).toContain("contents: write");
    expect(publishSection).toContain("id-token: write");
    expect(publishSection).not.toContain("run: npm ci");
    // The OIDC job must not execute whatever the registry serves at install
    // time: the CLI comes from the integrity-pinned tarball installer only.
    expect(publishSection).toContain("node tools/server-scripts/install-release-npm-cli.ts");
    expect(publishSection).not.toContain('npm install --global "npm@');
    expect(publishSection).toContain("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093");
    expect(publishSection).toContain("release-npm-set-${{ github.sha }}");
    // The complete native artifact set must be staged locally before the
    // irreversible npm publication, so an expired download cannot leave a
    // partial release.
    expect(publishSection).toContain("release-native-*-${{ github.sha }}");
    // download-artifact@v4's pattern match lands each artifact in its own
    // subdirectory; the checksum glob and Release upload need one flat set.
    expect(publishSection).toContain("merge-multiple: true");
    expect(publishSection).toContain("shasum -a 256 *.tar.gz > SHA256SUMS.txt");
    expect(publishSection).toContain("-eq 8");
    expect(publishSection.indexOf("release-native-*-${{ github.sha }}"))
      .toBeLessThan(publishSection.indexOf("publish-release-set.ts"));
    // The remote tag must peel to this commit before npm publication —
    // unconditionally, whether or not a Release object already exists.
    const tagVerify = publishSection.indexOf("Verify the release tag still points at this commit");
    expect(tagVerify).toBeGreaterThanOrEqual(0);
    expect(tagVerify).toBeLessThan(publishSection.indexOf("publish-release-set.ts"));
    expect(publishSection).toContain("refusing to publish");
    expect(publishSection).toContain("node tools/server-scripts/publish-release-set.ts --artifact-dir build/release/npm-set");
    // Trusted Publishing: the release workflow publishes through its OIDC
    // identity and must not carry a long-lived npm token secret.
    expect(workflow).not.toContain("NPM_BOOTSTRAP_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).toContain('NPM_CONFIG_PROVENANCE: "true"');
    expect(workflow).toContain('if gh release view "$RELEASE_TAG"');
    expect(workflow).toContain("gh release create \"$RELEASE_TAG\"");
    // An existing release may only be refreshed when its tag still peels to
    // this commit and every published native asset is byte-identical; a
    // partial-upload retry fills in missing assets instead of stopping.
    expect(workflow).toContain('git/ref/tags/$RELEASE_TAG');
    expect(workflow).toContain('no longer points at ${{ github.sha }}');
    expect(workflow).toContain("refusing to replace");
    expect(workflow).toContain("uploading missing native assets");
    expect(workflow).toContain('gh release upload "$RELEASE_TAG" $missing');
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
    const npmCliSetup = "run: node tools/server-scripts/install-release-npm-cli.ts";

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
