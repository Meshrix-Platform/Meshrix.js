import { describe, expect, it } from "vitest";
import { runGatewayOnly } from "../../../../apps/mcp-gateway-installer/src/cli.ts";

describe("gateway-only CLI profile", () => {
  it("[CASE-A07] supports dry-run and clean health/close without optional services", async () => {
    await expect(runGatewayOnly({ dryRun: true })).resolves.toEqual({ profile: "gateway-only", health: "dry-run" });
    await expect(runGatewayOnly({ health: true })).resolves.toEqual({ profile: "gateway-only", health: "ok" });
  });
});

