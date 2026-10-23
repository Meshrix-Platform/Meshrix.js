import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { installUpstreamRuntimeServices, structuredUpstreamServiceFixture } from "../../helpers/upstream-runtime-snapshot.ts";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";
import {
  parsePortableUpstreamServiceImport,
  upstreamServiceImportFromOpenApi
} from "../../../packages/contracts/src/upstream-service-publishing.ts";

const SUBJECT = {
  type: "tool-grant",
  subjectId: "operator",
  grantId: "grant",
  grant: {
    id: "grant",
    subjectId: "operator",
    dynamicCapabilities: ["cap:upstream:inventory:getItem", "cap:upstream:inventory:createItem"]
  },
  scopes: ["gateway:read", "gateway:write"],
  dynamicCapabilities: ["cap:upstream:inventory:getItem", "cap:upstream:inventory:createItem"]
};

function specDocument(overrides: Record<string, any> = {}) : any {
  return {
    openapi: "3.0.3",
    info: { title: "Inventory API", description: "Synthetic inventory service" },
    servers: [{ url: "https://inventory.example.test/v1" }],
    paths: {
      "/items/{id}": {
        get: {
          operationId: "getItem",
          summary: "Fetch one item",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "verbose", in: "query", required: false, schema: { type: "boolean" } }
          ],
          responses: {
            "200": {
              description: "Item",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Item" }
                }
              }
            }
          }
        }
      },
      "/items": {
        post: {
          operationId: "createItem",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/NewItem" }
              }
            }
          },
          responses: { "201": { description: "created" } }
        },
        get: { operationId: "listItems", responses: { "200": { description: "list" } } }
      },
      "/items/{id}/attachment": {
        post: {
          operationId: "attachFile",
          requestBody: {
            required: true,
            content: { "multipart/form-data": { schema: { type: "object" } } }
          },
          responses: { "204": { description: "done" } }
        }
      },
      "/admin/purge": {
        delete: {
          operationId: "purge",
          parameters: [{ name: "x-confirm-token", in: "header", required: true, schema: { type: "string" } }],
          responses: { "204": { description: "purged" } }
        }
      }
    },
    components: {
      schemas: {
        Item: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            note: { type: "string", nullable: true }
          },
          required: ["id", "name"]
        },
        NewItem: {
          type: "object",
          properties: {
            name: { type: "string" },
            count: { type: "integer", minimum: 0 },
            internal: { "x-internal": true, type: "string", description: "dropped annotation" }
          },
          required: ["name"]
        }
      }
    },
    ...overrides
  };
}

async function jsonPeer(handler: (body: any, request: any) => any) : Promise<any> {
  const hits = { count: 0, requests: [] as any[] };
  const peer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    hits.count += 1;
    hits.requests.push({ url: request.url, method: request.method });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(handler(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"), request)));
  });
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const address = peer.address();
  if (!address || typeof address === "string") throw new Error("Synthetic upstream peer is unavailable.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    close: () => new Promise<void>((resolve) => peer.close(() => resolve()))
  };
}

