import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  SUPPLY_CHAIN_MANIFEST_SCHEMA_VERSION,
  buildSupplyChainArtifacts
} from "../../../tools/generators/generate-supply-chain-artifacts.ts";
import {
  normalizeReleaseChannel,
  prepareMcpReleaseOutputDirectory,
  run,
  writeFlattenedReleaseChecksumAuthority
} from "../../../tools/server-scripts/lib/mcp-release-common.ts";
import {
  resolveNodeRuntimeCacheDirectory
} from "../../../tools/server-scripts/lib/mcp-release-portable.ts";
import {
  npmCliArgs,
  resolveNpmCliInvocation
} from "../../../tools/server-scripts/lib/npm-cli-invocation.ts";
import {
  MCP_PORTABLE_TARGETS,
  MCP_RELEASE_TARGETS,
  normalizeMcpPortableTargets
} from "../../../tools/server-scripts/lib/mcp-release-platforms.ts";
import {
  PLATFORM_ACCEPTANCE_JOB_BUDGET_MS,
  PLATFORM_ACCEPTANCE_JOB_OVERHEAD_MS,
  PLATFORM_ACCEPTANCE_COMMANDS,
  PLATFORM_ACCEPTANCE_PARALLELISM,
  PLATFORM_ACCEPTANCE_WORST_CASE_ESTIMATE
} from "../../../tools/server-scripts/verify-platform-acceptance.ts";
import {
  hashCommand,
  parseChecksumIndex,
  validateArchiveNames
} from "../../../tools/server-scripts/verify-mcp-release-assets.ts";

const ROOT: any = path.resolve(import.meta.dirname, "../../..");

function read(relativePath?: any) : any {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function jobSource(workflow?: any, jobId?: any) : any {
  const marker: any = `  ${jobId}:\n`;
  const start: any = workflow.indexOf(marker);
  if (start < 0) throw new Error(`release_workflow_job_missing:${jobId}`);
  const remainder: any = workflow.slice(start + marker.length);
  const nextJob: any = remainder.search(/\n  [a-z][a-z0-9-]*:\n/u);
  return workflow.slice(start, nextJob < 0 ? workflow.length : start + marker.length + nextJob);
}

function directJobNeeds(workflow?: any, jobId?: any) : any {
  const source: any = jobSource(workflow, jobId);
  const inline: any = source.match(/^    needs:\s*\[([^\]]*)\]\s*$/mu)?.[1];
  if (inline === undefined) return [];
  return inline.split(",").map((value?: any) : any => value.trim()).filter(Boolean);
}

function jobTransitivelyNeeds(workflow?: any, jobId?: any, requiredJobId?: any, visited: any = new Set<any>()) : any {
  if (visited.has(jobId)) return false;
  visited.add(jobId);
  const needs: any = directJobNeeds(workflow, jobId);
  return needs.includes(requiredJobId) || needs.some((dependency?: any) : any =>
    jobTransitivelyNeeds(workflow, dependency, requiredJobId, visited)
  );
}

