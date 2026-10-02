import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createDeviceEnvironmentPort
} from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/device-environment.ts";
import {
  publishDeviceHubManifest,
  resetServerConfig
} from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/device-config.ts";
import {
  listFilesystemEntries
} from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/scan-local.ts";
import { run } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/connector-process.ts";
import { summarizeMcpInstallerConvergenceReport } from "../../../tools/server-scripts/lib/mcp-installer-convergence-report.ts";

const discoveryEnvironment = {
  MESHRIX_MCP_URL: "http://meshrix.test:7228/mcp",
  MESHRIX_MCP_DISCOVERY_URL: "http://meshrix.test:7228/.well-known/meshrix/mcp.json",
  MESHRIX_MCP_DISCOVERY_FILE: "/tmp/meshrix-device/servers.json"
};

function controlledEnvironmentRunner(initial: Record<string, string> = {}) {
  const values: Record<string, string> = { ...initial };
  const runCommand = vi.fn(async (command: string, args: string[], options: Record<string, any> = {}) => {
    if (command === "launchctl") {
      const [operation, name, value] = args;
      if (operation === "getenv") return { ok: true, stdout: values[name] || "" };
      if (operation === "setenv") values[name] = value;
      if (operation === "unsetenv") delete values[name];
      return { ok: true, stdout: "" };
    }
    if (command === "powershell.exe") {
      const script = String(args.at(-1) || "");
      if (script.includes("ConvertTo-Json")) {
        const owned = Object.fromEntries(Object.entries(values).filter(([name]) => Object.hasOwn(discoveryEnvironment, name)));
        return { ok: true, stdout: JSON.stringify(owned) };
      }
      if (script.includes("CreateSubKey")) {
        Object.assign(values, Object.fromEntries(
          Object.entries(options.env || {}).filter(([name]) => Object.hasOwn(discoveryEnvironment, name))
        ));
      } else {
        for (const name of Object.keys(values)) {
          if (Object.hasOwn(discoveryEnvironment, name)) delete values[name];
        }
      }
      return { ok: true, stdout: "" };
    }
    return { ok: false, stdout: "", stderr: "unexpected command" };
  });
  return { values, runCommand };
}

