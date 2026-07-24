import { describe, expect, it, vi } from "vitest";

const secretResolution = vi.hoisted(() => ({
  resolve: vi.fn(async ({ secretRef, expectedRevision }) => ({
    secretRef,
    revision: expectedRevision || 1,
    payload: {
      headers: { authorization: ["Bearer", "fixture-material"].join(" ") },
      env: { SYNTHETIC_MATERIAL: "synthetic-environment-material" }
    }
  }))
}));

vi.mock("@meshrix/foundation/security/secrets/local-secret-store", () => ({
  resolveLocalSecretPayload: secretResolution.resolve
}));

import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.mjs";
import { parseWithDuplicateRejection } from "../../../packages/agents/src/upstream-gateway/manifest-compiler.mjs";
import {
  resolveCredentialMaterial,
  resolveMcpServiceConfigWithCredentials
} from "../../../packages/agents/src/upstream-gateway/credential-material.mjs";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.mjs";

describe("upstream publishing sensitive-reference custody", () => {
  it("does not reflect duplicate caller-controlled keys in parser errors", () => {
    const marker = "synthetic-sensitive-key";
    let message = "";
    try {
      parseWithDuplicateRejection(`{"${marker}":1,"${marker}":2}`);
    } catch (error) {
      message = error.message;
    }
    expect(message).toBe("Publishing input contains a duplicate object key.");
    expect(message).not.toContain(marker);
  });

  it("denies MCP forwarding before discovery, materialization, or an upstream call", async () => {
    const sessionManager = {
      listTools: vi.fn(async () => ({ tools: [] })),
      callTool: vi.fn(async () => ({ result: {} })),
      close: vi.fn(async () => {})
    };
    const registry = createUpstreamGatewayRegistry({ mcpSessionManager: sessionManager });
    installUpstreamRuntimeServices(registry, [{
      serviceId: "sensitive-reference-fixture",
      serviceProtocol: "mcp",
      label: "Sensitive reference fixture",
      baseUrl: "https://service.invalid:443/mcp",
      credentialRefs: ["credential://vault/fixture"],
      mcp: {
        transport: "streamable-http",
        url: "https://service.invalid:443/mcp",
        toolNamePrefix: "sensitive-reference-fixture"
      },
      operations: [{
        operationKey: "tools/call",
        protocol: "mcp",
        requiredScopes: ["gateway:execute"],
        risk: "read_only"
      }]
    }]);

    try {
      const publicServices = registry.listServices();
      expect(publicServices.items[0]).not.toHaveProperty("credentialRefs");
      expect(publicServices.items[0]).not.toHaveProperty("credentialReferences");
      expect(publicServices.items[0]).toMatchObject({
        credentialReferenceCount: 1,
        credentialBindingIds: [expect.stringMatching(/^credential:[a-f0-9]{16}$/u)]
      });
      expect(JSON.stringify(publicServices)).not.toContain("credential://vault/fixture");
      await expect(registry.forward({
        serviceId: "sensitive-reference-fixture",
        operationKey: "tools/call",
        toolName: "records.read",
        arguments: {}
      }, { scopes: [] })).rejects.toMatchObject({ status: 403 });
      expect(sessionManager.listTools).not.toHaveBeenCalled();
      expect(sessionManager.callTool).not.toHaveBeenCalled();
      expect(secretResolution.resolve).not.toHaveBeenCalled();
    } finally {
      await registry.close();
    }
  });

  it("enforces operation, host, protocol, scope, and revision bindings before materialization", async () => {
    const binding = {
      type: "credential",
      reference: "secret://vault/fixture",
      revision: 7,
      use: "request-auth",
      operationKey: "records.read",
      host: "service.invalid",
      protocol: "https",
      scopes: ["records:read"]
    };
    const service = {
      serviceId: "sensitive-reference-fixture",
      baseUrl: "https://service.invalid:443/api",
      credentialReferences: [binding]
    };

    const unrelated = await resolveCredentialMaterial({
      service,
      operation: { operationKey: "records.write", requiredScopes: ["records:write"] }
    });
    expect(unrelated).toMatchObject({ credentialRefCount: 0, resolvedCredentialRefCount: 0 });
    expect(secretResolution.resolve).not.toHaveBeenCalled();

    await expect(resolveCredentialMaterial({
      service,
      operation: { operationKey: "records.read", requiredScopes: [] }
    })).rejects.toMatchObject({ reasonCode: "upstream_credential_binding_denied" });
    expect(secretResolution.resolve).not.toHaveBeenCalled();

    await expect(resolveCredentialMaterial({
      service: {
        ...service,
        credentialReferences: [{ ...binding, reference: "credential://provider/fixture" }]
      },
      operation: { operationKey: "records.read", requiredScopes: ["records:read"] }
    })).rejects.toMatchObject({ reasonCode: "upstream_credential_authority_unsupported" });
    expect(secretResolution.resolve).not.toHaveBeenCalled();

    const material = await resolveCredentialMaterial({
      service,
      operation: { operationKey: "records.read", requiredScopes: ["records:read"] }
    });
    expect(material).toMatchObject({ credentialRefCount: 1, resolvedCredentialRefCount: 1 });
    expect(secretResolution.resolve).toHaveBeenCalledWith(expect.objectContaining({
      secretRef: binding.reference,
      expectedRevision: 7,
      expectedScope: expect.objectContaining({
        serviceId: service.serviceId,
        host: "service.invalid",
        protocol: "https",
        requiredScopes: ["records:read"]
      })
    }));
  });

  it("does not project resolved environment material into remote MCP configuration", async () => {
    const config = await resolveMcpServiceConfigWithCredentials({
      service: {
        serviceId: "sensitive-reference-fixture",
        serviceProtocol: "mcp",
        credentialReferences: [{
          type: "credential",
          reference: "secret://vault/fixture",
          revision: 1,
          use: "request-auth"
        }],
        mcp: {
          transport: "streamable-http",
          url: "https://service.invalid:443/mcp"
        }
      },
      operation: { operationKey: "tools/call", requiredScopes: ["gateway:read"] }
    });

    expect(config.headers).toHaveProperty("authorization");
    expect(config.env).not.toHaveProperty("SYNTHETIC_MATERIAL");
    expect(JSON.stringify(config)).not.toContain("synthetic-environment-material");
  });
});
