import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const packageName = "@meshrix/agent-codex-adapter";
const version = "0.0.1";
const runnerMocks: any = vi.hoisted(() => ({
  runInstallCommand: vi.fn(),
  trustedIntegrity: "sha512-trusted-adapter-integrity",
  viewOutput: ""
}));

vi.mock("../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/connector-process.ts", async (importOriginal?: any) : Promise<any> => ({
  ...(await importOriginal()),
  runInstallCommand: runnerMocks.runInstallCommand
}));
vi.mock("../../../packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts", async (importOriginal?: any) : Promise<any> => {
  const original: any = await importOriginal();
  return {
    ...original,
    mcpClientAdapterForTarget(target?: any) : any {
      const adapter: any = original.mcpClientAdapterForTarget(target);
      return adapter ? { ...adapter, integrity: runnerMocks.trustedIntegrity } : adapter;
    }
  };
});

import { acquireClientAdapter } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/client-adapter-runner.ts";

let cacheRoot = "";

beforeEach(async () : Promise<void> => {
  cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-client-adapter-runner-"));
  runnerMocks.viewOutput = "";
  runnerMocks.runInstallCommand.mockReset().mockImplementation(async (_command?: any, args?: any[]) : Promise<any> => {
    if (args?.[0] === "view") return { stdout: runnerMocks.viewOutput, stderr: "" };
    if (args?.[0] === "install") {
      const prefix: any = args[args.indexOf("--prefix") + 1];
      const installedPackage: any = path.join(prefix, "node_modules", "@meshrix", "agent-codex-adapter");
      await fs.mkdir(installedPackage, { recursive: true });
      await fs.writeFile(path.join(installedPackage, "package.json"), `${JSON.stringify({ name: packageName, version })}\n`);
      await fs.writeFile(path.join(installedPackage, "adapter.mjs"), "export {};\n");
      return { stdout: "", stderr: "" };
    }
    throw new Error("unexpected_client_adapter_command");
  });
});

afterEach(async () : Promise<void> => {
  await fs.rm(cacheRoot, { recursive: true, force: true });
});

describe("published client-adapter runner npm integrity lookup", () : any => {
  it.each([
    ["legacy scalar", JSON.stringify(runnerMocks.trustedIntegrity)],
    ["npm 12 single-result array", JSON.stringify([runnerMocks.trustedIntegrity])]
  ])("installs after accepting %s output", async (_label?: any, output?: any) : Promise<void> => {
    runnerMocks.viewOutput = output;

    const result: any = await acquireClientAdapter({ target: "codex", cacheRoot });

    expect(result.adapter.integrity).toBe(runnerMocks.trustedIntegrity);
    expect(runnerMocks.runInstallCommand.mock.calls.map(([command, args]: any[]) : any => args[0]))
      .toEqual(["view", "install"]);
    expect(runnerMocks.runInstallCommand.mock.calls[0][1].slice(0, 4)).toEqual([
      "view",
      `${packageName}@${version}`,
      "dist.integrity",
      "--json"
    ]);
  });

  it.each([
    ["a different exact-coordinate value", JSON.stringify("sha512-other-integrity")],
    ["multiple exact-coordinate results", JSON.stringify([runnerMocks.trustedIntegrity, runnerMocks.trustedIntegrity])]
  ])("rejects %s before installation", async (_label?: any, output?: any) : Promise<void> => {
    runnerMocks.viewOutput = output;

    await expect(acquireClientAdapter({ target: "codex", cacheRoot }))
      .rejects.toMatchObject({ code: "CLIENT_ADAPTER_INTEGRITY_MISMATCH" });
    expect(runnerMocks.runInstallCommand.mock.calls.map(([command, args]: any[]) : any => args[0]))
      .toEqual(["view"]);
  });
});
