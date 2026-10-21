import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeAdapter } from "@meshrix/client-adapter-kit";
import packageManifest from "../../../package.json";

import { resolveInstalledClientAdapter } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/client-adapter-runner.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-pi-registration-"));
  temporaryRoots.push(root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  const installed = await resolveInstalledClientAdapter({ target: "pi" });
  expect(installed.adapter).toMatchObject({
    packageName: "@meshrix/agent-pi-adapter",
    version: packageManifest.version,
    source: "meshrix-root-bundle"
  });
  const { adapter } = await import(pathToFileURL(path.join(installed.packageRoot, "adapter.mjs")).href);
  const request = {
    baseUrl: "https://gateway.invalid",
    serverName: "lico",
    credentialRef: { kind: "env", name: "MESHRIX_MCP_TOKEN" }
  };
  return { root, adapter, request };
}

describe("Pi adapter installed component", () => {
  it("registers native MCP under the configured agent directory and preserves unrelated settings", async () => {
    const { root, adapter, request } = await fixture();
    const mcpPath = path.join(root, "mcp.json");
    const settingsPath = path.join(root, "settings.json");
    const settings = `${JSON.stringify({ theme: "dark", extensions: ["custom.ts"] })}\n`;
    await fs.writeFile(settingsPath, settings);
    await fs.writeFile(mcpPath, JSON.stringify({ mcpServers: { other: { command: "other" } } }));

    await expect(invokeAdapter(adapter, "install", request)).resolves.toMatchObject({ installed: true, status: "configured", connectivity: "not-run" });
    const registered = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    expect(registered.mcpServers.lico).toEqual({
      url: `${request.baseUrl}/mcp`,
      headers: { "X-Meshrix.js-Api-Key": "${MESHRIX_MCP_TOKEN}" }
    });
    expect(registered.mcpServers.other).toEqual({ command: "other" });
    expect(await fs.readFile(settingsPath, "utf8")).toBe(settings);
    await expect(invokeAdapter(adapter, "verify", request)).resolves.toMatchObject({ installed: true, connectivity: "not-run" });
    await expect(invokeAdapter(adapter, "uninstall", request)).resolves.toEqual({ removed: true, installed: false, credentialsPreserved: true });
    expect(JSON.parse(await fs.readFile(mcpPath, "utf8"))).toEqual({ mcpServers: { other: { command: "other" } } });
    expect(await fs.readFile(settingsPath, "utf8")).toBe(settings);
  });

  it("honors an explicit config root and refuses malformed configuration without overwriting it", async () => {
    const { root, adapter, request } = await fixture();
    const configRoot = path.join(root, "selected");
    const selected = { ...request, client: { configRoot } };
    await invokeAdapter(adapter, "install", selected);
    await expect(fs.access(path.join(root, "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const target = path.join(configRoot, "mcp.json");
    await fs.writeFile(target, "{broken");
    await expect(invokeAdapter(adapter, "install", selected)).rejects.toThrow("configuration is invalid");
    expect(await fs.readFile(target, "utf8")).toBe("{broken");
  });
});
