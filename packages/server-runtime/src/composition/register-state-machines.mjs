/**
 * State Machine Registration
 *
 * Registers state machine definitions into the runtime composition lifecycle.
 * These definitions include runtime capability lifecycle, checkpoint, readiness,
 * and upload-session state machines.
 *
 * State machine definitions are loaded from foundation's workflow state machine
 * definitions directory and registered as platform services for runtime access.
 *
 * @module register-state-machines
 * @package @meshrix/server-runtime
 * @layer server-runtime/composition
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerPlatformService } from "./platform-registry.mjs";
import {
  computeStateMachineDefinitionHash,
  validateExecutableStateMachineDefinition
} from "../../../foundation/src/workflow/state-machine/engine/state-machine-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

/**
 * Default path to the foundation state machine definitions directory.
 * Relative to the repo root (foundation package location).
 */
const FOUNDATION_STATE_MACHINE_DEFINITIONS_DIR = path.resolve(
  __dirname,
  "../../../foundation/src/workflow/state-machine/definitions"
);
const STATE_MACHINE_INTEGRITY_REGISTRY_PATH = path.resolve(
  REPO_ROOT,
  "tools/registry/state-machines/state-machine-integrity.registry.json"
);

/**
 * Known state machine definitions to register for runtime lifecycle.
 * Maps machineId -> metadata label for registration.
 */
const KNOWN_STATE_MACHINE_DEFINITIONS = {
  "operation.narrow": {
    label: "Operation Narrow State Machine",
    kind: "operation-narrow",
    ownerFeatureId: "operation-proof-substrate"
  },
  "production.readiness.lifecycle": {
    label: "Production Readiness Lifecycle",
    kind: "production-readiness",
    ownerFeatureId: "devops"
  },
  "version.artifact.lifecycle": {
    label: "Version Artifact Lifecycle",
    kind: "version-artifact",
    ownerFeatureId: "module-management-core"
  },
  "version.transition.lifecycle": {
    label: "Version Transition Lifecycle",
    kind: "version-transition",
    ownerFeatureId: "module-management-core"
  }
};

function toPosixRelative(filePath) {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join("/");
}

function loadIntegrityRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) {
    throw new Error(`State machine integrity registry is missing: ${toPosixRelative(registryPath)}`);
  }
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  if (!Array.isArray(registry.machines)) {
    throw new Error(`State machine integrity registry is invalid: machines must be an array`);
  }
  const index = new Map();
  for (const entry of registry.machines) {
    if (!entry?.machineId) {
      throw new Error("State machine integrity registry contains an entry without machineId");
    }
    if (index.has(entry.machineId)) {
      throw new Error(`State machine integrity registry has duplicate machineId: ${entry.machineId}`);
    }
    index.set(entry.machineId, entry);
  }
  return { registry, index };
}