describe("OpenAPI -> portable upstream service import", () => {
  it("converts an OpenAPI 3 document into a publishable descriptor", () => {
    const result = upstreamServiceImportFromOpenApi(JSON.stringify(specDocument()));
    expect(result.document.serviceKey).toBe("inventory-api");
    expect(result.document.descriptor.serviceProtocol).toBe("http");
    expect(result.document.descriptor.baseUrl).toBe("https://inventory.example.test/v1");

    // Portable-import validation accepts the produced draft unchanged.
    const reparsed = parsePortableUpstreamServiceImport(JSON.stringify(result.document));
    expect(reparsed.serviceKey).toBe("inventory-api");

    const operations = result.document.descriptor.operations || [];
    const getItem = operations.find((operation: any) => operation.operationKey === "getItem") as any;
    const createItem = operations.find((operation: any) => operation.operationKey === "createItem") as any;
    const listItems = operations.find((operation: any) => operation.operationKey === "listItems") as any;
    expect(getItem.method).toBe("GET");
    expect(getItem.path).toBe("/items/{id}");
    expect(getItem.risk).toBe("read_only");
    expect(getItem.requiredScopes).toEqual(["gateway:read"]);
    expect(getItem.requestSchema).toMatchObject({
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, verbose: { type: "boolean" } }
    });
    // $ref resolved to a plain closed-schema object; `nullable` translated.
    expect(getItem.responseSchema).toMatchObject({
      type: "object",
      required: ["id", "name"],
      properties: { note: { type: ["string", "null"] } }
    });
    expect(createItem.method).toBe("POST");
    expect(createItem.risk).toBe("safe_write");
    expect(createItem.requestSchema).toMatchObject({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" }, count: { type: "integer", minimum: 0 } }
    });
    // Non-whitelisted schema annotations are dropped.
    expect(JSON.stringify(createItem.requestSchema)).not.toContain("x-internal");
    expect(JSON.stringify(createItem.requestSchema)).not.toContain("description");
    expect(listItems.risk).toBe("read_only");
    expect(result.skippedOperations).toEqual([
      { path: "/items/{id}/attachment", method: "post", reason: "request body has no JSON media type" },
      { path: "/admin/purge", method: "delete", reason: "requires a header parameter" }
    ]);
  });

  it("never publishes an allow-all request schema for unresolvable references", () => {
    const schemas: Record<string, any> = {
      Loop: { type: "object", properties: { next: { $ref: "#/components/schemas/Loop" } } }
    };
    for (let depth = 0; depth < 10; depth += 1) {
      schemas[`D${depth}`] = depth === 0
        ? { type: "object", properties: { leaf: { type: "string" } } }
        : { $ref: `#/components/schemas/D${depth - 1}` };
    }
    const spec = {
      openapi: "3.0.3",
      info: { title: "Ref Probe" },
      servers: [{ url: "https://probe.example.test" }],
      components: { schemas },
      paths: {
        "/ok": { get: { operationId: "okOperation", responses: {} } },
        "/external": { post: { requestBody: { content: { "application/json": { schema: { $ref: "https://other.example/Item.json" } } } } } },
        "/missing": { post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Absent" } } } } } },
        "/recursive": { post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Loop" } } } } } },
        "/deep": { post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/D9" } } } } } }
      }
    };
    const result = upstreamServiceImportFromOpenApi(JSON.stringify(spec));
    const imported = result.document.descriptor.operations.map((operation: any) => operation.path);
    expect(imported).toEqual(["/ok"]);
    expect(result.skippedOperations.map((skipped: any) => skipped.path).sort()).toEqual([
      "/deep", "/external", "/missing", "/recursive"
    ]);
    for (const skipped of result.skippedOperations) {
      expect(skipped.reason).toContain("could not be resolved");
    }
  });

  it("skips object bodies whose constraints cannot be flattened without changing the wire shape", () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Constrained" },
      servers: [{ url: "https://constrained.example.test" }],
      paths: {
        "/health": { get: { operationId: "healthCheck" } },
        "/items": {
          post: {
            operationId: "createConstrained",
            parameters: [{ name: "dryRun", in: "query", schema: { type: "boolean" } }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string" }, count: { type: "integer" } },
                    required: ["name"],
                    minProperties: 2,
                    allOf: [{ properties: { tag: { type: "string" } } }]
                  }
                }
              }
            }
          }
        }
      }
    };
    const result = upstreamServiceImportFromOpenApi(JSON.stringify(spec));
    // A nested "body" argument would be forwarded to the upstream as-is and
    // change the request payload, so the operation is skipped with its reason.
    expect(result.document.descriptor.operations.find((op: any) => op.path === "/items")).toBeUndefined();
    expect(result.skippedOperations).toEqual([
      expect.objectContaining({
        path: "/items",
        method: "post",
        reason: expect.stringContaining("cannot be projected without changing the wire shape")
      })
    ]);
  });

  it("forwards imported operations end-to-end including path parameters", async () => {
    const peer = await jsonPeer((body, request) =>
      request.method === "GET" && typeof request.url === "string" && request.url.startsWith("/items/")
        ? { id: "item-9", name: "widget" }
        : { echoed: body });
    const registry = createUpstreamGatewayRegistry({
      schemaPort: createGatewaySchemaPort(),
      claimProtectedSinkAttempt: async () => Object.freeze({ id: "claim-1", consumed: true })
    });
    try {
      const result = upstreamServiceImportFromOpenApi(JSON.stringify(specDocument()), {
        serviceKey: "inventory",
        baseUrl: peer.url
      });
      expect(result.document.descriptor.baseUrl).toBe(peer.url);
      const descriptor = result.document.descriptor as any;
      installUpstreamRuntimeServices(registry, [structuredUpstreamServiceFixture({
        serviceId: "inventory",
        serviceProtocol: "http",
        label: "inventory",
        allowLocalNetwork: true,
        baseUrl: descriptor.baseUrl,
        operations: descriptor.operations
      })]);
      const forwarded = await registry.forward(
        { serviceId: "inventory", operationKey: "getItem", pathParameters: { id: "item-9" }, query: { verbose: "true" } },
        SUBJECT
      );
      expect(peer.hits.count).toBe(1);
      expect(peer.hits.requests[0].url).toBe("/items/item-9?verbose=true");
      expect(forwarded?.response?.json).toMatchObject({ id: "item-9", name: "widget" });
      const created = await registry.forward(
        { serviceId: "inventory", operationKey: "createItem", body: { name: "widget", count: 3 } },
        SUBJECT
      );
      expect(peer.hits.count).toBe(2);
      expect(peer.hits.requests[1].url).toBe("/items");
      expect(created?.response?.json?.echoed).toMatchObject({ name: "widget", count: 3 });
    } finally {
      await registry.close();
      await peer.close();
    }
  });

  it("rejects documents that cannot produce a governed descriptor", () => {
    expect(() => upstreamServiceImportFromOpenApi("not json"))
      .toThrow(/not valid JSON/u);
    expect(() => upstreamServiceImportFromOpenApi(JSON.stringify({ swagger: "2.0" })))
      .toThrow(/2\.x/u);
    expect(() => upstreamServiceImportFromOpenApi(JSON.stringify(specDocument({ servers: [{ url: "/relative" }] }))))
      .toThrow(/baseUrl|servers/u);
    expect(() => upstreamServiceImportFromOpenApi(JSON.stringify(specDocument({ paths: {} }))))
      .toThrow(/no importable/u);
    expect(() => upstreamServiceImportFromOpenApi(JSON.stringify(specDocument({ info: {} })), {}))
      .toThrow(/serviceKey/u);
  });

  it("substitutes server variable defaults and sanitizes operation ids", () => {
    const spec = specDocument({
      info: { title: "svc" },
      servers: [{
        url: "https://{region}.api.example.test/v2",
        variables: { region: { default: "eu" } }
      }],
      paths: {
        "/thing": {
          post: { operationId: "99 bottles!!", responses: {} },
          get: { responses: {} }
        }
      }
    });
    const result = upstreamServiceImportFromOpenApi(JSON.stringify(spec));
    expect(result.document.descriptor.baseUrl).toBe("https://eu.api.example.test/v2");
    const keys = (result.document.descriptor.operations || []).map((operation: any) => operation.operationKey);
    expect(keys).toHaveLength(2);
    expect(keys.every((key: string) => /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(key))).toBe(true);
  });
});
