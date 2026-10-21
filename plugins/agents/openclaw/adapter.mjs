#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import packageManifest from "./package.json" with { type: "json" };
import { adapterError, clientCommand, descriptor, isDirectInvocation, nativeAdapter, run, runAdapterCli } from "@meshrix/client-adapter-kit";

export const description = descriptor({ target: "openclaw", label: "OpenClaw", version: packageManifest.version, packageName: "@meshrix/agent-openclaw-adapter", commandNames: ["openclaw"], installMode: "native-remote-mcp" });
function clientEnv(request) {
  return { ...process.env, ...(request.client?.configPath ? { OPENCLAW_CONFIG_PATH: request.client.configPath } : {}), ...(request.client?.configRoot ? { OPENCLAW_STATE_DIR: request.client.configRoot } : {}) };
}
export const adapter = nativeAdapter({
  description,
  async load(request, registration) {
    const command = clientCommand(request, "openclaw");
    const env = clientEnv(request);
    // `show` without a name reads authored definitions, not interpolated runtime credentials.
    const result = await run(command, ["mcp", "show", "--json"], { env });
    let servers;
    try { servers = JSON.parse(result.stdout); }
    catch { throw adapterError("invalid_client_config", "OpenClaw did not return a JSON MCP registry.", 74); }
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw adapterError("invalid_client_config", "OpenClaw returned an invalid MCP registry.", 74);
    return {
      entry: servers[registration.serverName],
      async save(entry) {
        if (entry === undefined) {
          // The shared matching guard rejects OAuth entries; unset cannot delete their auth stores.
          await run(command, ["mcp", "unset", registration.serverName], { env });
          return;
        }
        // Preserve additional authored fields without putting their possibly sensitive values in argv.
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-openclaw-registration-"));
        try {
          const file = path.join(directory, "assignment.json");
          await fs.writeFile(file, JSON.stringify([{ path: `mcp.servers.${registration.serverName}`, value: entry }]), { mode: 0o600, flag: "wx" });
          await run(command, ["config", "set", "--batch-file", file], { env });
        } finally { await fs.rm(directory, { recursive: true, force: true }); }
      }
    };
  }
});
if (isDirectInvocation(import.meta.url)) await runAdapterCli(adapter);
