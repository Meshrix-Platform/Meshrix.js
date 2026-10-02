import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { resolveReleaseWorkspaceDirectories } from "../../../tools/server-scripts/lib/release-metadata.ts";
import {
  extractAuthorityArchive,
  assertPreparedQualification,
  selectStableAuthorityRun,
  waitForOriginatingRun
} from "../../../tools/server-scripts/release-workflow-automation.ts";

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

describe("release workflow supply-chain boundary", () : any => {
  it("selects only the latest successful stable authority for the exact candidate", () => {
    const sourceRevision = "a".repeat(40);
    const runs = [
      {
        id: 31,
        run_attempt: 1,
        path: ".github/workflows/ci.yml",
        head_branch: "stable",
        head_sha: sourceRevision,
        event: "push",
        status: "completed",
        conclusion: "success"
      },
      {
        id: 32,
        run_attempt: 2,
        path: ".github/workflows/ci.yml",
        head_branch: "stable",
        head_sha: sourceRevision,
        event: "push",
        status: "completed",
        conclusion: "success"
      },
      {
        id: 33,
        run_attempt: 3,
        path: ".github/workflows/ci.yml",
        head_branch: "stable",
        head_sha: "b".repeat(40),
        event: "push",
        status: "completed",
        conclusion: "success"
      },
      {
        id: 34,
        run_attempt: 4,
        path: ".github/workflows/release-branch.yml",
        head_branch: "stable",
        head_sha: sourceRevision,
        event: "push",
        status: "completed",
        conclusion: "success"
      }
    ];

    expect(selectStableAuthorityRun(runs, sourceRevision)).toEqual({
      branch: "stable",
      event: "push",
      headSha: sourceRevision,
      runAttempt: 2,
      runId: "32",
      workflowPath: ".github/workflows/ci.yml"
    });
    expect(() => selectStableAuthorityRun(runs, "c".repeat(40)))
      .toThrow("promotion_authority_run_missing");
  });

  it("imports only the exact authority files and verifies the Actions artifact digest", () => {
    const files = ["SOURCE_CANDIDATE.json", "accepted-candidate.json"] as const;
    const archive = zipSync({
      "SOURCE_CANDIDATE.json": strToU8("candidate"),
      "accepted-candidate.json": strToU8("functional")
    });
    const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
    const extracted = extractAuthorityArchive(archive, { files, expectedDigest: digest });

    expect([...extracted.keys()].sort()).toEqual([...files].sort());
    expect(Buffer.from(extracted.get(files[0])!).toString("utf8")).toBe("candidate");
    expect(() => extractAuthorityArchive(archive, { files, expectedDigest: `sha256:${"0".repeat(64)}` }))
      .toThrow("release_workflow_artifact_digest_mismatch");
    expect(() => extractAuthorityArchive(zipSync({
      ...{
        "SOURCE_CANDIDATE.json": strToU8("candidate"),
        "accepted-candidate.json": strToU8("functional"),
        "unexpected.json": strToU8("untrusted")
      }
    }), { files })).toThrow("release_workflow_authority_archive_contents_invalid");
  });

  it("waits for the exact originating release-branch run and rejects mismatched or failed runs", async () => {
    const originalApiUrl = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = "https://api.github.com";
    const baseRun = {
      id: 42,
      run_attempt: 3,
      path: ".github/workflows/release-branch.yml",
      head_branch: "release",
      head_sha: "a".repeat(40),
      event: "workflow_dispatch",
      repository: { full_name: "meshrix/meshrix-js" }
    };
    const makeResponse = (status: string, conclusion?: string) => new Response(JSON.stringify({
      ...baseRun,
      status,
      conclusion
    }), { status: 200, headers: { "content-type": "application/json" } });

    try {
      const statuses = ["queued", "in_progress", "completed"];
      let requestCount = 0;
      const waits: number[] = [];
      const selection = await waitForOriginatingRun({
        repository: "meshrix/meshrix-js",
        runId: "42",
        runAttempt: 3,
        sourceRevision: "a".repeat(40),
        event: "workflow_dispatch",
        token: "fixture-token",
        fetchImplementation: async () => makeResponse(statuses[requestCount++], "success"),
        wait: async (milliseconds) => { waits.push(milliseconds); }
      });

      expect(selection).toEqual({
        branch: "release",
        event: "workflow_dispatch",
        headSha: "a".repeat(40),
        runAttempt: 3,
        runId: "42",
        workflowPath: ".github/workflows/release-branch.yml"
      });
      expect(requestCount).toBe(3);
      expect(waits).toEqual([5_000, 5_000]);

      await expect(waitForOriginatingRun({
        repository: "meshrix/meshrix-js",
        runId: "42",
        runAttempt: 3,
        sourceRevision: "a".repeat(40),
        event: "workflow_dispatch",
        token: "fixture-token",
        fetchImplementation: async () => new Response(JSON.stringify({
          ...baseRun,
          repository: { full_name: "attacker/other" },
          status: "completed",
          conclusion: "success"
        }), { status: 200 })
      })).rejects.toThrow("promotion_authority_originating_run_mismatch");

      await expect(waitForOriginatingRun({
        repository: "meshrix/meshrix-js",
        runId: "42",
        runAttempt: 3,
        sourceRevision: "a".repeat(40),
        event: "workflow_dispatch",
        token: "fixture-token",
        fetchImplementation: async () => makeResponse("completed", "failure")
      })).rejects.toThrow("promotion_authority_originating_run_unsuccessful");
    } finally {
      if (originalApiUrl === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = originalApiUrl;
    }
  });

  it("joins qualified npm artifacts to the exact prepared archives", () => {
    const prepared = {
      version: "0.0.1",
      packages: [
        { name: "meshrix.js", version: "0.0.1", filename: "meshrix.js-0.0.1.tgz", integrity: "sha512-root" },
        { name: "@meshrix/gateway", version: "0.0.1", filename: "meshrix-gateway-0.0.1.tgz", integrity: "sha512-gateway" }
      ]
    };
    const report = {
      candidate: {
        version: "0.0.1",
        artifacts: prepared.packages.map((entry) => ({ ...entry }))
      }
    };

    expect(() => assertPreparedQualification(prepared, report)).not.toThrow();
    expect(() => assertPreparedQualification(prepared, {
      candidate: { ...report.candidate, artifacts: report.candidate.artifacts.map((entry, index) =>
        index === 1 ? { ...entry, integrity: "sha512-unqualified" } : entry
      ) }
    })).toThrow();
    expect(() => assertPreparedQualification(prepared, {
      candidate: { ...report.candidate, artifacts: [...report.candidate.artifacts, report.candidate.artifacts[0]] }
    })).toThrow();
  });

  it("supplies the actual workspace manifests before a clean container dependency install", async () => {
    const manifest = JSON.parse(read("package.json"));
    const directories = await resolveReleaseWorkspaceDirectories({ rootDir: ROOT, workspaces: manifest.workspaces });
    const dependencyStage = read("Dockerfile").split("FROM deps AS npm-package-verifier")[0];
    const copied = [...dependencyStage.matchAll(/^COPY (.+) \.\/$|^COPY (\S+) \.\/\S+$/gmu)].flatMap((match) => (match[1] || match[2]).split(/\s+/u));
    for (const directory of directories) expect(copied, directory).toContain(`${directory}/package.json`);
  });

  it("resolves the canonical tag and exact release-branch authority before packaging", () : any => {
    const workflow: any = read(".github/workflows/release.yml");
    const branchWorkflow: any = read(".github/workflows/release-branch.yml");
    const definition: any = jobSource(workflow, "release-definition");
    const authority: any = jobSource(workflow, "release-authority");

    expect(workflow).toContain('tags: ["v*"]');
    expect(workflow).toContain("workflow_dispatch:");
    for (const input of [
      "originating_run_id:", "originating_run_attempt:", "originating_event:",
      "source_revision:", "bootstrap_candidate:"
    ]) expect(workflow).toContain(input);
    expect(definition).toContain("release-definition-outputs");
    for (const output of ["node_version", "npm_cli_version", "release_tag", "release_version"]) {
      expect(definition).toContain(`steps.definition.outputs.${output}`);
    }
    expect(authority).toContain("permissions:\n      contents: read\n      actions: read");
    expect(authority).toContain("release-workflow-automation.ts resolve-release-authority");
    expect(authority).toContain("verify:release-definition -- --tag");
    expect(authority).toContain("release:prepare -- --check --tag");
    expect(authority).toContain("release-authority-${{ github.sha }}");
    expect(authority).not.toContain("contents: write");
    expect(authority).not.toContain("id-token: write");

    expect(branchWorkflow).toContain("release-workflow-automation.ts prepare-branch-authority");
    expect(branchWorkflow).toContain("release-workflow-automation.ts ensure-release-tag");
    expect(branchWorkflow).toContain("release-workflow-automation.ts dispatch-release");
    expect(branchWorkflow).toContain("release-authority-${{ github.sha }}");
  });

  it("builds and verifies the exact npm archives and public supply-chain files before mutation", () : any => {
    const workflow: any = read(".github/workflows/release.yml");
    const assembly: any = jobSource(workflow, "assemble-release-assets");
    const preflight: any = jobSource(workflow, "npm-registry-preflight");

    expect(assembly).toContain("run: npm run build");
    expect(assembly).toContain("name: release-authority-${{ github.sha }}");
    expect(assembly).toContain("path: build/release/control/release-authority");
    expect(assembly).toContain("generate-supply-chain-artifacts.ts --output build/release/supply-chain");
    expect(assembly).toContain("verify-supply-chain-artifacts.ts --input build/release/supply-chain");
    expect(assembly).toContain("Prepare the public npm archives once");
    expect(assembly).toContain("release:publish-npm -- --prepare --artifact-dir build/release/npm-set");
    expect(assembly).toContain("release-workflow-automation.ts verify-prepared-qualification");
    expect(assembly).not.toContain("--tag \"$RELEASE_TAG\"");
    expect(assembly).toContain("release-inputs-${{ github.sha }}");

    expect(preflight).toContain("Download the prepared package archives");
    expect(preflight).toContain("Read and validate all npm package versions and dist-tags without publication");
    expect(preflight).toContain("release:publish-npm -- --preflight --artifact-dir build/release/npm-set");
    expect(preflight).not.toContain("NODE_AUTH_TOKEN");
    expect(preflight).not.toContain("NPM_BOOTSTRAP_TOKEN");
    expect(preflight).not.toContain("contents: write");
    expect(preflight).not.toContain("id-token: write");
  });

  it("keeps npm and GitHub publication in separate credential scopes", () : any => {
    const workflow: any = read(".github/workflows/release.yml");
    const npm: any = jobSource(workflow, "publish-npm-release-set");
    const github: any = jobSource(workflow, "publish-github-release");
    const uses: any = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)\s*(?:#.*)?$/gmu)]
      .map((match?: any) : any => match[1]);

    expect(npm).toContain("environment: release-candidate");
    expect(npm).toContain("permissions:\n      contents: read\n      id-token: write");
    expect(npm).toContain("--verify-oidc-trust --artifact-dir build/release/npm-set");
    expect(npm).toContain("release:publish-npm -- --artifact-dir build/release/npm-set");
    expect(npm).toContain("secrets.NPM_BOOTSTRAP_TOKEN");
    expect(npm.match(/NODE_AUTH_TOKEN:/gu)).toHaveLength(1);
    const bootstrapStep: any = npm.indexOf("Publish the first canonical release with the explicit bootstrap token");
    expect(bootstrapStep).toBeGreaterThan(0);
    expect(npm.slice(0, bootstrapStep)).not.toContain("NODE_AUTH_TOKEN");
    expect(npm.slice(bootstrapStep)).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}");
    expect(npm).not.toContain("contents: write");

    expect(github).toContain("needs: [release-definition, publish-npm-release-set, assemble-release-assets]");
    expect(github).toContain("permissions:\n      contents: write");
    expect(github).not.toContain("id-token: write");
    expect(github).not.toContain("NPM_BOOTSTRAP_TOKEN");
    expect(github).toContain("release-workflow-automation.ts publish-github-release");
    expect(github).not.toContain("gh api --jq");
    expect(github).not.toContain("cosign");
    expect(github).not.toContain("NPM_BOOTSTRAP_TOKEN");
    expect(workflow).not.toContain("sign-release-assets:");
    expect(workflow).not.toContain("sigstore/cosign-installer");
    expect(workflow).not.toContain(".sigstore.json");
    expect(uses.every((value?: any) : any => /@[a-f0-9]{40}$/u.test(value))).toBe(true);
  });

  it("runs every optional real-machine target in an independent workflow", () : any => {
    const releaseWorkflow: any = read(".github/workflows/release.yml");
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
    expect(workflow).toContain("name: release-authority-${{ inputs.source_revision }}");
    expect(workflow).toContain("--functional-receipt");
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
  });

  it("keeps native execution and external journeys out of the release definition", () : any => {
    const definition: any = JSON.parse(read("tools/registry/release-definition.registry.json"));
    expect(definition.acceptance).toMatchObject({
      stableRequiredClaim: "functional-complete",
      releaseRequiredClaim: "npm-package-installability-passed",
      standardsRegistry: "tools/registry/release-acceptance-standards.registry.json",
    });
    expect(definition.github).not.toHaveProperty("imageVerification");
    expect(definition).not.toHaveProperty("journeyGate");
    expect(definition.container).not.toHaveProperty("platforms");
    expect(definition.container.requiredForRelease).toBe(false);
  });

  it("limits release credentials to the publication step that needs them", () : any => {
    const workflow: any = read(".github/workflows/release.yml");
    const authority: any = jobSource(workflow, "release-authority");
    const assembly: any = jobSource(workflow, "assemble-release-assets");
    const preflight: any = jobSource(workflow, "npm-registry-preflight");
    const npm: any = jobSource(workflow, "publish-npm-release-set");
    const github: any = jobSource(workflow, "publish-github-release");

    expect(authority).toContain("permissions:\n      contents: read\n      actions: read");
    expect(authority).not.toContain("contents: write");
    expect(authority).not.toContain("id-token: write");
    expect(assembly).toContain("run: npm ci");
    expect(assembly).toContain("run: npm run build");
    expect(assembly).not.toContain("contents: write");
    expect(assembly).not.toContain("id-token: write");
    expect(preflight).not.toContain("NODE_AUTH_TOKEN");
    expect(preflight).not.toContain("NPM_BOOTSTRAP_TOKEN");
    expect(preflight).not.toContain("contents: write");
    expect(preflight).not.toContain("id-token: write");

    expect(npm).toContain("environment: release-candidate");
    expect(npm).toContain("id-token: write");
    expect(npm).toContain("release:publish-npm -- --verify-oidc-trust");
    expect(npm).toContain("secrets.NPM_BOOTSTRAP_TOKEN");
    expect(npm.match(/NODE_AUTH_TOKEN:/gu)).toHaveLength(1);
    const bootstrapStep: any = npm.indexOf("Publish the first canonical release with the explicit bootstrap token");
    expect(bootstrapStep).toBeGreaterThan(0);
    expect(npm.slice(0, bootstrapStep)).not.toContain("NODE_AUTH_TOKEN");
    expect(npm.slice(bootstrapStep)).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}");
    expect(npm).not.toContain("contents: write");

    expect(github).toContain("permissions:\n      contents: write");
    expect(github).not.toContain("id-token: write");
    expect(github).not.toContain("NPM_BOOTSTRAP_TOKEN");
    expect(github).toContain("GH_TOKEN: ${{ github.token }}");
    expect(github).toContain("release-workflow-automation.ts publish-github-release");
  });

  it("pins workflow actions and verifies the exact npm and supply-chain inputs", () : any => {
    const workflow: any = read(".github/workflows/release.yml");
    const uses: any = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)\s*(?:#.*)?$/gmu)]
      .map((match?: any) : any => match[1]);
    const assembly: any = jobSource(workflow, "assemble-release-assets");
    const releaseAuthority: any = jobSource(workflow, "release-authority");

    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((value?: any) : any => /@[a-f0-9]{40}$/u.test(value))).toBe(true);
    expect(workflow).toContain("generate-supply-chain-artifacts.ts --output build/release/supply-chain");
    expect(workflow).toContain("verify-supply-chain-artifacts.ts --input build/release/supply-chain");
    expect(assembly).toContain("release-workflow-automation.ts verify-prepared-qualification");
    expect(assembly).toContain("release:publish-npm -- --prepare --artifact-dir build/release/npm-set");
    expect(releaseAuthority).toContain("release-workflow-automation.ts resolve-release-authority");
    expect(releaseAuthority).toContain("overwrite: true");
    expect(workflow).not.toContain("docker buildx");
    expect(workflow).not.toContain("GHCR");
    expect(workflow).not.toContain("cosign");
    expect(workflow).not.toContain(".sigstore.json");
  });

  it("serializes releases and verifies GitHub assets only after npm publication", () : any => {
    const workflow: any = read(".github/workflows/release.yml");
    const github: any = jobSource(workflow, "publish-github-release");
    const bootstrap: any = jobSource(workflow, "publish-npm-release-set");

    expect(workflow).toContain("concurrency:\n  group: release\n  cancel-in-progress: false");
    expect(directJobNeeds(workflow, "publish-github-release")).toEqual([
      "release-definition", "publish-npm-release-set", "assemble-release-assets"
    ]);
    expect(github).toContain("release-workflow-automation.ts publish-github-release");
    expect(github).not.toContain("gh api --jq");
    expect(github).not.toContain("gh release create");
    expect(github).not.toContain("cosign");
    expect(bootstrap).toContain("release-candidate");
    expect(bootstrap).not.toContain("contents: write");
  });

  it("uses one immutable Node base-image reference across Docker authorities", () : any => {
    const dockerfile: any = read("Dockerfile");
    const deploymentIndex: any = JSON.parse(read("packages/foundation/config/deployment/index.json"));
    const image: any = dockerfile.match(/^ARG NODE_BASE_IMAGE=(.+)$/mu)?.[1] || "";
    expect(image).toMatch(/^docker\.io\/library\/node:24\.\d+\.\d+-bookworm-slim@sha256:[a-f0-9]{64}$/u);
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

  it("keeps the MCP command in the root npm release contract", () : any => {
    const verifier: any = read("tools/server-scripts/verify-npm-package-installability.ts");
    const rootPackage: any = JSON.parse(read("package.json"));
    expect(verifier).toContain('import { discoverReleaseSet, loadPreparedReleaseSet } from "./publish-release-set.ts";');
    expect(rootPackage.bin?.["meshrix-mcp"]).toBe(
      "dist/apps/server/bin/meshrix-mcp.js"
    );
    expect(verifier).toContain("assertPreparedProductBundleClosure");
    expect(verifier).toContain("bundledPackageNamesInArtifact(artifact.files)");
    expect(verifier).toContain("name === rootPackage.name");
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
      ])).rejects.toBeTruthy();
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
    ])).rejects.toBeTruthy();
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

  it("requires every external dependency, including Pactium, to use the official registry", () : any => {
    const lockfile: any = JSON.parse(read("package-lock.json"));
    const externalEntries: any = (Object.entries(lockfile.packages) as [string, any][])
      .filter(([packagePath, packageEntry]: any[]) : any => packagePath.startsWith("node_modules/") && packageEntry.link !== true);
    const registryEntries: any = externalEntries;
    expect(registryEntries.length).toBeGreaterThan(0);
    for (const [, packageEntry] of registryEntries) {
      expect(new URL(packageEntry.resolved).origin).toBe("https://registry.npmjs.org");
    }
    const pactiumVersion: any = "0.8.1";
    const pactiumResolved: any = `https://registry.npmjs.org/pactium/-/pactium-${pactiumVersion}.tgz`;
    const rootManifest: any = JSON.parse(read("package.json"));
    const foundationManifest: any = JSON.parse(read("packages/foundation/package.json"));
    const runtimeManifest: any = JSON.parse(read("packages/server-runtime/package.json"));
    expect(rootManifest.dependencies.pactium).toBe(pactiumVersion);
    expect(foundationManifest.peerDependencies.pactium).toBe(pactiumVersion);
    expect(runtimeManifest.peerDependencies.pactium).toBe(pactiumVersion);
    expect(foundationManifest.dependencies?.pactium).toBeUndefined();
    expect(runtimeManifest.dependencies?.pactium).toBeUndefined();
    expect(lockfile.packages[""].dependencies.pactium).toBe(pactiumVersion);
    expect(lockfile.packages["node_modules/pactium"]).toMatchObject({
      version: pactiumVersion,
      resolved: pactiumResolved,
      license: "MIT"
    });
    expect(lockfile.packages["node_modules/pactium"].integrity).toMatch(/^sha512-/u);

    const fixture: any = structuredClone(lockfile);
    fixture.packages[registryEntries[0][0]].resolved = "https://registry.example.test/package.tgz";
    expect(() : any => buildSupplyChainArtifacts(`${JSON.stringify(fixture)}\n`))
      .toThrow("official npm registry origin");

    const vendoredFixture: any = structuredClone(lockfile);
    vendoredFixture.packages["node_modules/pactium"].resolved = "file:vendor/other-package.tgz";
    vendoredFixture.packages[""].dependencies.pactium = "file:vendor/other-package.tgz";
    expect(() : any => buildSupplyChainArtifacts(`${JSON.stringify(vendoredFixture)}\n`))
      .toThrow("official npm registry origin");
  });

  it("uses a governed schema identity for the reproducible supply-chain manifest", () : any => {
    const artifacts: any = buildSupplyChainArtifacts(read("package-lock.json"));
    expect(JSON.parse(artifacts.manifest).schemaVersion)
      .toBe(SUPPLY_CHAIN_MANIFEST_SCHEMA_VERSION);
  });

  it("documents the npm-only immutable release and its verification evidence", () : any => {
    const operations: any = read("docs/RUNBOOK.md");
    const bundled: any = read("packages/foundation/config/entity-config/runbooks/project-release-runbook/README.md");
    const operationsStart: any = operations.indexOf("`.github/workflows/release.yml` is the sole publication path.");
    const publicationStart: any = bundled.indexOf("## Publication");
    const consumerStart: any = bundled.indexOf("## Consumer Verification", publicationStart);
    const publication: any = bundled.slice(publicationStart, consumerStart);

    expect(operationsStart).toBeGreaterThan(0);
    const releaseFlow: any = operations.slice(operationsStart);
    expect(releaseFlow).toContain("meshrix.js");
    expect(releaseFlow).toContain("@meshrix/gateway");
    expect(releaseFlow).toContain("npm publication supplies GitHub Actions provenance");
    expect(releaseFlow).toContain("registry signatures");
    expect(releaseFlow).toContain("release-set manifest");
    expect(releaseFlow).toContain("reruns reverify it without");
    expect(releaseFlow).not.toContain("RELEASE_SHA256SUMS");
    expect(releaseFlow).not.toContain(".sigstore.json");

    expect(publicationStart).toBeGreaterThan(0);
    expect(publication).toContain("meshrix.js");
    expect(publication).toContain("@meshrix/gateway");
    expect(publication).toContain("MCP support is included in `meshrix.js`");
    expect(publication).toContain("verifies actual immutability");
    expect(publication).toContain("not replace a conflicting immutable release");
    expect(publication).not.toContain("GHCR");
    expect(publication).not.toContain("RELEASE_SHA256SUMS");
    expect(publication).not.toContain(".sigstore.json");
  });

  it("accepts only a strict npm dist-tag channel and lets release commands finish naturally", async () : Promise<any> => {
    expect(normalizeReleaseChannel("stable")).toBe("stable");
    expect(normalizeReleaseChannel("next-release")).toBe("next-release");
    for (const invalid of ["", "Stable", "v1", "1.0.0", "next release", "../next", "next_tag"]) {
      expect(() : any => normalizeReleaseChannel(invalid)).toThrow("release_channel_dist_tag_invalid");
    }
    await expect(run(
      process.execPath,
      ["-e", "setTimeout(() => process.stdout.write('done'), 40)"]
    )).resolves.toMatchObject({ stdout: "done" });
  });
});
