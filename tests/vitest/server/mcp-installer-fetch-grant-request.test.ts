import { createHash, generateKeyPairSync, verify } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const processIdentityStoreMocks: any = vi.hoisted(() : any => ({
  deleteProcessIdentity: vi.fn(async () : Promise<any> => {}),
  loadProcessIdentity: vi.fn(async () : Promise<any> => null),
  saveProcessIdentity: vi.fn(async () : Promise<any> => ({
    filePath: "<process-identity-path>",
    reference: "<process-identity-ref>",
    storageBackend: "test"
  }))
}));

vi.mock("../../../packages/protocols/mcp/adapter/gateway-installer/lib/process-identity-store.ts", () : any =>
  processIdentityStoreMocks
);
vi.mock("../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/client-adapter-runner.ts", () : any => ({
  clientAdapterConnectorRequest: (value?: any) : any => value,
  defaultClientAdapterCacheRoot: () : any => "<adapter-cache>",
  describeClientAdapter: vi.fn(async () : Promise<any> => ({ result: {}, adapter: {}, cache: {} })),
  runClientAdapter: vi.fn(async () : Promise<any> => ({ result: {}, adapter: {}, cache: {} }))
}));
vi.mock("../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/device-config.ts", () : any => ({
  writeDeviceDiscovery: vi.fn(async () : Promise<any> => "<discovery-manifest>"),
  writeDeviceUninstall: vi.fn(async () : Promise<any> => "<discovery-manifest>"),
  writeServerConfigProfile: vi.fn(async () : Promise<any> => ({}))
}));

import { fetchCommand } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/fetch-command.ts";
import { resolveGrantRequestFields } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/grant-request.ts";
import { requestLocalMcpGrant } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/interactive.ts";
import { PROCESS_IDENTITY_CANONICAL_REQUEST_VERSION } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/constants.ts";

const originalToken: any = process.env.MESHRIX_MCP_TOKEN;
const issuerBaseUrl: any = "http://127.0.0.1:7391";
const artifactBody: any = Buffer.from("converted-pdf-bytes-0123456789", "utf8");
const artifactSha256: any = createHash("sha256").update(artifactBody).digest("hex");

const { publicKey: identityPublicKey, privateKey: identityPrivateKey } = generateKeyPairSync("ed25519");
const identityPublicKeyPem: any = identityPublicKey.export({ format: "pem", type: "spki" });

function storedIdentity() : any {
  return {
    baseUrl: issuerBaseUrl,
    grantId: "grant-codex",
    grantToken: "test-grant",
    privateKeyPem: identityPrivateKey.export({ format: "pem", type: "pkcs8" }),
    clientIdentityPackage: {
      clientId: "codex",
      packageId: "package-codex",
      processKey: { processKeyId: "pkey_codex" },
      clientFingerprint: {
        fingerprintId: "fp_codex",
        machineInstanceId: "machine_secret_instance",
        appInstanceId: "app_codex",
        runtimeInstanceId: "runtime_codex",
        fingerprintHash: "sha256:fingerprint"
      }
    }
  };
}

function jsonResponse(status?: any, payload?: any) : any {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

let temporaryDirectory: any = "";

afterEach(async () : Promise<any> => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  processIdentityStoreMocks.loadProcessIdentity.mockReset();
  processIdentityStoreMocks.loadProcessIdentity.mockResolvedValue(null);
  processIdentityStoreMocks.saveProcessIdentity.mockClear();
  processIdentityStoreMocks.deleteProcessIdentity.mockReset();
  processIdentityStoreMocks.deleteProcessIdentity.mockResolvedValue(undefined);
  if (originalToken === undefined) {
    delete process.env.MESHRIX_MCP_TOKEN;
  } else {
    process.env.MESHRIX_MCP_TOKEN = originalToken;
  }
  if (temporaryDirectory) {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = "";
  }
});

async function temporaryOutputPath(name: any = "artifact.pdf") : Promise<any> {
  temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-fetch-"));
  return path.join(temporaryDirectory, name);
}

