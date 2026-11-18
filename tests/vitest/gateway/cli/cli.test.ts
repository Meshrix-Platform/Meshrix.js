import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig, runGatewayOnly } from "../../../../apps/mcp-gateway-installer/src/cli.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const canned1 = `Bearer ${randomUUID()}`;




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
      await writeFile(config, JSON.stringify({ profile: "local", services: [{ serviceId: "local", baseUrl: "http://127.0.0.1:1122/mcp", authorization: canned1 }] }));
      await expect(runGatewayOnly({ dryRun: true, config })).rejects.toMatchObject({ code: "gateway_credential_invalid" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("[GC-058 partial] refuses a non-loopback remote listener without an explicit edge-TLS opt-in", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-gateway-cli-remote-listen-"));
    const config = join(directory, "config.json");
    const previous = process.env.MESH_TEST_LISTEN_TOKEN;
    process.env.MESH_TEST_LISTEN_TOKEN = randomUUID();
    const remote = (listen: Record<string, unknown>) => JSON.stringify({
      profile: "remote", listen,
      remoteAuth: { bearerToken: "env:MESH_TEST_LISTEN_TOKEN", allowedServiceIds: ["alpha"] },
      services: [{ serviceId: "alpha", baseUrl: "https://upstream.example/mcp", allowedHosts: ["upstream.example"] }]
    });
    try {
      await writeFile(config, remote({ host: "0.0.0.0" }));
      await expect(loadConfig(config)).rejects.toMatchObject({ code: "gateway_listen_unsafe" });
      await writeFile(config, remote({ host: "::" }));
      await expect(loadConfig(config)).rejects.toMatchObject({ code: "gateway_listen_unsafe" });
      await writeFile(config, remote({ host: "0.0.0.0", edgeTlsTermination: true }));
      await expect(loadConfig(config)).resolves.toMatchObject({ listen: { host: "0.0.0.0" } });
      await writeFile(config, remote({ host: "127.0.0.1" }));
      await expect(loadConfig(config)).resolves.toMatchObject({ listen: { host: "127.0.0.1" } });
    } finally {
      if (previous === undefined) delete process.env.MESH_TEST_LISTEN_TOKEN; else process.env.MESH_TEST_LISTEN_TOKEN = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
