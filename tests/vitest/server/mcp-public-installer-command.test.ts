import { describe, expect, it } from "vitest";

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
    const baseCommand = "npx --yes --package meshrix.js@0.0.1 meshrix-mcp";

    expect(npmMcpCommand("install", listenUrl)).toBe(`${baseCommand} install --url '${listenUrl}'`);
    expect(discovery.localDiscovery.entrypoint.command)
      .toBe(`${baseCommand} discover-local --url '${listenUrl}' --json`);
    expect(discovery.installer).toMatchObject({
      installCommand: `${baseCommand} install --url '${listenUrl}'`,
      autoInstallCommand: `${baseCommand} install --target auto --url '${listenUrl}' --json`,
      doctorCommand: `${baseCommand} doctor --url '${listenUrl}' --json`,
      discoverCommand: `${baseCommand} discover-local --url '${listenUrl}' --json`,
      scanCommand: `${baseCommand} scan --url '${listenUrl}' --json`,
      uninstallCommand: `${baseCommand} uninstall --target codex --url '${listenUrl}' --json`
    });
    expect(discovery.clientTargets.every(({ install }: Record<string, any>) =>
      install.command.startsWith(`${baseCommand} install --target `)
      && install.uninstallCommand.startsWith(`${baseCommand} uninstall --target `)
    )).toBe(true);
    expect(discovery.upgrade.reinstallCommand).toBe(discovery.installer.installCommand);
    expect(discovery.installer.portable.command).toBe("meshrix-mcp");

    const runtime = mcpConnectorRuntimeMetadata(discovery, mcpVersionInfo());
    const authError = mcpAuthorizationErrorData({ listenUrl });
    for (const value of [discovery, runtime, authError]) {
      const serialized = JSON.stringify(value);
      expect(serialized).toContain("npx --yes --package meshrix.js@0.0.1 meshrix-mcp");
      expect(serialized).not.toMatch(/\/bin\/sh|githubOneLine|nativeEntrypoint|windowsEntrypoint|bootstrapScript|\.ps1|\.sh/u);
    }
    expect(runtime.autoInstallCommand).toBe(discovery.installer.autoInstallCommand);
    expect(authError.nextCommand).toBe(discovery.installer.autoInstallCommand);
  });
});
