#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyReleaseAcceptanceStandards,
} from "./verify-release-acceptance-standards.ts";
import { resolveReleaseWorkspaceDirectories } from "./publish-release-set.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const definitionPath: any = "tools/registry/release-definition.registry.json";
const semverPattern: any =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const upstreamCandidateArtifacts: readonly any[] = Object.freeze([
  "build/reports/upstream-service-publishing.json",
  "build/reports/release-journey.json",
  "build/reports/upstream-service-publishing/upstream-service-basic-config.json",
  "build/reports/upstream-service-publishing.html",
  "build/reports/upstream-service-publishing/screenshots/console-authenticated.png",
  "build/reports/upstream-service-publishing/screenshots/console-organization-permissions.png",
  "build/reports/upstream-service-publishing/screenshots/console-upstream-basic-config.png",
  "build/reports/upstream-service-publishing/screenshots/console-upstream-operation-config.png",
  "build/reports/upstream-service-publishing/screenshots/console-upstream-published.png",
  "build/reports/upstream-service-publishing/screenshots/console-published-tool.png",
  "build/reports/upstream-service-publishing/screenshots/console-api-key-generated.png",
  "build/reports/upstream-service-publishing/screenshots/console-downstream-agent-configured.png",
  "build/reports/upstream-service-publishing/screenshots/console-operation-approval-pending.png",
  "build/reports/upstream-service-publishing/screenshots/console-operation-approval-completed.png",
  "build/reports/upstream-service-publishing/screenshots/console-downstream-mcp-call.png"
]);

export async function loadReleaseDefinition(rootDir: any = repoRoot) : Promise<any> {
  const text: any = await fs.readFile(path.join(rootDir, definitionPath), "utf8");
  return JSON.parse(text);
}

function fail(code?: any, detail?: any) : any {
  const error: Error & Record<string, any> = new Error(detail);
  error.code = code;
  throw error;
}

