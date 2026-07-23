import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { stableStringify } from "../../../packages/protocols/mcp/adapter/mcp-identity.mjs";

const processIdentityStoreMocks = vi.hoisted(() => ({
  deleteProcessIdentity: vi.fn(async () => {}),
  loadProcessIdentity: vi.fn(async () => null),
  saveProcessIdentity: vi.fn(async () => ({
    filePath: "<process-identity-path>",
    reference: "<process-identity-ref>",
    storageBackend: "test"
  }))
}));
const uninstallAdapterMocks = vi.hoisted(() => ({
  runClientAdapter: vi.fn(async ({ action }) => ({
    result: action === "uninstall" ? { removed: true, installed: false } : { installed: true },
    adapter: { coordinate: "@licomesh/agent-codex-adapter@0.0.1" },
    cache: { hit: true }
  })),
  describeClientAdapter: vi.fn(async () => ({
    result: { commandNames: ["node"] },
    adapter: { coordinate: "@licomesh/agent-codex-adapter@0.0.1" },
    cache: { hit: true }
  })),
  writeDeviceDiscovery: vi.fn(async () => "<discovery-manifest>"),
  writeDeviceUninstall: vi.fn(async () => "<discovery-manifest>")
}));
const verifierAuthMocks = vi.hoisted(() => ({
  auth: { cookie: "console-session-cookie", csrf: "console-csrf-token" },
  installAuthenticatedFetch: vi.fn(),
  installedAuthFor: vi.fn()
}));

vi.mock("../../../packages/protocols/mcp/adapter/gateway-installer/lib/process-identity-store.mjs", () =>
  processIdentityStoreMocks
);
vi.mock("../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/client-adapter-runner.mjs", () => ({
  clientAdapterConnectorRequest: (value) => value,
  defaultClientAdapterCacheRoot: () => "<adapter-cache>",
  describeClientAdapter: uninstallAdapterMocks.describeClientAdapter,
  runClientAdapter: uninstallAdapterMocks.runClientAdapter
}));
vi.mock("../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/device-config.mjs", () => ({
  writeDeviceDiscovery: uninstallAdapterMocks.writeDeviceDiscovery,
  writeDeviceUninstall: uninstallAdapterMocks.writeDeviceUninstall,
  writeServerConfigProfile: vi.fn(async () => ({}))
}));
vi.mock("../../../tools/server-scripts/test-auth-helper.mjs", () => ({
  authHeaders: () => ({
    Cookie: verifierAuthMocks.auth.cookie,
    "x-lico-csrf": verifierAuthMocks.auth.csrf,
    "x-lico-safety-confirm": "true"
  }),
  installAuthenticatedFetch: verifierAuthMocks.installAuthenticatedFetch,
  installedAuthFor: verifierAuthMocks.installedAuthFor
}));

import {
  notifyLocalMcpUninstall,
  requestLocalMcpGrant,
  requestLocalMcpGrantBatch,
  resolveInstallToken
} from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/interactive.mjs";
import { resolveProxyCredentials } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/proxy-command.mjs";
import { installTargets } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/install-command.mjs";
import { uninstallTargets } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/uninstall-command.mjs";
import { MCP_INTERFACE_VERSION, MCP_STABLE_TOOL_NAME } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/constants.mjs";
import { createProcessIdentityClaim } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/process-identity-request.mjs";
import { issueVerifierLocalMcpGrant } from "../../../tools/server-scripts/lib/local-mcp-device-authorization.mjs";

const originalToken = process.env.LICO_MCP_TOKEN;

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function createIssuerFixture(baseUrl, serverId) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyJwk = publicKey.export({ format: "jwk" });
  const keyId = `issuer-${serverId}`;
  const identity = {
    schemaVersion: "v0.0.1:mcp:identity-1",
    algorithm: "Ed25519",
    keyId,
    publicKeyJwk
  };
  return {
    baseUrl,
    binding: { keyId, publicKeyJwk, serverId },
    async response(url, init = {}) {
      if (url === `${baseUrl}/api/mcp/discovery`) {
        return jsonResponse(200, {
          name: "LicoMesh",
          interfaceVersion: MCP_INTERFACE_VERSION,
          stableToolName: MCP_STABLE_TOOL_NAME,
          identity,
          handshake: { url: `${baseUrl}/api/mcp/handshake` }
        });
      }
      if (url === `${baseUrl}/api/mcp/handshake`) {
        const nonce = JSON.parse(String(init.body || "{}")).nonce;
        const payload = {
          schemaVersion: "v0.0.1:mcp:handshake-1",
          nonce,
          identity,
          server: {
            name: "LicoMesh",
            serverId,
            interfaceVersion: MCP_INTERFACE_VERSION,
            stableToolName: MCP_STABLE_TOOL_NAME
          }
        };
        return jsonResponse(200, {
          ok: true,
          payload,
          signature: {
            algorithm: "Ed25519",
            value: sign(null, Buffer.from(stableStringify(payload)), privateKey).toString("base64url")
          }
        });
      }
      return null;
    }
  };
}

