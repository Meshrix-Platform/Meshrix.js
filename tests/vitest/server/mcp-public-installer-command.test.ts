import { describe, expect, it } from "vitest";
import packageManifest from "../../../package.json";

import {
  buildMeshrixMcpDiscovery,
  mcpAuthorizationErrorData,
  mcpConnectorRuntimeMetadata,
  mcpVersionInfo,
  npmMcpCommand
} from "../../../packages/protocols/mcp/modern-downstream/discovery.ts";

describe("public MCP install command metadata", () => {
  it("uses the shipped npm Node bin for discovery, clients, errors and upgrades", () => {
    const listenUrl = "http://127.0.0.1:7228";
    const discovery = buildMeshrixMcpDiscovery({ listenUrl });
    const baseCommand = `npx --yes --package meshrix.js@${packageManifest.version} meshrix-mcp`;

    expect(npmMcpCommand("install", listenUrl)).toBe(`${baseCommand} install --url '${listenUrl}'`);
    expect(discovery.localDiscovery.entrypoint.command)
      .toBe(`${baseCommand} discover-local --url '${listenUrl}' --json`);
    const referenceArgs = " --token-env MESHRIX_MCP_TOKEN --server-name lico";
    expect(discovery.installer).toMatchObject({
      installCommand: `${baseCommand} install --url '${listenUrl}'${referenceArgs}`,
      autoInstallCommand: `${baseCommand} install --target auto --url '${listenUrl}'${referenceArgs} --json`,
      doctorCommand: `${baseCommand} doctor --url '${listenUrl}'${referenceArgs} --json`,
      discoverCommand: `${baseCommand} discover-local --url '${listenUrl}' --json`,
      scanCommand: `${baseCommand} scan --url '${listenUrl}' --json`,
      uninstallCommand: `${baseCommand} uninstall --target codex --url '${listenUrl}'${referenceArgs} --json`
    });
    expect(discovery.clientTargets.every(({ install, nativeRegistration }: Record<string, any>) =>
      (nativeRegistration.supported ? install.command.startsWith(`${baseCommand} install --target `) : install.command === "" && install.commandJson === "")
      && install.uninstallCommand.startsWith(`${baseCommand} uninstall --target `)
    )).toBe(true);
    expect(discovery.installer.priorityTargets).toEqual(["openclaw", "codex", "claude-code", "opencode", "pi"]);
    expect(discovery.installer.tokenInput).toBe("client-environment-reference");
    expect(discovery.auth.acceptedHeaders).toEqual(["X-Meshrix.js-Api-Key"]);
    expect(discovery.upgrade.reinstallCommand).toBe(discovery.installer.installCommand);
    expect(discovery.installer.portable.command).toBe("meshrix-mcp");

    const runtime = mcpConnectorRuntimeMetadata(discovery, mcpVersionInfo());
    const authError = mcpAuthorizationErrorData({ listenUrl });
    for (const value of [discovery, runtime, authError]) {
      const serialized = JSON.stringify(value);
      expect(serialized).toContain(baseCommand);
      expect(serialized).not.toMatch(/\/bin\/sh|githubOneLine|nativeEntrypoint|windowsEntrypoint|bootstrapScript|\.ps1|\.sh/u);
    }
    expect(runtime.autoInstallCommand).toBe(discovery.installer.autoInstallCommand);
    expect(authError.nextCommand).toBe(discovery.installer.autoInstallCommand);
  });
});
