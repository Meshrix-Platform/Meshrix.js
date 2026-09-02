#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  createProcessCommandRunner,
  createRealMachineValidationWorkflow,
  REAL_MACHINE_OPERATIONAL_PHASES,
  REAL_MACHINE_TARGET_COMMAND_MANIFESTS,
  REAL_MACHINE_VALIDATION_PHASES,
} from "./lib/real-machine-validation-workflow.ts";

const repoRoot: any = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function fail(code?: any) : any {
  const error: Error & Record<string, any> = new Error(code);
  error.code = code;
  throw error;
}

function valueAfter(args?: any, flag?: any) : any {
  const index: any = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function parseArgs(args?: any) : any {
  const phase: any = args[0] || "";
  const allowedPhases: any = new Set<any>([...REAL_MACHINE_VALIDATION_PHASES, "run"]);
  if (!allowedPhases.has(phase)) fail("real_machine_phase_invalid");
  const valueFlags: any = new Set<any>([
    "--state-root",
    "--run-id",
    "--environment",
    "--target",
    "--architecture",
    "--candidate",
    "--functional-receipt",
    "--commands",
  ]);
  for (let index: any = 1; index < args.length; index += 1) {
    const flag: any = args[index];
    if (!valueFlags.has(flag) || !args[index + 1]) {
      fail("real_machine_argument_invalid");
    }
    index += 1;
  }
  return Object.freeze({
    phase,
    stateRoot: valueAfter(args, "--state-root"),
    runId: valueAfter(args, "--run-id"),
    environmentId: valueAfter(args, "--environment"),
    target: valueAfter(args, "--target"),
    architecture: valueAfter(args, "--architecture"),
    candidateDigest: valueAfter(args, "--candidate"),
    functionalReceiptPath: valueAfter(args, "--functional-receipt"),
    commandsPath: valueAfter(args, "--commands"),
  });
}

async function loadCommands(commandsPath?: any, phase?: any) : Promise<any> {
  if (phase === "reduce") return {};
  if (!commandsPath) {
    fail("real_machine_target_commands_unresolved");
  }
  const resolvedPath: any = path.isAbsolute(commandsPath)
    ? path.resolve(commandsPath)
    : path.resolve(repoRoot, commandsPath);
  if (!path.isAbsolute(commandsPath)) {
    const relative: any = path.relative(repoRoot, resolvedPath);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      fail("real_machine_commands_path_invalid");
    }
  }
  const stat: any = await fs.lstat(resolvedPath).catch(() : any => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    fail("real_machine_commands_unavailable");
  }
  let commands: any;
  try {
    commands = JSON.parse(await fs.readFile(resolvedPath, "utf8"));
  } catch {
    fail("real_machine_commands_invalid");
  }
  const requiredPhases: any = phase === "run"
    ? REAL_MACHINE_OPERATIONAL_PHASES
    : [phase];
  for (const requiredPhase of requiredPhases) {
    if (!commands?.[requiredPhase]) {
      fail(`real_machine_${requiredPhase}_command_missing`);
    }
  }
  return commands;
}

async function resolveTarget(options?: any) : Promise<any> {
  if (options.target) return options.target;
  if (
    !path.isAbsolute(options.stateRoot) ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(options.runId)
  ) {
    return "";
  }
  const statePath: any = path.join(options.stateRoot, options.runId, "state.json");
  const state: any = await fs.readFile(statePath, "utf8")
    .then(JSON.parse)
    .catch(() : any => null);
  return typeof state?.target === "string" ? state.target : "";
}

async function main() : Promise<any> {
  const options: any = parseArgs(process.argv.slice(2));
  const selectedTarget: any = await resolveTarget(options);
  const commandsPath: any = options.commandsPath ||
    REAL_MACHINE_TARGET_COMMAND_MANIFESTS[selectedTarget] ||
    "";
  const commands: any = await loadCommands(commandsPath, options.phase);
  const commandRunner: any = options.phase === "reduce"
    ? undefined
    : createProcessCommandRunner({ commands });
  const workflow: any = createRealMachineValidationWorkflow({
    ...options,
    commandRunner,
  });
  const result: any = await workflow.execute(options.phase);
  const receipt: any = result?.receipt || result;
  process.stdout.write(`${JSON.stringify({
    status: receipt.status || "accepted",
    phase: receipt.phase || options.phase,
    target: receipt.target,
    architecture: receipt.architecture,
    candidateDigest: receipt.candidateDigest,
    receiptDigest: receipt.receiptDigest,
    idempotent: receipt.idempotent === true,
  })}\n`);
}

main().catch((error?: any) : any => {
  process.stderr.write(`${JSON.stringify({
    status: "failed",
    code: String(error?.code || error?.message || "real_machine_validation_failed"),
  })}\n`);
  process.exitCode = 1;
});
