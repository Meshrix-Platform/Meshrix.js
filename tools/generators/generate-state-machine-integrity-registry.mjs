#!/usr/bin/env node
/**
 * generate-state-machine-integrity-registry — Generates the trusted hash
 * registry for built-in state machine JSON definitions.
 *
 * Usage:
 *   node tools/generators/generate-state-machine-integrity-registry.mjs
 *   node tools/generators/generate-state-machine-integrity-registry.mjs --check
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeStateMachineDefinitionHash,
  validateExecutableStateMachineDefinition
} from "../../packages/foundation/src/workflow/state-machine/engine/state-machine-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const DEFINITIONS_DIR = path.resolve(ROOT, "packages/foundation/src/workflow/state-machine/definitions");
const OUTPUT_PATH = path.resolve(ROOT, "tools/registry/state-machines/state-machine-integrity.registry.json");
const GENERATED_AT = "1970-01-01T00:00:00.000Z";
const PROTOCOL_VERSION = "v0.0.1:registry:state-machine-integrity-1";

function toPosixRelative(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function terminalStateIds(definition) {
  return (definition.states || [])
    .filter((state) => state.terminal === true)
    .map((state) => state.id)
    .sort();
}

function listDefinitionFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listDefinitionFiles(fullPath);
      }
      return entry.isFile() && entry.name.endsWith(".json") ? [fullPath] : [];
    })
    .sort((left, right) => toPosixRelative(left).localeCompare(toPosixRelative(right)));
}

function buildMachineEntry(filePath) {
  const definition = readJson(filePath);
  const validation = validateExecutableStateMachineDefinition(definition);
  if (!validation.ok) {
    const message = validation.errors.map((error) => error.message).join("; ");
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

function buildRegistry() {
  const files = listDefinitionFiles(DEFINITIONS_DIR);

  const machines = files.map(buildMachineEntry).sort((left, right) =>
    left.machineId.localeCompare(right.machineId)
  );

  const ids = new Set();
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

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function main() {
  const checkMode = process.argv.includes("--check");
  const next = stableStringify(buildRegistry());
  if (checkMode) {
    if (!fs.existsSync(OUTPUT_PATH)) {
      console.error(`MISSING: ${toPosixRelative(OUTPUT_PATH)}`);
      process.exit(1);
    }
    const current = fs.readFileSync(OUTPUT_PATH, "utf8");
    if (current !== next) {
      console.error(`STALE: ${toPosixRelative(OUTPUT_PATH)} (state machine definition hashes changed)`);
      console.error("Run: node tools/generators/generate-state-machine-integrity-registry.mjs");
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
