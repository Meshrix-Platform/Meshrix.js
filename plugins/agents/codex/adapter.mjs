#!/usr/bin/env node
import {
  MCP_SERVER_NAME, clientCommand, connectorFrom, descriptor, homePath, isDirectInvocation, readJson, run, runAdapterCli, writeJson
} from "@meshrix/client-adapter-kit";
import fs from "node:fs/promises";
import path from "node:path";

const PLUGIN_NAME = "lico";
const MARKETPLACE_NAME = "meshrix-local";
export const description = descriptor({ target: "codex", label: "Codex", version: "0.0.1", packageName: "@meshrix/agent-codex-adapter", commandNames: ["codex"], installMode: "codex-marketplace-and-mcp-cli" });

function marketplacePaths(request) {
  const root = String(request?.client?.marketplaceRoot || homePath(".lico", "codex-plugin-marketplace"));
  return { root, pluginRoot: path.join(root, "plugins", PLUGIN_NAME), catalog: path.join(root, ".agents", "plugins", "marketplace.json") };
}

async function writeMarketplace(request, connector) {
  const paths = marketplacePaths(request);
  await writeJson(path.join(paths.pluginRoot, ".codex-plugin", "plugin.json"), {
    name: PLUGIN_NAME, version: "0.0.1", description: "Meshrix MCP integration for Codex.", license: "Apache-2.0", mcpServers: "./.mcp.json"
  });
  await writeJson(path.join(paths.pluginRoot, ".mcp.json"), { mcpServers: { [MCP_SERVER_NAME]: { command: connector.command, args: connector.args } } });
  const catalog = await readJson(paths.catalog, { name: MARKETPLACE_NAME, plugins: [] });
  catalog.name = MARKETPLACE_NAME;
  catalog.plugins = [...(catalog.plugins || []).filter((item) => item?.name !== PLUGIN_NAME), { name: PLUGIN_NAME, source: { source: "local", path: `./plugins/${PLUGIN_NAME}` }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Coding" }];
  await writeJson(paths.catalog, catalog);
  return paths;
}

async function installed(command) {
  const result = await run(command, ["mcp", "get", MCP_SERVER_NAME], { allowFailure: true });
  return result.ok && /\blico\b/iu.test(result.stdout);
}

export const adapter = {
  description,
  async scan(request) {
    const command = clientCommand(request, "codex");
    const available = (await run(command, ["--version"], { allowFailure: true })).ok;
    return { available, installed: available && await installed(command) };
  },
  async install(request) {
    const command = clientCommand(request, "codex");
    const connector = connectorFrom(request, "codex");
    const marketplace = await writeMarketplace(request, connector);
    await run(command, ["plugin", "marketplace", "add", marketplace.root], { allowFailure: true });
    await run(command, ["plugin", "remove", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], { allowFailure: true });
    await run(command, ["plugin", "add", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], { allowFailure: true });
    await run(command, ["mcp", "remove", MCP_SERVER_NAME], { allowFailure: true });
    await run(command, ["mcp", "add", MCP_SERVER_NAME, "--", connector.command, ...connector.args]);
    return { installed: await installed(command), marketplaceRegistered: true };
  },
  async verify(request) { return { installed: await installed(clientCommand(request, "codex")) }; },
  async uninstall(request) {
    const command = clientCommand(request, "codex");
    const existed = await installed(command);
    const marketplace = marketplacePaths(request);
    await run(command, ["mcp", "remove", MCP_SERVER_NAME], { allowFailure: true });
    await run(command, ["plugin", "remove", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], { allowFailure: true });
    await fs.rm(marketplace.pluginRoot, { recursive: true, force: true });
    const catalog = await readJson(marketplace.catalog, null);
    if (catalog?.plugins) {
      catalog.plugins = catalog.plugins.filter((item) => item?.name !== PLUGIN_NAME);
      await writeJson(marketplace.catalog, catalog);
    }
    return { removed: existed, installed: await installed(command), marketplaceRemoved: true };
  }
};

if (isDirectInvocation(import.meta.url)) await runAdapterCli(adapter);
