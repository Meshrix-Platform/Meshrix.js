import { spawn } from "node:child_process";

import {
  asArray,
  normalizeTransportConfig,
  resolveStringRecord,
  stdioExecutionEnv,
  text
} from "./upstream-mcp-transport-common.ts";

const MAX_ARGUMENTS: any = 128;
const MAX_ARGUMENT_CHARS: any = 4096;
const MAX_COMMAND_CHARS: any = 4096;
const MAX_ENVIRONMENT_ENTRIES: any = 64;
const MAX_ENVIRONMENT_VALUE_CHARS: any = 8192;
const ENVIRONMENT_NAME: any = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function boundedText(value?: any, label?: any, maxCharacters?: any) : any {
  const normalized: any = String(value ?? "");
  if (
    !normalized ||
    normalized.length > maxCharacters ||
    normalized.includes("\0")
  ) {
    throw new TypeError(`${label} must be a bounded non-empty string.`);
  }
  return normalized;
}

function boundedArgument(value?: any, index?: any) : any {
  const normalized: any = String(value ?? "");
  if (normalized.length > MAX_ARGUMENT_CHARS || normalized.includes("\0")) {
    throw new TypeError(`Upstream MCP stdio argument ${index} is invalid.`);
  }
  return normalized;
}

function launchDescriptor(config?: any, inheritedEnvironment?: any) : any {
  const normalized: any = normalizeTransportConfig(config);
  if (normalized.transport !== "stdio") {
    throw new TypeError("Upstream MCP stdio launcher requires stdio transport configuration.");
  }
  const command: any = boundedText(text(normalized.command), "Upstream MCP stdio command", MAX_COMMAND_CHARS);
  const rawArguments: any = asArray(normalized.args);
  if (rawArguments.length > MAX_ARGUMENTS) {
    throw new TypeError("Upstream MCP stdio arguments exceed the transport limit.");
  }
  const args: any = rawArguments.map(boundedArgument);
  const configuredEnvironment: any = resolveStringRecord(normalized.env, inheritedEnvironment);
  const environmentEntries: any = (Object.entries(configuredEnvironment) as [string, any][]);
  if (environmentEntries.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new TypeError("Upstream MCP stdio environment exceeds the transport limit.");
  }
  for (const [name, value] of environmentEntries) {
    if (
      !ENVIRONMENT_NAME.test(name) ||
      String(value).length > MAX_ENVIRONMENT_VALUE_CHARS ||
      String(value).includes("\0")
    ) {
      throw new TypeError("Upstream MCP stdio environment contains an invalid entry.");
    }
  }
  return Object.freeze({
    command,
    args: Object.freeze(args),
    env: Object.freeze({
      ...stdioExecutionEnv(inheritedEnvironment),
      ...configuredEnvironment
    })
  });
}

export function createUpstreamMcpStdioLauncher({ spawnImpl = spawn }: Record<string, any> = {}) : any {
  if (typeof spawnImpl !== "function") {
    throw new TypeError("Upstream MCP stdio process launcher is unavailable.");
  }
  return Object.freeze({
    launch(config?: any, { env = process.env }: Record<string, any> = {}) : any {
      const descriptor: any = launchDescriptor(config, env);
      return spawnImpl(descriptor.command, [...descriptor.args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...descriptor.env },
        shell: false,
        windowsHide: true
      });
    }
  });
}
