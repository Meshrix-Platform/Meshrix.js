import fs from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MCP_CATALOG_DELIVERY_SCHEMA_VERSION,
  createMcpCatalogInvalidation,
  normalizeMcpProxySessionId,
  parseMcpCatalogAcknowledgement,
  parseMcpCatalogFacts,
  parseMcpCatalogInvalidation
} from "../../../packages/contracts/src/mcp-catalog-delivery.ts";

const corpus: any = JSON.parse(fs.readFileSync(
  new URL("../../../packages/contracts/src/fixtures/mcp-catalog-delivery-wire-corpus.json", import.meta.url),
  "utf8"
));

describe("MCP catalog delivery wire contract", () : any => {
  it("accepts the frozen positive corpus and emits the canonical invalidation", () : any => {
    expect(normalizeMcpProxySessionId(corpus.valid.proxySessionId)).toBe(corpus.valid.proxySessionId);
    expect(parseMcpCatalogInvalidation(corpus.valid.invalidation)).toEqual(corpus.valid.invalidation);
    expect(parseMcpCatalogFacts(corpus.valid.catalogFacts)).toEqual(corpus.valid.catalogFacts);
    expect(parseMcpCatalogAcknowledgement(corpus.valid.acknowledgement))
      .toEqual(corpus.valid.acknowledgement);
    expect(createMcpCatalogInvalidation({
      ...corpus.valid.invalidation,
      affectedPartitions: ["opaque-partition-a", "opaque-partition-a"]
    })).toEqual(corpus.valid.invalidation);
    expect(corpus.valid.invalidation.schemaVersion).toBe(MCP_CATALOG_DELIVERY_SCHEMA_VERSION);
  });

  it("rejects identity-bearing, catalog-bearing, malformed, and extended wire values", () : any => {
    for (const value of corpus.invalidInvalidations) {
      expect(parseMcpCatalogInvalidation(value)).toBeNull();
    }
    expect(parseMcpCatalogInvalidation({ ...corpus.valid.invalidation, tags: [] })).toBeNull();
    expect(parseMcpCatalogFacts({ ...corpus.valid.catalogFacts, partitionKeys: [] })).toBeNull();
    expect(parseMcpCatalogAcknowledgement({
      ...corpus.valid.acknowledgement,
      partitionKeys: ["opaque-partition-b", "opaque-partition-a"]
    })).toBeNull();
    expect(normalizeMcpProxySessionId("short")).toBe("");
  });
});
