import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const canned1 = "MESHRIX_TEST_CONNECTOR_KEY";
const canned2 = "credential-store";
const canned3 = "https://meshrix.invalid";
const canned4 = "provided";
const canned5 = "WORK_KEY";
const canned6 = "external-reference-unverified";
const canned7 = "";
const canned8 = "OTHER_KEY";


const wire = `mxak1.${"A".repeat(22)}.${"b".repeat(43)}`;
const KEY: any = wire;
const stdinMocks: any = vi.hoisted(() : any => ({ readStdin: vi.fn(async () : Promise<any> => "") }));
const adapterMocks: any = vi.hoisted(() : any => ({
  run: vi.fn(async ({ action }: any) : Promise<any> => ({
    result: action === "install" ? { installed: true, status: "configured" } : { removed: true, installed: false, credentialsPreserved: true },
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
  clientAdapterRegistrationRequest: ({ baseUrl, serverName, credentialRef, client }: any) => ({ baseUrl, serverName, credentialRef, client }),
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
import {
  deleteMcpApiKeyCredential,
  loadMcpApiKeyCredential,
  saveMcpApiKeyCredential
} from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/credential-store.ts";
import { authHeaders, ensureService, resolveApiKey } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/discovery.ts";
import { resolveInstallToken } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/interactive.ts";
import { shellCommandForInstall, commandGuidanceContext, installGuidanceMetadata } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/guidance.ts";
import { installCommand, installSelectedCandidates, installTargets } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/install-command.ts";
import { assertCredentialDestinationBinding, proxyCommand, resolveProxyCredentials, subscribeToMcpUpdates } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/proxy-command.ts";
import { optionsWithStoredBaseUrl, uninstallTargets } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/uninstall-command.ts";
import {
  MCP_INTERFACE_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_STABLE_TOOL_NAME
} from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-constants.ts";



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

      await expect(installCommand({ target: "codex", url: "https://meshrix.invalid" })).rejects.toThrow(credential ? /API Key/iu : /environment reference/iu);
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

  it("rejects unsupported credential targets before filesystem access", async () : Promise<any> => {
    const binding = { target: "../../escaped", baseUrl: "https://meshrix.invalid" };
    await expect(saveMcpApiKeyCredential({ ...binding, token: KEY })).rejects.toThrow(/target and Meshrix.js base URL/iu);
    await expect(loadMcpApiKeyCredential(binding)).rejects.toThrow(/target and Meshrix.js base URL/iu);
    await expect(deleteMcpApiKeyCredential(binding)).rejects.toThrow(/target and Meshrix.js base URL/iu);
    expect(await fs.readdir(credentialDir)).toEqual([]);
  });

  it("reads a stored credential record once and binds it to its original server", async () : Promise<any> => {
    delete process.env.MESHRIX_MCP_TOKEN;
    await saveMcpApiKeyCredential({ target: "pi", baseUrl: "https://meshrix.invalid", token: KEY, autoUpdate: true });
    const readFile = vi.spyOn(fs, "readFile");

    const credentials: any = await resolveProxyCredentials({
      target: "pi",
      url: "https://meshrix.invalid",
      "token-env": canned1
    });

    expect(credentials).toMatchObject({
      tokenSource: canned2,
      credentialBaseUrl: canned3,
      autoUpdate: true
    });
    expect(readFile).toHaveBeenCalledOnce();
    expect(() : any => assertCredentialDestinationBinding(credentials, "https://different.invalid"))
      .toThrow(/bound to a different server/iu);
    expect(() : any => assertCredentialDestinationBinding(credentials, "https://meshrix.invalid")).not.toThrow();
  });

  it.skipIf(process.platform === "win32")("fails credential persistence when private directory permissions cannot be enforced", async () : Promise<any> => {
    const chmod = vi.spyOn(fs, "chmod").mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EPERM" }));
    await expect(saveMcpApiKeyCredential({
      target: "pi",
      baseUrl: "https://meshrix.invalid",
      token: KEY
    })).rejects.toMatchObject({ code: "EPERM" });
    expect(chmod).toHaveBeenCalledOnce();
    expect((await fs.readdir(credentialDir)).filter((name?: any) : any => name.endsWith(".json"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("does not publish a credential when its file mode cannot be enforced", async () : Promise<any> => {
    const chmodFile = fs.chmod;
    let calls = 0;
    const chmod = vi.spyOn(fs, "chmod").mockImplementation(async (filePath?: any, mode?: any) : Promise<any> => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      return chmodFile(filePath, mode);
    });
    await expect(saveMcpApiKeyCredential({
      target: "pi",
      baseUrl: "https://meshrix.invalid",
      token: KEY
    })).rejects.toMatchObject({ code: "EPERM" });
    expect(chmod).toHaveBeenCalledTimes(2);
    expect((await fs.readdir(credentialDir)).filter((name?: any) : any => name.endsWith(".json") || name.endsWith(".tmp"))).toEqual([]);
  });

  it("accepts one strict environment or protected-stdin value and rejects ambiguity", async () : Promise<any> => {
    process.env.MESHRIX_MCP_TOKEN = KEY;
    await expect(resolveProxyCredentials({ target: "codex" })).resolves.toMatchObject({
      target: "codex",
      tokenSource: canned4,
      autoUpdate: false
    });

    delete process.env.MESHRIX_MCP_TOKEN;
    stdinMocks.readStdin.mockResolvedValue(`${KEY}\n`);
    await expect(resolveApiKey({ "token-stdin": true }, { required: true })).resolves.toBe(KEY);

    process.env.MESHRIX_MCP_TOKEN = KEY;
    await expect(resolveApiKey({ "token-stdin": true }, { required: true })).rejects.toThrow(/Ambiguous API Key input/iu);
    expect(stdinMocks.readStdin).toHaveBeenCalledTimes(1);
  });

  it("recognizes Meshrix interface markers independently of the standard serverInfo display name", async () : Promise<any> => {
    const fetchMock: any = vi.fn(async () : Promise<any> => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "complete",
        supportedVersions: [MCP_PROTOCOL_VERSION],
        _meta: {
          "io.modelcontextprotocol/serverInfo": { name: "meshrix-platform", version: "0.1.0-alpha.1" },
          interfaceVersion: MCP_INTERFACE_VERSION,
          stableToolName: MCP_STABLE_TOOL_NAME
        }
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureService("https://meshrix.invalid")).resolves.toMatchObject({ ok: true, status: 200 });
    const request: any = fetchMock.mock.calls[0][1];
    const message: any = JSON.parse(request.body);
    expect(message.method).toBe("server/discover");
    expect(message.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe(MCP_PROTOCOL_VERSION);
  });

  it.each([
    ["unsupported protocol version", { supportedVersions: ["2025-11-25"] }],
    ["wrong Meshrix interface", { _meta: { interfaceVersion: "other", stableToolName: MCP_STABLE_TOOL_NAME } }],
    ["wrong stable outlet", { _meta: { interfaceVersion: MCP_INTERFACE_VERSION, stableToolName: "other" } }]
  ])("rejects an MCP endpoint outside the signed interface contract (%s)", async (_?: any, override: Record<string, any> = {}) : Promise<any> => {
    const standardMeta: any = {
      "io.modelcontextprotocol/serverInfo": { name: "meshrix-platform", version: "0.1.0-alpha.1" },
      interfaceVersion: MCP_INTERFACE_VERSION,
      stableToolName: MCP_STABLE_TOOL_NAME
    };
    const fetchMock: any = vi.fn(async () : Promise<any> => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "complete",
        supportedVersions: override.supportedVersions || [MCP_PROTOCOL_VERSION],
        _meta: { ...standardMeta, ...(override._meta || {}) }
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureService("https://meshrix.invalid")).rejects.toThrow(/MCP is not available/u);
  });

  it("registers a native reference without creating credentials and preserves optional proxy credentials on uninstall", async () : Promise<any> => {
    const discoveryFile: any = path.join(credentialDir, "discovery.json");
    vi.stubGlobal("fetch", vi.fn(async () : Promise<any> => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "complete",
        supportedVersions: [MCP_PROTOCOL_VERSION],
        _meta: {
          "io.modelcontextprotocol/serverInfo": { name: "meshrix-platform", version: "0.1.0-alpha.1" },
          interfaceVersion: MCP_INTERFACE_VERSION,
          stableToolName: MCP_STABLE_TOOL_NAME
        }
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await saveMcpApiKeyCredential({ target: "pi", baseUrl: "https://meshrix.invalid", token: KEY, autoUpdate: true });
    const filesBefore = await fs.readdir(credentialDir);
    const credentialFile = filesBefore.find((name) => name.startsWith("pi-"))!;
    const credentialBefore = await fs.readFile(path.join(credentialDir, credentialFile), "utf8");
    const independentTarget = { status: "configured", credentialRef: { kind: "env", name: "WORK_KEY" } };
    await fs.writeFile(discoveryFile, JSON.stringify({ servers: {
      independent: { httpUrl: "https://other.invalid/mcp" },
      work: { targets: { "independent-client": independentTarget } }
    } }));
    await expect(installTargets({
      options: {
        url: "https://meshrix.invalid", "server-name": "work", "token-env": canned5,
        "client-command": "test-client", "discovery-file": discoveryFile, "no-verify": true
      },
      targets: ["pi", "kimi"], token: KEY, tokenInfo: { source: "environment" }
    })).resolves.toMatchObject({
      ok: false,
      installed: {
        pi: { credentialStored: false, environmentProvisioned: false, credentialStatus: canned6, connectivity: "not-run" },
        kimi: { ok: false, status: "unsupported", errorCode: "unsupported_protected_header_reference" }
      }
    });
    expect((await fs.readdir(credentialDir)).sort()).toEqual([...filesBefore, "discovery.json"].sort());
    const discovery = await fs.readFile(discoveryFile, "utf8");
    expect(discovery).not.toContain(KEY);
    expect(JSON.parse(discovery).servers.independent.httpUrl).toBe("https://other.invalid/mcp");
    expect(JSON.parse(discovery).servers.work.auth.tokenEnv).toBe("WORK_KEY");
    expect(JSON.parse(discovery).servers.work.targets["independent-client"]).toEqual(independentTarget);
    expect(JSON.stringify(adapterMocks.run.mock.calls)).not.toContain(KEY);
    expect(adapterMocks.run).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ serverName: "work", credentialRef: { kind: "env", name: "WORK_KEY" } }) }));

    delete process.env.MESHRIX_MCP_TOKEN;
    await expect(resolveProxyCredentials({
      target: "pi",
      url: "https://meshrix.invalid",
      "discovery-file": discoveryFile
    })).resolves.toMatchObject({
      target: "pi",
      tokenSource: canned2,
      autoUpdate: true
    });

    await expect(uninstallTargets({
      options: await optionsWithStoredBaseUrl({
        url: "https://meshrix.invalid",
        "server-name": "work",
        "client-command": "test-client",
        "discovery-file": discoveryFile
      }),
      targets: ["pi"]
    })).resolves.toMatchObject({ ok: true });
    await expect(resolveProxyCredentials({
      target: "pi",
      url: "https://meshrix.invalid",
      "discovery-file": discoveryFile
    })).resolves.toMatchObject({ tokenSource: canned2, autoUpdate: true });
    expect(await fs.readFile(path.join(credentialDir, credentialFile), "utf8")).toBe(credentialBefore);
    expect(JSON.parse(await fs.readFile(discoveryFile, "utf8")).servers.work.targets["independent-client"]).toEqual(independentTarget);
  });

  it("refuses stdin handoff and unsupported clients before discovery or target mutation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(installCommand({ target: "pi", "token-stdin": true })).rejects.toMatchObject({ code: "credential_handoff_required" });
    const result = await installTargets({ options: { url: "https://meshrix.invalid", "token-env": canned5 }, targets: ["kimi", "antigravity"], token: canned7 });
    expect(result.ok).toBe(false);
    for (const target of ["kimi", "antigravity"]) expect(result.installed[target]).toMatchObject({ status: "unsupported", errorCode: "unsupported_protected_header_reference" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(adapterMocks.run).not.toHaveBeenCalled();
  });

  it("resolves only the selected registration's endpoint and reference, including URL prefixes", async () => {
    const discoveryFile = path.join(credentialDir, "discovery.json");
    await fs.writeFile(discoveryFile, JSON.stringify({ servers: {
      work: { httpUrl: "https://meshrix.invalid/team/mcp", auth: { tokenEnv: canned5 } },
      lico: { httpUrl: "https://other.invalid/mcp", auth: { tokenEnv: canned8 } }
    } }));
    const options = { "server-name": "work", "discovery-file": discoveryFile };
    await expect(optionsWithStoredBaseUrl(options)).resolves.toMatchObject({ "resolved-url": "https://meshrix.invalid/team", "token-env": canned5 });
    const explicit = await optionsWithStoredBaseUrl({ ...options, url: "https://different.invalid" });
    expect(explicit).not.toHaveProperty("resolved-url");
    expect(explicit).not.toHaveProperty("token-env");
  });

  it("refuses a conflicting local identity record before service or configuration writes", async () => {
    const discoveryFile = path.join(credentialDir, "discovery.json");
    const original = JSON.stringify({ servers: { work: { httpUrl: "https://other.invalid/mcp", auth: { tokenEnv: canned8 } } } });
    await fs.writeFile(discoveryFile, original);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await installTargets({ options: { url: "https://meshrix.invalid", "server-name": "work", "token-env": canned5, "discovery-file": discoveryFile }, targets: ["pi"], token: canned7 });
    expect(result.installed.pi).toMatchObject({ ok: false, errorCode: "registration_conflict" });
    expect(await fs.readFile(discoveryFile, "utf8")).toBe(original);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(adapterMocks.run).not.toHaveBeenCalled();
  });

  it("opens one filtered subscription for an opted-in connector and only forwards update notifications", async () : Promise<any> => {
    const controller: any = new AbortController();
    const received: any[] = [];
    const dispatcher: any = { close: vi.fn(async () : Promise<any> => {}), destroy: vi.fn(async () : Promise<any> => {}) };
    const dispatcherFactory: any = vi.fn((options?: any) : any => {
      expect(options).toEqual({ connectTimeout: 0, headersTimeout: 0, bodyTimeout: 0 });
      return dispatcher;
    });
    const fetchMock: any = vi.fn(async (_url?: any, init?: any) : Promise<any> => {
      const request: any = JSON.parse(init.body);
      expect(request.method).toBe("subscriptions/listen");
      expect(request.params.notifications).toEqual({
        toolsListChanged: true,
        meshrixSkillHubCatalogChanged: true,
        meshrixUpdateAvailable: true
      });
      expect(request.id).toBe("meshrix-auto-update-subscription");
      return new Response([
        "event: message\r\n",
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: {
            notifications: request.params.notifications,
            _meta: { "io.modelcontextprotocol/subscriptionId": request.id }
          }
        })}\r\n\r\n`,
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
      dispatcherFactory,
      onNotification(notification?: any) : any {
        received.push(notification);
        controller.abort();
      }
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(dispatcher);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
    expect(received).toHaveLength(1);
    expect(received[0].params).toEqual({ revision: 4, command: "must-not-run" });
    expect(dispatcher.destroy).toHaveBeenCalledOnce();
    expect(dispatcher.close).not.toHaveBeenCalled();
  });

  it("uses only the API Key credential header over HTTPS or literal loopback HTTP", () : any => {
    const headers: any = authHeaders(KEY, "codex", "https://meshrix.invalid");
    expect(headers["X-Meshrix.js-Api-Key"]).toBe(KEY);
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers).not.toHaveProperty("x-meshrix-tool-token");
    expect(Object.keys(headers).some((name?: any) : any => /claim|signature|verification/iu.test(name))).toBe(false);
    expect(() : any => authHeaders(KEY, "codex", "http://meshrix.invalid")).toThrow(/require HTTPS/iu);
    expect(authHeaders(KEY, "codex", "http://127.0.0.1:7228")["X-Meshrix.js-Api-Key"]).toBe(KEY);
  });

  it("accepts an unresolved explicit reference and keeps registration identity in guidance", async () => {
    delete process.env.MESHRIX_MCP_TOKEN;
    const parsed = parseArgs(["install", "--target", "pi", "--server-name", "work", "--token-env", "MESHRIX_MCP_TOKEN", "--client-config", "fixture.json"]);
    expect(parsed.options).toMatchObject({ "server-name": "work", "client-config": "fixture.json" });
    await expect(resolveInstallToken(parsed.options)).resolves.toMatchObject({ token: canned7, credentialRef: { kind: "env", name: "MESHRIX_MCP_TOKEN" } });
    const command = shellCommandForInstall({ ...commandGuidanceContext(parsed.options), target: "pi" });
    expect(command).toContain("--server-name 'work'");
    expect(command).toContain("--token-env 'MESHRIX_MCP_TOKEN'");
    expect(command).not.toContain("--token-stdin");
    expect(commandGuidanceContext({}).serverName).toBe("lico");
    const guidance = installGuidanceMetadata();
    expect(guidance.priorityTargets).not.toContain("kimi");
    expect(guidance.priorityTargets).not.toContain("antigravity");
  });

  it("retains one failed service check across selected clients instead of repeating the request", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await installSelectedCandidates({
      options: { url: "https://meshrix.invalid", "discovery-file": path.join(credentialDir, "discovery.json"), "token-env": canned5, "no-verify": true },
      selected: ["pi", "codex"].map((target) => ({ target, id: target })), tokenInfo: { token: canned7, source: "environment-reference" }
    });
    expect(result.ok).toBe(false);
    expect(result.partials).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(adapterMocks.run).not.toHaveBeenCalled();
  });

  it("rejects unsupported options through the generic parser", () : any => {
    expect(() : any => parseArgs(["install", "--unsupported-option"])).toThrow(/Unknown option/iu);
  });

  it("uninstalls locally without reading a key or contacting the server", async () : Promise<any> => {
    delete process.env.MESHRIX_MCP_TOKEN;
    const fetchMock: any = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(uninstallTargets({
      options: { url: "https://meshrix.invalid", "client-command": "test-client", "discovery-file": path.join(credentialDir, "discovery.json") },
      targets: ["codex"]
    })).resolves.toMatchObject({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(adapterMocks.run).toHaveBeenCalledTimes(1);
    expect(adapterMocks.writeUninstall).toHaveBeenCalledTimes(1);
  });
});
