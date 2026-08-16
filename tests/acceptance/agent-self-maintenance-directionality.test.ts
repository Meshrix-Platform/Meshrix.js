import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginRoot = path.join(repositoryRoot, "plugins/agents/meshrix-self-maintenance");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(pluginRoot, relativePath), "utf8");
}

describe("Agent self-maintenance directionality", () => {
  it("accepts only atomic local configuration and exposes no inbound control surface", () => {
    const schema = JSON.parse(read("contracts/local-config.schema.json"));
    const manifest = JSON.parse(read("plugin.json"));
    const runtimeSource = read("internal/runtime.mjs");
    const clientSource = read("internal/http-clients.mjs");

    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).not.toEqual(
      expect.arrayContaining(["listener", "server", "socket", "port", "controlChannel"]),
    );
    expect(manifest.types).toEqual(["client-peer-plugin"]);
    expect(manifest.integration).toMatchObject({ operations: [], toolsets: [], mountNames: [] });
    expect(runtimeSource).toContain("new AtomicConfigSource(configPath)");
    expect(`${runtimeSource}\n${clientSource}`).not.toMatch(/createServer\s*\(|\.listen\s*\(|WebSocket/u);
  });

  it("calls the standalone model service directly and Meshrix only through governed execution", () => {
    const clientSource = read("internal/http-clients.mjs");

    expect(clientSource).toContain('"/v1/chat/completions"');
    expect(clientSource).toContain('"/api/operation-permission/v1/execute"');
    expect(clientSource).not.toMatch(/runtime\.enabledPlugins|gatewayChannels|plugin contribution/iu);
  });
});
