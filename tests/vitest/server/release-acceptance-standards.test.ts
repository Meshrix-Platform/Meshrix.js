import { describe, expect, it } from "vitest";

import standards from "../../../tools/registry/release-acceptance-standards.registry.json" with {
  type: "json",
};
import {
  validateReleaseAcceptanceStandards,
} from "../../../tools/server-scripts/verify-release-acceptance-standards.ts";

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