export async function verifyReleaseDefinition({
  rootDir = repoRoot,
  expectedTag = ""
}: Record<string, any> = {}) : Promise<any> {
  const definition: any = await loadReleaseDefinition(rootDir);
  const version: any = String(definition?.release?.version || "");
  const tag: any = String(definition?.release?.tag || "");
  const channel: any = String(definition?.release?.channel || "");
  if (!semverPattern.test(version) || tag !== `v${version}`) {
    fail("release_definition_coordinates_invalid", "Release version and tag do not agree.");
  }
  if (channel !== (version.includes("-") ? "next" : "stable")) {
    fail("release_definition_channel_invalid", "Release channel does not agree with SemVer.");
  }
  if (expectedTag && expectedTag !== tag) {
    fail("release_definition_tag_mismatch", "Git tag does not match the release definition.");
  }

  const rootPackage: any = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
  const workspaceDirectories: any = await resolveReleaseWorkspaceDirectories({
    rootDir,
    workspaces: rootPackage.workspaces
  });
  const expectedManifests: any[] = [
    "package.json",
    ...workspaceDirectories.map((workspace?: any) : any => `${workspace}/package.json`),
    "packages/protocols/mcp/adapter/gateway-installer/package.json"
  ];
  if (JSON.stringify(definition.packages.manifests) !== JSON.stringify(expectedManifests)) {
    fail("release_definition_manifest_set_mismatch", "Release manifest set is not the workspace release set.");
  }
  for (const manifest of expectedManifests) {
    const value: any = JSON.parse(await fs.readFile(path.join(rootDir, manifest), "utf8"));
    if (value.version !== version) {
      fail("release_definition_package_version_mismatch", `${manifest} does not match the release version.`);
    }
  }
  const lock: any = JSON.parse(await fs.readFile(path.join(rootDir, "package-lock.json"), "utf8"));
  if (lock.version !== version || lock.packages?.[""]?.version !== version) {
    fail("release_definition_lock_version_mismatch", "package-lock.json does not match the release version.");
  }
  const releasePlan: any = JSON.parse(await fs.readFile(path.join(rootDir, "docs/releases/plan.json"), "utf8"));
  if (releasePlan.schemaVersion !== 2 || releasePlan.repository !== "Meshrix.js") {
    fail("release_definition_plan_identity_invalid", "Release plan identity is invalid.");
  }
  if (releasePlan.currentVersion !== rootPackage.version) {
    fail("release_definition_plan_version_mismatch", "Release plan version does not match package.json.");
  }
  const changelog: any = String(releasePlan.changelog || "");
  try {
    await fs.access(path.join(rootDir, changelog));
  } catch {
    fail("release_definition_plan_changelog_missing", "Release plan changelog is missing.");
  }
  const platforms: any = definition?.container?.platforms;
  if (JSON.stringify(platforms) !== JSON.stringify(["linux/amd64", "linux/arm64"])) {
    fail("release_definition_platforms_invalid", "The release requires amd64 and arm64 image artifacts.");
  }
  if (
    definition?.acceptance?.profile !== "enterprise-single-node" ||
    definition?.acceptance?.commandId !== "platform-acceptance" ||
    definition?.acceptance?.stableRequiredClaim !== "functional-complete" ||
    definition?.acceptance?.releaseRequiredClaim !== "release-deployment-verified" ||
    definition?.acceptance?.standardsRegistry !==
      "tools/registry/release-acceptance-standards.registry.json"
  ) {
    fail(
      "release_definition_acceptance_standard_invalid",
      "The release definition must bind enterprise-single-node to the canonical platform-acceptance functional-complete claim.",
    );
  }
  if (
    definition?.acceptance?.deployment?.claim !== "release-deployment-verified" ||
    definition?.acceptance?.deployment?.requiredForRelease !== true ||
    definition?.acceptance?.deployment?.requiresClaim !== "functional-complete" ||
    definition?.acceptance?.deployment?.command !==
      "npm run server:verify:release-deployment" ||
    definition?.acceptance?.deployment?.controller !==
      "tools/server-scripts/verify-release-deployment.ts" ||
    definition?.acceptance?.deployment?.workflow !==
      ".github/workflows/release-branch.yml" ||
    definition?.acceptance?.deployment?.runner !== "ubuntu-24.04" ||
    definition?.acceptance?.deployment?.receipt !==
      "build/reports/release-deployment.json"
  ) {
    fail(
      "release_definition_deployment_standard_invalid",
      "The release definition must bind the mandatory external runtime-ui release-deployment claim.",
    );
  }
  if (
    definition?.prepublication?.requiredClaim !==
      "upstream-publishing-prepublication-passed"
    || definition?.prepublication?.candidateReceipt !==
      "build/reports/upstream-service-publishing-candidate.json"
    || JSON.stringify(definition?.prepublication?.artifacts) !==
      JSON.stringify(upstreamCandidateArtifacts)
  ) {
    fail(
      "release_definition_prepublication_invalid",
      "The release definition must bind the complete upstream candidate artifact set."
    );
  }
  await verifyReleaseAcceptanceStandards({ rootDir, rootPackage });
  return definition;
}

function readField(definition?: any, field?: any) : any {
  const value: any = field.split(".").reduce((current?: any, key?: any) : any => current?.[key], definition);
  if (value === undefined || (typeof value === "object" && value !== null)) {
    fail("release_definition_field_invalid", `Field ${field} is not a scalar release fact.`);
  }
  return String(value);
}

async function main() : Promise<any> {
  const args: any = process.argv.slice(2);
  let expectedTag: any = "";
  let field: any = "";
  let jsonField: any = "";
  for (let index: any = 0; index < args.length; index += 1) {
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
  const definition: any = await verifyReleaseDefinition({ expectedTag });
  if (field && jsonField) {
    fail("release_definition_argument_invalid", "Use either --field or --json-field.");
  }
  if (field) {
    process.stdout.write(`${readField(definition, field)}\n`);
  } else if (jsonField) {
    const value: any = jsonField.split(".").reduce((current?: any, key?: any) : any => current?.[key], definition);
    if (value === undefined) fail("release_definition_field_invalid", `Unknown field ${jsonField}.`);
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      version: definition.release.version,
      tag: definition.release.tag,
      channel: definition.release.channel,
      platformCount: definition.container.platforms.length,
      prepublicationClaim: definition.prepublication.requiredClaim,
      stableClaim: definition.acceptance.stableRequiredClaim,
      releaseClaim: definition.acceptance.releaseRequiredClaim
    })}\n`);
  }
}

const isMain: any = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error?: any) : any => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "release_definition_invalid" })}\n`);
    process.exitCode = 1;
  });
}
