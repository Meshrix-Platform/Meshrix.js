#!/usr/bin/env node
import { MCP_SERVER_NAME, clientCommand, connectorFrom, descriptor, isDirectInvocation, run, runAdapterCli } from "@meshrix/client-adapter-kit";

export const description = descriptor({ target: "openclaw", label: "OpenClaw", version: "0.0.1", packageName: "@meshrix/agent-openclaw-adapter", commandNames: ["openclaw", "ironclaw", "zeroclaw"], installMode: "external-client-adapter" });
async function installed(command) { const result = await run(command, ["mcp", "show", MCP_SERVER_NAME], { allowFailure: true }); return result.ok && /\blico\b/iu.test(result.stdout); }
export const adapter = {
  description,
  async scan(request) { const command = clientCommand(request, "openclaw"); const probe = await run(command, ["mcp", "--help"], { allowFailure: true }); return { available: probe.ok, installed: probe.ok && await installed(command) }; },
  async install(request) { const command = clientCommand(request, "openclaw"); const connector = connectorFrom(request, "openclaw"); const config = { command: connector.command, args: connector.args, enabled: true }; await run(command, ["mcp", "set", MCP_SERVER_NAME, JSON.stringify(config)]); return { installed: await installed(command) }; },
  async verify(request) { return { installed: await installed(clientCommand(request, "openclaw")) }; },
  async uninstall(request) { const command = clientCommand(request, "openclaw"); const existed = await installed(command); await run(command, ["mcp", "unset", MCP_SERVER_NAME], { allowFailure: true }); return { removed: existed, installed: await installed(command) }; }
};
if (isDirectInvocation(import.meta.url)) await runAdapterCli(adapter);
