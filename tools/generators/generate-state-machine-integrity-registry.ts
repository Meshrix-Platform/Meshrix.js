#!/usr/bin/env node
/**
 * generate-state-machine-integrity-registry — Generates the trusted hash
 * registry for built-in state machine JSON definitions.
 *
 * Usage:
 *   node tools/generators/generate-state-machine-integrity-registry.ts
 *   node tools/generators/generate-state-machine-integrity-registry.ts --check
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeStateMachineDefinitionHash,
  validateExecutableStateMachineDefinition
} from "../../packages/foundation/src/workflow/state-machine/engine/state-machine-core.ts";

const __dirname: any = path.dirname(fileURLToPath(import.meta.url));
const ROOT: any = path.resolve(__dirname, "../..");
const DEFINITIONS_DIR: any = path.resolve(ROOT, "packages/foundation/src/workflow/state-machine/definitions");
const OUTPUT_PATH: any = path.resolve(ROOT, "tools/registry/state-machines/state-machine-integrity.registry.json");
const GENERATED_AT: any = "1970-01-01T00:00:00.000Z";
const PROTOCOL_VERSION: any = "v0.0.1:registry:state-machine-integrity-1";

function toPosixRelative(filePath?: any) : any {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function readJson(filePath?: any) : any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function terminalStateIds(definition?: any) : any {
  return (definition.states || [])
    .filter((state?: any) : any => state.terminal === true)
    .map((state?: any) : any => state.id)
    .sort();
}

function listDefinitionFiles(dir?: any) : any {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry?: any) : any => {
      const fullPath: any = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listDefinitionFiles(fullPath);
      }
      return entry.isFile() && entry.name.endsWith(".json") ? [fullPath] : [];
    })
    .sort((left?: any, right?: any) : any => toPosixRelative(left).localeCompare(toPosixRelative(right)));
}

function buildMachineEntry(filePath?: any) : any {
  const definition: any = readJson(filePath);
  const validation: any = validateExecutableStateMachineDefinition(definition);
  if (!validation.ok) {
    const message: any = validation.errors.map((error?: any) : any => error.message).join("; ");
    throw new Error(`State machine definition is not executable: ${filePath}: ${message}`);
  }
  return {
    machineId: definition.machineId,
    entityType: definition.entityType || "",
    version: definition.version || "",
    path: toPosixRelative(filePath),
    canonicalSha256: computeStateMachineDefinitionHash(definition),
    stateCount: (definition.states || []).length,
    eventCount: (definition.events || []).length,
    matrixCellCount: (definition.totalMatrix || []).length,
    initialState: definition.initialState || "",
    terminalStateIds: terminalStateIds(definition)
  };
}

function buildRegistry() : any {
  const files: any = listDefinitionFiles(DEFINITIONS_DIR);

  const machines: any = files.map(buildMachineEntry).sort((left?: any, right?: any) : any =>
    left.machineId.localeCompare(right.machineId)
  );

  const ids: any = new Set<any>();
  for (const machine of machines) {
    if (!machine.machineId) {
      throw new Error(`State machine integrity entry missing machineId: ${machine.path}`);
    }
    if (ids.has(machine.machineId)) {
      throw new Error(`Duplicate state machine machineId in integrity registry: ${machine.machineId}`);
    }
    ids.add(machine.machineId);
  }

  return {
    "$schema": "../schema/state-machine-integrity.schema.json",
    "$comment": "GENERATED - DO NOT EDIT MANUALLY. Source: packages/foundation/src/workflow/state-machine/definitions/**/*.json",
    version: PROTOCOL_VERSION,
    generatedAt: GENERATED_AT,
    definitionRoot: "packages/foundation/src/workflow/state-machine/definitions",
    definitionCount: machines.length,
    hashAlgorithm: "canonical-json-sha256",
    machines
  };
}

function stableStringify(value?: any) : any {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ensureParent(filePath?: any) : any {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function main() : any {
  const checkMode: any = process.argv.includes("--check");
  const next: any = stableStringify(buildRegistry());
  if (checkMode) {
    if (!fs.existsSync(OUTPUT_PATH)) {
      console.error(`MISSING: ${toPosixRelative(OUTPUT_PATH)}`);
      process.exit(1);
    }
    const current: any = fs.readFileSync(OUTPUT_PATH, "utf8");
    if (current !== next) {
      console.error(`STALE: ${toPosixRelative(OUTPUT_PATH)} (state machine definition hashes changed)`);
      console.error("Run: node tools/generators/generate-state-machine-integrity-registry.ts");
      process.exit(1);
    }
    console.log(`OK: ${toPosixRelative(OUTPUT_PATH)}`);
    return;
  }

  ensureParent(OUTPUT_PATH);
  fs.writeFileSync(OUTPUT_PATH, next, "utf8");
  console.log(`Generated: ${toPosixRelative(OUTPUT_PATH)}`);
}

main();
