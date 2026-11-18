#!/usr/bin/env node
import path from "node:path";
import packageManifest from "./package.json" with { type: "json" };
import { descriptor, homePath, isDirectInvocation, jsonRegistrationStore, nativeAdapter, runAdapterCli } from "@meshrix/client-adapter-kit";

export const description = descriptor({ target: "antigravity", label: "Antigravity", version: packageManifest.version, packageName: "@meshrix/agent-antigravity-adapter", commandNames: ["antigravity-ide", "agy", "agy-ide", "antigravity"], installMode: "native-remote-mcp" });
function configPath(request) {
  return request.client?.configPath || path.join(request.client?.configRoot || homePath(".gemini", "config"), "mcp_config.json");
}
export const adapter = nativeAdapter({
  description,
  load: (request, registration) => jsonRegistrationStore(configPath(request), "mcpServers", registration.serverName)
});
if (isDirectInvocation(import.meta.url)) await runAdapterCli(adapter);
