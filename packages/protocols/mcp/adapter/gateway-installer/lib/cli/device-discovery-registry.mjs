import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_DISCOVERY_REGISTRY,
  MESHRIX_MCP_DISCOVERY_FILE_ENV,
  MESHRIX_MCP_DISCOVERY_URL_ENV,
  MESHRIX_MCP_URL_ENV
} from "./constants.mjs";
import { option } from "./basic-utils.mjs";
import { expandHomePath } from "./connector-process.mjs";

export function discoveryRegistryPath(options = {}) {
  const selected = option(
    options,
    "discovery-file",
    process.env[MESHRIX_MCP_DISCOVERY_FILE_ENV] || DEFAULT_DISCOVERY_REGISTRY
  );
  return path.resolve(expandHomePath(selected));
}

export function deviceDiscoveryPaths(options = {}) {
  return [discoveryRegistryPath(options)];
}

export function deviceDiscoveryEnv({ baseUrl, primaryPath }) {
  return {
    [MESHRIX_MCP_URL_ENV]: `${baseUrl}/mcp`,
    [MESHRIX_MCP_DISCOVERY_URL_ENV]: `${baseUrl}/.well-known/meshrix/mcp.json`,
    [MESHRIX_MCP_DISCOVERY_FILE_ENV]: primaryPath
  };
}

function stripJsonComments(value = "") {
  const input = String(value || "");
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function stripTrailingJsonCommas(value = "") {
  const input = String(value || "");
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(input[lookahead] || "")) lookahead += 1;
      if (input[lookahead] === "}" || input[lookahead] === "]") {
        continue;
      }
    }
    output += char;
  }
  return output;
}

function parseJsonConfig(value = "") {
  const raw = String(value || "");
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(stripTrailingJsonCommas(stripJsonComments(raw)));
  }
}

export async function readJson(filePath, fallback = {}) {
  try {
    return parseJsonConfig(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
