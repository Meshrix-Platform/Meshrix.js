#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeploymentIndex } from "./deployment-index.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const index = await loadDeploymentIndex({ cwd: repoRoot });
const [dockerfile, compose, packageJson] = await Promise.all([
  fs.readFile(path.join(repoRoot, "Dockerfile"), "utf8"),
  fs.readFile(path.join(repoRoot, "docker-compose.yml"), "utf8"),
  fs.readFile(path.join(repoRoot, "package.json"), "utf8").then(JSON.parse)
]);

assert.equal(index.kind, "meshrix.deployment.entry-index");
assert.equal(index.dockerPresets?.mainService?.dockerfile, "Dockerfile");
assert.equal(index.dockerPresets?.mainService?.runtime?.command?.[0], "node");
assert.equal(index.dockerPresets?.mainService?.runtime?.hostPublishAddress, "127.0.0.1");
assert.equal(index.dockerPresets?.mainService?.runtime?.hostPublishAddressEnv, "MESHRIX_BIND_ADDRESS");
assert.equal(index.dockerPresets?.mainService?.runtime?.advertisedHostEnv, "MESHRIX_ADVERTISED_HOST");
assert.equal(index.sourcePackages?.mainService?.command, "npm run release:package-server-source");
assert.equal(index.sourcePackages?.mainService?.builder, "tools/server-scripts/package-server-source.mjs");
assert.equal(index.sourcePackages?.mainService?.archiveFormat, "tar.gz");
assert.equal(index.sourcePackages?.mainService?.checksumAlgorithm, "sha256");
assert.equal(index.sourcePackages?.mainService?.containsDependencies, false);
assert.equal(index.sourcePackages?.mainService?.requiresNetworkForContainerBuild, true);
assert.deepEqual(index.sourcePackages?.mainService?.dockerTargets, ["runtime", "runtime-ui"]);
assert.equal(
  packageJson.scripts?.["release:package-server-source"],
  "node tools/server-scripts/package-server-source.mjs"
);
assert.equal(
  packageJson.scripts?.["server:deployment-index"],
  "node tools/server-scripts/deployment-index.mjs"
);
assert.match(compose, /target: \$\{MESHRIX_BUILD_TARGET:-runtime\}/u);
assert.match(compose, /MESHRIX_SERVER_WITH_UI: "\$\{MESHRIX_SERVER_WITH_UI:-0\}"/u);
assert.match(compose, /\$\{MESHRIX_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{MESHRIX_HOST_PORT:-7228\}:7228/u);
assert.match(compose, /http:\/\/\$\{MESHRIX_ADVERTISED_HOST:-127\.0\.0\.1\}:\$\{MESHRIX_HOST_PORT:-7228\}/u);
assert.match(compose, /^\s+healthcheck:$/mu);
const baseImage = String(index.dockerPresets?.baseImages?.mainService || "");
assert.match(
  baseImage,
  /^node:24\.\d+\.\d+-bookworm-slim@sha256:[a-f0-9]{64}$/u,
  "deployment base image must pin both the Node patch version and OCI index digest"
);
assert.equal(
  index.dockerPresets?.mainService?.buildArgs?.NODE_BASE_IMAGE,
  baseImage,
  "deployment build argument must use the authoritative pinned base image"
);
assert.equal(
  dockerfile.match(/^ARG NODE_BASE_IMAGE=(.+)$/mu)?.[1],
  baseImage,
  "Dockerfile and deployment index must use the same pinned base image"
);
assert.ok(
  index.validation?.freshContainer?.some((item) =>
    String(item.command || "").includes("verify-deployment-container-flow.mjs") &&
      String(item.checks || "").includes("canonical server source archive") &&
      String(item.checks || "").includes("container health") &&
      String(item.checks || "").includes("MCP baseline")
  ),
  "deployment flow must document source archive, health, and MCP baseline runtime checks"
);
assert.ok(
  index.validation?.freshContainer?.some((item) =>
    String(item.command || "").includes("verify-deployment-container-flow.mjs") &&
      String(item.checks || "").includes("Core discovery")
  ),
  "deployment flow must document the Core discovery runtime check"
);
assert.ok(
  index.validation?.freshContainer?.some((item) =>
    String(item.command || "").includes("verify-deployment-container-flow.mjs") &&
      String(item.checks || "").includes("optional plugin surfaces remain absent")
  ),
  "deployment flow must document optional plugin absence"
);
await fs.access(path.join(repoRoot, "tools/server-scripts/verify-deployment-container-flow.mjs"));
await fs.access(path.join(repoRoot, "tools/server-scripts/prepare-npm-artifact-cache.mjs"));
await fs.access(path.join(repoRoot, index.sourcePackages.mainService.builder));

console.log("[verify-deployment-index] ok");
