#!/usr/bin/env node
import {
  MCP_SERVER_NAME, clientCommand, connectorFrom, descriptor, homePath, isDirectInvocation,
  readJsonc, removeNamedEntry, run, runAdapterCli, writeJson
} from "@meshrix/client-adapter-kit";

export const description = descriptor({ target: "opencode", label: "OpenCode", version: "0.0.1", packageName: "@meshrix/agent-opencode-adapter", commandNames: ["opencode"], installMode: "external-client-adapter" });
function configPath(request) { return String(request?.client?.configPath || homePath(".config", "opencode", "opencode.jsonc")); }
async function installed(request) { const config = await readJsonc(configPath(request), {}); return Boolean(config?.mcp?.[MCP_SERVER_NAME]); }
export const adapter = {
  description,
  async scan(request) { const available = (await run(clientCommand(request, "opencode"), ["--version"], { allowFailure: true })).ok; return { available, installed: await installed(request) }; },
  async install(request) { const connector = connectorFrom(request, "opencode"); const config = await readJsonc(configPath(request), {}); config.mcp = { ...(config.mcp || {}), [MCP_SERVER_NAME]: { type: "local", command: [connector.command, ...connector.args] } }; await writeJson(configPath(request), config); return { installed: true }; },
  async verify(request) { return { installed: await installed(request) }; },
  async uninstall(request) { const removed = await removeNamedEntry(configPath(request), "mcp"); return { removed, installed: await installed(request) }; }
};
if (isDirectInvocation(import.meta.url)) await runAdapterCli(adapter);
