import { describe, expect, it, vi } from "vitest";
import {
  isUpstreamCredentialHeaderName,
  isUpstreamServiceOrigin,
  normalizeUpstreamMcpContextHeaders,
  normalizeUpstreamMcpHttpRequestHeaders,
  resolveUpstreamCredentialMaterial
} from "@meshrix/contracts/upstream-service-publishing";

const secretResolution: any = vi.hoisted(() : any => ({
  resolve: vi.fn(async ({ secretRef, expectedRevision }: Record<string, any>) : Promise<any> => ({
    secretRef,
    revision: expectedRevision || 1,
    payload: {
      headers: { authorization: ["Bearer", "fixture-material"].join(" ") },
      env: { SYNTHETIC_MATERIAL: "synthetic-environment-material" }
    }
  }))
}));

vi.mock("@meshrix/foundation/security/secret-store/local-secret-store", () : any => ({
  resolveLocalSecretPayload: secretResolution.resolve
}));

import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { parseWithDuplicateRejection } from "../../../packages/agents/src/upstream-gateway/manifest-compiler.ts";
import {
  resolveCredentialMaterial,
  resolveMcpServiceConfigWithCredentials
} from "../../../packages/agents/src/upstream-gateway/credential-material.ts";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.ts";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";

describe("upstream publishing sensitive-reference custody", () : any => {
  it("shares literal context and resolved-header rules with target-neutral runtimes", () : any => {
    expect(normalizeUpstreamMcpContextHeaders({ "X-Workspace": "$WORKSPACE_ID" })).toEqual({
      "x-workspace": "$WORKSPACE_ID"
    });
    expect(() => normalizeUpstreamMcpContextHeaders({ "X-Api-Key": "synthetic-credential" }))
      .toThrow(expect.objectContaining({ code: "upstream_mcp_headers_invalid" }));
    expect(() => normalizeUpstreamMcpContextHeaders({ Host: "alternate.example.test" }))
      .toThrow(expect.objectContaining({ code: "upstream_mcp_headers_invalid" }));
    expect(normalizeUpstreamMcpHttpRequestHeaders({ Authorization: ["Bearer", "synthetic-credential"].join(" ") }))
      .toEqual({ authorization: ["Bearer", "synthetic-credential"].join(" ") });
    expect(isUpstreamCredentialHeaderName("x-project-token")).toBe(true);
    expect(isUpstreamCredentialHeaderName("x-project-id")).toBe(false);
    expect(isUpstreamCredentialHeaderName("x-author-id")).toBe(false);
    expect(isUpstreamCredentialHeaderName("x-auth-token")).toBe(true);
    expect(isUpstreamCredentialHeaderName("x_api_key")).toBe(true);
    expect(isUpstreamServiceOrigin("https://service.invalid:8443")).toBe(true);
    expect(isUpstreamServiceOrigin("https://service.invalid:443")).toBe(false);
    expect(isUpstreamServiceOrigin("https://service.invalid/path")).toBe(false);
  });

  it("validates every credential binding before lookup and normalizes returned payloads once", async () : Promise<any> => {
    const bindings: any[] = [
      {
        reference: "secret://vault/first",
        revision: 3,
        origin: "https://service.invalid",
        operationKey: "records.read",
        scopes: ["records:read"]
      },
      {
        reference: "secret://vault/second",
        revision: 4,
        origin: "https://service.invalid",
        operationKey: "records.read",
        scopes: ["records:write"]
      }
    ];
    const resolveSecretPayload = vi.fn(async () : Promise<any> => ({ payload: { headers: { "x-api-key": "synthetic-material" } } }));

    await expect(resolveUpstreamCredentialMaterial({
      bindings,
      targetOrigin: "https://service.invalid",
      tenantId: "synthetic-tenant",
      operationKey: "records.read",
      requiredScopes: ["records:read"],
      resolveSecretPayload
    })).rejects.toMatchObject({ status: 403, reasonCode: "upstream_credential_binding_denied" });
    expect(resolveSecretPayload).not.toHaveBeenCalled();

    const binding = { ...bindings[0], scopes: ["records:read"] };
    const signal = new AbortController().signal;
    resolveSecretPayload.mockImplementationOnce(async (...args: any[]) : Promise<any> => {
      expect(args).toMatchObject([
        binding,
        "https://service.invalid",
        "synthetic-tenant",
        signal,
        "records.read",
        ["records:read"]
      ]);
      return {
        secretRef: binding.reference,
        revision: binding.revision,
        payload: {
          headers: { Authorization: ["Bearer", "synthetic-material"].join(" ") },
          env: JSON.parse('{"__proto__":"synthetic-env","SYNTHETIC_ENV":"synthetic-env"}')
        }
      };
    });
    const result: any = await resolveUpstreamCredentialMaterial({
      bindings: [binding],
      targetOrigin: "https://service.invalid",
      tenantId: "synthetic-tenant",
      operationKey: "records.read",
      requiredScopes: ["records:read"],
      signal,
      resolveSecretPayload
    });
    expect(result).toMatchObject({
      headers: { authorization: ["Bearer", "synthetic-material"].join(" ") },
      env: { SYNTHETIC_ENV: "synthetic-env" },
      credentialRefCount: 1,
      resolvedCredentialRefCount: 1,
      credentialRevisions: [{ secretRef: binding.reference, revision: binding.revision }]
    });
    expect(Object.getPrototypeOf(result.env)).toBe(Object.prototype);
    expect(Object.hasOwn(result.env, "__proto__")).toBe(true);
  });

  it("does not reflect duplicate caller-controlled keys in parser errors", () : any => {
    const marker: any = "synthetic-sensitive-key";
    let message: any = "";
    try {
      parseWithDuplicateRejection(`{"${marker}":1,"${marker}":2}`);
    } catch (error: any) {
      message = error.message;
    }
    expect(message).toBe("Publishing input contains a duplicate object key.");
    expect(message).not.toContain(marker);
  });

  it("denies MCP forwarding before discovery, materialization, or an upstream call", async () : Promise<any> => {
    const sessionManager: Record<string, any> = {
      listTools: vi.fn(async () : Promise<any> => ({ tools: [] })),
      callTool: vi.fn(async () : Promise<any> => ({ result: {} })),
      close: vi.fn(async () : Promise<any> => {})
    };
    const registry: any = createUpstreamGatewayRegistry({ schemaPort: createGatewaySchemaPort(), mcpSessionManager: sessionManager });
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
      const publicServices: any = registry.listServices();
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

  it("enforces operation, host, protocol, scope, and revision bindings before materialization", async () : Promise<any> => {
    const binding: Record<string, any> = {
      type: "credential",
      reference: "secret://vault/fixture",
      revision: 7,
      use: "request-auth",
      operationKey: "records.read",
      origin: "https://service.invalid",
      host: "service.invalid",
      protocol: "https",
      scopes: ["records:read"]
    };
    const service: Record<string, any> = {
      serviceId: "sensitive-reference-fixture",
      baseUrl: "https://service.invalid:443/api",
      credentialReferences: [binding]
    };

    const unrelated: any = await resolveCredentialMaterial({
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

    const material: any = await resolveCredentialMaterial({
      service,
      operation: { operationKey: "records.read", requiredScopes: ["records:read"] }
    });
    expect(material).toMatchObject({ credentialRefCount: 1, resolvedCredentialRefCount: 1 });
    expect(secretResolution.resolve).toHaveBeenCalledWith(expect.objectContaining({
      secretRef: binding.reference,
      expectedRevision: 7,
      expectedScope: expect.objectContaining({
        serviceId: service.serviceId,
        origin: "https://service.invalid",
        host: "service.invalid",
        protocol: "https",
        requiredScopes: ["records:read"]
      })
    }));

    secretResolution.resolve.mockClear();
    const otherOrigin: any = await resolveCredentialMaterial({
      service,
      operation: { operationKey: "records.read", requiredScopes: ["records:read"] },
      targetUrl: new URL("https://service.invalid:8443/api")
    });
    expect(otherOrigin).toMatchObject({ credentialRefCount: 0, resolvedCredentialRefCount: 0 });
    expect(secretResolution.resolve).not.toHaveBeenCalled();
  });

  it("does not project resolved environment material into remote MCP configuration", async () : Promise<any> => {
    const config: any = await resolveMcpServiceConfigWithCredentials({
      service: {
        serviceId: "sensitive-reference-fixture",
        serviceProtocol: "mcp",
        credentialReferences: [{
          type: "credential",
          reference: "secret://vault/fixture",
          revision: 1,
          use: "request-auth",
          origin: "https://service.invalid"
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
