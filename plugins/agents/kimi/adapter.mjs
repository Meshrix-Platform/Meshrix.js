#!/usr/bin/env node
import path from "node:path";
import packageManifest from "./package.json" with { type: "json" };
import { descriptor, homePath, isDirectInvocation, jsonRegistrationStore, nativeAdapter, runAdapterCli } from "@meshrix/client-adapter-kit";

export const description = descriptor({ target: "kimi", label: "Kimi Code", version: packageManifest.version, packageName: "@meshrix/agent-kimi-adapter", commandNames: ["kimi"], installMode: "native-remote-mcp" });
function configPath(request) {
  return request.client?.configPath || path.join(request.client?.configRoot || process.env.KIMI_CODE_HOME || homePath(".kimi-code"), "mcp.json");
}
export const adapter = nativeAdapter({
  description,
  load: (request, registration) => jsonRegistrationStore(configPath(request), "mcpServers", registration.serverName)
});
if (isDirectInvocation(import.meta.url)) await runAdapterCli(adapter);
