#!/usr/bin/env node
/**
 * OTel Semantic Convention Fields (adoption baseline):
 *   service.name, service.version
 *   mcp.method.name
 *
 * These fields SHOULD be emitted during MCP gateway install/register/discover
 * operations. Adoption is incremental; new installer paths should include them.
 */
import {
  MCP_INTERFACE_VERSION,
  MCP_STABLE_TOOL_NAME,
  packageJson
} from "../lib/cli/constants.mjs";
import { parseArgs, usage } from "../lib/cli/basic-utils.mjs";
import { LICO_MCP_COMMAND_REGISTRY } from "../lib/cli/commands.mjs";
import { emitCommandError, emitResult } from "../lib/cli/formatters.mjs";

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (options.version || command === "version" || command === "--version") {
    emitResult({
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      stableToolName: MCP_STABLE_TOOL_NAME,
      interfaceVersion: MCP_INTERFACE_VERSION
    }, options, "version");
    return;
  }
  if (options.help || command === "help" || !command) {
    console.log(usage());
    return;
  }
  const handler = LICO_MCP_COMMAND_REGISTRY[command];
  if (!handler) {
    throw new Error(`Unknown command: ${command}`);
  }
  if (command === "proxy") {
    await handler(options);
    return;
  }
  emitResult(await handler(options), options, command);
}

main().catch((error) => {
  const argv = process.argv.slice(2);
  const requestedCommand = String(argv[0] || "");
  const command = Object.hasOwn(LICO_MCP_COMMAND_REGISTRY, requestedCommand) || ["help", "version"].includes(requestedCommand)
    ? requestedCommand
    : "";
  const options = {
    json: argv.includes("--json"),
    pretty: argv.includes("--pretty")
  };
  emitCommandError(error, options, command);
});
