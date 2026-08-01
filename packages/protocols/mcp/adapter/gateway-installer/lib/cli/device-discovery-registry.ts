import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_DISCOVERY_REGISTRY,
  MESHRIX_MCP_DISCOVERY_FILE_ENV,
  MESHRIX_MCP_DISCOVERY_URL_ENV,
  MESHRIX_MCP_URL_ENV
} from "./constants.ts";
import { option } from "./basic-utils.ts";
import { expandHomePath } from "./connector-process.ts";

export function discoveryRegistryPath(options: Record<string, any> = {}) : any {
  const selected: any = option(
    options,
    "discovery-file",
    process.env[MESHRIX_MCP_DISCOVERY_FILE_ENV] || DEFAULT_DISCOVERY_REGISTRY
  );
  return path.resolve(expandHomePath(selected));
}

export function deviceDiscoveryPaths(options: Record<string, any> = {}) : any {
  return [discoveryRegistryPath(options)];
}

export function deviceDiscoveryEnv({ baseUrl, primaryPath }: Record<string, any>) : any {
  return {
    [MESHRIX_MCP_URL_ENV]: `${baseUrl}/mcp`,
    [MESHRIX_MCP_DISCOVERY_URL_ENV]: `${baseUrl}/.well-known/meshrix/mcp.json`,
    [MESHRIX_MCP_DISCOVERY_FILE_ENV]: primaryPath
  };
}

function stripJsonComments(value: any = "") : any {
  const input: any = String(value || "");
  let output: any = "";
  let inString: any = false;
  let escaped: any = false;
  for (let index: any = 0; index < input.length; index += 1) {
    const char: any = input[index];
    const next: any = input[index + 1];
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

function stripTrailingJsonCommas(value: any = "") : any {
  const input: any = String(value || "");
  let output: any = "";
  let inString: any = false;
  let escaped: any = false;
  for (let index: any = 0; index < input.length; index += 1) {
    const char: any = input[index];
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
      let lookahead: any = index + 1;
      while (/\s/.test(input[lookahead] || "")) lookahead += 1;
      if (input[lookahead] === "}" || input[lookahead] === "]") {
        continue;
      }
    }
    output += char;
  }
  return output;
}

function parseJsonConfig(value: any = "") : any {
  const raw: any = String(value || "");
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(stripTrailingJsonCommas(stripJsonComments(raw)));
  }
}

export async function readJson(filePath?: any, fallback: Record<string, any> = {}) : Promise<any> {
  try {
    return parseJsonConfig(await fs.readFile(filePath, "utf8"));
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function writeJson(filePath?: any, value?: any) : Promise<any> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
