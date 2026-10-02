import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  describeClientAdapter,
  resolveInstalledClientAdapter
} from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/client-adapter-runner.ts";
import { MCP_SUPPORTED_TARGETS, mcpClientAdapterForTarget } from "../../../packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts";

let fixtureRoot = "";

afterEach(async () : Promise<void> => {
  if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = "";
});

describe("installed first-party client adapter resolution", () : any => {
  it("resolves and validates each adapter shipped with the root product", async () : Promise<void> => {
    for (const target of MCP_SUPPORTED_TARGETS) {
      const resolved: any = await resolveInstalledClientAdapter({ target });
      const trusted: any = mcpClientAdapterForTarget(target);
      expect(resolved.adapter).toMatchObject({
        packageName: trusted.packageName,
        version: trusted.version,
        source: "meshrix-root-bundle"
      });
      expect(path.relative(resolved.packageRoot, resolved.entrypoint)).toBe(trusted.entrypoint);

      const described: any = await describeClientAdapter({ target });
      expect(described.result).toMatchObject({
        target,
        packageName: trusted.packageName,
        version: trusted.version,
        protocol: trusted.protocol
      });
    }
  });

  it("fails closed when the target or installed component is unavailable", async () : Promise<void> => {
    await expect(resolveInstalledClientAdapter({ target: "untrusted" }))
      .rejects.toMatchObject({ code: "CLIENT_ADAPTER_TARGET_UNSUPPORTED" });
    await expect(resolveInstalledClientAdapter({ target: "codex", resolveModule: () => { throw new Error("missing"); } }))
      .rejects.toMatchObject({ code: "CLIENT_ADAPTER_PACKAGE_MISSING" });
  });

  it("rejects an installed package whose identity or synchronized release version differs", async () : Promise<void> => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-client-component-"));
    const packageRoot: any = path.join(fixtureRoot, "node_modules", "@meshrix", "agent-codex-adapter");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "@meshrix/agent-codex-adapter",
      version: "9.9.9"
    }));
    await fs.writeFile(path.join(packageRoot, "adapter.mjs"), "export {};\n");
    const resolveModule: any = () => pathToFileURL(path.join(packageRoot, "adapter.mjs")).href;

    await expect(resolveInstalledClientAdapter({ target: "codex", resolveModule }))
      .rejects.toMatchObject({ code: "CLIENT_ADAPTER_PACKAGE_MISMATCH" });
    await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "@meshrix/wrong-adapter",
      version: "0.0.1"
    }));
    await expect(resolveInstalledClientAdapter({ target: "codex", resolveModule }))
      .rejects.toMatchObject({ code: "CLIENT_ADAPTER_PACKAGE_MISMATCH" });
  });
});
