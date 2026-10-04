#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadRegistry } from "../registry/index.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const EXPECTED_FUNCTIONAL_CLAIM: any = "functional-complete";
const EXPECTED_NPM_INSTALLABILITY_CLAIM: any = "npm-package-installability-passed";
const EXPECTED_RELEASE_DEPLOYMENT_CLAIM: any = "release-deployment-verified";
const EXPECTED_REAL_MACHINE_CLAIM: any = "real-machine-verified";
const EXPECTED_REAL_MACHINE_SCRIPT: any =
  "cross-env NODE_OPTIONS=--conditions=source node tools/server-scripts/verify-real-machine-validation.ts";
const EXPECTED_REAL_MACHINE_TARGETS: readonly any[] = Object.freeze([
  "native-linux-x64",
  "native-linux-arm64",
  "native-macos-arm64",
  "native-windows-x64",
  "public-cloud-single-node",
  "clean-host-recovery",
]);

const EXPECTED_RELEASE_DEPLOYMENT_SCRIPT: any =
  "cross-env NODE_OPTIONS=--conditions=source node tools/server-scripts/verify-release-deployment.ts";
const EXPECTED_NPM_INSTALLABILITY_SCRIPT: any =
  "cross-env NODE_OPTIONS=--conditions=source node tools/server-scripts/verify-npm-package-installability.ts";
const EXPECTED_RELEASE_DEPLOYMENT_SCENARIOS: readonly any[] = Object.freeze([
  "success",
  "concurrency",
  "cancellation",
  "provider-fault",
]);

function fail(code?: any) : any {
  const error: Error & Record<string, any> = new Error(code);
  error.code = code;
  throw error;
}

function commandScriptName(command: any = "") : any {
  const match: any = /^npm run ([a-z0-9:-]+)$/u.exec(String(command).trim());
  return match?.[1] || "";
}

function simulationCommandExists(command?: any, rootPackage?: any) : any {
  const value: any = String(command || "").trim();
  const scriptName: any = commandScriptName(value);
  if (scriptName) return typeof rootPackage?.scripts?.[scriptName] === "string";
  const nodeScript: any = /^node (tools\/server-scripts\/[A-Za-z0-9._/-]+\.ts)$/u.exec(value);
  return nodeScript ? nodeScript[1] : false;
}

export function validateReleaseAcceptanceStandards(standards?: any, rootPackage?: any) : any {
  const reasons: any[] = [];
  const functional: any = standards?.functionalCompleteness;
  const npmInstallability: any = standards?.npmPackageInstallability;
  const deployment: any = standards?.releaseDeploymentVerification;
  const realMachine: any = standards?.realMachineVerification;

  if (standards?.version !== "v0.0.1:registry:release-acceptance-standards-2") {
    reasons.push("release_acceptance_standards_version_invalid");
  }
  if (
    functional?.claim !== EXPECTED_FUNCTIONAL_CLAIM ||
    functional?.requiredForRelease !== true ||
    functional?.command !== "npm run verify:acceptance"
  ) {
    reasons.push("functional_release_standard_invalid");
  }
  if (
    !Array.isArray(functional?.covers) ||
    functional.covers.length === 0 ||
    new Set<any>(functional.covers).size !== functional.covers.length
  ) {
    reasons.push("functional_release_coverage_invalid");
  }
  if (
    npmInstallability?.claim !== EXPECTED_NPM_INSTALLABILITY_CLAIM ||
    npmInstallability?.requiredForRelease !== true ||
    npmInstallability?.requiresClaim !== EXPECTED_FUNCTIONAL_CLAIM ||
    npmInstallability?.command !== "npm run verify:npm-package-installability" ||
    npmInstallability?.controller !== "tools/server-scripts/verify-npm-package-installability.ts" ||
    npmInstallability?.receipt !== "build/reports/npm-package-installability.json" ||
    npmInstallability?.schemaVersion !== "v0.0.1:release:npm-package-installability-report-1"
  ) {
    reasons.push("npm_package_installability_release_standard_invalid");
  }
  if (rootPackage?.scripts?.["verify:npm-package-installability"] !== EXPECTED_NPM_INSTALLABILITY_SCRIPT) {
    reasons.push("npm_package_installability_command_missing_or_mismatched");
  }
  if (
    deployment?.claim !== EXPECTED_RELEASE_DEPLOYMENT_CLAIM ||
    deployment?.requiredForRelease !== false ||
    deployment?.requiresClaim !== EXPECTED_FUNCTIONAL_CLAIM ||
    deployment?.command !== "npm run server:verify:release-deployment" ||
    deployment?.controller !== "tools/server-scripts/verify-release-deployment.ts" ||
    deployment?.receipt !== "build/reports/release-deployment.json" ||
    JSON.stringify(deployment?.scenarios || []) !==
      JSON.stringify(EXPECTED_RELEASE_DEPLOYMENT_SCENARIOS)
  ) {
    reasons.push("release_deployment_release_standard_invalid");
  }
  if (rootPackage?.scripts?.["server:verify:release-deployment"] !==
    EXPECTED_RELEASE_DEPLOYMENT_SCRIPT) {
    reasons.push("release_deployment_command_missing_or_mismatched");
  }
  if (
    realMachine?.claim !== EXPECTED_REAL_MACHINE_CLAIM ||
    realMachine?.requiredForRelease !== false ||
    realMachine?.requiresClaim !== EXPECTED_FUNCTIONAL_CLAIM ||
    realMachine?.command !== "npm run verify:real-machine"
  ) {
    reasons.push("real_machine_release_standard_invalid");
  }
  if (rootPackage?.scripts?.["verify:acceptance"] === undefined) {
    reasons.push("functional_release_command_missing");
  }
  if (rootPackage?.scripts?.["verify:real-machine"] !== EXPECTED_REAL_MACHINE_SCRIPT) {
    reasons.push("real_machine_command_missing_or_mismatched");
  }

  const targets: any = Array.isArray(realMachine?.targets) ? realMachine.targets : [];
  const targetIds: any = targets.map((target?: any) : any => String(target?.id || ""));
  if (JSON.stringify(targetIds) !== JSON.stringify(EXPECTED_REAL_MACHINE_TARGETS)) {
    reasons.push("real_machine_target_set_invalid");
  }
  for (const target of targets) {
    if (target?.mode !== "optional") {
      reasons.push(`real_machine_target_not_optional:${target?.id || "missing"}`);
    }
    const simulation: any = simulationCommandExists(target?.simulationCommand, rootPackage);
    if (!simulation) {
      reasons.push(`real_machine_simulation_command_missing:${target?.id || "missing"}`);
    }
  }

  return {
    valid: reasons.length === 0,
    functionalClaim: String(functional?.claim || ""),
    npmInstallabilityClaim: String(npmInstallability?.claim || ""),
    releaseDeploymentClaim: String(deployment?.claim || ""),
    realMachineClaim: String(realMachine?.claim || ""),
    targetCount: targets.length,
    reasons,
  };
}

