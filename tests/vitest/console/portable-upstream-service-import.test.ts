import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  parsePortableUpstreamServiceImport,
  PORTABLE_UPSTREAM_SERVICE_KIND,
  PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION,
} from "@meshrix/contracts/upstream-service-publishing";

describe("portable upstream service import schema", () : any => {
  it("accepts the canonical format-convert multipart artifact configuration", () : any => {
    const imported: any = parsePortableUpstreamServiceImport(readFileSync(
      new URL("../../../docs/examples/file-parser-format-convert.upstream.json", import.meta.url),
      "utf8",
    ));
    expect(imported).toMatchObject({
      serviceKey: "file-parser/format-convert",
      descriptor: {
        baseUrl: "http://format-convert:8080",
        healthPath: "/readyz",
        operations: [{
          operationKey: "convert",
          path: "/v1/convert",
          payloadTransport: {
            request: {
              mode: "artifact_multipart",
              multipart: {
                artifactParts: [{ argument: "file", partName: "file", required: true }],
                scalarFields: [{ argument: "targetFormat", partName: "targetFormat", required: false }],
              },
            },
            response: { mode: "artifact" },
          },
        }],
      },
    });
  });

  it("accepts the explicit portable envelope and preserves the complete descriptor", () : any => {
    const descriptor: Record<string, any> = {
      serviceProtocol: "json-rpc",
      baseUrl: "https://service.invalid:443/rpc",
      operations: [{
        operationKey: "query",
        method: "POST",
        path: "/rpc",
        payloadTransport: {
          request: { mode: "structured_json", maxBytes: 1024, mediaTypes: ["application/json"] },
          response: { mode: "structured_json", maxBytes: 2048, mediaTypes: ["application/json"] },
        },
      }],
      permissions: { requiredScopes: ["catalog:read"] },
    };
    expect(parsePortableUpstreamServiceImport(JSON.stringify({
      kind: PORTABLE_UPSTREAM_SERVICE_KIND,
      schemaVersion: PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION,
      serviceKey: " file-parser/format-convert ",
      descriptor,
    }))).toEqual({
      kind: PORTABLE_UPSTREAM_SERVICE_KIND,
      schemaVersion: PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION,
      serviceKey: "file-parser/format-convert",
      descriptor,
    });
  });

  it.each([
    [{ schemaVersion: PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION, serviceKey: "svc", descriptor: {} }, "Missing top-level field: kind"],
    [{ kind: PORTABLE_UPSTREAM_SERVICE_KIND, schemaVersion: "unsupported", serviceKey: "svc", descriptor: {} }, "schemaVersion must be"],
    [{ kind: PORTABLE_UPSTREAM_SERVICE_KIND, schemaVersion: PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION, serviceKey: "", descriptor: {} }, "serviceKey must be a canonical non-empty service key"],
    [{ kind: PORTABLE_UPSTREAM_SERVICE_KIND, schemaVersion: PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION, serviceKey: "svc", descriptor: {}, extra: true }, "Unknown top-level field(s): extra"],
  ])("rejects invalid strict envelopes without producing a draft", (input?: any, message?: any) : any => {
    expect(() : any => parsePortableUpstreamServiceImport(JSON.stringify(input))).toThrow(message);
  });

  it.each([
    [{ baseUrl: "https://service.invalid:443", operations: [{ operationKey: "x", method: "GET", path: "/" }] }, "serviceProtocol"],
    [{ serviceProtocol: "ftp", baseUrl: "https://service.invalid:443", operations: [{}] }, "serviceProtocol"],
    [{ serviceProtocol: "http", baseUrl: "https://service.invalid", operations: [{}] }, "explicit port"],
    [{ serviceProtocol: "http", endpoints: [{ baseUrl: "https://service.invalid" }], operations: [{}] }, "explicit port"],
    [{ serviceProtocol: "http", baseUrl: "https://service.invalid:443", operations: [] }, "at least one explicit HTTP operation"],
    [{ serviceProtocol: "http", baseUrl: "https://service.invalid:443", operations: [{}], unsupported: true }, "Unknown descriptor field(s): unsupported"],
  ])("rejects unsafe or incomplete descriptors", (descriptor?: any, message?: any) : any => {
    expect(() : any => parsePortableUpstreamServiceImport(JSON.stringify({
      kind: PORTABLE_UPSTREAM_SERVICE_KIND,
      schemaVersion: PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION,
      serviceKey: "svc",
      descriptor,
    }))).toThrow(message);
  });
});
