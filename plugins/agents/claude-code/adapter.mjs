#!/usr/bin/env node
import { MCP_SERVER_NAME, clientCommand, connectorFrom, descriptor, isDirectInvocation, run, runAdapterCli } from "@meshrix/client-adapter-kit";

export const description = descriptor({ target: "claude-code", label: "Claude Code", version: "0.0.1", packageName: "@meshrix/agent-claude-code-adapter", commandNames: ["claude"], installMode: "external-client-adapter" });
async function installed(command) {
  const result = await run(command, ["mcp", "get", MCP_SERVER_NAME], { allowFailure: true });
  return result.ok && /\blico\b/iu.test(result.stdout);
}
export const adapter = {
  description,
  async scan(request) { const command = clientCommand(request, "claude"); const available = (await run(command, ["--version"], { allowFailure: true })).ok; return { available, installed: available && await installed(command) }; },
  async install(request) {
    const command = clientCommand(request, "claude");
    const connector = connectorFrom(request, "claude-code");
    const config = { type: "stdio", command: connector.command, args: connector.args };
    await run(command, ["mcp", "remove", MCP_SERVER_NAME], { allowFailure: true });
    await run(command, ["mcp", "add-json", MCP_SERVER_NAME, JSON.stringify(config), "--scope", "user"]);
    return { installed: await installed(command) };
  },
  async verify(request) { return { installed: await installed(clientCommand(request, "claude")) }; },
  async uninstall(request) { const command = clientCommand(request, "claude"); const existed = await installed(command); await run(command, ["mcp", "remove", MCP_SERVER_NAME], { allowFailure: true }); return { removed: existed, installed: await installed(command) }; }
};
if (isDirectInvocation(import.meta.url)) await runAdapterCli(adapter);
