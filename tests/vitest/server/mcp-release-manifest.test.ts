import { describe, expect, it } from "vitest";

import { releaseManifest } from "../../../tools/server-scripts/lib/mcp-release-manifest.ts";
import { MCP_SUPPORTED_TARGETS } from "../../../packages/protocols/mcp/adapter/mcp-release-targets.ts";

function manifestInput(): Record<string, any> {
  return {
    channel: "stable",
    packageJson: {
      name: "meshrix.js",
      version: "0.0.1",
      engines: { node: ">=22.19.0 <23 || >=24.3.0 <25" }
    },
    tarballName: "meshrix.js-0.0.1.tgz",
    npmIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    checksum: "1".repeat(64),
    sizeBytes: 100,
    portables: [{
      platform: "macos-arm64",
      archiveName: "meshrix-mcp-connector-0.0.1-macos-arm64.tar.gz",
      sha256: "2".repeat(64),
      sizeBytes: 200,
      zipArchiveName: "meshrix-mcp-connector-0.0.1-macos-arm64.zip",
      zipSha256: "3".repeat(64),
      zipSizeBytes: 220,
      executable: "meshrix-mcp",
      includesNodeRuntime: true,
      bundledNodeVersion: "24.16.0",
      nodeRuntimeLockPath: "licenses/node/NODE_RUNTIME.lock.json"
    }],
    generatedAt: "2026-01-02T03:04:05.000Z"
  };
}

describe("MCP release manifest", () => {
  it("publishes the npm CLI contract and only generated portable assets", () => {
    const input = manifestInput();
    const manifest = releaseManifest(input);

    expect(manifest.portable.supportedTargetDetails.map(({ target }: Record<string, any>) => target))
      .toEqual(MCP_SUPPORTED_TARGETS);
    expect(manifest.install.supportedTargetDetails.map(({ target }: Record<string, any>) => target))
      .toEqual(MCP_SUPPORTED_TARGETS);
    expect(manifest.connector).toMatchObject({
      packageName: "meshrix.js",
      tarball: "meshrix.js-0.0.1.tgz",
      npmIntegrity: input.npmIntegrity,
      userDeviceInstaller: "node-bin"
    });
    expect(manifest.install.registryCommand)
      .toBe("npx --yes --package meshrix.js@0.0.1 meshrix-mcp install");
    expect(manifest.portable.artifacts[0]).toMatchObject({
      platform: "macos-arm64",
      launcher: "meshrix-mcp",
      archive: "meshrix-mcp-connector-0.0.1-macos-arm64.tar.gz",
      zipArchive: "meshrix-mcp-connector-0.0.1-macos-arm64.zip",
      includesNodeRuntime: true
    });
    expect(manifest.publish.releaseFiles).toEqual([
      "meshrix.js-0.0.1.tgz",
      "meshrix-mcp-connector-0.0.1-macos-arm64.tar.gz",
      "meshrix-mcp-connector-0.0.1-macos-arm64.zip",
      "SHA256SUMS",
      "RELEASE_SHA256SUMS",
      "RELEASE_SHA256SUMS.sigstore.json",
      "meshrix-mcp-release.json",
      "latest.json"
    ]);
    expect(JSON.stringify(manifest)).not.toMatch(/meshrix-mcp-install|meshrix-mcp-uninstall|\/bin\/sh|githubOneLine|bootstrap/i);
    expect(releaseManifest(input)).toEqual(manifest);
  });
});
