#!/usr/bin/env node
import path from "node:path";
import packageManifest from "./package.json" with { type: "json" };
import { descriptor, homePath, isDirectInvocation, jsonRegistrationStore, nativeAdapter, runAdapterCli } from "@meshrix/client-adapter-kit";

export const description = descriptor({ target: "claude-code", label: "Claude Code", version: packageManifest.version, packageName: "@meshrix/agent-claude-code-adapter", commandNames: ["claude"], installMode: "native-remote-mcp" });
function configPath(request) {
  if (request.client?.configPath) return request.client.configPath;
  const root = request.client?.configRoot || process.env.CLAUDE_CONFIG_DIR;
  return root ? path.join(root, ".claude.json") : homePath(".claude.json");
}
export const adapter = nativeAdapter({
  description,
  load: (request, registration) => jsonRegistrationStore(configPath(request), "mcpServers", registration.serverName)
});
// Direct user-scope config updates avoid `mcp remove`, which also removes native OAuth data.
if (isDirectInvocation(import.meta.url)) await runAdapterCli(adapter);