describe("release workflow supply-chain boundary", () : any => {
  it("requires the self-contained Core upstream gate before functional acceptance and publication", () : any => {
    const workflow: any = read(".github/workflows/release.yml");
    const upstreamJobId: any = "upstream-service-publishing";
    const upstream: any = jobSource(workflow, upstreamJobId);
    const functional: any = jobSource(workflow, "functional-completeness");
    const publicationJobs: any[] = [
      "build-release-image",
      "sign-finalize-release",
      "prepare-release-draft",
      "publish-container-version",
      "publish-npm-release-set",
      "publish-github-release",
      "advance-container-latest"
    ];

    expect(directJobNeeds(workflow, upstreamJobId)).toContain("verify");
    expect(upstream).toContain("name: Install Core dependencies");
    expect(upstream).toContain("run: npm ci");
    expect(upstream).toContain(
      "name: Verify the self-contained Core upstream publishing boundary"
    );
    expect(upstream).toContain("run: npm run verify:upstream-service-publishing");
    expect(upstream).not.toMatch(/\b(?:git|gh repo) clone\b/u);
    expect(upstream).not.toContain("contents: write");
    expect(upstream).not.toContain("packages: write");
    expect(upstream).not.toContain("id-token: write");

    expect(directJobNeeds(workflow, "functional-completeness"))
      .toContain(upstreamJobId);
    expect(functional).toContain("name: Functional-complete authority");
    expect(workflow.match(/name: Functional-complete authority/gu)).toHaveLength(1);
    expect(upstream).not.toContain("Functional-complete authority");
    expect(upstream).not.toContain("functional-complete");
    for (const jobId of publicationJobs) {
      expect(
        jobTransitivelyNeeds(workflow, jobId, upstreamJobId),
        `${jobId} must retain the Core upstream publishing prerequisite`
      ).toBe(true);
    }
  });

  it("freezes one source-candidate artifact and joins its functional and OCI authorities before signing", () : any => {
    const workflow: any = read(".github/workflows/release.yml");
    const freeze: any = jobSource(workflow, "freeze-source-candidate");
    const functional: any = jobSource(workflow, "functional-completeness");
    const image: any = jobSource(workflow, "build-release-image");
    const sign: any = jobSource(workflow, "sign-finalize-release");
    const candidateArtifact: any = "release-source-candidate-${{ github.sha }}";

    expect(directJobNeeds(workflow, "freeze-source-candidate")).toContain("verify");
    expect(freeze.match(/verify-release-candidate-identity\.ts/gu)).toHaveLength(1);
    expect(freeze.match(/actions\/upload-artifact@/gu)).toHaveLength(1);
    expect(freeze).toContain(`name: ${candidateArtifact}`);
    expect(freeze).toContain("build/release/control/SOURCE_CANDIDATE.json");

    expect(directJobNeeds(workflow, "functional-completeness"))
      .toContain("freeze-source-candidate");
    expect(functional).toContain(`name: ${candidateArtifact}`);
    expect(functional).toContain("build/release/control/SOURCE_CANDIDATE.json");
    expect(functional).toContain("--source-candidate");

    expect(jobTransitivelyNeeds(workflow, "build-release-image", "freeze-source-candidate"))
      .toBe(true);
    expect(image).toContain(`name: ${candidateArtifact}`);
    expect(image).toContain("--source-candidate build/release/control/SOURCE_CANDIDATE.json");

    expect(jobTransitivelyNeeds(workflow, "sign-finalize-release", "functional-completeness"))
      .toBe(true);
    expect(sign).toContain(`name: ${candidateArtifact}`);
    expect(sign).toContain("name: functional-platform-acceptance");
    expect(sign).toContain(
      "imageAuthority.candidateDigest !== sourceCandidate.candidate_digest"
    );
    expect(sign).toContain(
      "functionalAuthority.candidate_digest !== sourceCandidate.candidate_digest"
    );
    expect(sign.indexOf("imageAuthority.candidateDigest"))
      .toBeLessThan(sign.indexOf("cosign sign"));
  });

  it("keeps functional completeness mandatory without native-host publication dependencies", () : any => {
    const workflow: any = read(".github/workflows/release.yml");
    const orderedJobs: any[] = [
      "verify-release-inputs",
      "npm-registry-preflight",
      "build-release-image",
      "sign-finalize-release",
      "prepare-release-draft",
      "publish-container-version",
      "publish-npm-release-set",
      "publish-github-release",
      "advance-container-latest"
    ];
    const verifyJob: any = workflow.indexOf("  verify:\n");
    const firstPublicationJob: any = workflow.indexOf("  verify-release-inputs:\n");
    const verification: any = jobSource(workflow, "verify");
    const acceptanceJob: any = jobSource(workflow, "functional-completeness");
    const assembly: any = jobSource(workflow, "assemble-release-assets");
    expect(workflow).toContain('tags: ["v*"]');
    expect(verification).toContain("npm run release:prepare -- --check --tag");
    expect(verification).toContain("npm run verify:release-definition -- --tag");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(verifyJob).toBeGreaterThan(0);
    expect(firstPublicationJob).toBeGreaterThan(verifyJob);
    expect(verification).not.toContain("npm run verify:acceptance");
    expect(acceptanceJob).toContain(
      "needs: [verify, upstream-service-publishing, freeze-source-candidate]"
    );
    expect(acceptanceJob).toContain("name: Functional completeness release gate");
    expect(acceptanceJob).toContain("name: Functional-complete authority");
    expect(acceptanceJob).toContain("MESHRIX_RELEASE_PARALLELISM: \"4\"");
    expect(acceptanceJob).toContain("verify-platform-acceptance.ts");
    expect(acceptanceJob).toContain("--field acceptance.profile");
    expect(acceptanceJob).toContain("environment: release-candidate");
    expect(assembly).toContain("needs: [verify, functional-completeness]");
    const orderedJobOffsets: any = orderedJobs.map((jobId?: any) : any => workflow.indexOf(`  ${jobId}:\n`));
    expect(orderedJobOffsets.every((offset?: any) : any => offset > 0)).toBe(true);
    expect(orderedJobOffsets).toEqual([...orderedJobOffsets].sort((a?: any, b?: any) : any => a - b));
    expect(workflow).toContain("group: release");
    expect(workflow).toContain("refs/remotes/origin/release");
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).not.toContain("  npm-package-portability:\n");
    expect(workflow).not.toContain("--host-platform-probe");
    expect(workflow).not.toContain("continue-on-error: true");
    expect(workflow).not.toContain("\n  platform-acceptance:\n");
    expect(workflow).not.toContain("Canonical platform acceptance");
    expect(jobSource(workflow, "verify-release-inputs")).toContain(
      "needs: [verify, assemble-release-assets]"
    );
    const npmPreflight: any = jobSource(workflow, "npm-registry-preflight");
    expect(npmPreflight).toContain("needs: [verify, functional-completeness]");
    expect(npmPreflight).toContain("run: npm run release:publish-npm -- --preflight");
    expect(jobSource(workflow, "build-release-image")).toContain(
      "needs: [verify-release-inputs, npm-registry-preflight]"
    );
    expect(jobSource(workflow, "prepare-release-draft")).toContain("gh release create");
    expect(jobSource(workflow, "prepare-release-draft"))
      .toContain("--notes-file build/release/RELEASE_NOTES.md");
    expect(jobSource(workflow, "publish-npm-release-set")).toContain(
      "needs: [functional-completeness, sign-finalize-release, prepare-release-draft, publish-container-version]"
    );
    expect(jobSource(workflow, "publish-github-release")).toContain(
      "needs: [prepare-release-draft, publish-container-version, publish-npm-release-set]"
    );
    expect(jobTransitivelyNeeds(workflow, "publish-npm-release-set", "prepare-release-draft"))
      .toBe(true);
    expect(jobTransitivelyNeeds(workflow, "publish-npm-release-set", "publish-container-version"))
      .toBe(true);
    expect(jobTransitivelyNeeds(workflow, "publish-npm-release-set", "npm-package-node22"))
      .toBe(false);
    expect(jobTransitivelyNeeds(
      workflow,
      "publish-npm-release-set",
      "verify-macos-mcp-final-asset"
    )).toBe(false);
    expect(jobTransitivelyNeeds(
      workflow,
      "publish-container-version",
      "verify-release-image-native"
    )).toBe(false);
    expect(workflow).not.toContain("npm run verify:real-machine");
    expect(jobTransitivelyNeeds(workflow, "publish-container-version", "npm-registry-preflight"))
      .toBe(true);
    expect(jobTransitivelyNeeds(workflow, "publish-github-release", "publish-npm-release-set"))
      .toBe(true);
    expect(jobSource(workflow, "publish-npm-release-set"))
      .toContain("run: npm run release:publish-npm");
    expect(workflow).toContain(".github/RELEASE_TEMPLATE.md");
    expect(MCP_RELEASE_TARGETS).toEqual(["macos-arm64"]);
    expect(normalizeMcpPortableTargets(null)).toEqual(["macos-arm64"]);
    expect(MCP_RELEASE_TARGETS.every((target?: any) : any => MCP_PORTABLE_TARGETS.includes(target))).toBe(true);
    expect(() : any => normalizeMcpPortableTargets("unsupported-platform")).toThrow(
      "mcp_release_platform_not_supported"
    );
  });

  it("runs every optional real-machine target in an independent workflow", () : any => {
    const releaseWorkflow: any = read(".github/workflows/release.yml");
    const ciWorkflow: any = read(".github/workflows/ci.yml");
    const workflow: any = read(".github/workflows/real-machine-validation.yml");
    const targets: any[] = [
      "native-linux-x64",
      "native-linux-arm64",
      "native-macos-arm64",
      "native-windows-x64",
      "public-cloud-single-node",
      "clean-host-recovery",
    ];

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("npm run verify:real-machine --");
    expect(workflow).toContain("verify-release-acceptance-standards.ts");
    expect(workflow).toContain("name: functional-platform-acceptance");
    expect(workflow).toContain("run-id: ${{ inputs.functional_run_id }}");
    expect(workflow).toContain("source_revision:");
    expect(workflow).toContain("ref: ${{ inputs.source_revision }}");
    expect(workflow).toContain("verify-real-machine-source-run.ts");
    expect(workflow).toContain("verify-real-machine-workflow-inputs.ts");
    expect(workflow).toContain("name: unsigned-release-image-${{ inputs.source_revision }}");
    expect(workflow).toContain("resolve-real-machine-candidate.ts");
    expect(workflow).toContain("MESHRIX_REAL_MACHINE_CANDIDATE_IMAGE: ${{ steps.candidate.outputs.image }}");
    expect(workflow).toContain('--candidate "${{ steps.candidate.outputs.digest }}"');
    expect(workflow).toContain("MESHRIX_REAL_MACHINE_SECRET_ROOT: ${{ runner.temp }}/meshrix-real-machine-secrets");
    expect(workflow).toContain("Remove ephemeral production secret custody inputs");
    expect(workflow.indexOf("Remove ephemeral production secret custody inputs"))
      .toBeGreaterThan(workflow.indexOf("Preserve privacy-safe phase and final receipts"));
    expect(workflow).not.toContain(
      "path: ${{ runner.temp }}/meshrix-real-machine-secrets/"
    );
    expect(workflow).not.toContain("candidate_artifact_run_id:");
    expect(workflow).not.toContain("candidate_digest:");
    expect(workflow).toContain("actions: read");
    for (const target of targets) {
      expect(workflow).toContain(`- ${target}`);
    }
    expect(workflow).toContain("'macos-15'");
    expect(workflow).toContain("'windows-2025'");
    expect(workflow).toContain("'ubuntu-24.04-arm'");
    expect(workflow).toContain("meshrix-public-cloud");
    expect(workflow).toContain("meshrix-clean-host-recovery");
    expect(releaseWorkflow).not.toContain("verify:real-machine");
    expect(releaseWorkflow).not.toContain("real-machine-validation.yml");
    expect(releaseWorkflow).not.toContain("--host-platform-probe");
    expect(ciWorkflow).not.toContain("--host-platform-probe");
    expect(ciWorkflow).not.toContain("windows-installer-security:");
    expect(ciWorkflow).not.toContain("macos-latest");
    expect(ciWorkflow).not.toContain("windows-latest");
    expect(ciWorkflow).not.toContain("continue-on-error: true");
    expect(jobSource(ciWorkflow, "functional-completeness"))
      .toContain("name: Functional completeness release gate");
    expect(ciWorkflow).not.toContain("\n  platform-acceptance:\n");
  });

  it("keeps native execution and external journeys out of the release definition", () : any => {
    const definition: any = JSON.parse(read("tools/registry/release-definition.registry.json"));
    expect(definition.acceptance).toMatchObject({
      requiredClaim: "functional-complete",
      standardsRegistry: "tools/registry/release-acceptance-standards.registry.json",
    });
    expect(definition.github).not.toHaveProperty("imageVerification");
    expect(definition).not.toHaveProperty("journeyGate");
    expect(definition.container.platforms).toEqual(["linux/amd64", "linux/arm64"]);
  });

  it("enforces least privilege and repository-code boundaries across every publication job", () : any => {
    const workflow: any = read(".github/workflows/release.yml");
    const verification: any = jobSource(workflow, "verify");
    const acceptance: any = jobSource(workflow, "functional-completeness");
    const assembly: any = jobSource(workflow, "assemble-release-assets");
    const inputs: any = jobSource(workflow, "verify-release-inputs");
    const npmPreflight: any = jobSource(workflow, "npm-registry-preflight");
    const build: any = jobSource(workflow, "build-release-image");
    const sign: any = jobSource(workflow, "sign-finalize-release");
    const draft: any = jobSource(workflow, "prepare-release-draft");
    const version: any = jobSource(workflow, "publish-container-version");
    const githubRelease: any = jobSource(workflow, "publish-github-release");
    const npmRelease: any = jobSource(workflow, "publish-npm-release-set");
    const latest: any = jobSource(workflow, "advance-container-latest");

    expect(verification).toContain("permissions:\n      contents: read");
    expect(verification).not.toContain("contents: write");
    expect(verification).not.toContain("packages: write");
    expect(verification).not.toContain("id-token: write");

    expect(acceptance).toContain("permissions:\n      contents: read");
    expect(acceptance).not.toContain("contents: write");
    expect(acceptance).not.toContain("packages: write");
    expect(acceptance).not.toContain("id-token: write");

    expect(assembly).toContain("permissions:\n      contents: read");
    expect(assembly).toContain("run: npm ci --ignore-scripts");
    expect(assembly).toContain("run: npm run release:prepare-node-runtime-source-evidence");
    expect(assembly).not.toContain("node tools/server-scripts/prepare-node-runtime-source-evidence.ts");
    expect(assembly).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");

    expect(inputs).toContain("permissions:\n      contents: read");
    expect(inputs).toContain("actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5");
    expect(inputs).toContain("fetch-depth: 0");
    expect(inputs).toContain("run: npm ci --ignore-scripts");
    expect(inputs).toContain("verify-mcp-release-assets.ts");
    expect(inputs).toContain("--node-runtime-source-dir build/release/node-runtime-source");
    expect(inputs).toContain("git log --first-parent --format='%s%x00'");
    expect(inputs).not.toContain("releases/generate-notes");
    expect(inputs).toContain("RELEASE_RENDERED_NOTES=\"build/release/RELEASE_NOTES.md\"");

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
    expect(build).toContain("create-release-image-authority.ts");
    expect(read("tools/server-scripts/lib/release-image-evidence.ts"))
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

  it("pins every third-party action and emits container provenance plus an SBOM", () : any => {
    const workflow: any = read(".github/workflows/release.yml");
    const sourceCandidateFreeze: any = jobSource(workflow, "freeze-source-candidate");
    const uses: any = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)\s*(?:#.*)?$/gmu)]
      .map((match?: any) : any => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((value?: any) : any => /@[a-f0-9]{40}$/u.test(value))).toBe(true);
    expect(workflow).toContain("--json-field container.platforms");
    expect(workflow).toContain('--platform "$platform_csv"');
    expect(workflow).toContain('--target "$image_target"');
    expect(jobSource(workflow, "sign-finalize-release"))
      .toContain("needs: [verify-release-inputs, build-release-image]");
    expect(workflow).toContain("--provenance=mode=max,version=v0.2");
    expect(workflow).toContain(
      "aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25"
    );
    const build: any = jobSource(workflow, "build-release-image");
    expect(build.match(/aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/gu))
      .toHaveLength(2);
    expect(build.match(/TRIVY_PLATFORM: linux\/(?:amd64|arm64)/gu))
      .toEqual(["TRIVY_PLATFORM: linux/amd64", "TRIVY_PLATFORM: linux/arm64"]);
    expect(build.match(/version: v0\.69\.3/gu)).toHaveLength(2);
    expect(build.match(/severity: CRITICAL,HIGH/gu)).toHaveLength(2);
    expect(build.match(/exit-code: "1"/gu)).toHaveLength(2);
    expect(build.match(/ignore-unfixed: true/gu)).toHaveLength(2);
    expect(build).toContain('--build-arg "MESHRIX_SOURCE_REPOSITORY=${GITHUB_REPOSITORY}"');
    expect(build).toContain('--build-arg "MESHRIX_SOURCE_REF=${GITHUB_REF}"');
    expect(build).toContain('--build-arg "MESHRIX_SOURCE_COMMIT=${GITHUB_SHA}"');
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
    expect(workflow).toContain("generate-supply-chain-artifacts.ts --output build/release/supply-chain");
    expect(workflow).toContain("verify-supply-chain-artifacts.ts --input build/release/supply-chain");
    expect(sourceCandidateFreeze).toContain("build/release/control/SOURCE_CANDIDATE.json");
    expect(sourceCandidateFreeze).toContain("overwrite: true");
    expect(workflow.match(/overwrite: true/gu)).toHaveLength(5);
  });

  it("signs before immutable publication and exposes the GitHub release only after npm", () : any => {
    const workflow: any = read(".github/workflows/release.yml");
    const npmPreflightStep: any = workflow.indexOf(
      "name: Read and validate all npm package versions and dist-tags without publication"
    );
    const candidateMutationStep: any = workflow.indexOf(
      "name: Resolve or stage the immutable multi-platform container"
    );
    const immutableStep: any = workflow.indexOf("name: Publish the immutable container version tag");
    const signingStep: any = workflow.indexOf("name: Sign the staged digest or reverify a resumable version");
    const draftStep: any = workflow.indexOf("name: Prepare or resume the private GitHub release draft");
    const assetVerificationStep: any = workflow.indexOf("name: Verify the exact remote release asset set");
    const releaseOrderStep: any = workflow.indexOf("name: Determine monotonic release ordering");
    const releasePublicationStep: any = workflow.indexOf("name: Publish the verified GitHub release draft");
    const npmPublicationStep: any = workflow.indexOf("name: Publish missing tarballs or reverify immutable versions");
    const latestStep: any = workflow.indexOf("name: Verify immutable publication and advance the stable container tag");
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
    const source: any = workflow.slice(immutableStep, releasePublicationStep);
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

  it("uses one immutable Node base-image reference across Docker authorities", () : any => {
    const dockerfile: any = read("Dockerfile");
    const deploymentIndex: any = JSON.parse(read("packages/foundation/config/deployment/index.json"));
    const image: any = dockerfile.match(/^ARG NODE_BASE_IMAGE=(.+)$/mu)?.[1] || "";
    expect(image).toMatch(/^node:24\.\d+\.\d+-bookworm-slim@sha256:[a-f0-9]{64}$/u);
    expect(deploymentIndex.dockerPresets.baseImages.mainService).toBe(image);
    expect(deploymentIndex.dockerPresets.mainService.buildArgs.NODE_BASE_IMAGE).toBe(image);
    expect(dockerfile).not.toContain("default-settings.json");
  });

  it("keeps compose discovery coordinates aligned with its host port and shutdown budget", () : any => {
    const compose: any = read("docker-compose.yml");
    const releaseTemplate: any = read(".github/RELEASE_TEMPLATE.md");
    expect(compose).toContain(
      '"${MESHRIX_BIND_ADDRESS:-127.0.0.1}:${MESHRIX_HOST_PORT:-7228}:7228"'
    );
    expect(compose).toContain("healthcheck:");
    expect(compose).toContain("stop_grace_period: 90s");
    expect(releaseTemplate).toContain("--stop-timeout 90");
    for (const field of [
      "MESHRIX_BOOTSTRAP_URL",
      "MESHRIX_ADVERTISED_BASE_URL",
      "MESHRIX_ACTIVE_SERVICE_URL"
    ]) {
      expect(compose).toContain(
        `${field}: http://${"${MESHRIX_ADVERTISED_HOST:-127.0.0.1}"}:${"${MESHRIX_HOST_PORT:-7228}"}`
      );
      expect(compose).not.toContain(`${field}: http://127.0.0.1:7228`);
    }
  });

  it("keeps the npm verifier cache content-addressed and project-isolated", () : any => {
    const dockerfile: any = read("Dockerfile");
    const cacheMount: any =
      "--mount=type=cache,id=meshrix-core-npm,target=${ROOTFS}var/cache/meshrix/npm,sharing=locked";
    expect(dockerfile.split(cacheMount)).toHaveLength(3);
    expect(dockerfile).toContain('--cache="${ROOTFS}var/cache/meshrix/npm"');
    expect(dockerfile).toContain(
      'cp -a "${ROOTFS}var/cache/meshrix/npm/_cacache" "${ROOTFS}opt/meshrix-npm-cache/_cacache"'
    );
    expect(dockerfile).not.toContain("cp -a ${ROOTFS}var/cache/meshrix/npm/. ");
    expect(dockerfile).not.toContain(["", "root", ".npm"].join("/"));
  });

  it("executes the connector from the canonical npm release set", () : any => {
    const verifier: any = read("tools/server-scripts/verify-npm-package-installability.ts");
    expect(verifier).toContain('import { discoverReleaseSet } from "./publish-release-set.ts";');
    expect(verifier).toContain('name === "meshrix-mcp-connector"');
    expect(verifier).toContain('connectorFiles.includes("dist/lib/mcp-proxy-session.js")');
    expect(verifier).toContain('"meshrix-mcp", "version", "--json"');
  });

  it("gives the canonical fresh-container package simulation a bounded timeout", () : any => {
    const workflow: any = read(".github/workflows/ci.yml");
    const releaseWorkflow: any = read(".github/workflows/release.yml");
    const verifier: any = read("tools/server-scripts/verify-npm-package-installability.ts");
    const acceptanceCatalog: any = read(
      "tools/server-scripts/lib/platform-acceptance-command-catalog.ts"
    );
    const publicGateStart: any = workflow.indexOf("  public-gate:\n");
    const publicGateEnd: any = workflow.indexOf("\n  functional-completeness:\n", publicGateStart);
    const ciAcceptance: any = jobSource(workflow, "functional-completeness");
    const portabilityStart: any = workflow.indexOf("  npm-package-portability:\n");
    const nextJob: any = workflow.indexOf("\n  supply-chain:\n", portabilityStart);
    expect(portabilityStart).toBeGreaterThan(0);
    expect(nextJob).toBeGreaterThan(portabilityStart);
    expect(publicGateStart).toBeGreaterThan(0);
    expect(publicGateEnd).toBeGreaterThan(publicGateStart);
    expect(workflow.slice(publicGateStart, publicGateEnd)).toContain("timeout-minutes: 120");
    const portability: any = workflow.slice(portabilityStart, nextJob);
    expect(portability).toContain("runs-on: ubuntu-latest");
    expect(portability).toContain("timeout-minutes: 60");
    expect(portability).toContain('node-version: "24"');
    expect(portability).toContain("npm run verify:npm-package-installability");
    expect(portability).not.toContain("matrix.");
    expect(portability).not.toContain("--host-platform-probe");
    expect(workflow).not.toContain("windows-installer-security:");
    expect(workflow).not.toContain("macos-latest");
    expect(workflow).not.toContain("windows-latest");
    expect(verifier).toContain("const DOCKER_BUILD_TIMEOUT_MS: any = 25 * 60 * 1000;");
    expect(verifier).toContain("const DOCKER_RUN_TIMEOUT_MS: any = 20 * 60 * 1000;");
    expect(verifier.match(/\{ timeoutMs: DOCKER_BUILD_TIMEOUT_MS \}/gu)).toHaveLength(1);
    expect(verifier.match(/\{ timeoutMs: DOCKER_RUN_TIMEOUT_MS \}/gu)).toHaveLength(1);
    expect(verifier).not.toContain("{ timeoutMs: 15 * 60 * 1000 }");
    expect(acceptanceCatalog).toContain(
      "const NPM_PACKAGE_INSTALLABILITY_TIMEOUT_MS: any = 55 * 60 * 1000;"
    );
    expect(acceptanceCatalog.match(/timeoutMs: NPM_PACKAGE_INSTALLABILITY_TIMEOUT_MS/gu))
      .toHaveLength(1);
    const buildMinutes: any = Number(
      verifier.match(/DOCKER_BUILD_TIMEOUT_MS(?:: any)? = (\d+) \* 60 \* 1000/u)?.[1]
    );
    const runMinutes: any = Number(
      verifier.match(/DOCKER_RUN_TIMEOUT_MS(?:: any)? = (\d+) \* 60 \* 1000/u)?.[1]
    );
    const acceptanceMinutes: any = Number(
      acceptanceCatalog.match(/NPM_PACKAGE_INSTALLABILITY_TIMEOUT_MS(?:: any)? = (\d+) \* 60 \* 1000/u)?.[1]
    );
    const canonicalJobMinutes: any = Number(
      portability.match(/timeout-minutes: (\d+)/u)?.[1]
    );
    const publicGateMinutes: any = Number(
      workflow.slice(publicGateStart, publicGateEnd).match(/timeout-minutes: (\d+)/u)?.[1]
    );
    const releaseVerify: any = jobSource(releaseWorkflow, "verify");
    const releaseAcceptance: any = jobSource(releaseWorkflow, "functional-completeness");
    const assembly: any = jobSource(releaseWorkflow, "assemble-release-assets");
    const ciAcceptanceMinutes: any = Number(ciAcceptance.match(/timeout-minutes: (\d+)/u)?.[1]);
    const releaseAcceptanceMinutes: any = Number(
      releaseAcceptance.match(/timeout-minutes: (\d+)/u)?.[1]
    );
    const declaredAcceptanceJobMinutes: any = PLATFORM_ACCEPTANCE_JOB_BUDGET_MS / 60000;

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
    const privateDeploymentCommand: any = PLATFORM_ACCEPTANCE_COMMANDS.find((command?: any) : any =>
      command.id === "private-deployment-internal-platform-e2e"
    );
    expect(privateDeploymentCommand?.timeoutMs).toBe(2 * 60 * 1000);
    expect(PLATFORM_ACCEPTANCE_JOB_BUDGET_MS).toBeGreaterThanOrEqual(
      PLATFORM_ACCEPTANCE_WORST_CASE_ESTIMATE.timeoutMs + PLATFORM_ACCEPTANCE_JOB_OVERHEAD_MS
    );
    expect([ciAcceptanceMinutes, releaseAcceptanceMinutes, declaredAcceptanceJobMinutes])
      .toEqual([395, 395, 395]);
    expect(ciAcceptance).toContain('MESHRIX_RELEASE_PARALLELISM: "4"');
    expect(releaseAcceptance).toContain('MESHRIX_RELEASE_PARALLELISM: "4"');
    expect(assembly).toContain("timeout-minutes: 60");
  });

  it("keeps the release directory limited to final files", () : any => {
    const releaseSource: any = read("tools/server-scripts/mcp-release.ts");
    const portableSource: any = read("tools/server-scripts/lib/mcp-release-portable.ts");
    expect(releaseSource).toContain("release_output_contains_non_file_entry");
    expect(releaseSource).toContain("`extracted-${target}`");
    expect(portableSource).toContain("fs.rm(stagingRoot, { recursive: true, force: true })");
    expect(portableSource).toContain("PINNED_DOWNLOAD_TIMEOUT_MS: any = 300000");
  });

  it("uses one canonical Node runtime cache resolver for assembly and source evidence", () : any => {
    const override: any = path.join(ROOT, "build", "fixture-node-runtime-cache");
    const dataDir: any = path.join(ROOT, "build", "fixture-data");
    expect(resolveNodeRuntimeCacheDirectory({
      environment: { MESHRIX_MCP_NODE_RUNTIME_CACHE_DIR: `  ${override}  ` },
      dataDir: ""
    })).toBe(path.resolve(override));
    expect(resolveNodeRuntimeCacheDirectory({ environment: {}, dataDir })).toBe(
      path.join(path.resolve(dataDir), "cache", "mcp-node-runtime")
    );
    expect(() : any => resolveNodeRuntimeCacheDirectory({ environment: {}, dataDir: "" }))
      .toThrow("node_runtime_cache_data_directory_missing");

    const sourceEvidence: any = read("tools/server-scripts/prepare-node-runtime-source-evidence.ts");
    expect(sourceEvidence).toContain(
      'import { resolveNodeRuntimeCacheDirectory } from "./lib/mcp-release-portable.ts";'
    );
    expect(sourceEvidence).toContain("const cacheDir: any = resolveNodeRuntimeCacheDirectory();");
    expect(sourceEvidence).not.toContain("ServerConfig.getDataDir()");
  });

  it("rejects ambiguous archive paths and malformed checksum indexes", () : any => {
    expect(() : any => validateArchiveNames(["root/", "root/file"], "root", "fixture"))
      .not.toThrow();
    expect(() : any => validateArchiveNames(["root/", "root/file", "root/file/"], "root", "fixture"))
      .toThrow("fixture_normalized_path_collision");
    expect(() : any => validateArchiveNames(["root/", "root/FILE", "root/file"], "root", "fixture"))
      .toThrow("fixture_casefold_path_collision");
    expect(() : any => validateArchiveNames(["root/", "root\\file"], "root", "fixture"))
      .toThrow("fixture_unsafe_path_character");
    expect(() : any => parseChecksumIndex(`${"a".repeat(64)}  asset.tgz\n`)).not.toThrow();
    expect(() : any => parseChecksumIndex(`${"a".repeat(64)}  asset.tgz\n${"b".repeat(64)}  asset.tgz\n`))
      .toThrow("mcp_release_checksum_duplicate");
  });

  it("hashes archive subprocess output only after the stream closes", async () : Promise<any> => {
    const payload: any = "portable-release-stream".repeat(1024);
    const digest: any = createHash("sha256").update(payload).digest("hex");
    await expect(hashCommand(process.execPath, [
      "--input-type=module",
      "-e",
      `process.stdout.write(${JSON.stringify(payload)})`
    ])).resolves.toBe(digest);
  });

  it("runs npm through its JavaScript CLI on Windows without a command shell", () : any => {
    const invocation: any = resolveNpmCliInvocation({
      env: { npm_execpath: "/runtime/npm-cli.js" },
      execPath: "/runtime/node",
      isFile: (candidate?: any) : any => candidate === "/runtime/npm-cli.js",
      platform: "win32"
    });
    expect(invocation).toEqual({
      command: "/runtime/node",
      prefixArgs: ["/runtime/npm-cli.js"]
    });
    expect(npmCliArgs(invocation, ["pack", "--json"]))
      .toEqual(["/runtime/npm-cli.js", "pack", "--json"]);
    expect(() : any => resolveNpmCliInvocation({
      env: {},
      execPath: "/runtime/node",
      isFile: () : any => false,
      platform: "win32"
    })).toThrow("npm_cli_entrypoint_not_found");
  });

  it("removes the dedicated output after a release assembly failure", async () : Promise<any> => {
    const outputDir: any = path.join(ROOT, "build", "release", "mcp-failure-cleanup-test");
    await fsPromises.rm(outputDir, { recursive: true, force: true });
    try {
      await expect(run(process.execPath, [
        "tools/server-scripts/mcp-release.ts",
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

  it("rejects unsupported release assembly arguments before creating output", async () : Promise<any> => {
    const outputDir: any = path.join(ROOT, "build", "release", "mcp-unknown-argument-test");
    await fsPromises.rm(outputDir, { recursive: true, force: true });
    await expect(run(process.execPath, [
      "tools/server-scripts/mcp-release.ts",
      "--output-dir",
      outputDir,
      "--unsupported-option"
    ], { timeoutMs: 30000 })).rejects.toBeTruthy();
    await expect(fsPromises.access(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts only a new or empty dedicated MCP output directory", async () : Promise<any> => {
    const repositoryRoot: any = await fsPromises.mkdtemp(path.join(os.tmpdir(), "meshrix-release-output-"));
    try {
      const releaseRoot: any = path.join(repositoryRoot, "build", "release");
      const allowed: any = path.join(releaseRoot, "mcp");
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

      const fileOutput: any = path.join(releaseRoot, "file-target");
      await fsPromises.writeFile(fileOutput, "not-a-directory", "utf8");
      await expect(
        prepareMcpReleaseOutputDirectory(fileOutput, { repositoryRoot })
      ).rejects.toThrow("release_output_not_directory");

      const symlinkTarget: any = path.join(repositoryRoot, "symlink-target");
      const symlinkOutput: any = path.join(releaseRoot, "linked");
      await fsPromises.mkdir(symlinkTarget);
      await fsPromises.symlink(symlinkTarget, symlinkOutput);
      await expect(
        prepareMcpReleaseOutputDirectory(symlinkOutput, { repositoryRoot })
      ).rejects.toThrow("release_output_symlink_rejected");

      const ancestorRepository: any = path.join(repositoryRoot, "ancestor-repository");
      const ancestorTarget: any = path.join(repositoryRoot, "ancestor-target");
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

  it("writes outer checksums with final flat asset names and rejects collisions", async () : Promise<any> => {
    const temporaryRoot: any = await fsPromises.mkdtemp(path.join(os.tmpdir(), "meshrix-release-checksum-"));
    try {
      const first: any = path.join(temporaryRoot, "mcp");
      const second: any = path.join(temporaryRoot, "supply-chain");
      await Promise.all([fsPromises.mkdir(first), fsPromises.mkdir(second)]);
      await Promise.all([
        fsPromises.writeFile(path.join(first, "connector.tar.gz"), "connector", "utf8"),
        fsPromises.writeFile(path.join(second, "bom.cdx.json"), "sbom", "utf8")
      ]);
      const outputPath: any = path.join(temporaryRoot, "RELEASE_SHA256SUMS");
      const result: any = await writeFlattenedReleaseChecksumAuthority({
        assetDirectories: [first, second],
        outputPath
      });
      expect(result.assetNames).toEqual(["bom.cdx.json", "connector.tar.gz"]);
      const checksumText: any = await fsPromises.readFile(outputPath, "utf8");
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

  it("requires every external lockfile dependency to use the official npm registry origin", () : any => {
    const lockfile: any = JSON.parse(read("package-lock.json"));
    const externalEntries: any = (Object.entries(lockfile.packages) as [string, any][])
      .filter(([packagePath, packageEntry]: any[]) : any => packagePath.startsWith("node_modules/") && packageEntry.link !== true);
    expect(externalEntries.length).toBeGreaterThan(0);
    for (const [, packageEntry] of externalEntries) {
      expect(new URL(packageEntry.resolved).origin).toBe("https://registry.npmjs.org");
    }

    const fixture: any = structuredClone(lockfile);
    fixture.packages[externalEntries[0][0]].resolved = "https://registry.example.test/package.tgz";
    expect(() : any => buildSupplyChainArtifacts(`${JSON.stringify(fixture)}\n`))
      .toThrow("official npm registry origin");
  });

  it("uses a governed schema identity for the reproducible supply-chain manifest", () : any => {
    const artifacts: any = buildSupplyChainArtifacts(read("package-lock.json"));
    expect(JSON.parse(artifacts.manifest).schemaVersion)
      .toBe(SUPPLY_CHAIN_MANIFEST_SCHEMA_VERSION);
  });

  it("keeps the built-in release runbook preparation-only", () : any => {
    const runbook: any = read("packages/foundation/config/entity-config/runbooks/project-release-runbook/README.md");
    expect(runbook).toContain("`npm run verify:acceptance` is the mandatory Functional Release Gate");
    expect(runbook).toContain("cannot block or promote project");
    expect(runbook).toContain("`.github/workflows/release.yml` is the only release publication path");
    expect(runbook).toMatch(/This runbook does not commit, tag, push, upload, or\s+call a package registry/u);
    expect(runbook).toContain("`RELEASE_SHA256SUMS.sigstore.json`");
  });

  it("accepts only a strict npm dist-tag channel and bounds child processes", async () : Promise<any> => {
    expect(normalizeReleaseChannel("stable")).toBe("stable");
    expect(normalizeReleaseChannel("next-release")).toBe("next-release");
    for (const invalid of ["", "Stable", "v1", "1.0.0", "next release", "../next", "next_tag"]) {
      expect(() : any => normalizeReleaseChannel(invalid)).toThrow("release_channel_dist_tag_invalid");
    }
    await expect(run(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      { timeoutMs: 25 }
    )).rejects.toMatchObject({ killed: true });
  });
});
