#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import packageManifest from "./package.json" with { type: "json" };
import {
  adapterError, descriptor, homePath, isDirectInvocation, isOwnedProxy, nativeAdapter,
  readJson, runAdapterCli, writePrivateFile
} from "@meshrix/client-adapter-kit";

export const description = descriptor({ target: "codex", label: "Codex", version: packageManifest.version, packageName: "@meshrix/agent-codex-adapter", commandNames: ["codex"], installMode: "native-remote-mcp" });
function configPath(request) {
  return request.client?.configPath || path.join(request.client?.configRoot || process.env.CODEX_HOME || homePath(".codex"), "config.toml");
}
export const adapter = nativeAdapter({
  description,
  async load(request, registration) {
    const file = configPath(request);
    let config;
    try { config = parse(await fs.readFile(file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") config = {};
      else throw adapterError("invalid_client_config", "The Codex TOML configuration is invalid.", 74);
    }
    if (config.mcp_servers !== undefined && (!config.mcp_servers || typeof config.mcp_servers !== "object" || Array.isArray(config.mcp_servers))) {
      throw adapterError("invalid_client_config", "The Codex MCP server map is invalid.", 74);
    }
    return {
      config, entry: config.mcp_servers?.[registration.serverName],
      async save(entry) {
        if (entry === undefined) delete config.mcp_servers[registration.serverName];
        else config.mcp_servers = { ...config.mcp_servers, [registration.serverName]: entry };
        await writePrivateFile(file, stringify(config));
      }
    };
  },
  async beforeInstall(request, registration, store) {
    if (registration.serverName !== "lico") return false;
    const root = request.client?.marketplaceRoot || homePath(".lico", "codex-plugin-marketplace");
    const pluginRoot = path.join(root, "plugins", "lico");
    const manifest = await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), null);
    if (manifest?.name !== "lico" || manifest.description !== "Meshrix MCP integration for Codex." ||
        manifest.license !== "Apache-2.0" || manifest.mcpServers !== "./.mcp.json") return false;
    const servers = await readJson(path.join(pluginRoot, ".mcp.json"), {});
    if (!isOwnedProxy(servers.mcpServers?.lico, registration, "codex")) return false;
    // Disable only the positively identified former generated duplicate. Keep all plugin assets.
    const id = "lico@meshrix-local";
    if (store.config.plugins?.[id]?.enabled === false) return false;
    store.config.plugins = { ...store.config.plugins, [id]: { ...store.config.plugins?.[id], enabled: false } };
    return true;
  }
});
if (isDirectInvocation(import.meta.url)) await runAdapterCli(adapter);