function verifyDefinitionIntegrity(definition, {
  filePath,
  integrityIndex,
  definitionsDir,
  integrityDefinitionRoot
}) {
  const machineId = definition?.machineId || "";
  const expected = integrityIndex.get(machineId);
  if (!expected) {
    throw new Error(`State machine integrity entry missing for machineId: ${machineId || "(empty)"}`);
  }
  const actualHash = computeStateMachineDefinitionHash(definition);
  if (actualHash !== expected.canonicalSha256) {
    throw new Error(`State machine integrity mismatch for ${machineId}: expected ${expected.canonicalSha256}, got ${actualHash}`);
  }
  const physicalRelativePath = toPosixRelative(filePath);
  const relativeDefinitionPath = path.relative(definitionsDir, filePath).split(path.sep).join("/");
  const logicalRelativePath = path.posix.join(
    String(integrityDefinitionRoot || "").replace(/\\/gu, "/"),
    relativeDefinitionPath
  );
  if (
    expected.path &&
    expected.path !== physicalRelativePath &&
    expected.path !== logicalRelativePath
  ) {
    throw new Error(
      `State machine integrity path mismatch for ${machineId}: expected ${expected.path}, got ${logicalRelativePath}`
    );
  }
  if (expected.version && expected.version !== (definition.version || "")) {
    throw new Error(`State machine integrity version mismatch for ${machineId}: expected ${expected.version}, got ${definition.version || ""}`);
  }
  const stateCount = (definition.states || []).length;
  const eventCount = (definition.events || []).length;
  const matrixCellCount = (definition.totalMatrix || []).length;
  if (expected.stateCount !== stateCount || expected.eventCount !== eventCount || expected.matrixCellCount !== matrixCellCount) {
    throw new Error(`State machine integrity count mismatch for ${machineId}`);
  }
  return actualHash;
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

/**
 * Registers state machine definitions from the foundation definitions directory
 * into the platform registry for runtime lifecycle access.
 *
 * @param {object} registry - Platform registry instance
 * @param {object} [options]
 * @param {string} [options.definitionsDir] - Custom path to definitions directory
 * @returns {Array<object>} Registered service entries
 */
export function registerStateMachineDefinitions(registry, {
  definitionsDir = FOUNDATION_STATE_MACHINE_DEFINITIONS_DIR,
  integrityRegistryPath = STATE_MACHINE_INTEGRITY_REGISTRY_PATH,
  enforceIntegrity = true
} = {}) {
  const entries = [];
  const loadedMachineIds = new Set();
  const integrity = enforceIntegrity
    ? loadIntegrityRegistry(integrityRegistryPath)
    : { registry: null, index: new Map() };

  let definitionFiles = [];
  try {
    definitionFiles = listDefinitionFiles(definitionsDir);
  } catch (err) {
    // Definitions directory may not exist in all environments — skip gracefully
    return entries;
  }

  for (const filePath of definitionFiles) {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));

    if (!raw || !raw.machineId) {
      throw new Error(`State machine definition missing machineId: ${toPosixRelative(filePath)}`);
    }

    const machineId = raw.machineId;
    loadedMachineIds.add(machineId);

    const validation = validateExecutableStateMachineDefinition(raw);
    if (!validation.ok) {
      const message = validation.errors.map((error) => error.message).join("; ");
      throw new Error(`State machine definition is not executable: ${machineId}: ${message}`);
    }

    const definitionHash = enforceIntegrity
      ? verifyDefinitionIntegrity(raw, {
          filePath,
          integrityIndex: integrity.index,
          definitionsDir,
          integrityDefinitionRoot: integrity.registry?.definitionRoot
        })
      : computeStateMachineDefinitionHash(raw);

    const known = KNOWN_STATE_MACHINE_DEFINITIONS[machineId] || {};
    entries.push(registerPlatformService(registry, {
      id: `state-machine.${machineId}`,
      platform: "state-machine",
      label: known.label || `${machineId} State Machine`,
      kind: known.kind || "state-machine-definition",
      ownerFeatureId: known.ownerFeatureId || "foundation-state-machine",
      value: raw,
      metadata: {
        machineId,
        entityType: raw.entityType || "",
        version: raw.version || "",
        definitionHash,
        integrityRegistryVersion: integrity.registry?.version || "",
        integrityRegistryPath: enforceIntegrity ? toPosixRelative(integrityRegistryPath) : "",
        initialState: raw.initialState || "",
        stateCount: (raw.states || []).length,
        eventCount: (raw.events || []).length,
        matrixCellCount: (raw.totalMatrix || []).length,
        terminalStateIds: (raw.states || [])
          .filter((state) => state.terminal)
          .map((state) => state.id)
      }
    }));
  }

  if (enforceIntegrity) {
    for (const machineId of integrity.index.keys()) {
      if (!loadedMachineIds.has(machineId)) {
        throw new Error(`State machine definition missing for integrity entry: ${machineId}`);
      }
    }
  }

  return entries;
}

/**
 * Loads a single state machine definition by machineId.
 * Searches the definitions directory for a matching JSON file.
 *
 * @param {string} machineId - Machine ID to find
 * @param {object} [options]
 * @param {string} [options.definitionsDir] - Custom path to definitions directory
 * @returns {object|null} The state machine definition or null if not found
 */
export function loadStateMachineDefinition(machineId, {
  definitionsDir = FOUNDATION_STATE_MACHINE_DEFINITIONS_DIR,
  integrityRegistryPath = STATE_MACHINE_INTEGRITY_REGISTRY_PATH,
  enforceIntegrity = true
} = {}) {
  if (!machineId) {
    return null;
  }

  let definitionFiles = [];
  const integrity = enforceIntegrity
    ? loadIntegrityRegistry(integrityRegistryPath)
    : { index: new Map() };
  try {
    definitionFiles = fs.readdirSync(definitionsDir)
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch {
    return null;
  }

  for (const file of definitionFiles) {
    try {
      const filePath = path.join(definitionsDir, file);
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (raw && raw.machineId === machineId) {
        if (enforceIntegrity) {
          verifyDefinitionIntegrity(raw, {
            filePath,
            integrityIndex: integrity.index,
            definitionsDir,
            integrityDefinitionRoot: integrity.registry?.definitionRoot
          });
        }
        return raw;
      }
    } catch {
      continue;
    }
  }

  return null;
}
