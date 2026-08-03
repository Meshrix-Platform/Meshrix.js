import { afterEach, describe, expect, it, vi } from "vitest";

const KEY: any = `mxak1.${"A".repeat(22)}.${"b".repeat(43)}`;
const stdinMocks: any = vi.hoisted(() : any => ({ readStdin: vi.fn(async () : Promise<any> => "") }));
const adapterMocks: any = vi.hoisted(() : any => ({
  run: vi.fn(async () : Promise<any> => ({
    result: { removed: true },
    adapter: { coordinate: "@meshrix/test-adapter@0.0.1" },
    cache: { hit: true }
  })),
  resolve: vi.fn(async (_target?: any, _settings?: any, client?: any) : Promise<any> => ({ command: client.command || "test-client" })),
  writeUninstall: vi.fn(async () : Promise<any> => "<discovery-manifest>")
}));

vi.mock("../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/connector-process.ts", async (importOriginal?: any) : Promise<any> => ({
  ...(await importOriginal()),
  readStdin: stdinMocks.readStdin
}));
vi.mock("../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/client-adapter-runner.ts", async (importOriginal?: any) : Promise<any> => ({
  ...(await importOriginal()),
  clientAdapterConnectorRequest: (value?: any) : any => value,
  runClientAdapter: adapterMocks.run
}));
vi.mock("../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/scan-candidates.ts", async (importOriginal?: any) : Promise<any> => ({
  ...(await importOriginal()),
  resolveClientAdapterForTarget: adapterMocks.resolve
}));
vi.mock("../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/device-config.ts", async (importOriginal?: any) : Promise<any> => ({
  ...(await importOriginal()),
  writeDeviceUninstall: adapterMocks.writeUninstall
}));

import { parseArgs } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/basic-utils.ts";
import { authHeaders, resolveApiKey } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/discovery.ts";
import { installCommand } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/install-command.ts";
import { proxyCommand, resolveProxyCredentials } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/proxy-command.ts";
import { uninstallTargets } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/uninstall-command.ts";

const originalToken: any = process.env.MESHRIX_MCP_TOKEN;

afterEach(() : any => {
  vi.restoreAllMocks();
  stdinMocks.readStdin.mockReset().mockResolvedValue("");
  adapterMocks.run.mockClear();
  adapterMocks.resolve.mockClear();
  adapterMocks.writeUninstall.mockClear();
  if (originalToken === undefined) delete process.env.MESHRIX_MCP_TOKEN;
  else process.env.MESHRIX_MCP_TOKEN = originalToken;
});

describe("MCP installer API Key-only input", () : any => {
  it.each(["", "legacy-credential", `mxak1.${"A".repeat(21)}.${"b".repeat(43)}`])(
    "rejects missing or malformed input before install discovery: %s",
    async (credential?: any) : Promise<any> => {
      if (credential) process.env.MESHRIX_MCP_TOKEN = credential;
      else delete process.env.MESHRIX_MCP_TOKEN;
      const fetchMock: any = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(installCommand({ target: "codex", url: "https://meshrix.invalid" })).rejects.toThrow(/API Key/iu);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(adapterMocks.resolve).not.toHaveBeenCalled();
      expect(adapterMocks.run).not.toHaveBeenCalled();
    }
  );

  it("rejects proxy startup before discovery when no key is configured", async () : Promise<any> => {
    delete process.env.MESHRIX_MCP_TOKEN;
    const fetchMock: any = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(proxyCommand({ target: "codex", url: "https://meshrix.invalid" })).rejects.toThrow(/Missing API Key/iu);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts one strict environment or protected-stdin value and rejects ambiguity", async () : Promise<any> => {
    process.env.MESHRIX_MCP_TOKEN = KEY;
    await expect(resolveProxyCredentials({ target: "codex" })).resolves.toMatchObject({
      target: "codex",
      tokenSource: "provided"
    });

    delete process.env.MESHRIX_MCP_TOKEN;
    stdinMocks.readStdin.mockResolvedValue(`${KEY}\n`);
    await expect(resolveApiKey({ "token-stdin": true }, { required: true })).resolves.toBe(KEY);

    process.env.MESHRIX_MCP_TOKEN = KEY;
    await expect(resolveApiKey({ "token-stdin": true }, { required: true })).rejects.toThrow(/Ambiguous API Key input/iu);
    expect(stdinMocks.readStdin).toHaveBeenCalledTimes(1);
  });

  it("uses only the API Key credential header", () : any => {
    const headers: any = authHeaders(KEY, "codex");
    expect(headers["X-Meshrix-Api-Key"]).toBe(KEY);
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers).not.toHaveProperty("x-meshrix-tool-token");
    expect(Object.keys(headers).some((name?: any) : any => /claim|signature|verification/iu.test(name))).toBe(false);
  });

  it("rejects unsupported options through the generic parser", () : any => {
    expect(() : any => parseArgs(["install", "--unsupported-option"])).toThrow(/Unknown option/iu);
  });

  it("uninstalls locally without reading a key or contacting the server", async () : Promise<any> => {
    delete process.env.MESHRIX_MCP_TOKEN;
    const fetchMock: any = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(uninstallTargets({
      options: { url: "https://meshrix.invalid", "client-command": "test-client" },
      targets: ["codex"]
    })).resolves.toMatchObject({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(adapterMocks.run).toHaveBeenCalledTimes(1);
    expect(adapterMocks.writeUninstall).toHaveBeenCalledTimes(1);
  });
});
