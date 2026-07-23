import { describe, expect, it } from "vitest";

import { releaseManifest } from "../../../tools/server-scripts/lib/mcp-release-manifest.mjs";
import { MCP_SUPPORTED_TARGETS } from "../../../packages/protocols/mcp/adapter/mcp-release-targets.mjs";

function bootstrapFixture() {
  const localized = {
    scriptName: "lico-mcp-install.zh-CN.sh",
    sha256: "b".repeat(64),
    githubLatestUrl: "https://example.invalid/installer-zh",
    oneLineCommand: "./lico-mcp-install.zh-CN.sh",
    oneLineClientInstallJsonCommand: "./lico-mcp-install.zh-CN.sh --target <client> --json",
    oneLineAutoInstallCommand: "./lico-mcp-install.zh-CN.sh --target auto --json",
    oneLinePriorityInstallCommand: "./lico-mcp-install.zh-CN.sh --target codex --json",
    uninstallScriptName: "lico-mcp-uninstall.zh-CN.sh",
    uninstallSha256: "c".repeat(64),
    githubLatestUninstallUrl: "https://example.invalid/uninstaller-zh",
    oneLineUninstallCommand: "./lico-mcp-uninstall.zh-CN.sh",
  };
  return {
    scriptName: "lico-mcp-install.sh",
    sha256: "d".repeat(64),
    githubLatestUrl: "https://example.invalid/installer",
    oneLineCommand: "./lico-mcp-install.sh",
    oneLineClientInstallJsonCommand: "./lico-mcp-install.sh --target <client> --json",
    oneLineAutoInstallCommand: "./lico-mcp-install.sh --target auto --json",
    oneLinePriorityInstallCommand: "./lico-mcp-install.sh --target codex --json",
    uninstallScriptName: "lico-mcp-uninstall.sh",
    uninstallSha256: "e".repeat(64),
    githubLatestUninstallUrl: "https://example.invalid/uninstaller",
    oneLineUninstallCommand: "./lico-mcp-uninstall.sh",
    windowsScriptName: "lico-mcp-install.ps1",
    windowsSha256: "f".repeat(64),
    windowsGithubLatestUrl: "https://example.invalid/installer-windows",
    windowsUninstallScriptName: "lico-mcp-uninstall.ps1",
    windowsUninstallSha256: "a".repeat(64),
    windowsGithubLatestUninstallUrl: "https://example.invalid/uninstaller-windows",
    localized: { zhCN: localized },
  };
}

describe("MCP release manifest", () => {
  it("projects canonical target details without a late runtime reference failure", () => {
    const input = {
      channel: "stable",
      packageJson: {
        name: "lico-mcp-connector",
        version: "0.0.1",
        engines: { node: "^22.0.0 || ^24.0.0" },
      },
      tarballName: "lico-mcp-connector-0.0.1.tgz",
      checksum: "1".repeat(64),
      sizeBytes: 100,
      portables: [{
        platform: "macos-arm64",
        archiveName: "lico-mcp-connector-0.0.1-macos-arm64.tar.gz",
        sha256: "2".repeat(64),
        sizeBytes: 200,
        zipArchiveName: "lico-mcp-connector-0.0.1-macos-arm64.zip",
        zipSha256: "3".repeat(64),
        zipSizeBytes: 220,
        executable: "lico-mcp",
        includesNodeRuntime: true,
        bundledNodeVersion: "24.16.0",
        nodeRuntimeLockPath: "licenses/node/NODE_RUNTIME.lock.json",
      }],
      bootstrap: bootstrapFixture(),
      generatedAt: "2026-01-02T03:04:05.000Z",
    };
    const manifest = releaseManifest(input);

    expect(manifest.portable.supportedTargetDetails.map(({ target }) => target))
      .toEqual(MCP_SUPPORTED_TARGETS);
    expect(manifest.install.supportedTargetDetails.map(({ target }) => target))
      .toEqual(MCP_SUPPORTED_TARGETS);
    expect(manifest.install.supportedTargetDetails.every(({ locations }) =>
      locations.length === 1 && locations[0] === "local"
    )).toBe(true);
    expect(releaseManifest(input)).toEqual(manifest);
  });
});
