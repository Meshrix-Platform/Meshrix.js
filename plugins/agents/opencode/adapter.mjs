#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import packageManifest from "./package.json" with { type: "json" };
import { adapterError, descriptor, homePath, isDirectInvocation, jsonRegistrationStore, nativeAdapter, readJsonc, runAdapterCli } from "@meshrix/client-adapter-kit";

export const description = descriptor({ target: "opencode", label: "OpenCode", version: packageManifest.version, packageName: "@meshrix/agent-opencode-adapter", commandNames: ["opencode"], installMode: "native-remote-mcp" });
async function configPath(request) {
  if (request.client?.configPath || process.env.OPENCODE_CONFIG) return request.client?.configPath || process.env.OPENCODE_CONFIG;
  const root = request.client?.configRoot || path.join(process.env.XDG_CONFIG_HOME || homePath(".config"), "opencode");
  const candidates = [path.join(root, "opencode.jsonc"), path.join(root, "opencode.json")];
  const existing = [];
  for (const file of candidates) {
    try { await fs.access(file); existing.push(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (existing.length > 1) throw adapterError("ambiguous_client_config", "Both OpenCode config files exist; select an explicit client.configPath rather than changing an ambiguous configuration.", 65);
  return existing[0] || candidates[0];
}
export const adapter = nativeAdapter({
  description,
  load: async (request, registration) => jsonRegistrationStore(await configPath(request), "mcp", registration.serverName, readJsonc)
});
if (isDirectInvocation(import.meta.url)) await runAdapterCli(adapter);
