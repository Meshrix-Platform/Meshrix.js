import { spawn } from "node:child_process";

import {
  asArray,
  normalizeTransportConfig,
  resolveStringRecord,
  stdioExecutionEnv,
  text
} from "./upstream-mcp-transport-common.mjs";

const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_CHARS = 4096;
const MAX_COMMAND_CHARS = 4096;
const MAX_ENVIRONMENT_ENTRIES = 64;
const MAX_ENVIRONMENT_VALUE_CHARS = 8192;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function boundedText(value, label, maxCharacters) {
  const normalized = String(value ?? "");
  if (
    !normalized ||
    normalized.length > maxCharacters ||
    normalized.includes("\0")
  ) {
    throw new TypeError(`${label} must be a bounded non-empty string.`);
  }
  return normalized;
}

function boundedArgument(value, index) {
  const normalized = String(value ?? "");
  if (normalized.length > MAX_ARGUMENT_CHARS || normalized.includes("\0")) {
    throw new TypeError(`Upstream MCP stdio argument ${index} is invalid.`);
  }
  return normalized;
}

function launchDescriptor(config, inheritedEnvironment) {
  const normalized = normalizeTransportConfig(config);
  if (normalized.transport !== "stdio") {
    throw new TypeError("Upstream MCP stdio launcher requires stdio transport configuration.");
  }
  const command = boundedText(text(normalized.command), "Upstream MCP stdio command", MAX_COMMAND_CHARS);
  const rawArguments = asArray(normalized.args);
  if (rawArguments.length > MAX_ARGUMENTS) {
    throw new TypeError("Upstream MCP stdio arguments exceed the transport limit.");
  }
  const args = rawArguments.map(boundedArgument);
  const configuredEnvironment = resolveStringRecord(normalized.env, inheritedEnvironment);
  const environmentEntries = Object.entries(configuredEnvironment);
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

export function createUpstreamMcpStdioLauncher({ spawnImpl = spawn } = {}) {
  if (typeof spawnImpl !== "function") {
    throw new TypeError("Upstream MCP stdio process launcher is unavailable.");
  }
  return Object.freeze({
    launch(config, { env = process.env } = {}) {
      const descriptor = launchDescriptor(config, env);
      return spawnImpl(descriptor.command, [...descriptor.args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...descriptor.env },
        shell: false,
        windowsHide: true
      });
    }
  });
}
