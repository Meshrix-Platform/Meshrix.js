#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
} from "../lib/cli/constants.ts";
import { parseArgs, usage } from "../lib/cli/basic-utils.ts";
import { MESHRIX_MCP_COMMAND_REGISTRY } from "../lib/cli/commands.ts";
import { emitCommandError, emitResult } from "../lib/cli/formatters.ts";

export async function main(argv: any = process.argv.slice(2)) : Promise<any> {
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
  const handler: any = MESHRIX_MCP_COMMAND_REGISTRY[command];
  if (!handler) {
    throw new Error(`Unknown command: ${command}`);
  }
  if (command === "proxy" || command === "fetch") {
    const result: any = await runWithOwnedProcessSignals(handler, options);
    if (command === "proxy") return;
    emitResult(result, options, command);
    return;
  }
  emitResult(await handler(options), options, command);
}

export async function runWithOwnedProcessSignals(handler?: any, options: Record<string, any> = {}, signalSource: any = process) : Promise<any> {
  const controller: any = new AbortController();
  const abortForSignal: any = (signalName?: any) : any => {
    if (controller.signal.aborted) return;
    const error: Error & Record<string, any> = new Error(signalName === "SIGINT" ? "Command interrupted." : "Command terminated.");
    error.name = "AbortError";
    error.code = signalName;
    controller.abort(error);
  };
  const onInterrupt: any = () : any => abortForSignal("SIGINT");
  const onTerminate: any = () : any => abortForSignal("SIGTERM");
  signalSource.on("SIGINT", onInterrupt);
  signalSource.on("SIGTERM", onTerminate);
  try {
    return await handler({ ...options, signal: controller.signal });
  } finally {
    signalSource.removeListener("SIGINT", onInterrupt);
    signalSource.removeListener("SIGTERM", onTerminate);
  }
}

function isDirectCliEntry() : any {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectCliEntry()) {
  main().catch((error?: any) : any => {
    const argv: any = process.argv.slice(2);
    const requestedCommand: any = String(argv[0] || "");
    const command: any = Object.hasOwn(MESHRIX_MCP_COMMAND_REGISTRY, requestedCommand) || ["help", "version"].includes(requestedCommand)
      ? requestedCommand
      : "";
    const options: Record<string, any> = {
      json: argv.includes("--json"),
      pretty: argv.includes("--pretty")
    };
    emitCommandError(error, options, command);
  });
}
