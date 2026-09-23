import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyGatewayMigration, previewGatewayMigration, restoreGatewayMigration } from "../../../../tools/server-scripts/migrate-gateway-config.ts";

const directories: string[] = [];
async function source(value: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-migration-closure-"));
  directories.push(directory);
  const file = join(directory, "configuration.json");
  await writeFile(file, value, { mode: 0o600 });
  return file;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("original migration owner", () => {
  it("[GC-052] never transforms unknown roots into empty services", async () => {
    const bytes = '{"unknown":{"test":true}}\n';
    const file = await source(bytes);
    const preview = await previewGatewayMigration(file);
    expect(preview.errors).toContain("services or service must be present in a supported gateway configuration");
    await expect(applyGatewayMigration(file, { expectedRevision: preview.sourceRevision })).rejects.toMatchObject({ code: "gateway_migration_rejected" });
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it("[GC-053 GC-054 GC-055] retains stdio settings, fences stale previews, preserves earliest backup and restores exact bytes", async () => {
    const bytes = `${JSON.stringify({ services: [{ serviceKey: "local", transport: "stdio", command: "node", args: ["peer.mjs"], credentialBinding: "synthetic-ref", rpcMethod: "POST" }] })}\n`;
    const file = await source(bytes);
    const first = await previewGatewayMigration(file);
    expect(first.errors).toEqual([]);
    await expect(applyGatewayMigration(file)).rejects.toMatchObject({ code: "gateway_migration_preview_required" });
    const applied = await applyGatewayMigration(file, { expectedRevision: first.sourceRevision });
    expect(applied.applied).toBe(true);
    const migrated = JSON.parse(await readFile(file, "utf8"));
    expect(migrated.services[0]).toMatchObject({ serviceId: "local", transport: "stdio", command: "node", credentialBinding: "synthetic-ref", method: "POST" });
    expect(migrated.services[0]).not.toHaveProperty("baseUrl");
    await expect(applyGatewayMigration(file, { expectedRevision: first.sourceRevision })).rejects.toMatchObject({ code: "gateway_migration_rejected" });
    const after = await previewGatewayMigration(file);
    expect((await applyGatewayMigration(file, { expectedRevision: after.sourceRevision })).applied).toBe(false);
    expect(await readFile(`${file}.backup`, "utf8")).toBe(bytes);
    expect((await restoreGatewayMigration(file, { expectedRevision: after.sourceRevision, backupRevision: first.sourceRevision })).applied).toBe(true);
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it("[GC-054] admits at most one of two concurrent applies with the same digest", async () => {
    const file = await source('{"services":[{"serviceKey":"local","endpoint":"http://127.0.0.1","rpcMethod":"POST"}]}\n');
    const preview = await previewGatewayMigration(file);
    const results = await Promise.allSettled([applyGatewayMigration(file, { expectedRevision: preview.sourceRevision }), applyGatewayMigration(file, { expectedRevision: preview.sourceRevision })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(JSON.parse(await readFile(file, "utf8")).services[0].serviceId).toBe("local");
  });

  it("[GC-055] rejects directory, symlink, wrong bytes and broken provenance before replacing source", async () => {
    const bytes = '{"services":[{"serviceKey":"first","transport":"stdio","command":"node"}]}\n';
    for (const kind of ["directory", "symlink", "wrong-bytes"] as const) {
      const file = await source(bytes);
      const backup = `${file}.backup`;
      if (kind === "directory") await mkdir(backup);
      else if (kind === "symlink") await symlink(file, backup);
      else await writeFile(backup, '{"services":[{"serviceId":"other","transport":"stdio","command":"node"}]}\n', { mode: 0o600 });
      const preview = await previewGatewayMigration(file);
      await expect(applyGatewayMigration(file, { expectedRevision: preview.sourceRevision })).rejects.toMatchObject({ code: expect.stringMatching(/^gateway_migration_backup_/) });
      expect(await readFile(file, "utf8")).toBe(bytes);
    }
    const file = await source(bytes);
    const preview = await previewGatewayMigration(file);
    await applyGatewayMigration(file, { expectedRevision: preview.sourceRevision });
    const migrated = await previewGatewayMigration(file);
    const object = `${file}.backup.${preview.sourceRevision.replace(":", "-")}`;
    expect(await readFile(object, "utf8")).toBe(bytes);
    const receipt = JSON.parse(await readFile(`${file}.backup.receipt.json`, "utf8"));
    expect(receipt).toMatchObject({ sourceRevision: preview.sourceRevision, targetRevision: migrated.sourceRevision, objectRevision: preview.sourceRevision });
    await writeFile(object, "tampered", { mode: 0o600 });
    await expect(restoreGatewayMigration(file, { expectedRevision: migrated.sourceRevision, backupRevision: preview.sourceRevision })).rejects.toMatchObject({ code: "gateway_migration_backup_conflict" });
    expect((await previewGatewayMigration(file)).sourceRevision).toBe(migrated.sourceRevision);
  });

  it("[GC-055] cleans partial atomic writes and rename failures, leaving a usable earliest backup", async () => {
    const bytes = '{"services":[{"serviceKey":"first","transport":"stdio","command":"node"}]}\n';
    const file = await source(bytes);
    const first = await previewGatewayMigration(file);
    await expect(applyGatewayMigration(file, { expectedRevision: first.sourceRevision, atomicIO: { rename: async () => { throw new Error("synthetic rename failure"); } } })).rejects.toThrow("synthetic rename failure");
    expect(await readFile(file, "utf8")).toBe(bytes);
    expect((await readdir(file.slice(0, file.lastIndexOf("/")))).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
    expect(await readFile(`${file}.backup`, "utf8")).toBe(bytes);
    await applyGatewayMigration(file, { expectedRevision: first.sourceRevision });
    const migrated = await previewGatewayMigration(file);
    await expect(restoreGatewayMigration(file, { expectedRevision: migrated.sourceRevision, backupRevision: first.sourceRevision, atomicIO: {
      write: async (handle, input) => { await handle.writeFile(input.subarray(0, 3)); throw new Error("synthetic partial write failure"); }
    } })).rejects.toThrow("synthetic partial write failure");
    expect((await previewGatewayMigration(file)).sourceRevision).toBe(migrated.sourceRevision);
    expect((await readdir(file.slice(0, file.lastIndexOf("/")))).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
    expect((await restoreGatewayMigration(file, { expectedRevision: migrated.sourceRevision, backupRevision: first.sourceRevision })).applied).toBe(true);
    expect(await readFile(file, "utf8")).toBe(bytes);
    expect((await restoreGatewayMigration(file, { expectedRevision: first.sourceRevision, backupRevision: first.sourceRevision })).applied).toBe(false);
  });
});
