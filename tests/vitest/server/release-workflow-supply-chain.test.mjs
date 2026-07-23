import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  SUPPLY_CHAIN_MANIFEST_SCHEMA_VERSION,
  buildSupplyChainArtifacts
} from "../../../tools/generators/generate-supply-chain-artifacts.mjs";
import {
  normalizeReleaseChannel,
  prepareMcpReleaseOutputDirectory,
  run,
  writeFlattenedReleaseChecksumAuthority
} from "../../../tools/server-scripts/lib/mcp-release-common.mjs";
import {
  resolveNodeRuntimeCacheDirectory
} from "../../../tools/server-scripts/lib/mcp-release-portable.mjs";
import {
  npmCliArgs,
  resolveNpmCliInvocation
} from "../../../tools/server-scripts/lib/npm-cli-invocation.mjs";
import {
  MCP_PORTABLE_TARGETS,
  MCP_RELEASE_TARGETS,
  normalizeMcpPortableTargets
} from "../../../tools/server-scripts/lib/mcp-release-platforms.mjs";
import {
  PLATFORM_ACCEPTANCE_JOB_BUDGET_MS,
  PLATFORM_ACCEPTANCE_JOB_OVERHEAD_MS,
  PLATFORM_ACCEPTANCE_COMMANDS,
  PLATFORM_ACCEPTANCE_PARALLELISM,
  PLATFORM_ACCEPTANCE_WORST_CASE_ESTIMATE
} from "../../../tools/server-scripts/verify-platform-acceptance.mjs";
import {
  hashCommand,
  parseChecksumIndex,
  validateArchiveNames
} from "../../../tools/server-scripts/verify-mcp-release-assets.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function jobSource(workflow, jobId) {
  const marker = `  ${jobId}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`release_workflow_job_missing:${jobId}`);
  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/\n  [a-z][a-z0-9-]*:\n/u);
  return workflow.slice(start, nextJob < 0 ? workflow.length : start + marker.length + nextJob);
}

function directJobNeeds(workflow, jobId) {
  const source = jobSource(workflow, jobId);
  const inline = source.match(/^    needs:\s*\[([^\]]*)\]\s*$/mu)?.[1];
  if (inline === undefined) return [];
  return inline.split(",").map((value) => value.trim()).filter(Boolean);
}

function jobTransitivelyNeeds(workflow, jobId, requiredJobId, visited = new Set()) {
  if (visited.has(jobId)) return false;
  visited.add(jobId);
  const needs = directJobNeeds(workflow, jobId);
  return needs.includes(requiredJobId) || needs.some((dependency) =>
    jobTransitivelyNeeds(workflow, dependency, requiredJobId, visited)
  );
}

describe("release workflow supply-chain boundary", () => {
  it("requires Node 22, final macOS asset execution, and npm preflight before container mutation", () => {
    const workflow = read(".github/workflows/release.yml");
    const orderedJobs = [
      "verify-release-inputs",
      "verify-macos-mcp-final-asset",
      "npm-registry-preflight",
      "build-release-image",
      "sign-finalize-release",
      "prepare-release-draft",
      "publish-container-version",
      "publish-npm-release-set",
      "publish-github-release",
      "advance-container-latest"
    ];
    const verifyJob = workflow.indexOf("  verify:\n");
    const firstPublicationJob = workflow.indexOf("  verify-release-inputs:\n");
    const verification = jobSource(workflow, "verify");
    const acceptanceJob = jobSource(workflow, "platform-acceptance");
    const assembly = jobSource(workflow, "assemble-release-assets");
    expect(workflow).toContain('tags: ["v*"]');
    expect(verification).toContain("npm run release:prepare -- --check --tag");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(verifyJob).toBeGreaterThan(0);
    expect(firstPublicationJob).toBeGreaterThan(verifyJob);
    expect(verification).not.toContain("npm run verify:acceptance");
    expect(acceptanceJob).toContain("needs: [verify]");
    expect(acceptanceJob).toContain("LICO_RELEASE_PARALLELISM: \"4\"");
    expect(acceptanceJob).toContain("npm run verify:acceptance");
    expect(assembly).toContain("needs: [verify, platform-acceptance]");
    const orderedJobOffsets = orderedJobs.map((jobId) => workflow.indexOf(`  ${jobId}:\n`));
    expect(orderedJobOffsets.every((offset) => offset > 0)).toBe(true);
    expect(orderedJobOffsets).toEqual([...orderedJobOffsets].sort((a, b) => a - b));
    expect(workflow).toContain("group: release");
    expect(workflow).toContain("refs/remotes/origin/release");
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain("  npm-package-portability:\n");
    expect(jobSource(workflow, "npm-package-portability")).toContain("continue-on-error: true");
    expect(jobSource(workflow, "npm-package-portability")).not.toContain('node: "22"');
    expect(workflow).toContain(
      "npm run verify:npm-package-installability -- --host-platform-probe"
    );
    const node22 = jobSource(workflow, "npm-package-node22");
    expect(node22).toContain("needs: [verify]");
    expect(node22).toContain('node-version: "22"');
    expect(node22).not.toContain("continue-on-error");
    expect(node22).toContain("--required-host-probe");
    expect(node22).not.toContain("--host-platform-probe");
    expect(node22).toContain("--report-path build/reports/npm-package-installability-node22.json");
    expect(jobSource(workflow, "verify-release-inputs")).toContain(
      "needs: [verify, assemble-release-assets]"
    );
    const macFinalAsset = jobSource(workflow, "verify-macos-mcp-final-asset");
    expect(macFinalAsset).toContain("needs: [verify-release-inputs]");
    expect(macFinalAsset).toContain("runs-on: macos-15");
    expect(macFinalAsset).toContain("run: npm run verify:mcp-final-release-asset");
    const npmPreflight = jobSource(workflow, "npm-registry-preflight");
    expect(npmPreflight).toContain("needs: [verify, platform-acceptance, npm-package-node22]");
    expect(npmPreflight).toContain("run: npm run release:publish-npm -- --preflight");
    expect(jobSource(workflow, "build-release-image")).toContain(
      "needs: [verify-release-inputs, verify-macos-mcp-final-asset, npm-registry-preflight]"
    );
    expect(jobSource(workflow, "prepare-release-draft")).toContain("gh release create");
    expect(jobSource(workflow, "prepare-release-draft"))
      .toContain("--notes-file build/release/RELEASE_NOTES.md");
    expect(jobSource(workflow, "publish-npm-release-set")).toContain(
      "needs: [platform-acceptance, sign-finalize-release, prepare-release-draft, publish-container-version]"
    );
    expect(jobSource(workflow, "publish-github-release")).toContain(
      "needs: [prepare-release-draft, publish-container-version, publish-npm-release-set]"
    );
    expect(jobTransitivelyNeeds(workflow, "publish-npm-release-set", "prepare-release-draft"))
      .toBe(true);
    expect(jobTransitivelyNeeds(workflow, "publish-npm-release-set", "publish-container-version"))
      .toBe(true);
    expect(jobTransitivelyNeeds(workflow, "publish-npm-release-set", "npm-package-node22"))
      .toBe(true);
    expect(jobTransitivelyNeeds(
      workflow,
      "publish-npm-release-set",
      "verify-macos-mcp-final-asset"
    )).toBe(true);
    expect(jobTransitivelyNeeds(workflow, "publish-container-version", "npm-registry-preflight"))
      .toBe(true);
    expect(jobTransitivelyNeeds(workflow, "publish-github-release", "publish-npm-release-set"))
      .toBe(true);
    expect(jobSource(workflow, "publish-npm-release-set"))
      .toContain("run: npm run release:publish-npm");
    expect(workflow).toContain(".github/RELEASE_TEMPLATE.md");
    expect(MCP_RELEASE_TARGETS).toEqual(["macos-arm64"]);
    expect(normalizeMcpPortableTargets(null)).toEqual(["macos-arm64"]);
    expect(MCP_RELEASE_TARGETS.every((target) => MCP_PORTABLE_TARGETS.includes(target))).toBe(true);
    expect(() => normalizeMcpPortableTargets("unsupported-platform")).toThrow(
      "mcp_release_platform_not_supported"
    );
  });

  it("enforces least privilege and repository-code boundaries across every publication job", () => {
    const workflow = read(".github/workflows/release.yml");
    const verification = jobSource(workflow, "verify");
    const packagePortability = jobSource(workflow, "npm-package-portability");
    const node22 = jobSource(workflow, "npm-package-node22");
    const acceptance = jobSource(workflow, "platform-acceptance");
    const assembly = jobSource(workflow, "assemble-release-assets");
    const inputs = jobSource(workflow, "verify-release-inputs");
    const macFinalAsset = jobSource(workflow, "verify-macos-mcp-final-asset");
    const npmPreflight = jobSource(workflow, "npm-registry-preflight");
    const build = jobSource(workflow, "build-release-image");
    const sign = jobSource(workflow, "sign-finalize-release");
    const draft = jobSource(workflow, "prepare-release-draft");
    const version = jobSource(workflow, "publish-container-version");
    const githubRelease = jobSource(workflow, "publish-github-release");
    const npmRelease = jobSource(workflow, "publish-npm-release-set");
    const latest = jobSource(workflow, "advance-container-latest");

    expect(verification).toContain("permissions:\n      contents: read");
    expect(verification).not.toContain("contents: write");
    expect(verification).not.toContain("packages: write");
    expect(verification).not.toContain("id-token: write");

    expect(packagePortability).toContain("permissions:\n      contents: read");
    expect(packagePortability).not.toContain("contents: write");
    expect(packagePortability).not.toContain("packages: write");
    expect(packagePortability).not.toContain("id-token: write");

    expect(node22).toContain("permissions:\n      contents: read");
    expect(node22).not.toContain("contents: write");
    expect(node22).not.toContain("packages: write");
    expect(node22).not.toContain("id-token: write");

    expect(acceptance).toContain("permissions:\n      contents: read");
    expect(acceptance).not.toContain("contents: write");
    expect(acceptance).not.toContain("packages: write");
    expect(acceptance).not.toContain("id-token: write");

    expect(assembly).toContain("permissions:\n      contents: read");
    expect(assembly).toContain("run: npm ci --ignore-scripts");
    expect(assembly).toContain("run: npm run release:prepare-node-runtime-source-evidence");
    expect(assembly).not.toContain("node tools/server-scripts/prepare-node-runtime-source-evidence.mjs");
    expect(assembly).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");

    expect(inputs).toContain("permissions:\n      contents: read");
    expect(inputs).toContain("actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5");
    expect(inputs).toContain("fetch-depth: 0");
    expect(inputs).toContain("run: npm ci --ignore-scripts");
    expect(inputs).toContain("verify-mcp-release-assets.mjs");
    expect(inputs).toContain("--node-runtime-source-dir build/release/node-runtime-source");
    expect(inputs).toContain("git log --first-parent --format='%s%x00'");
    expect(inputs).not.toContain("releases/generate-notes");
    expect(inputs).toContain("RELEASE_RENDERED_NOTES=\"build/release/RELEASE_NOTES.md\"");

    expect(macFinalAsset).toContain("permissions:\n      contents: read");
    expect(macFinalAsset).not.toContain("contents: write");
    expect(macFinalAsset).not.toContain("packages: write");
    expect(macFinalAsset).not.toContain("id-token: write");
    expect(macFinalAsset).toContain("verified-release-inputs-${{ github.sha }}");

    expect(npmPreflight).toContain("permissions:\n      contents: read");
    expect(npmPreflight).toContain("run: npm ci --ignore-scripts");
    expect(npmPreflight).toContain("run: npm run release:publish-npm -- --preflight");
    expect(npmPreflight).not.toContain("contents: write");
    expect(npmPreflight).not.toContain("packages: write");
    expect(npmPreflight).not.toContain("id-token: write");
    expect(npmPreflight).not.toContain("NODE_AUTH_TOKEN");
    expect(npmPreflight).not.toContain("NPM_TOKEN");

    expect(build).toContain("permissions:\n      contents: read\n      packages: write");
    expect(build).toContain("actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5");
    expect(build).not.toContain("id-token: write");
    expect(build).not.toContain("cosign ");
    expect(build).toContain("RELEASE_IMAGE_STATE.json");
    expect(build).toContain("create-release-image-authority.mjs");
    expect(read("tools/server-scripts/lib/release-image-evidence.mjs"))
      .toContain("v0.0.1:release:image-authority-2");

    expect(sign).toContain("permissions:\n      contents: read\n      packages: write\n      id-token: write");
    expect(sign).not.toContain("actions/checkout@");
    expect(sign).not.toMatch(/\bnode tools\//u);
    expect(sign).toContain("cosign sign --yes");
    expect(sign).toContain("cosign sign-blob --yes --bundle");
    expect(sign).toContain("name: finalized-release-${{ github.sha }}");
    expect(sign).toContain("Resolve an exact resumable signed asset set");
    expect(sign).toContain('gh release download "$GITHUB_REF_NAME"');
    expect(sign).toContain("published_release_resume_authority_mismatch");
    expect(sign).toContain("resumable_release_deterministic_asset_mismatch");
    expect(sign).toContain('if [[ "$SIGNED_ASSETS_REUSED" != "true" ]]');
    expect(sign).toContain("release_checksum_digest_mismatch");

    expect(draft).toContain("permissions:\n      contents: write");
    expect(draft).not.toContain("packages: write");
    expect(draft).not.toContain("id-token: write");
    expect(draft).not.toContain("actions/checkout@");
    expect(draft).not.toMatch(/\bnode tools\//u);
    expect(draft).toContain("remote_release_asset_authority_mismatch");
    expect(draft).toContain("id: release-order");

    expect(version).toContain("permissions:\n      contents: read\n      packages: write");
    expect(version).not.toContain("contents: write");
    expect(version).not.toContain("id-token: write");
    expect(version).not.toContain("actions/checkout@");
    expect(version).not.toMatch(/\bnode tools\//u);
    expect(version).toContain("Verify all release signatures before publication");

    expect(githubRelease).toContain("permissions:\n      contents: write");
    expect(githubRelease).not.toContain("packages: write");
    expect(githubRelease).not.toContain("id-token: write");
    expect(githubRelease).not.toContain("actions/checkout@");
    expect(githubRelease).not.toMatch(/\bnode tools\//u);

    expect(npmRelease).toContain("permissions:\n      contents: read\n      id-token: write");
    expect(npmRelease).not.toContain("contents: write");
    expect(npmRelease).not.toContain("packages: write");
    expect(npmRelease).toContain("actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5");
    expect(npmRelease).toContain("fetch-depth: 0");
    expect(npmRelease).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    expect(npmRelease).toContain('node-version: "24.16.0"');
    expect(npmRelease).toContain("npm run release:prepare -- --check --tag");
    expect(npmRelease).toContain("run: npm ci --ignore-scripts");
    expect(npmRelease).toContain("run: npm run release:publish-npm");
    expect(npmRelease).not.toContain("NODE_AUTH_TOKEN");
    expect(npmRelease).not.toContain("NPM_TOKEN");
    expect(npmRelease).not.toContain("npm@latest");

    expect(latest).toContain("permissions:\n      contents: read\n      packages: write");
    expect(latest).not.toContain("contents: write");
    expect(latest).not.toContain("id-token: write");
    expect(latest).not.toContain("actions/checkout@");
    expect(latest).not.toMatch(/\bnode tools\//u);
  });

  it("pins every third-party action and emits container provenance plus an SBOM", () => {
    const workflow = read(".github/workflows/release.yml");
    const uses = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)\s*(?:#.*)?$/gmu)]
      .map((match) => match[1]);
    expect(uses).toHaveLength(36);
    expect(uses.every((value) => /@[a-f0-9]{40}$/u.test(value))).toBe(true);
    expect(workflow).toContain("--platform linux/amd64,linux/arm64");
    expect(workflow).toContain("--target runtime-ui");
    expect(workflow).toContain("--provenance=mode=max,version=v0.2");
    expect(workflow).toContain(
      "aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25"
    );
    const build = jobSource(workflow, "build-release-image");
    expect(build.match(/aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/gu))
      .toHaveLength(2);
    expect(build.match(/TRIVY_PLATFORM: linux\/(?:amd64|arm64)/gu))
      .toEqual(["TRIVY_PLATFORM: linux/amd64", "TRIVY_PLATFORM: linux/arm64"]);
    expect(build.match(/version: v0\.69\.3/gu)).toHaveLength(2);
    expect(build.match(/severity: CRITICAL,HIGH/gu)).toHaveLength(2);
    expect(build.match(/exit-code: "1"/gu)).toHaveLength(2);
    expect(build.match(/ignore-unfixed: true/gu)).toHaveLength(2);
    expect(build).toContain('--build-arg "LICO_SOURCE_REPOSITORY=${GITHUB_REPOSITORY}"');
    expect(build).toContain('--build-arg "LICO_SOURCE_REF=${GITHUB_REF}"');
    expect(build).toContain('--build-arg "LICO_SOURCE_COMMIT=${GITHUB_SHA}"');
    expect(build).not.toContain("JSON.stringify(provenance).includes");
    expect(workflow).toContain("sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("cosign sign --yes");
    expect(workflow).toContain("cosign verify");
    expect(workflow).toContain("cosign sign-blob --yes --bundle");
    expect(workflow).toContain("cosign verify-blob");
    expect(workflow).toContain("https://token.actions.githubusercontent.com");
    expect(workflow).toContain("RELEASE_SHA256SUMS.sigstore.json");
    expect(workflow).toContain("Build, sign, and verify the flattened checksum authority");
    expect(workflow).toContain("release_checksum_assets_missing");
    expect(workflow).toContain("generate-supply-chain-artifacts.mjs --output build/release/supply-chain");
    expect(workflow).toContain("verify-supply-chain-artifacts.mjs --input build/release/supply-chain");
    expect(workflow.match(/overwrite: true/gu)).toHaveLength(4);
  });

  it("signs before immutable publication and exposes the GitHub release only after npm", () => {
    const workflow = read(".github/workflows/release.yml");
    const npmPreflightStep = workflow.indexOf(
      "name: Read and validate all npm package versions and dist-tags without publication"
    );
    const candidateMutationStep = workflow.indexOf(
      "name: Resolve or stage the immutable multi-platform container"
    );
    const immutableStep = workflow.indexOf("name: Publish the immutable container version tag");
    const signingStep = workflow.indexOf("name: Sign the staged digest or reverify a resumable version");
    const draftStep = workflow.indexOf("name: Prepare or resume the private GitHub release draft");
    const assetVerificationStep = workflow.indexOf("name: Verify the exact remote release asset set");
    const releaseOrderStep = workflow.indexOf("name: Determine monotonic release ordering");
    const releasePublicationStep = workflow.indexOf("name: Publish the verified GitHub release draft");
    const npmPublicationStep = workflow.indexOf("name: Publish missing tarballs or reverify immutable versions");
    const latestStep = workflow.indexOf("name: Verify immutable publication and advance the stable container tag");
    expect(signingStep).toBeGreaterThan(0);
    expect(npmPreflightStep).toBeGreaterThan(0);
    expect(candidateMutationStep).toBeGreaterThan(npmPreflightStep);
    expect(draftStep).toBeGreaterThan(signingStep);
    expect(assetVerificationStep).toBeGreaterThan(draftStep);
    expect(releaseOrderStep).toBeGreaterThan(assetVerificationStep);
    expect(immutableStep).toBeGreaterThan(releaseOrderStep);
    expect(immutableStep).toBeGreaterThan(assetVerificationStep);
    expect(npmPublicationStep).toBeGreaterThan(immutableStep);
    expect(releasePublicationStep).toBeGreaterThan(npmPublicationStep);
    expect(latestStep).toBeGreaterThan(releasePublicationStep);
    expect(immutableStep).toBeGreaterThan(0);
    const source = workflow.slice(immutableStep, releasePublicationStep);
    expect(source).toContain("docker buildx imagetools inspect");
    expect(source).toContain('existing_digest" != "$IMAGE_DIGEST"');
    expect(source).toContain('if [[ -z "$existing_digest" ]]');
    expect(source).toContain("docker buildx imagetools create --tag \"$target\"");
    expect(source).not.toContain("${image}:latest");
    expect(workflow.slice(draftStep, immutableStep)).toContain("--draft");
    expect(workflow.slice(assetVerificationStep, immutableStep)).toContain(
      "remote_release_asset_authority_mismatch"
    );
    expect(jobSource(workflow, "publish-github-release")).toContain("release.immutable !== true");
    expect(jobSource(workflow, "advance-container-latest"))
      .toContain("if: ${{ needs.prepare-release-draft.outputs.advance == 'true' }}");
    expect(workflow.slice(latestStep)).toContain("${IMAGE}:latest");
  });

  it("uses one immutable Node base-image reference across Docker authorities", () => {
    const dockerfile = read("Dockerfile");
    const deploymentIndex = JSON.parse(read("packages/foundation/config/deployment/index.json"));
    const image = dockerfile.match(/^ARG NODE_BASE_IMAGE=(.+)$/mu)?.[1] || "";
    expect(image).toMatch(/^node:24\.\d+\.\d+-bookworm-slim@sha256:[a-f0-9]{64}$/u);
    expect(deploymentIndex.dockerPresets.baseImages.mainService).toBe(image);
    expect(deploymentIndex.dockerPresets.mainService.buildArgs.NODE_BASE_IMAGE).toBe(image);
    expect(dockerfile).not.toContain("default-settings.json");
  });

  it("keeps compose discovery coordinates aligned with its host port and shutdown budget", () => {
    const compose = read("docker-compose.yml");
    const releaseTemplate = read(".github/RELEASE_TEMPLATE.md");
    expect(compose).toContain(
      '"${LICO_BIND_ADDRESS:-127.0.0.1}:${LICO_HOST_PORT:-7228}:7228"'
    );
    expect(compose).toContain("healthcheck:");
    expect(compose).toContain("stop_grace_period: 90s");
    expect(releaseTemplate).toContain("--stop-timeout 90");
    for (const field of [
      "LICO_BOOTSTRAP_URL",
      "LICO_ADVERTISED_BASE_URL",
      "LICO_ACTIVE_SERVICE_URL"
    ]) {
      expect(compose).toContain(
        `${field}: http://${"${LICO_ADVERTISED_HOST:-127.0.0.1}"}:${"${LICO_HOST_PORT:-7228}"}`
      );
      expect(compose).not.toContain(`${field}: http://127.0.0.1:7228`);
    }
  });

  it("keeps the npm verifier cache content-addressed and project-isolated", () => {
    const dockerfile = read("Dockerfile");
    const cacheMount =
      "--mount=type=cache,id=licomesh-core-npm,target=/var/cache/licomesh/npm,sharing=locked";
    expect(dockerfile.match(new RegExp(cacheMount, "gu"))).toHaveLength(2);
    expect(dockerfile).toContain("--cache=/var/cache/licomesh/npm");
    expect(dockerfile).toContain(
      "cp -a /var/cache/licomesh/npm/_cacache /opt/lico-npm-cache/_cacache"
    );
    expect(dockerfile).not.toMatch(/cp -a \/var\/cache\/licomesh\/npm\/\. /u);
    expect(dockerfile).not.toContain("/root/.npm");
  });

  it("executes the connector from the canonical npm release set", () => {
    const verifier = read("tools/server-scripts/verify-npm-package-installability.mjs");
    expect(verifier).toContain('import { discoverReleaseSet } from "./publish-release-set.mjs";');
    expect(verifier).toContain('name === "lico-mcp-connector"');
    expect(verifier).toContain('connectorFiles.includes("lib/mcp-proxy-session.mjs")');
    expect(verifier).toContain('"lico-mcp", "version", "--json"');
  });

  it("gives the canonical fresh-container package probe a layered timeout budget without widening host probes", () => {
    const workflow = read(".github/workflows/ci.yml");
    const releaseWorkflow = read(".github/workflows/release.yml");
    const verifier = read("tools/server-scripts/verify-npm-package-installability.mjs");
    const acceptanceCatalog = read(
      "tools/server-scripts/lib/platform-acceptance-command-catalog.mjs"
    );
    const publicGateStart = workflow.indexOf("  public-gate:\n");
    const publicGateEnd = workflow.indexOf("\n  platform-acceptance:\n", publicGateStart);
    const ciAcceptance = jobSource(workflow, "platform-acceptance");
    const portabilityStart = workflow.indexOf("  npm-package-portability:\n");
    const nextJob = workflow.indexOf("\n  windows-installer-security:\n", portabilityStart);
    expect(portabilityStart).toBeGreaterThan(0);
    expect(nextJob).toBeGreaterThan(portabilityStart);
    expect(publicGateStart).toBeGreaterThan(0);
    expect(publicGateEnd).toBeGreaterThan(publicGateStart);
    expect(workflow.slice(publicGateStart, publicGateEnd)).toContain("timeout-minutes: 120");
    const portability = workflow.slice(portabilityStart, nextJob);
    expect(portability).toContain("timeout-minutes: ${{ matrix.timeout }}");
    expect(portability).toContain(
      '- os: ubuntu-latest\n            node: "24"\n            mode: container\n            timeout: 60'
    );
    expect(portability.match(/mode: host\n\s+timeout: 15/gu)).toHaveLength(3);
    expect(verifier).toContain("const DOCKER_BUILD_TIMEOUT_MS = 25 * 60 * 1000;");
    expect(verifier).toContain("const DOCKER_RUN_TIMEOUT_MS = 20 * 60 * 1000;");
    expect(verifier.match(/\{ timeoutMs: DOCKER_BUILD_TIMEOUT_MS \}/gu)).toHaveLength(1);
    expect(verifier.match(/\{ timeoutMs: DOCKER_RUN_TIMEOUT_MS \}/gu)).toHaveLength(1);
    expect(verifier).not.toContain("{ timeoutMs: 15 * 60 * 1000 }");
    expect(acceptanceCatalog).toContain(
      "const NPM_PACKAGE_INSTALLABILITY_TIMEOUT_MS = 55 * 60 * 1000;"
    );
    expect(acceptanceCatalog.match(/timeoutMs: NPM_PACKAGE_INSTALLABILITY_TIMEOUT_MS/gu))
      .toHaveLength(1);
    const buildMinutes = Number(
      verifier.match(/DOCKER_BUILD_TIMEOUT_MS = (\d+) \* 60 \* 1000/u)?.[1]
    );
    const runMinutes = Number(
      verifier.match(/DOCKER_RUN_TIMEOUT_MS = (\d+) \* 60 \* 1000/u)?.[1]
    );
    const acceptanceMinutes = Number(
      acceptanceCatalog.match(/NPM_PACKAGE_INSTALLABILITY_TIMEOUT_MS = (\d+) \* 60 \* 1000/u)?.[1]
    );
    const canonicalJobMinutes = Number(
      portability.match(/mode: container\n\s+timeout: (\d+)/u)?.[1]
    );
    const publicGateMinutes = Number(
      workflow.slice(publicGateStart, publicGateEnd).match(/timeout-minutes: (\d+)/u)?.[1]
    );
    const releaseVerify = jobSource(releaseWorkflow, "verify");
    const releaseAcceptance = jobSource(releaseWorkflow, "platform-acceptance");
    const assembly = jobSource(releaseWorkflow, "assemble-release-assets");
    const ciAcceptanceMinutes = Number(ciAcceptance.match(/timeout-minutes: (\d+)/u)?.[1]);
    const releaseAcceptanceMinutes = Number(
      releaseAcceptance.match(/timeout-minutes: (\d+)/u)?.[1]
    );
    const declaredAcceptanceJobMinutes = PLATFORM_ACCEPTANCE_JOB_BUDGET_MS / 60000;

    expect([buildMinutes, runMinutes, acceptanceMinutes, canonicalJobMinutes])
      .toEqual([25, 20, 55, 60]);
    expect(acceptanceMinutes).toBeGreaterThan(buildMinutes + runMinutes);
    expect(canonicalJobMinutes).toBeGreaterThan(buildMinutes + runMinutes);
    expect(publicGateMinutes).toBe(120);
    expect(releaseVerify).toContain("timeout-minutes: 120");
    expect(releaseVerify).not.toContain("npm run verify:acceptance");
    expect(PLATFORM_ACCEPTANCE_PARALLELISM).toBe(4);
    expect(PLATFORM_ACCEPTANCE_WORST_CASE_ESTIMATE).toMatchObject({
      commandCount: PLATFORM_ACCEPTANCE_COMMANDS.length,
      maxParallel: 4
    });
    const privateDeploymentCommand = PLATFORM_ACCEPTANCE_COMMANDS.find((command) =>
      command.id === "private-deployment-open-platform-e2e"
    );
    expect(privateDeploymentCommand?.timeoutMs).toBe(2 * 60 * 1000);
    expect(PLATFORM_ACCEPTANCE_JOB_BUDGET_MS).toBeGreaterThanOrEqual(
      PLATFORM_ACCEPTANCE_WORST_CASE_ESTIMATE.timeoutMs + PLATFORM_ACCEPTANCE_JOB_OVERHEAD_MS
    );
    expect([ciAcceptanceMinutes, releaseAcceptanceMinutes, declaredAcceptanceJobMinutes])
      .toEqual([395, 395, 395]);
    expect(ciAcceptance).toContain('LICO_RELEASE_PARALLELISM: "4"');
    expect(releaseAcceptance).toContain('LICO_RELEASE_PARALLELISM: "4"');
    expect(assembly).toContain("timeout-minutes: 60");
  });

  it("keeps the release directory limited to final files", () => {
    const releaseSource = read("tools/server-scripts/mcp-release.mjs");
    const portableSource = read("tools/server-scripts/lib/mcp-release-portable.mjs");
    expect(releaseSource).toContain("release_output_contains_non_file_entry");
    expect(releaseSource).toContain("`extracted-${target}`");
    expect(portableSource).toContain("fs.rm(stagingRoot, { recursive: true, force: true })");
    expect(portableSource).toContain("PINNED_DOWNLOAD_TIMEOUT_MS = 300000");
  });

  it("uses one canonical Node runtime cache resolver for assembly and source evidence", () => {
    const override = path.join(ROOT, "build", "fixture-node-runtime-cache");
    const dataDir = path.join(ROOT, "build", "fixture-data");
    expect(resolveNodeRuntimeCacheDirectory({
      environment: { LICO_MCP_NODE_RUNTIME_CACHE_DIR: `  ${override}  ` },
      dataDir: ""
    })).toBe(path.resolve(override));
    expect(resolveNodeRuntimeCacheDirectory({ environment: {}, dataDir })).toBe(
      path.join(path.resolve(dataDir), "cache", "mcp-node-runtime")
    );
    expect(() => resolveNodeRuntimeCacheDirectory({ environment: {}, dataDir: "" }))
      .toThrow("node_runtime_cache_data_directory_missing");

    const sourceEvidence = read("tools/server-scripts/prepare-node-runtime-source-evidence.mjs");
    expect(sourceEvidence).toContain(
      'import { resolveNodeRuntimeCacheDirectory } from "./lib/mcp-release-portable.mjs";'
    );
    expect(sourceEvidence).toContain("const cacheDir = resolveNodeRuntimeCacheDirectory();");
    expect(sourceEvidence).not.toContain("ServerConfig.getDataDir()");
  });

  it("rejects ambiguous archive paths and malformed checksum indexes", () => {
    expect(() => validateArchiveNames(["root/", "root/file"], "root", "fixture"))
      .not.toThrow();
    expect(() => validateArchiveNames(["root/", "root/file", "root/file/"], "root", "fixture"))
      .toThrow("fixture_normalized_path_collision");
    expect(() => validateArchiveNames(["root/", "root/FILE", "root/file"], "root", "fixture"))
      .toThrow("fixture_casefold_path_collision");
    expect(() => validateArchiveNames(["root/", "root\\file"], "root", "fixture"))
      .toThrow("fixture_unsafe_path_character");
    expect(() => parseChecksumIndex(`${"a".repeat(64)}  asset.tgz\n`)).not.toThrow();
    expect(() => parseChecksumIndex(`${"a".repeat(64)}  asset.tgz\n${"b".repeat(64)}  asset.tgz\n`))
      .toThrow("mcp_release_checksum_duplicate");
  });

  it("hashes archive subprocess output only after the stream closes", async () => {
    const payload = "portable-release-stream".repeat(1024);
    const digest = createHash("sha256").update(payload).digest("hex");
    await expect(hashCommand(process.execPath, [
      "--input-type=module",
      "-e",
      `process.stdout.write(${JSON.stringify(payload)})`
    ])).resolves.toBe(digest);
  });

  it("runs npm through its JavaScript CLI on Windows without a command shell", () => {
    const invocation = resolveNpmCliInvocation({
      env: { npm_execpath: "/runtime/npm-cli.js" },
      execPath: "/runtime/node",
      isFile: (candidate) => candidate === "/runtime/npm-cli.js",
      platform: "win32"
    });
    expect(invocation).toEqual({
      command: "/runtime/node",
      prefixArgs: ["/runtime/npm-cli.js"]
    });
    expect(npmCliArgs(invocation, ["pack", "--json"]))
      .toEqual(["/runtime/npm-cli.js", "pack", "--json"]);
    expect(() => resolveNpmCliInvocation({
      env: {},
      execPath: "/runtime/node",
      isFile: () => false,
      platform: "win32"
    })).toThrow("npm_cli_entrypoint_not_found");
  });

  it("removes the dedicated output after a release assembly failure", async () => {
    const outputDir = path.join(ROOT, "build", "release", "mcp-failure-cleanup-test");
    await fsPromises.rm(outputDir, { recursive: true, force: true });
    try {
      await expect(run(process.execPath, [
        "tools/server-scripts/mcp-release.mjs",
        "--output-dir",
        outputDir,
        "--platforms",
        "unsupported-platform"
      ], { timeoutMs: 30000 })).rejects.toBeTruthy();
      await expect(fsPromises.access(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fsPromises.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported release assembly arguments before creating output", async () => {
    const outputDir = path.join(ROOT, "build", "release", "mcp-unknown-argument-test");
    await fsPromises.rm(outputDir, { recursive: true, force: true });
    await expect(run(process.execPath, [
      "tools/server-scripts/mcp-release.mjs",
      "--output-dir",
      outputDir,
      "--unsupported-option"
    ], { timeoutMs: 30000 })).rejects.toBeTruthy();
    await expect(fsPromises.access(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts only a new or empty dedicated MCP output directory", async () => {
    const repositoryRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "licomesh-release-output-"));
    try {
      const releaseRoot = path.join(repositoryRoot, "build", "release");
      const allowed = path.join(releaseRoot, "mcp");
      await expect(prepareMcpReleaseOutputDirectory(allowed, { repositoryRoot })).resolves.toBe(allowed);

      await fsPromises.writeFile(path.join(allowed, "existing.txt"), "occupied", "utf8");
      await expect(
        prepareMcpReleaseOutputDirectory(allowed, { repositoryRoot })
      ).rejects.toThrow("release_output_directory_not_empty");
      await expect(
        prepareMcpReleaseOutputDirectory(repositoryRoot, { repositoryRoot })
      ).rejects.toThrow("release_output_directory_out_of_scope");
      await expect(
        prepareMcpReleaseOutputDirectory(releaseRoot, { repositoryRoot })
      ).rejects.toThrow("release_output_directory_out_of_scope");
      await expect(
        prepareMcpReleaseOutputDirectory(path.join(releaseRoot, "nested", "mcp"), { repositoryRoot })
      ).rejects.toThrow("release_output_directory_out_of_scope");
      await expect(
        prepareMcpReleaseOutputDirectory(path.join(repositoryRoot, "outside"), { repositoryRoot })
      ).rejects.toThrow("release_output_directory_out_of_scope");
      await expect(
        prepareMcpReleaseOutputDirectory(path.dirname(repositoryRoot), { repositoryRoot })
      ).rejects.toThrow("release_output_directory_out_of_scope");

      const fileOutput = path.join(releaseRoot, "file-target");
      await fsPromises.writeFile(fileOutput, "not-a-directory", "utf8");
      await expect(
        prepareMcpReleaseOutputDirectory(fileOutput, { repositoryRoot })
      ).rejects.toThrow("release_output_not_directory");

      const symlinkTarget = path.join(repositoryRoot, "symlink-target");
      const symlinkOutput = path.join(releaseRoot, "linked");
      await fsPromises.mkdir(symlinkTarget);
      await fsPromises.symlink(symlinkTarget, symlinkOutput);
      await expect(
        prepareMcpReleaseOutputDirectory(symlinkOutput, { repositoryRoot })
      ).rejects.toThrow("release_output_symlink_rejected");

      const ancestorRepository = path.join(repositoryRoot, "ancestor-repository");
      const ancestorTarget = path.join(repositoryRoot, "ancestor-target");
      await Promise.all([fsPromises.mkdir(ancestorRepository), fsPromises.mkdir(ancestorTarget)]);
      await fsPromises.symlink(ancestorTarget, path.join(ancestorRepository, "build"));
      await expect(prepareMcpReleaseOutputDirectory(
        path.join(ancestorRepository, "build", "release", "mcp"),
        { repositoryRoot: ancestorRepository }
      )).rejects.toThrow("release_output_ancestor_symlink_rejected");
    } finally {
      await fsPromises.rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("writes outer checksums with final flat asset names and rejects collisions", async () => {
    const temporaryRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "licomesh-release-checksum-"));
    try {
      const first = path.join(temporaryRoot, "mcp");
      const second = path.join(temporaryRoot, "supply-chain");
      await Promise.all([fsPromises.mkdir(first), fsPromises.mkdir(second)]);
      await Promise.all([
        fsPromises.writeFile(path.join(first, "connector.tar.gz"), "connector", "utf8"),
        fsPromises.writeFile(path.join(second, "bom.cdx.json"), "sbom", "utf8")
      ]);
      const outputPath = path.join(temporaryRoot, "RELEASE_SHA256SUMS");
      const result = await writeFlattenedReleaseChecksumAuthority({
        assetDirectories: [first, second],
        outputPath
      });
      expect(result.assetNames).toEqual(["bom.cdx.json", "connector.tar.gz"]);
      const checksumText = await fsPromises.readFile(outputPath, "utf8");
      expect(checksumText).not.toContain("mcp/");
      expect(checksumText).not.toContain("supply-chain/");

      await fsPromises.writeFile(path.join(second, "connector.tar.gz"), "collision", "utf8");
      await expect(writeFlattenedReleaseChecksumAuthority({
        assetDirectories: [first, second],
        outputPath: path.join(temporaryRoot, "nested", "RELEASE_SHA256SUMS")
      })).rejects.toThrow("release_asset_flat_name_collision");
    } finally {
      await fsPromises.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("requires every external lockfile dependency to use the official npm registry origin", () => {
    const lockfile = JSON.parse(read("package-lock.json"));
    const externalEntries = Object.entries(lockfile.packages)
      .filter(([packagePath, packageEntry]) => packagePath.startsWith("node_modules/") && packageEntry.link !== true);
    expect(externalEntries.length).toBeGreaterThan(0);
    for (const [, packageEntry] of externalEntries) {
      expect(new URL(packageEntry.resolved).origin).toBe("https://registry.npmjs.org");
    }

    const fixture = structuredClone(lockfile);
    fixture.packages[externalEntries[0][0]].resolved = "https://registry.example.test/package.tgz";
    expect(() => buildSupplyChainArtifacts(`${JSON.stringify(fixture)}\n`))
      .toThrow("official npm registry origin");
  });

  it("uses a governed schema identity for the reproducible supply-chain manifest", () => {
    const artifacts = buildSupplyChainArtifacts(read("package-lock.json"));
    expect(JSON.parse(artifacts.manifest).schemaVersion)
      .toBe(SUPPLY_CHAIN_MANIFEST_SCHEMA_VERSION);
  });

  it("keeps the built-in release runbook preparation-only", () => {
    const runbook = read("packages/foundation/config/entity-config/runbooks/project-release-runbook/README.md");
    expect(runbook).toContain("`npm run verify:acceptance` is the only project-level readiness authority");
    expect(runbook).toContain("`.github/workflows/release.yml` is the only release publication path");
    expect(runbook).toMatch(/This runbook does not commit, tag, push, upload, or\s+call a package registry/u);
    expect(runbook).toContain("`RELEASE_SHA256SUMS.sigstore.json`");
  });

  it("accepts only a strict npm dist-tag channel and bounds child processes", async () => {
    expect(normalizeReleaseChannel("stable")).toBe("stable");
    expect(normalizeReleaseChannel("next-release")).toBe("next-release");
    for (const invalid of ["", "Stable", "v1", "1.0.0", "next release", "../next", "next_tag"]) {
      expect(() => normalizeReleaseChannel(invalid)).toThrow("release_channel_dist_tag_invalid");
    }
    await expect(run(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      { timeoutMs: 25 }
    )).rejects.toMatchObject({ killed: true });
  });
});