describe("meshrix-mcp fetch signed artifact download", () : any => {
  it("downloads an artifact with signed process-identity headers and verifies the digest", async () : Promise<any> => {
    delete process.env.MESHRIX_MCP_TOKEN;
    const identity: any = storedIdentity();
    processIdentityStoreMocks.loadProcessIdentity.mockResolvedValue(identity);
    const outputPath: any = await temporaryOutputPath();
    const artifactUrl: any = `${issuerBaseUrl}/api/gateway/v1/artifacts/artifact_abc123`;
    const fetchMock: any = vi.fn(async () : Promise<any> => new Response(artifactBody, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(artifactBody.length),
        digest: `sha-256=${createHash("sha256").update(artifactBody).digest("base64")}`
      }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result: any = await fetchCommand({
      target: "codex",
      artifact: artifactUrl,
      out: outputPath
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [requestedUrl, requestInit] = fetchMock.mock.calls[0];
    expect(requestedUrl).toBe(artifactUrl);
    expect(requestInit.method).toBe("GET");
    const headers: any = requestInit.headers;
    expect(headers.Authorization).toBe("Bearer test-grant");
    expect(headers["X-Meshrix-MCP-Target"]).toBe("codex");
    expect(headers["x-meshrix-body-sha256"]).toBe(createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
    expect(headers["x-meshrix-machine-instance-id"]).toBe("machine_secret_instance");
    const canonical: any = [
      PROCESS_IDENTITY_CANONICAL_REQUEST_VERSION,
      "GET",
      "/api/gateway/v1/artifacts/artifact_abc123",
      headers["x-meshrix-body-sha256"],
      headers["x-meshrix-timestamp"],
      headers["x-meshrix-nonce"],
      "codex",
      "package-codex",
      "pkey_codex",
      "fp_codex",
      "machine_secret_instance",
      "app_codex",
      "runtime_codex",
      "sha256:fingerprint"
    ].join("\n");
    expect(verify(
      null,
      Buffer.from(canonical, "utf8"),
      identityPublicKeyPem,
      Buffer.from(String(headers["x-meshrix-signature"]), "base64url")
    )).toBe(true);

    expect(await fsp.readFile(outputPath)).toEqual(artifactBody);
    expect(result).toMatchObject({
      ok: true,
      target: "codex",
      artifactId: "artifact_abc123",
      byteLength: artifactBody.length,
      sha256: artifactSha256,
      digestVerified: true,
      outputPath: `<local-path>/${path.basename(outputPath)}`
    });
    const receipt: any = JSON.stringify(result);
    expect(receipt).not.toContain("test-grant");
    expect(receipt).not.toContain("machine_secret_instance");
    expect(receipt).not.toContain(temporaryDirectory);
  });

  it("resolves a bare artifact id against the stored issuer and rejects foreign origins", async () : Promise<any> => {
    delete process.env.MESHRIX_MCP_TOKEN;
    processIdentityStoreMocks.loadProcessIdentity.mockResolvedValue(storedIdentity());
    const outputPath: any = await temporaryOutputPath();
    const fetchMock: any = vi.fn(async () : Promise<any> => new Response(artifactBody, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCommand({
      target: "codex",
      artifact: "artifact_abc123",
      out: outputPath
    })).resolves.toMatchObject({ ok: true, artifactId: "artifact_abc123", digestVerified: false });
    expect(fetchMock.mock.calls[0][0]).toBe(`${issuerBaseUrl}/api/gateway/v1/artifacts/artifact_abc123`);

    await expect(fetchCommand({
      target: "codex",
      artifact: "http://169.254.169.254:7391/api/gateway/v1/artifacts/artifact_abc123",
      out: await temporaryOutputPath()
    })).rejects.toThrow(/does not match the stored credential issuer/iu);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails on digest mismatch and removes the partial download", async () : Promise<any> => {
    delete process.env.MESHRIX_MCP_TOKEN;
    processIdentityStoreMocks.loadProcessIdentity.mockResolvedValue(storedIdentity());
    const outputPath: any = await temporaryOutputPath();
    const foreignDigest: any = createHash("sha256").update("other-bytes").digest("base64");
    vi.stubGlobal("fetch", vi.fn(async () : Promise<any> => new Response(artifactBody, {
      status: 200,
      headers: { digest: `sha-256=${foreignDigest}` }
    })));

    await expect(fetchCommand({
      target: "codex",
      artifact: `${issuerBaseUrl}/api/gateway/v1/artifacts/artifact_abc123`,
      out: outputPath
    })).rejects.toThrow(/digest header did not match/iu);

    expect(fs.existsSync(outputPath)).toBe(false);
    expect(await fsp.readdir(temporaryDirectory)).toEqual([]);
  });

  it("fails before any network call when the stored process identity is missing", async () : Promise<any> => {
    delete process.env.MESHRIX_MCP_TOKEN;
    const fetchMock: any = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCommand({
      target: "codex",
      artifact: `${issuerBaseUrl}/api/gateway/v1/artifacts/artifact_abc123`,
      out: await temporaryOutputPath()
    })).rejects.toThrow(/Missing local process identity/iu);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("meshrix-mcp install explicit grant request flags", () : any => {
  it("keeps the default device-authorization request free of grant fields", async () : Promise<any> => {
    delete process.env.MESHRIX_MCP_TOKEN;
    vi.spyOn(process.stderr, "write").mockImplementation(() : any => true);
    const fetchMock: any = vi.fn(async (_url?: any, init: Record<string, any> = {}) : Promise<any> => {
      if (fetchMock.mock.calls.length === 1) {
        const body: any = JSON.parse(String(init.body || "{}"));
        return jsonResponse(202, {
          ok: true,
          requestId: "mcp_auth_req_default",
          status: "pending",
          verificationCode: `${body.claimTokenHash.slice(0, 4)}-${body.claimTokenHash.slice(4, 8)}`.toUpperCase()
        });
      }
      return jsonResponse(201, {
        ok: true,
        token: "issued-grant-token",
        grant: { id: "grant-default" },
        processIdentity: {
          clientIdentityPackage: {
            packageId: "package-default",
            clientId: "codex",
            processKey: { processKeyId: "process-key-default" }
          }
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestLocalMcpGrant({
      "resolved-url": issuerBaseUrl,
      "authorization-poll-interval-ms": 50,
      "authorization-timeout-ms": 1_000
    }, {
      targets: ["codex"]
    })).resolves.toMatchObject({ token: "issued-grant-token" });

    const createBody: any = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(createBody).not.toHaveProperty("toolsets");
    expect(createBody).not.toHaveProperty("scopes");
    expect(createBody).not.toHaveProperty("maxRisk");
    expect(createBody).not.toHaveProperty("dynamicCapabilities");
    expect(createBody).not.toHaveProperty("allowedServiceIds");
    expect(resolveGrantRequestFields({})).toEqual({ explicit: false, fields: {}, summary: "" });
  });

  it("submits validated grant fields and echoes a redacted summary", async () : Promise<any> => {
    delete process.env.MESHRIX_MCP_TOKEN;
    const stderrWrite: any = vi.spyOn(process.stderr, "write").mockImplementation(() : any => true);
    const fetchMock: any = vi.fn(async (_url?: any, init: Record<string, any> = {}) : Promise<any> => {
      if (fetchMock.mock.calls.length === 1) {
        const body: any = JSON.parse(String(init.body || "{}"));
        return jsonResponse(202, {
          ok: true,
          requestId: "mcp_auth_req_explicit",
          status: "pending",
          verificationCode: `${body.claimTokenHash.slice(0, 4)}-${body.claimTokenHash.slice(4, 8)}`.toUpperCase()
        });
      }
      return jsonResponse(201, {
        ok: true,
        token: "issued-write-grant-token",
        grant: { id: "grant-explicit" },
        processIdentity: {
          clientIdentityPackage: {
            packageId: "package-explicit",
            clientId: "codex",
            processKey: { processKeyId: "process-key-explicit" }
          }
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestLocalMcpGrant({
      "resolved-url": issuerBaseUrl,
      "authorization-poll-interval-ms": 50,
      "authorization-timeout-ms": 1_000,
      toolsets: "meshrix.gateway.read,meshrix.gateway.write",
      scopes: "gateway:read,gateway:write",
      "max-risk": "safe_write",
      "upstream-capability": "cap:upstream:format-convert:convert",
      "allowed-service": "format-convert"
    }, {
      targets: ["codex"]
    })).resolves.toMatchObject({ token: "issued-write-grant-token" });

    const createBody: any = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(createBody.toolsets).toEqual(["meshrix.gateway.read", "meshrix.gateway.write"]);
    expect(createBody.scopes).toEqual(["gateway:read", "gateway:write"]);
    expect(createBody.maxRisk).toBe("safe_write");
    expect(createBody.dynamicCapabilities).toEqual(["cap:upstream:format-convert:convert"]);
    expect(createBody.allowedServiceIds).toEqual(["format-convert"]);
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining(
      "MCP grant request: toolsets=meshrix.gateway.read,meshrix.gateway.write; scopes=gateway:read,gateway:write; maxRisk=safe_write; upstreamCapabilities=cap:upstream:format-convert:convert; allowedServices=format-convert"
    ));
  });

  it("rejects invalid grant flag values before submission", async () : Promise<any> => {
    expect(() : any => resolveGrantRequestFields({ toolsets: "meshrix.gateway.write,meshrix.unknown" }))
      .toThrow(/non-grantable MCP grant toolset/iu);
    expect(() : any => resolveGrantRequestFields({ toolsets: "meshrix.admin" }))
      .toThrow(/non-grantable MCP grant toolset/iu);
    expect(() : any => resolveGrantRequestFields({ scopes: "gateway:read,unknown:scope" }))
      .toThrow(/Unsupported MCP grant scope/iu);
    expect(() : any => resolveGrantRequestFields({ "max-risk": "everything" }))
      .toThrow(/Unsupported MCP grant max risk/iu);
    expect(() : any => resolveGrantRequestFields({
      toolsets: "meshrix.gateway.write",
      "upstream-capability": "cap:wrong"
    })).toThrow(/cap:upstream:<service>:<operation>/iu);
    expect(() : any => resolveGrantRequestFields({ "upstream-capability": "cap:upstream:format-convert:convert" }))
      .toThrow(/stays read-only/iu);
    expect(() : any => resolveGrantRequestFields({ toolsets: "meshrix.jobs.write" }))
      .toThrow(/--max-risk repair_write/iu);
    expect(resolveGrantRequestFields({
      toolsets: "meshrix.jobs.write",
      "max-risk": "repair_write"
    })).toMatchObject({
      explicit: true,
      fields: { toolsets: ["meshrix.jobs.write"], maxRisk: "repair_write" }
    });
    expect(resolveGrantRequestFields({
      toolsets: "meshrix.uploads.write",
      scopes: "uploads:write",
      "max-risk": "safe_write"
    })).toMatchObject({
      explicit: true,
      fields: {
        toolsets: ["meshrix.uploads.write"],
        scopes: ["uploads:write"],
        maxRisk: "safe_write"
      }
    });
    // The server stores allowedServiceIds as plain strings; path-segment ids
    // such as file-parser/format-convert are accepted.
    expect(resolveGrantRequestFields({
      toolsets: "meshrix.gateway.write",
      "allowed-service": "file-parser/format-convert"
    })).toMatchObject({
      explicit: true,
      fields: { allowedServiceIds: ["file-parser/format-convert"] }
    });
    expect(() : any => resolveGrantRequestFields({
      toolsets: "meshrix.gateway.write",
      "allowed-service": "/format-convert"
    })).toThrow(/Invalid allowed upstream service id/iu);
    expect(() : any => resolveGrantRequestFields({
      toolsets: "meshrix.gateway.write",
      "allowed-service": "bad service"
    })).toThrow(/Invalid allowed upstream service id/iu);
  });
});
