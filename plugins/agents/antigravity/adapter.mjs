#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  MCP_SERVER_NAME, clientCommand, connectorFrom, descriptor, homePath, isDirectInvocation,
  readJson, run, runAdapterCli, writeJson
} from "@meshrix/client-adapter-kit";

export const description = descriptor({ target: "antigravity", label: "Antigravity", version: "0.0.1", packageName: "@meshrix/agent-antigravity-adapter", commandNames: ["antigravity-ide", "agy", "agy-ide", "antigravity"], installMode: "external-client-adapter" });

function configPath(request) {
  if (request?.client?.configPath) return String(request.client.configPath);
  if (request?.client?.configRoot) return path.join(String(request.client.configRoot), "mcp_config.json");
  return homePath(".gemini", "antigravity", "mcp_config.json");
}

async function installed(request) {
  const config = await readJson(configPath(request), {});
  return Boolean(config?.mcpServers?.[MCP_SERVER_NAME]);
}

export const adapter = {
  description,
  async scan(request) {
    const command = clientCommand(request, "antigravity-ide");
    const help = await run(command, ["--help"], { allowFailure: true });
    const version = help.ok
      ? null
      : await run(command, ["--version"], { allowFailure: true });
    return {
      available: help.ok || version?.ok === true,
      installed: await installed(request)
    };
  },
  async install(request) {
    const target = configPath(request);
    const connector = connectorFrom(request, "antigravity");
    const config = await readJson(target, {});
    config.mcpServers = {
      ...(config.mcpServers || {}),
      [MCP_SERVER_NAME]: {
        command: connector.command,
        args: connector.args
      }
    };
    await writeJson(target, config);
    return { installed: true };
  },
  async verify(request) { return { installed: await installed(request) }; },
  async uninstall(request) {
    const target = configPath(request);
    const config = await readJson(target, {});
    const removed = Boolean(config?.mcpServers?.[MCP_SERVER_NAME]);
    if (removed) delete config.mcpServers[MCP_SERVER_NAME];
    if (Object.keys(config.mcpServers || {}).length === 0) delete config.mcpServers;
    if (Object.keys(config).length > 0) await writeJson(target, config);
    else await fs.rm(target, { force: true });
    return { removed, installed: await installed(request) };
  }
};
if (isDirectInvocation(import.meta.url)) await runAdapterCli(adapter);
