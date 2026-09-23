import { describe, expect, it } from "vitest";
import { runGatewayOnly } from "../../../../apps/mcp-gateway-installer/src/cli.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("gateway-only CLI profile", () => {
  it("[CASE-A07] supports dry-run and clean health/close without optional services", async () => {
    await expect(runGatewayOnly({ dryRun: true })).resolves.toEqual({ profile: "gateway-only", health: "dry-run" });
    await expect(runGatewayOnly({ health: true })).resolves.toEqual({ profile: "gateway-only", health: "ok" });
  });
  it("[GC-058 partial] rejects public endpoints and inline credentials even in dry-run configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-gateway-cli-config-"));
    const config = join(directory, "config.json");
    try {
      await writeFile(config, JSON.stringify({ profile: "local", services: [{ serviceId: "remote", baseUrl: "https://outside.invalid/mcp" }] }));
      await expect(runGatewayOnly({ dryRun: true, config })).rejects.toMatchObject({ code: "gateway_target_unsafe" });
      await writeFile(config, JSON.stringify({ profile: "local", services: [{ serviceId: "local", baseUrl: "http://127.0.0.1:1122/mcp", authorization: "Bearer synthetic" }] }));
      await expect(runGatewayOnly({ dryRun: true, config })).rejects.toMatchObject({ code: "gateway_credential_invalid" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
