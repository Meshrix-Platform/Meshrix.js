#!/usr/bin/env node
import path from "node:path";
import packageManifest from "./package.json" with { type: "json" };
import { adapterError, clientCommand, descriptor, homePath, isDirectInvocation, jsonRegistrationStore, nativeAdapter, run, runAdapterCli } from "@meshrix/client-adapter-kit";

export const description = descriptor({ target: "pi", label: "Pi", version: packageManifest.version, packageName: "@meshrix/agent-pi-adapter", commandNames: ["pi"], installMode: "native-remote-mcp" });
function configPath(request) {
  return request.client?.configPath || path.join(request.client?.configRoot || process.env.PI_CODING_AGENT_DIR || homePath(".pi", "agent"), "mcp.json");
}
export const adapter = nativeAdapter({
  description,
  async probe(request) {
    const help = await run(clientCommand(request, "pi"), ["mcp", "--help"], { allowFailure: true });
    return help.ok && /\bpi mcp add\b/u.test(`${help.stdout}\n${help.stderr}`);
  },
  load: (request, registration) => jsonRegistrationStore(configPath(request), "mcpServers", registration.serverName),
  beforeInstall(_request, registration, store) {
    const namespace = registration.serverName.replaceAll("-", "_");
    if (Object.keys(store.config.mcpServers || {}).some((name) => name !== registration.serverName && name.replaceAll("-", "_") === namespace)) {
      throw adapterError("registration_conflict", "Another Pi server uses the same tool namespace. Select a distinct --server-name.", 65);
    }
    return false;
  }
});
if (isDirectInvocation(import.meta.url)) await runAdapterCli(adapter);