describe("portable MCP installer discovery", () => {
  it("reads, writes and removes exactly the macOS discovery keys", async () => {
    const { values, runCommand } = controlledEnvironmentRunner({ MESHRIX_MCP_OTHER: "preserve" });
    const port = createDeviceEnvironmentPort({ platform: "darwin", runCommand });

    expect(await port.write(discoveryEnvironment)).toEqual({ supported: true, persisted: true });
    expect(await port.read()).toEqual(discoveryEnvironment);
    expect(await port.remove()).toEqual({ supported: true, persisted: true });
    expect(values).toEqual({ MESHRIX_MCP_OTHER: "preserve" });
    expect(runCommand).toHaveBeenCalledWith("launchctl", ["setenv", "MESHRIX_MCP_URL", discoveryEnvironment.MESHRIX_MCP_URL], expect.any(Object));
    expect(runCommand).toHaveBeenCalledWith("launchctl", ["unsetenv", "MESHRIX_MCP_URL"], expect.any(Object));
  });

  it("uses a static Windows registry adapter and keeps values out of command text", async () => {
    const { values, runCommand } = controlledEnvironmentRunner({ MESHRIX_MCP_OTHER: "preserve" });
    const port = createDeviceEnvironmentPort({ platform: "win32", runCommand });

    expect(await port.write(discoveryEnvironment)).toEqual({ supported: true, persisted: true });
    expect(await port.read()).toEqual(discoveryEnvironment);
    const writeCall = runCommand.mock.calls.find(([command, args]) =>
      command === "powershell.exe" && String(args.at(-1)).includes("CreateSubKey")
    );
    expect(writeCall?.[1].join(" ")).not.toContain(discoveryEnvironment.MESHRIX_MCP_URL);
    expect(writeCall?.[2]?.env).toMatchObject(discoveryEnvironment);
    expect(await port.remove()).toEqual({ supported: true, persisted: true });
    expect(values).toEqual({ MESHRIX_MCP_OTHER: "preserve" });
  });

  it("reports unsupported Linux persistence without suggesting shell profile edits", async () => {
    const runCommand = vi.fn();
    const port = createDeviceEnvironmentPort({ platform: "linux", runCommand: runCommand as any });

    expect(await port.read()).toEqual({});
    expect(await port.write(discoveryEnvironment)).toEqual({
      supported: false,
      persisted: false,
      reason: "unsupported-platform"
    });
    expect(await port.remove()).toEqual({
      supported: false,
      persisted: false,
      reason: "unsupported-platform"
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects non-owned keys and reports adapter failures with bounded errors", async () => {
    const failedRunner = vi.fn(async () => ({ ok: false, stdout: "", stderr: "private detail" }));
    const port = createDeviceEnvironmentPort({ platform: "darwin", runCommand: failedRunner as any });

    await expect(port.write({ ...discoveryEnvironment, MESHRIX_MCP_TOKEN: "input" }))
      .rejects.toThrow("device_environment_key_not_owned");
    await expect(port.write({ ...discoveryEnvironment, MESHRIX_MCP_URL: 4 }))
      .rejects.toThrow("device_environment_value_invalid");
    expect(failedRunner).not.toHaveBeenCalled();
    await expect(port.write(discoveryEnvironment)).rejects.toThrow("device_environment_write_failed");
    expect(failedRunner).toHaveBeenCalledTimes(1);
  });

  it("honors no-env for register and reset without calling the OS adapter", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-device-environment-"));
    try {
      const discoveryFile = path.join(root, "servers.json");
      const runCommand = vi.fn();
      const environmentPort = createDeviceEnvironmentPort({ platform: process.platform, runCommand: runCommand as any });
      const published = await publishDeviceHubManifest({
        baseUrl: "http://meshrix.test:7228",
        targets: {},
        discoveryPath: discoveryFile,
        publishEnv: false,
        environmentPort
      });
      expect(published.envPublished).toBe(false);
      expect(published.envPersistence.persisted).toBe(false);
      expect(published.envPersistence.reason).toBe("disabled");

      const reset = await resetServerConfig({
        options: { "discovery-file": discoveryFile },
        publishEnv: false,
        environmentPort
      });
      expect(reset.envPublished).toBe(false);
      expect(reset.envPersistence.reason).toBe("disabled");
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps desktop application traversal within the selected root depth", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-scan-depth-"));
    try {
      const expected = path.join(root, "one", "visible.desktop");
      const beyondDepth = path.join(root, "one", "two", "hidden.desktop");
      await fs.mkdir(path.dirname(expected), { recursive: true });
      await fs.mkdir(path.dirname(beyondDepth), { recursive: true });
      await fs.writeFile(expected, "");
      await fs.writeFile(beyondDepth, "");

      const files = await listFilesystemEntries(root, 2, (entry, entryPath) =>
        entry.isFile() && entryPath.endsWith(".desktop")
      );
      expect(files).toEqual([expected]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("MCP installer convergence report", () => {
  it("blocks release readiness when setup fails before any test is recorded", () => {
    expect(summarizeMcpInstallerConvergenceReport({
      tests: [],
      destructiveTests: [],
      executionFailure: { code: "controlled_setup_failure" }
    })).toEqual({
      testCount: 0,
      destructiveTestCount: 0,
      failedCount: 1,
      executionFailureCount: 1,
      releaseReady: false
    });
  });

  it("requires at least one passing test before reporting readiness", () => {
    expect(summarizeMcpInstallerConvergenceReport({
      tests: [{ status: "passed" }],
      destructiveTests: [],
      executionFailure: null
    })).toMatchObject({ failedCount: 0, releaseReady: true });
    expect(summarizeMcpInstallerConvergenceReport({
      tests: [],
      destructiveTests: [],
      executionFailure: null
    })).toMatchObject({ failedCount: 0, releaseReady: false });
  });
});

if (process.platform === "win32" && process.env.MESHRIX_MCP_WINDOWS_REGISTRY_FIXTURE === "1") {
  describe("isolated Windows MCP discovery registry fixture", () => {
    it("writes, reads and removes only owned values under a temporary user registry key", async () => {
      const registrySubkey = `Software\\Meshrix\\Acceptance\\${randomUUID()}`;
      const acceptanceValues = {
        MESHRIX_MCP_URL: "https://meshrix.test.invalid/mcp",
        MESHRIX_MCP_DISCOVERY_URL: "https://meshrix.test.invalid/.well-known/meshrix/mcp.json",
        MESHRIX_MCP_DISCOVERY_FILE: path.win32.join("C:\\MeshrixAcceptance", "servers.json")
      };
      const powershell = async (script: string) => run(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { allowFailure: true }
      );
      const fixtureCommand = async (command: string, args: string[], options: Record<string, any> = {}) => {
        if (command !== "powershell.exe") return { ok: false, stdout: "", stderr: "unexpected-command" };
        const originalScript = String(args.at(-1) || "");
        const scopedScript = originalScript
          .replaceAll("OpenSubKey('Environment'", `OpenSubKey('${registrySubkey}'`)
          .replaceAll("CreateSubKey('Environment'", `CreateSubKey('${registrySubkey}'`);
        if (scopedScript === originalScript) {
          return { ok: false, stdout: "", stderr: "registry-scope-not-applied" };
        }
        return run(command, [...args.slice(0, -1), scopedScript], options);
      };
      const port = createDeviceEnvironmentPort({ platform: "win32", runCommand: fixtureCommand as any });
      try {
        const setup = await powershell([
          "$ErrorActionPreference = 'Stop'",
          `$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${registrySubkey}')`,
          "$key.SetValue('MESHRIX_MCP_ACCEPTANCE_PRESERVE', 'preserve')",
          "$key.Close()"
        ].join("\n"));
        expect(setup.ok).toBe(true);
        expect(await port.write(acceptanceValues)).toEqual({ supported: true, persisted: true });
        expect(await port.read()).toEqual(acceptanceValues);
        expect(await port.remove()).toEqual({ supported: true, persisted: true });
        expect(await port.read()).toEqual({});
        const preserved = await powershell([
          "$ErrorActionPreference = 'Stop'",
          `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${registrySubkey}')`,
          "$value = $key.GetValue('MESHRIX_MCP_ACCEPTANCE_PRESERVE')",
          "$key.Close()",
          "[string]$value"
        ].join("\n"));
        expect(preserved.ok).toBe(true);
        expect(preserved.stdout.trim()).toBe("preserve");
      } finally {
        const cleanup = await powershell([
          "$ErrorActionPreference = 'Stop'",
          `[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${registrySubkey}', $false)`
        ].join("\n"));
        expect(cleanup.ok).toBe(true);
      }
    });
  });
}
