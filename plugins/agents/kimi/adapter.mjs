#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import {
  MCP_SERVER_NAME, clientCommand, connectorFrom, descriptor, homePath, isDirectInvocation,
  readJsonc, removeNamedEntry, run, runAdapterCli, writeJson
} from "@meshrix/client-adapter-kit";

export const description = descriptor({ target: "kimi", label: "Kimi CLI", version: "0.0.1", packageName: "@meshrix/agent-kimi-adapter", commandNames: ["kimi"], installMode: "external-client-adapter" });
function configPath(request) {
  const override = String(request?.client?.configPath || "").trim();
  if (override) return override;
  const dataRoot = String(process.env.KIMI_CODE_HOME || "").trim();
  return dataRoot ? path.join(dataRoot, "mcp.json") : homePath(".kimi-code", "mcp.json");
}
function displayPath(filePath) { const home = os.homedir(); return home && filePath.startsWith(`${home}${path.sep}`) ? `~${filePath.slice(home.length)}` : filePath; }
async function installed(request) { const config = await readJsonc(configPath(request), {}); return Boolean(config?.mcpServers?.[MCP_SERVER_NAME]); }
export const adapter = {
  description,
  async scan(request) { const available = (await run(clientCommand(request, "kimi"), ["--version"], { allowFailure: true })).ok; return { available, installed: await installed(request) }; },
  async install(request) { const connector = connectorFrom(request, "kimi"); const filePath = configPath(request); const config = await readJsonc(filePath, {}); config.mcpServers = { ...(config.mcpServers || {}), [MCP_SERVER_NAME]: { command: connector.command, args: connector.args } }; await writeJson(filePath, config); return { installed: true, configPath: displayPath(filePath) }; },
  async verify(request) { return { installed: await installed(request) }; },
  async uninstall(request) { const removed = await removeNamedEntry(configPath(request), "mcpServers"); return { removed, installed: await installed(request) }; }
};
if (isDirectInvocation(import.meta.url)) await runAdapterCli(adapter);
