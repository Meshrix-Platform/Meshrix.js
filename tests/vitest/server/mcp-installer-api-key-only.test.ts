import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { installCommand, installTargets } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/install-command.ts";
import { proxyCommand, resolveProxyCredentials, subscribeToMcpUpdates } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/proxy-command.ts";
import { uninstallTargets } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/uninstall-command.ts";

const originalToken: any = process.env.MESHRIX_MCP_TOKEN;
const originalCredentialDir: any = process.env.MESHRIX_MCP_CREDENTIAL_DIR;
let credentialDir: any = "";

beforeEach(async () : Promise<any> => {
  credentialDir = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-credentials-"));
  process.env.MESHRIX_MCP_CREDENTIAL_DIR = credentialDir;
});

afterEach(async () : Promise<any> => {
  vi.restoreAllMocks();
  stdinMocks.readStdin.mockReset().mockResolvedValue("");
  adapterMocks.run.mockClear();
  adapterMocks.resolve.mockClear();
  adapterMocks.writeUninstall.mockClear();
  if (originalToken === undefined) delete process.env.MESHRIX_MCP_TOKEN;
  else process.env.MESHRIX_MCP_TOKEN = originalToken;
  if (originalCredentialDir === undefined) delete process.env.MESHRIX_MCP_CREDENTIAL_DIR;
  else process.env.MESHRIX_MCP_CREDENTIAL_DIR = originalCredentialDir;
  await fs.rm(credentialDir, { recursive: true, force: true });
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
      tokenSource: "provided",
      autoUpdate: false
    });

    delete process.env.MESHRIX_MCP_TOKEN;
    stdinMocks.readStdin.mockResolvedValue(`${KEY}\n`);
    await expect(resolveApiKey({ "token-stdin": true }, { required: true })).resolves.toBe(KEY);

    process.env.MESHRIX_MCP_TOKEN = KEY;
    await expect(resolveApiKey({ "token-stdin": true }, { required: true })).rejects.toThrow(/Ambiguous API Key input/iu);
    expect(stdinMocks.readStdin).toHaveBeenCalledTimes(1);
  });

  it("persists an installed target credential for proxy startup and deletes it on uninstall", async () : Promise<any> => {
    const discoveryFile: any = path.join(credentialDir, "discovery.json");
    vi.stubGlobal("fetch", vi.fn(async () : Promise<any> => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "Meshrix.js" } }
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(installTargets({
      options: {
        url: "https://meshrix.invalid",
        "client-command": "test-client",
        "discovery-file": discoveryFile,
        "no-verify": true,
        __meshrixAutoUpdate: true
      },
      targets: ["pi"],
      token: KEY,
      tokenInfo: { source: "protected-stdin" }
    })).resolves.toMatchObject({
      ok: true,
      installed: { pi: { credentialStored: true } }
    });
    const credentialFile: any = (await fs.readdir(credentialDir)).find((name?: any) : any => name.startsWith("pi-"));
    expect(credentialFile).toBeTruthy();
    const credentialStat: any = await fs.stat(path.join(credentialDir, credentialFile));
    if (process.platform !== "win32") expect(credentialStat.mode & 0o777).toBe(0o600);
    expect(await fs.readFile(discoveryFile, "utf8")).not.toContain(KEY);

    delete process.env.MESHRIX_MCP_TOKEN;
    await expect(resolveProxyCredentials({
      target: "pi",
      url: "https://meshrix.invalid",
      "discovery-file": discoveryFile
    })).resolves.toMatchObject({
      target: "pi",
      tokenSource: "credential-store",
      autoUpdate: true
    });

    await expect(uninstallTargets({
      options: {
        url: "https://meshrix.invalid",
        "client-command": "test-client",
        "discovery-file": discoveryFile
      },
      targets: ["pi"]
    })).resolves.toMatchObject({ ok: true });
    await expect(resolveProxyCredentials({
      target: "pi",
      url: "https://meshrix.invalid",
      "discovery-file": discoveryFile
    })).rejects.toThrow(/Missing API Key/iu);
  });

  it("opens one filtered subscription for an opted-in connector and only forwards update notifications", async () : Promise<any> => {
    const controller: any = new AbortController();
    const received: any[] = [];
    const fetchMock: any = vi.fn(async (_url?: any, init?: any) : Promise<any> => {
      const request: any = JSON.parse(init.body);
      expect(request.method).toBe("subscriptions/listen");
      expect(request.params.notifications).toEqual([
        "notifications/tools/list_changed",
        "notifications/meshrix/skill_hub/catalog_changed",
        "notifications/meshrix/update_available"
      ]);
      return new Response([
        "event: message\r\n",
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/meshrix/skill_hub/catalog_changed", params: { revision: 4, command: "must-not-run" } })}\r\n\r\n`
      ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    await subscribeToMcpUpdates({
      baseUrl: "https://meshrix.invalid",
      token: KEY,
      target: "codex",
      proxySessionId: "abcdefghijklmnopqrstuvwx",
      signal: controller.signal,
      fetchImpl: fetchMock,
      onNotification(notification?: any) : any {
        received.push(notification);
        controller.abort();
      }
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(received).toHaveLength(1);
    expect(received[0].params).toEqual({ revision: 4, command: "must-not-run" });
  });

  it("uses only the API Key credential header", () : any => {
    const headers: any = authHeaders(KEY, "codex");
    expect(headers["X-Meshrix.js-Api-Key"]).toBe(KEY);
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
