#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const definitionPath = "tools/registry/release-definition.registry.json";
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export async function loadReleaseDefinition(rootDir = repoRoot) {
  const text = await fs.readFile(path.join(rootDir, definitionPath), "utf8");
  return JSON.parse(text);
}

function fail(code, detail) {
  const error = new Error(detail);
  error.code = code;
  throw error;
}

export async function verifyReleaseDefinition({
  rootDir = repoRoot,
  expectedTag = ""
} = {}) {
  const definition = await loadReleaseDefinition(rootDir);
  const version = String(definition?.release?.version || "");
  const tag = String(definition?.release?.tag || "");
  const channel = String(definition?.release?.channel || "");
  if (!semverPattern.test(version) || tag !== `v${version}`) {
    fail("release_definition_coordinates_invalid", "Release version and tag do not agree.");
  }
  if (channel !== (version.includes("-") ? "next" : "stable")) {
    fail("release_definition_channel_invalid", "Release channel does not agree with SemVer.");
  }
  if (expectedTag && expectedTag !== tag) {
    fail("release_definition_tag_mismatch", "Git tag does not match the release definition.");
  }

  const rootPackage = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
  const expectedManifests = [
    "package.json",
    ...rootPackage.workspaces.map((workspace) => `${workspace}/package.json`),
    "packages/protocols/mcp/adapter/gateway-installer/package.json"
  ];
  if (JSON.stringify(definition.packages.manifests) !== JSON.stringify(expectedManifests)) {
    fail("release_definition_manifest_set_mismatch", "Release manifest set is not the workspace release set.");
  }
  for (const manifest of expectedManifests) {
    const value = JSON.parse(await fs.readFile(path.join(rootDir, manifest), "utf8"));
    if (value.version !== version) {
      fail("release_definition_package_version_mismatch", `${manifest} does not match the release version.`);
    }
  }
  const lock = JSON.parse(await fs.readFile(path.join(rootDir, "package-lock.json"), "utf8"));
  if (lock.version !== version || lock.packages?.[""]?.version !== version) {
    fail("release_definition_lock_version_mismatch", "package-lock.json does not match the release version.");
  }
  const platforms = definition?.container?.platforms;
  if (JSON.stringify(platforms) !== JSON.stringify(["linux/amd64", "linux/arm64"])) {
    fail("release_definition_platforms_invalid", "The release requires native amd64 and arm64 images.");
  }
  const imageVerification = definition?.github?.imageVerification;
  const verifiedPlatforms = imageVerification?.map((entry) => entry.platform);
  if (JSON.stringify(verifiedPlatforms) !== JSON.stringify(platforms)) {
    fail("release_definition_runner_matrix_mismatch", "Every container platform needs a native GitHub runner.");
  }
  // The journey gate is a mandatory release declaration. This verifier only
  // checks the declaration and its wiring; the gate itself runs in the
  // release workflow journey job, never during tag validation.
  const journeyGate = definition?.journeyGate;
  if (journeyGate?.commandId !== "verify:release-journey" || journeyGate?.required !== true) {
    fail("release_definition_journey_gate_invalid", "The release requires the mandatory verify:release-journey gate declaration.");
  }
  const journeyCommand = String(rootPackage.scripts?.["verify:release-journey"] || "");
  const journeyScriptPath = "tools/server-scripts/verify-release-journey.mjs";
  if (journeyCommand !== `node ${journeyScriptPath}`) {
    fail("release_definition_journey_gate_script_mismatch", "package.json must wire verify:release-journey to the journey gate verifier.");
  }
  await fs.access(path.join(rootDir, journeyScriptPath)).catch(() => {
    fail("release_definition_journey_gate_script_missing", "The release journey gate verifier is missing.");
  });
  return definition;
}

function readField(definition, field) {
  const value = field.split(".").reduce((current, key) => current?.[key], definition);
  if (value === undefined || (typeof value === "object" && value !== null)) {
    fail("release_definition_field_invalid", `Field ${field} is not a scalar release fact.`);
  }
  return String(value);
}

async function main() {
  const args = process.argv.slice(2);
  let expectedTag = "";
  let field = "";
  let jsonField = "";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--tag") {
      expectedTag = String(args[++index] || "");
    } else if (args[index] === "--field") {
      field = String(args[++index] || "");
    } else if (args[index] === "--json-field") {
      jsonField = String(args[++index] || "");
    } else {
      fail("release_definition_argument_invalid", `Unknown argument: ${args[index]}`);
    }
  }
  const definition = await verifyReleaseDefinition({ expectedTag });
  if (field && jsonField) {
    fail("release_definition_argument_invalid", "Use either --field or --json-field.");
  }
  if (field) {
    process.stdout.write(`${readField(definition, field)}\n`);
  } else if (jsonField) {
    const value = jsonField.split(".").reduce((current, key) => current?.[key], definition);
    if (value === undefined) fail("release_definition_field_invalid", `Unknown field ${jsonField}.`);
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      version: definition.release.version,
      tag: definition.release.tag,
      channel: definition.release.channel,
      platformCount: definition.container.platforms.length
    })}\n`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "release_definition_invalid" })}\n`);
    process.exitCode = 1;
  });
}