export async function verifyReleaseAcceptanceStandards({
  rootDir = repoRoot,
  standards = null,
  rootPackage = null,
}: Record<string, any> = {}) : Promise<any> {
  const registry: any = standards || await loadRegistry("release-acceptance-standards");
  const packageDefinition: any = rootPackage || JSON.parse(
    await fs.readFile(path.join(rootDir, "package.json"), "utf8"),
  );
  const result: any = validateReleaseAcceptanceStandards(registry, packageDefinition);
  if (!result.valid) fail(result.reasons[0]);

  await fs.access(path.join(rootDir, registry.npmPackageInstallability.controller))
    .catch(() : any => fail("npm_package_installability_verifier_missing"));
  await fs.access(path.join(rootDir, registry.releaseDeploymentVerification.controller))
    .catch(() : any => fail("release_deployment_verifier_missing"));
  for (const target of registry.realMachineVerification.targets) {
    const nodeScript: any = simulationCommandExists(target.simulationCommand, packageDefinition);
    if (typeof nodeScript === "string") {
      await fs.access(path.join(rootDir, nodeScript)).catch(() : any => {
        fail("real_machine_simulation_script_missing");
      });
    }
  }
  await fs.access(
    path.join(rootDir, "tools/server-scripts/verify-real-machine-validation.ts"),
  ).catch(() : any => {
    fail("real_machine_verifier_missing");
  });
  for (const target of registry.realMachineVerification.targets) {
    const commandsPath: any = path.join(
      rootDir,
      "tools/server-scripts/real-machine-targets",
      `${target.id}.commands.json`,
    );
    const stat: any = await fs.lstat(commandsPath).catch(() : any => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      fail("real_machine_target_commands_missing");
    }
    let commands: any;
    try {
      commands = JSON.parse(await fs.readFile(commandsPath, "utf8"));
    } catch {
      fail("real_machine_target_commands_invalid");
    }
    for (const phase of ["prepare", "start", "verify", "stop", "cleanup"]) {
      const command: any = commands?.[phase];
      if (
        typeof command?.executable !== "string" ||
        !command.executable.trim() ||
        !Array.isArray(command.args) ||
        command.args.some((argument?: any) : any => typeof argument !== "string")
      ) {
        fail("real_machine_target_commands_invalid");
      }
    }
  }
  return Object.freeze({
    ...result,
    sourceOfTruth: "tools/registry/release-acceptance-standards.registry.json",
  });
}

async function main() : Promise<any> {
  const result: any = await verifyReleaseAcceptanceStandards();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    functionalClaim: result.functionalClaim,
    releaseDeploymentClaim: result.releaseDeploymentClaim,
    realMachineClaim: result.realMachineClaim,
    targetCount: result.targetCount,
  })}\n`);
}

const isMain: any = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error?: any) : any => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || "release_acceptance_standards_invalid",
    })}\n`);
    process.exitCode = 1;
  });
}
