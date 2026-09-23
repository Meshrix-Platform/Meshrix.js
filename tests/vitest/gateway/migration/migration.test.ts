import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyGatewayMigration, previewGatewayMigration } from "../../../../tools/server-scripts/migrate-gateway-config.ts";

describe("gateway configuration migration", () => {
  it("[CASE-D01] [CASE-D02] previews changes without writing and applies with revision fencing and backup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-gateway-migration-"));
    const input = join(directory, "gateway.json");
    await writeFile(input, `${JSON.stringify({ services: [{ serviceKey: "demo", endpoint: "https://example.com", rpcMethod: "POST" }] })}\n`, { mode: 0o600 });
    const preview = await previewGatewayMigration(input);
    expect(preview.changed).toEqual(["services[0].serviceKey->serviceId", "services[0].endpoint->baseUrl", "services[0].rpcMethod->method", "schemaVersion"]);
    expect(JSON.parse(await readFile(input, "utf8"))).not.toHaveProperty("schemaVersion");
    const applied = await applyGatewayMigration(input, { expectedRevision: preview.sourceRevision });
    expect(applied.applied).toBe(true);
    expect(JSON.parse(await readFile(input, "utf8"))).toMatchObject({ schemaVersion: "v0.0.1:meshrix:gateway-config-1", services: [{ serviceId: "demo", baseUrl: "https://example.com", method: "POST" }] });
    expect((await readFile(`${input}.backup`, "utf8"))).toContain("serviceKey");
  });

  it("[CASE-D03] rejects a stale expected revision and never claims external rollback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-gateway-migration-"));
    const input = join(directory, "gateway.json");
    await writeFile(input, JSON.stringify({ services: [{ serviceId: "demo", baseUrl: "https://example.com", method: "POST" }] }), { mode: 0o600 });
    await expect(applyGatewayMigration(input, { expectedRevision: "stale" })).rejects.toMatchObject({ code: "gateway_migration_rejected" });
  });
});
