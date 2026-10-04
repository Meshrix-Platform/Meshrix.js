import { describe, expect, it } from "vitest";
import { collectOpaqueStream, MemoryArtifactStore, normalizeBaseUrl, normalizeMethod, projectCustomFields } from "@meshrix/gateway";

describe("gateway transit and service configuration", () => {
  it("[CASE-B06] [CASE-T01] [CASE-T02] [CASE-T04] preserves opaque bytes, enforces budgets, and supports owner-bound ranges", async () => {
    const collected = await collectOpaqueStream((async function* () { yield new Uint8Array([1, 2]); yield new Uint8Array([3]); })(), { maxBytes: 3 });
    expect([...collected.bytes]).toEqual([1, 2, 3]);
    await expect(collectOpaqueStream((async function* () { yield new Uint8Array([1, 2, 3, 4]); })(), { maxBytes: 3 })).rejects.toMatchObject({ code: "transit_budget_exceeded" });
    const store = new MemoryArtifactStore();
    const artifact = store.put({ owner: "principal-demo", bytes: new Uint8Array([10, 11, 12]), contentType: "application/octet-stream" });
    expect(store.head(artifact.id, "principal-demo").length).toBe(3);
    expect([...store.read(artifact.id, "principal-demo", { start: 1, end: 3 })]).toEqual([11, 12]);
    expect(() => store.read(artifact.id, "other-principal")).toThrowError(/not authorized/u);
  });

  it("[CASE-T05] [CASE-T06] accepts default URL ports, validates methods, and applies only declared custom fields", () => {
    expect(normalizeBaseUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeMethod("HEAD")).toBe("HEAD");
    expect(() => normalizeMethod("not a method")).toThrowError(/invalid/u);
    const config = { serviceId: "service", baseUrl: "https://example.com", method: "POST", customFields: { "x-request-id": "r1", timeout: 3 }, customFieldDescriptors: [{ name: "x-request-id", type: "string", location: "header" as const }, { name: "timeout", type: "number" as const, location: "query" as const }] };
    expect(projectCustomFields(config)).toEqual({ headers: {}, query: {}, body: {} });
    expect(projectCustomFields(config, config.customFields)).toEqual({ headers: { "x-request-id": "r1" }, query: { timeout: "3" }, body: {} });
  });
});
