import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import standards from "../../../tools/registry/release-acceptance-standards.registry.json" with {
  type: "json",
};
import {
  validateReleaseAcceptanceStandards,
} from "../../../tools/server-scripts/verify-release-acceptance-standards.ts";

import { verifyReleaseDefinition } from "../../../tools/server-scripts/verify-release-definition.ts";

function rootPackage() : any {
  return {
    scripts: {
      "verify:acceptance": "node tools/server-scripts/verify-platform-acceptance.ts",
      "verify:npm-package-installability":
        "cross-env NODE_OPTIONS=--conditions=source node tools/server-scripts/verify-npm-package-installability.ts",
      "verify:single-node:ubuntu-container":
        "node tools/server-scripts/verify-single-node-ubuntu-container.ts",
      "verify:mcp-release-portable-assembly":
        "node tools/server-scripts/verify-mcp-release-portable-assembly.ts",
      "verify:real-machine":
        "cross-env NODE_OPTIONS=--conditions=source node tools/server-scripts/verify-real-machine-validation.ts",
      "server:verify:release-deployment":
        "cross-env NODE_OPTIONS=--conditions=source node tools/server-scripts/verify-release-deployment.ts",
    },
  };
}

describe("release acceptance standards", () : any => {
  it("requires functional and npm installability claims while leaving deployment and real-machine claims optional", () : any => {
    const result: any = validateReleaseAcceptanceStandards(standards, rootPackage());
    expect(result).toMatchObject({
      valid: true,
      functionalClaim: "functional-complete",
      npmInstallabilityClaim: "npm-package-installability-passed",
      releaseDeploymentClaim: "release-deployment-verified",
      realMachineClaim: "real-machine-verified",
      targetCount: 6,
      reasons: [],
    });
  });

  it("rejects reverse blocking and missing development simulation coverage", () : any => {
    const invalid: any = structuredClone(standards);
    invalid.npmPackageInstallability.requiredForRelease = false;
    invalid.releaseDeploymentVerification.requiredForRelease = true;
    invalid.realMachineVerification.requiredForRelease = true;
    invalid.realMachineVerification.targets[0].simulationCommand =
      "npm run verify:missing-simulation";
    const result: any = validateReleaseAcceptanceStandards(invalid, rootPackage());
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("real_machine_release_standard_invalid");
    expect(result.reasons).toContain("npm_package_installability_release_standard_invalid");
    expect(result.reasons).toContain("release_deployment_release_standard_invalid");
    expect(result.reasons).toContain(
      "real_machine_simulation_command_missing:native-linux-x64",
    );
  });

  it("rejects a real-machine command that is not the unified lifecycle verifier", () : any => {
    const packageDefinition: any = rootPackage();
    packageDefinition.scripts["verify:real-machine"] =
      "node tools/server-scripts/legacy-platform-probe.ts";
    expect(
      validateReleaseAcceptanceStandards(standards, packageDefinition).reasons,
    ).toContain("real_machine_command_missing_or_mismatched");
  });
});


describe("release metadata verification", () => {
  it("verifies publish metadata independently of optional platform workflows and live evidence", async () => {
    const repository = fileURLToPath(new URL("../../../", import.meta.url));
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-release-metadata-"));
    const definitionPath = "tools/registry/release-definition.registry.json";
    const definition = JSON.parse(await fs.readFile(path.join(repository, definitionPath), "utf8"));
    definition.github.npmCliVersion = "11.5.1";
    const plan = JSON.parse(await fs.readFile(path.join(repository, "docs/releases/plan.json"), "utf8"));
    try {
      for (const filename of [...definition.packages.manifests, "package-lock.json", "docs/releases/plan.json", plan.changelog]) {
        const destination = path.join(rootDir, filename);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(path.join(repository, filename), destination);
      }
      await fs.mkdir(path.dirname(path.join(rootDir, definitionPath)), { recursive: true });
      await fs.writeFile(path.join(rootDir, definitionPath), JSON.stringify(definition));
      await expect(verifyReleaseDefinition({ rootDir, expectedTag: definition.release.tag })).resolves.toEqual(definition);
      await expect(verifyReleaseDefinition({ rootDir, expectedTag: "v9.9.9" })).rejects.toMatchObject({ code: "release_definition_tag_mismatch" });
      definition.github.npmCliVersion = "11.5.0";
      await fs.writeFile(path.join(rootDir, definitionPath), JSON.stringify(definition));
      await expect(verifyReleaseDefinition({ rootDir })).rejects.toMatchObject({ code: "release_definition_npm_cli_version_unsupported" });
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
