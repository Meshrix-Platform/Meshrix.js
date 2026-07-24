import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateStateMachineDefinition } from "./engine/state-machine-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFINITIONS_DIR = resolve(__dirname, "definitions");

/**
 * Load a state machine definition from a JSON file.
 *
 * @param {string} definitionPath - Absolute or relative path to the JSON definition
 * @returns {object} Parsed definition
 */
export function loadDefinition(definitionPath) {
  if (!definitionPath) {
    throw new Error("definitionPath is required");
  }

  const resolvedPath = resolve(definitionPath);
  const content = readFileSync(resolvedPath, "utf-8");
  return JSON.parse(content);
}

/**
 * Load a built-in definition by name from the definitions/ directory.
 *
 * @param {string} name - Definition name (e.g., "checkpoint.restore", "operation.narrow")
 * @returns {object} Parsed definition
 */
export function loadBuiltinDefinition(name) {
  if (!name) {
    throw new Error("Definition name is required");
  }

  // Try loading as-is first
  const paths = [
    resolve(DEFINITIONS_DIR, `${name}.json`),
    resolve(DEFINITIONS_DIR, name),
  ];

  for (const p of paths) {
    try {
      return loadDefinition(p);
    } catch {
      // Continue to next path
    }
  }

  throw new Error(`Built-in definition not found: "${name}"`);
}

/**
 * Resolve a definition from either a file path or an inline object.
 *
 * @param {object|string} definition - Definition object or file path
 * @returns {object} Resolved definition
 */
export function resolveDefinition(definition) {
  if (typeof definition === "string") {
    return loadDefinition(definition);
  }
  if (typeof definition === "object" && definition !== null && !Array.isArray(definition)) {
    return definition;
  }
  throw new Error("definition must be a file path string or a definition object");
}

/**
 * List all available built-in definition names.
 *
 * @returns {string[]} Array of definition names
 */
export function listBuiltinDefinitions() {
  try {
    const files = readdirSync(DEFINITIONS_DIR);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/**
 * Validate a definition object against the state machine schema.
 * Delegates to the existing schema checker from the engine.
 *
 * @param {object} definition
 * @returns {{ ok: boolean, errors: Array<{ errorCode: string, message: string }> }}
 */
export function validateDefinition(definition) {
  return validateStateMachineDefinition(definition);
}