function storedIdentity(target, grantToken, {
  baseUrl = "",
  grantId = `grant-${target}`,
  issuerIdentity = null
} = {}) {
  const claim = createProcessIdentityClaim(target);
  return {
    baseUrl,
    grantId,
    grantToken,
    issuerIdentity,
    privateKeyPem: claim.privateKeyPem,
    clientIdentityPackage: {
      clientId: target,
      packageId: `package-${target}`,
      processKey: { processKeyId: claim.request.processKeyId },
      clientFingerprint: claim.request.clientFingerprint
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  processIdentityStoreMocks.loadProcessIdentity.mockReset();
  processIdentityStoreMocks.loadProcessIdentity.mockResolvedValue(null);
  processIdentityStoreMocks.saveProcessIdentity.mockClear();
  processIdentityStoreMocks.deleteProcessIdentity.mockReset();
  processIdentityStoreMocks.deleteProcessIdentity.mockResolvedValue(undefined);
  for (const mock of Object.values(uninstallAdapterMocks)) {
    mock.mockClear();
  }
  verifierAuthMocks.installAuthenticatedFetch.mockReset();
  verifierAuthMocks.installedAuthFor.mockReset();
  if (originalToken === undefined) {
    delete process.env.LICO_MCP_TOKEN;
  } else {
    process.env.LICO_MCP_TOKEN = originalToken;
  }
});

describe("native MCP installer device authorization", () => {
  it("keeps the one-time claim in memory and consumes an approved request", async () => {
    delete process.env.LICO_MCP_TOKEN;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchMock = vi.fn(async (_url, init = {}) => {
      if (fetchMock.mock.calls.length === 1) {
        const body = JSON.parse(String(init.body || "{}"));
        return jsonResponse(202, {
          ok: true,
          requestId: "mcp_auth_req_test",
          status: "pending",
          verificationCode: `${body.claimTokenHash.slice(0, 4)}-${body.claimTokenHash.slice(4, 8)}`.toUpperCase()
        });
      }
      if (fetchMock.mock.calls.length === 2) {
        return jsonResponse(202, {
          ok: true,
          requestId: "mcp_auth_req_test",
          status: "pending"
        });
      }
      return jsonResponse(201, {
        ok: true,
        authorizationRequestId: "mcp_auth_req_test",
        token: "issued-grant-token",
        tokenPrefix: "issued_",
        grant: { id: "grant-1", tokenPrefix: "issued_" },
        processIdentity: {
          protocolVersion: "test-process-identity",
          serverIdentity: { serverId: "server-1" },
          clientIdentityPackage: {
            packageId: "package-1",
            clientId: "codex",
            processKey: { processKeyId: "process-key-1" }
          }
        },
        toolsets: ["lico.runtime.read"],
        scopes: ["runtime:read"]
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestLocalMcpGrant({
      "resolved-url": "http://127.0.0.1:7391",
      "authorization-poll-interval-ms": 50,
      "authorization-timeout-ms": 1_000
    }, {
      targets: ["codex"]
    });

    expect(result).toMatchObject({
      token: "issued-grant-token",
      source: "device-authorization",
      processIdentityRef: "<process-identity-ref>"
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:7391/api/mcp/local-grant/requests");
    const createBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const claimToken = fetchMock.mock.calls[1][1].headers["x-lico-authorization-claim"];
    expect(createBody.claimTokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(createBody.claimTokenHash).toBe(
      createHash("sha256").update(claimToken, "utf8").digest("hex")
    );
    const verificationCode = `${createBody.claimTokenHash.slice(0, 4)}-${createBody.claimTokenHash.slice(4, 8)}`.toUpperCase();
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("mcp_auth_req_test"));
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining(verificationCode));
    expect(JSON.stringify(createBody)).not.toContain(claimToken);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "http://127.0.0.1:7391/api/mcp/local-grant/requests/mcp_auth_req_test/consume"
    );
    expect(fetchMock.mock.calls[2][1].headers["x-lico-authorization-claim"]).toBe(claimToken);
    expect(processIdentityStoreMocks.saveProcessIdentity).toHaveBeenCalledOnce();
    expect(processIdentityStoreMocks.saveProcessIdentity).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ grantToken: "issued-grant-token" })
    );
  });

  it("retries an interrupted consume with the same claim and persists the recovered response once", async () => {
    delete process.env.LICO_MCP_TOKEN;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchMock = vi.fn(async (_url, init = {}) => {
      const callNumber = fetchMock.mock.calls.length;
      if (callNumber === 1) {
        const body = JSON.parse(String(init.body || "{}"));
        return jsonResponse(202, {
          ok: true,
          requestId: "mcp_auth_req_retry",
          status: "pending",
          verificationCode: `${body.claimTokenHash.slice(0, 4)}-${body.claimTokenHash.slice(4, 8)}`.toUpperCase()
        });
      }
      if (callNumber === 2) {
        throw new TypeError("simulated interrupted response");
      }
      return jsonResponse(201, {
        ok: true,
        authorizationRequestId: "mcp_auth_req_retry",
        token: "recovered-grant-token",
        grant: { id: "grant-retry" },
        processIdentity: {
          clientIdentityPackage: {
            packageId: "package-retry",
            clientId: "codex",
            processKey: { processKeyId: "process-key-retry" }
          }
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestLocalMcpGrant({
      "resolved-url": "http://127.0.0.1:7391",
      "authorization-poll-interval-ms": 50,
      "authorization-timeout-ms": 1_000
    }, {
      targets: ["codex"]
    })).resolves.toMatchObject({
      token: "recovered-grant-token",
      source: "device-authorization"
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][1].headers["x-lico-authorization-claim"]).toBe(
      fetchMock.mock.calls[2][1].headers["x-lico-authorization-claim"]
    );
    expect(processIdentityStoreMocks.saveProcessIdentity).toHaveBeenCalledOnce();
  });

  it("revokes every newly issued batch grant when local credential persistence is partial", async () => {
    delete process.env.LICO_MCP_TOKEN;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const issuer = createIssuerFixture("http://127.0.0.1:7391", "server-batch-persistence");
    const records = {};
    let rejectOpenCodeSave = true;
    processIdentityStoreMocks.loadProcessIdentity.mockImplementation(async (target) => records[target] || null);
    processIdentityStoreMocks.saveProcessIdentity.mockImplementation(async (target, record) => {
      if (target === "opencode" && rejectOpenCodeSave) {
        rejectOpenCodeSave = false;
        throw new Error("simulated credential store failure");
      }
      records[target] = record;
      return { reference: `<${target}-credential>`, storageBackend: "test" };
    });
    processIdentityStoreMocks.deleteProcessIdentity.mockImplementation(async (target) => {
      delete records[target];
    });
    const targetPayload = (target) => ({
      token: `${target}-batch-token`,
      grant: { id: `grant-${target}-batch` },
      processIdentity: {
        clientIdentityPackage: {
          clientId: target,
          packageId: `package-${target}-batch`,
          processKey: { processKeyId: `process-key-${target}-batch` },
          clientFingerprint: {}
        }
      }
    });
    const fetchMock = vi.fn(async (url, init = {}) => {
      if (String(url).endsWith("/api/mcp/local-grant/requests")) {
        const body = JSON.parse(String(init.body || "{}"));
        return jsonResponse(202, {
          ok: true,
          requestId: "mcp_auth_req_batch_persist",
          verificationCode: `${body.claimTokenHash.slice(0, 4)}-${body.claimTokenHash.slice(4, 8)}`.toUpperCase()
        });
      }
      if (String(url).endsWith("/consume")) {
        return jsonResponse(201, {
          ok: true,
          targetGrants: {
            codex: targetPayload("codex"),
            opencode: targetPayload("opencode")
          }
        });
      }
      const issuerResponse = await issuer.response(url, init);
      return issuerResponse || jsonResponse(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestLocalMcpGrantBatch({
      "resolved-url": issuer.baseUrl,
      __licoDiscovery: {
        handshake: {
          payload: {
            identity: {
              keyId: issuer.binding.keyId,
              publicKeyJwk: issuer.binding.publicKeyJwk
            },
            server: { serverId: issuer.binding.serverId }
          }
        }
      },
      "authorization-poll-interval-ms": 50,
      "authorization-timeout-ms": 1_000
    }, {
      targets: ["codex", "opencode"]
    })).rejects.toThrow(/newly issued grants were revoked/iu);

    const uninstallCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/mcp/local-uninstall"));
    expect(uninstallCalls).toHaveLength(2);
    expect(uninstallCalls.map(([, init]) => JSON.parse(init.body).targets)).toEqual([["codex"], ["opencode"]]);
    expect(records).toEqual({});
  });

  it("uses an explicitly supplied existing grant without starting device authorization", async () => {
    process.env.LICO_MCP_TOKEN = "provided-grant-token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveInstallToken({
      "resolved-url": "http://127.0.0.1:7391"
    }, {
      targets: ["codex"]
    })).resolves.toMatchObject({
      token: "provided-grant-token",
      source: "provided"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses a same-issuer stored grant and refuses to overwrite it for another server", async () => {
    delete process.env.LICO_MCP_TOKEN;
    const issuerA = createIssuerFixture("http://127.0.0.1:7391", "server-existing-a");
    const issuerB = createIssuerFixture("http://127.0.0.1:7392", "server-existing-b");
    processIdentityStoreMocks.loadProcessIdentity.mockResolvedValue(
      storedIdentity("codex", "stored-install-grant", {
        baseUrl: issuerA.baseUrl,
        grantId: "grant-existing",
        issuerIdentity: issuerA.binding
      })
    );
    const optionsFor = (issuer) => ({
      "resolved-url": issuer.baseUrl,
      __licoDiscovery: {
        handshake: {
          payload: {
            identity: {
              keyId: issuer.binding.keyId,
              publicKeyJwk: issuer.binding.publicKeyJwk
            },
            server: { serverId: issuer.binding.serverId }
          }
        }
      }
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveInstallToken(optionsFor(issuerA), {
      targets: ["codex"]
    })).resolves.toMatchObject({
      token: "stored-install-grant",
      source: "credential-store",
      issuedNow: false,
      grant: { id: "grant-existing" }
    });
    await expect(resolveInstallToken(optionsFor(issuerB), {
      targets: ["codex"]
    })).rejects.toThrow(/cannot be reused for this server/iu);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(processIdentityStoreMocks.saveProcessIdentity).not.toHaveBeenCalled();
  });

  it("surfaces a missing uninstall credential without minting a replacement grant", async () => {
    delete process.env.LICO_MCP_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(notifyLocalMcpUninstall({
      "resolved-url": "http://127.0.0.1:7391"
    }, {
      targets: ["codex"]
    })).resolves.toMatchObject({
      ok: false,
      targets: ["codex"],
      perTarget: {
        codex: {
          ok: false,
          serverDeviceRemoved: false
        }
      }
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses the persisted grant after a proxy restart without reauthorizing", async () => {
    delete process.env.LICO_MCP_TOKEN;
    processIdentityStoreMocks.loadProcessIdentity.mockResolvedValue({
      grantToken: "stored-grant-token",
      privateKeyPem: "stored-private-key",
      clientIdentityPackage: { packageId: "stored-package" }
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const firstLaunch = await resolveProxyCredentials({ target: "codex" });
    const restartedLaunch = await resolveProxyCredentials({ target: "codex" });
    process.env.LICO_MCP_TOKEN = "provided-restart-token";
    const explicitLaunch = await resolveProxyCredentials({ target: "codex" });

    expect(firstLaunch).toMatchObject({ target: "codex", token: "stored-grant-token", tokenSource: "credential-store" });
    expect(restartedLaunch).toMatchObject({ target: "codex", token: "stored-grant-token", tokenSource: "credential-store" });
    expect(explicitLaunch).toMatchObject({ target: "codex", token: "provided-restart-token", tokenSource: "provided" });
    expect(processIdentityStoreMocks.loadProcessIdentity).toHaveBeenCalledTimes(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects bearer-only Orb and remote installation before device authorization starts", async () => {
    delete process.env.LICO_MCP_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const locationOptions of [
      {
        "execution-location": "orb",
        "orb-vm": "test-vm",
        "orb-user": "test-user"
      },
      {
        "execution-location": "docker",
        "remote-kind": "docker",
        "remote-id": "test-container",
        "remote-bin": "docker"
      }
    ]) {
      await expect(resolveInstallToken({
        "resolved-url": "http://127.0.0.1:7391",
        ...locationOptions
      }, {
        targets: ["codex"]
      })).rejects.toThrow(/not supported by this release/iu);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(processIdentityStoreMocks.saveProcessIdentity).not.toHaveBeenCalled();
  });

  it("revokes and removes only the newly issued grant when client installation fails", async () => {
    const issuer = createIssuerFixture("http://127.0.0.1:7391", "server-install-rollback");
    const identity = storedIdentity("codex", "new-install-grant-token", {
      baseUrl: issuer.baseUrl,
      grantId: "grant-new-install",
      issuerIdentity: issuer.binding
    });
    processIdentityStoreMocks.loadProcessIdentity.mockResolvedValue(identity);
    uninstallAdapterMocks.runClientAdapter.mockRejectedValueOnce(new Error("simulated client install failure"));
    const fetchMock = vi.fn(async (url, init = {}) => {
      if (url === `${issuer.baseUrl}/mcp`) {
        return jsonResponse(200, { result: { serverInfo: { name: "LicoMesh" } } });
      }
      return await issuer.response(url, init) || jsonResponse(200, { ok: true, targets: ["codex"] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await installTargets({
      options: { "resolved-url": issuer.baseUrl },
      targets: ["codex"],
      token: identity.grantToken,
      tokenInfo: {
        token: identity.grantToken,
        source: "device-authorization",
        issuedNow: true,
        grant: { id: identity.grantId }
      }
    });

    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/mcp/local-uninstall"))).toHaveLength(1);
    expect(processIdentityStoreMocks.deleteProcessIdentity).toHaveBeenCalledWith("codex");
    expect(result).toMatchObject({
      ok: false,
      installed: {
        codex: {
          status: "failed",
          authorizationRollback: {
            ok: true,
            serverGrantRevoked: true,
            localCredentialRemoved: true
          }
        }
      }
    });
  });

  it("does not revoke a reused grant when a repair install fails", async () => {
    const issuer = createIssuerFixture("http://127.0.0.1:7391", "server-repair-failure");
    const identity = storedIdentity("codex", "reused-install-grant-token", {
      baseUrl: issuer.baseUrl,
      grantId: "grant-reused-install",
      issuerIdentity: issuer.binding
    });
    processIdentityStoreMocks.loadProcessIdentity.mockResolvedValue(identity);
    uninstallAdapterMocks.runClientAdapter.mockRejectedValueOnce(new Error("simulated repair failure"));
    const fetchMock = vi.fn(async (url) =>
      url === `${issuer.baseUrl}/mcp`
        ? jsonResponse(200, { result: { serverInfo: { name: "LicoMesh" } } })
        : jsonResponse(500, { ok: false })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await installTargets({
      options: { "resolved-url": issuer.baseUrl },
      targets: ["codex"],
      token: identity.grantToken,
      tokenInfo: {
        token: identity.grantToken,
        source: "credential-store",
        issuedNow: false,
        grant: { id: identity.grantId }
      }
    });

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/mcp/local-uninstall"))).toBe(false);
    expect(processIdentityStoreMocks.deleteProcessIdentity).not.toHaveBeenCalled();
    expect(result.installed.codex.authorizationRollback).toBeUndefined();
  });

  it("notifies two uninstall targets independently before deleting only the confirmed credential", async () => {
    delete process.env.LICO_MCP_TOKEN;
    const issuerA = createIssuerFixture("http://127.0.0.1:7391", "server-a");
    const issuerB = createIssuerFixture("http://127.0.0.1:7392", "server-b");
    const identities = {
      codex: storedIdentity("codex", "codex-grant-token", {
        baseUrl: issuerA.baseUrl,
        grantId: "grant-codex",
        issuerIdentity: issuerA.binding
      }),
      opencode: storedIdentity("opencode", "opencode-grant-token", {
        baseUrl: issuerB.baseUrl,
        grantId: "grant-opencode",
        issuerIdentity: issuerB.binding
      })
    };
    processIdentityStoreMocks.loadProcessIdentity.mockImplementation(async (target) => identities[target] || null);
    const fetchMock = vi.fn(async (url, init = {}) => {
      for (const issuer of [issuerA, issuerB]) {
        const response = await issuer.response(url, init);
        if (response) {
          return response;
        }
      }
      const [target] = JSON.parse(String(init.body || "{}")).targets || [];
      return target === "codex"
        ? jsonResponse(200, { ok: true, targets: [target] })
        : jsonResponse(403, { ok: false, error: { message: "grant rejected" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await uninstallTargets({
      options: {
        "resolved-url": issuerB.baseUrl
      },
      targets: ["codex", "opencode"]
    });

    const uninstallCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/mcp/local-uninstall"));
    expect(uninstallCalls).toHaveLength(2);
    expect(uninstallCalls.map(([, init]) => JSON.parse(init.body).targets)).toEqual([
      ["codex"],
      ["opencode"]
    ]);
    expect(uninstallCalls[0][0]).toBe(`${issuerA.baseUrl}/api/mcp/local-uninstall`);
    expect(uninstallCalls[1][0]).toBe(`${issuerB.baseUrl}/api/mcp/local-uninstall`);
    expect(uninstallCalls[0][1].headers.Authorization).toBe(`Bearer ${identities.codex.grantToken}`);
    expect(uninstallCalls[1][1].headers.Authorization).toBe(`Bearer ${identities.opencode.grantToken}`);
    expect(processIdentityStoreMocks.deleteProcessIdentity).toHaveBeenCalledOnce();
    expect(processIdentityStoreMocks.deleteProcessIdentity).toHaveBeenCalledWith("codex");
    expect(processIdentityStoreMocks.deleteProcessIdentity.mock.invocationCallOrder[0]).toBeGreaterThan(
      fetchMock.mock.invocationCallOrder.at(-1)
    );
    expect(result).toMatchObject({
      ok: false,
      uninstalled: {
        codex: {
          ok: true,
          serverDeviceRemoved: true,
          localProcessIdentityRemoved: true
        },
        opencode: {
          ok: false,
          serverDeviceRemoved: false,
          localProcessIdentityRemoved: false
        }
      }
    });
  });

  it("reports credential deletion failure after server removal instead of claiming local cleanup", async () => {
    delete process.env.LICO_MCP_TOKEN;
    const issuer = createIssuerFixture("http://127.0.0.1:7391", "server-delete-failure");
    processIdentityStoreMocks.loadProcessIdentity.mockResolvedValue(
      storedIdentity("codex", "codex-delete-failure-token", {
        baseUrl: issuer.baseUrl,
        grantId: "grant-delete-failure",
        issuerIdentity: issuer.binding
      })
    );
    processIdentityStoreMocks.deleteProcessIdentity.mockRejectedValue(
      new Error("credential deletion was not confirmed")
    );
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) =>
      await issuer.response(url, init) || jsonResponse(200, { ok: true, targets: ["codex"] })
    ));

    const result = await uninstallTargets({
      options: { "resolved-url": "http://127.0.0.1:7391" },
      targets: ["codex"]
    });

    expect(result).toMatchObject({
      ok: false,
      uninstalled: {
        codex: {
          ok: false,
          serverDeviceRemoved: true,
          localProcessIdentityRemoved: false
        }
      }
    });
  });

  it("keeps create and consume unauthenticated while approving with a real console transport", async () => {
    verifierAuthMocks.installedAuthFor.mockReturnValue(verifierAuthMocks.auth);
    const fetchMock = vi.fn(async (_url, init = {}) => {
      const callNumber = fetchMock.mock.calls.length;
      if (callNumber === 1) {
        return jsonResponse(202, {
          ok: true,
          requestId: "mcp_auth_req_verifier",
          status: "pending"
        });
      }
      if (callNumber === 2) {
        return jsonResponse(200, { ok: true, grantId: "" });
      }
      return jsonResponse(201, {
        ok: true,
        token: "verifier-grant-token",
        grant: { id: "grant-verifier" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await issueVerifierLocalMcpGrant({
      server: { url: "http://127.0.0.1:7392" },
      grantRequest: {
        targets: ["codex"],
        processIdentity: { processPublicKeyPem: "public-key" }
      }
    });

    expect(result.status).toBe(201);
    const createHeaders = fetchMock.mock.calls[0][1].headers;
    const approveHeaders = fetchMock.mock.calls[1][1].headers;
    const consumeHeaders = fetchMock.mock.calls[2][1].headers;
    expect(createHeaders).toMatchObject({
      Cookie: "",
      "x-lico-csrf": "",
      "x-lico-safety-confirm": ""
    });
    expect(approveHeaders).toMatchObject({
      Cookie: verifierAuthMocks.auth.cookie,
      "x-lico-csrf": verifierAuthMocks.auth.csrf,
      "x-lico-safety-confirm": "true"
    });
    expect(consumeHeaders).toMatchObject({
      Cookie: "",
      "x-lico-csrf": "",
      "x-lico-safety-confirm": ""
    });
    expect(consumeHeaders["x-lico-authorization-claim"]).toMatch(/^[A-Za-z0-9_-]{32,128}$/u);
  });
});
