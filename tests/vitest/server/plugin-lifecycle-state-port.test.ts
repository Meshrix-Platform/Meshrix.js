import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPluginLifecycleStatePort
} from "../../../packages/foundation/src/module-system/plugin-lifecycle-state-port.ts";

const execFile: any = promisify(execFileCallback);
const roots: any[] = [];
const POLICY: Readonly<Record<string, any>> = Object.freeze({
  heartbeatIntervalMs: 20,
  leaseDurationMs: 60,
  staleThresholdMs: 120
});

async function fixture(pluginId: any = "alpha") : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-lifecycle-state-port-"));
  roots.push(root);
  const userDataPath: any = path.join(root, "data");
  await fs.mkdir(userDataPath);
  const port: any = await createPluginLifecycleStatePort({ userDataPath, pluginId, lockPolicy: POLICY });
  const stateRoot: any = path.join(userDataPath, "plugin-lifecycle", pluginId);
  return { root, userDataPath, stateRoot, leasePath: path.join(stateRoot, "lease"), port };
}

function leaseRecord(pluginId?: any, ownerToken?: any) : any {
  return {
    kind: "plugin-lifecycle-lease",
    pluginId,
    ownerToken,
    acquiredAtMs: Date.now(),
    leaseDurationMs: POLICY.leaseDurationMs,
    staleThresholdMs: POLICY.staleThresholdMs,
    heartbeatIntervalMs: POLICY.heartbeatIntervalMs
  };
}

async function writeLease(leasePath?: any, pluginId?: any, ownerToken?: any) : Promise<any> {
  await fs.mkdir(leasePath, { mode: 0o700 });
  await fs.writeFile(
    path.join(leasePath, "owner.json"),
    `${JSON.stringify(leaseRecord(pluginId, ownerToken))}\n`,
    { mode: 0o600 }
  );
}

async function contendFromProcess(userDataPath?: any, pluginId: any = "alpha") : Promise<any> {
  const moduleUrl: any = pathToFileURL(path.resolve(
    import.meta.dirname,
    "../../../packages/foundation/src/module-system/plugin-lifecycle-state-port.ts"
  )).href;
  const script: any = `
    import { createPluginLifecycleStatePort } from ${JSON.stringify(moduleUrl)};
    const port = await createPluginLifecycleStatePort({
      userDataPath: process.argv.at(-2),
      pluginId: process.argv.at(-1),
      lockPolicy: ${JSON.stringify(POLICY)}
    });
    try {
      await port.runExclusive(async () => {});
      process.stdout.write(JSON.stringify({ acquired: true }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ acquired: false, code: error?.code || "unknown" }));
    }
  `;
  const { stdout } = await execFile(process.execPath, [
    "--input-type=module", "-e", script, userDataPath, pluginId
  ]);
  return JSON.parse(stdout);
}

async function leaveCrashLease(userDataPath?: any, pluginId: any = "alpha") : Promise<any> {
  const moduleUrl: any = pathToFileURL(path.resolve(
    import.meta.dirname,
    "../../../packages/foundation/src/module-system/plugin-lifecycle-state-port.ts"
  )).href;
  const script: any = `
    import fs from "node:fs";
    import { createPluginLifecycleStatePort } from ${JSON.stringify(moduleUrl)};
    const port = await createPluginLifecycleStatePort({
      userDataPath: process.argv.at(-2),
      pluginId: process.argv.at(-1),
      lockPolicy: ${JSON.stringify(POLICY)}
    });
    await port.runExclusive(async () => {
      fs.writeSync(1, "lease-acquired");
      process.exit(0);
    });
  `;
  const { stdout } = await execFile(process.execPath, [
    "--input-type=module", "-e", script, userDataPath, pluginId
  ]);
  return stdout;
}

afterEach(async () : Promise<any> => {
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("PluginLifecycleStatePort durable filesystem lease", () : any => {
  it("keeps records bounded, immutable, private, regular, and no-follow", async () : Promise<any> => {
    const input: any = await fixture();
    await input.port.writeRecord("journal", { state: "in_progress", nested: { step: 1 } });
    const record: any = await input.port.readRecord("journal");
    expect(Object.isFrozen(record.nested)).toBe(true);
    expect(() : any => { record.nested.step = 2; }).toThrow();
    expect((await fs.stat(path.join(input.stateRoot, "journal.json"))).mode & 0o777).toBe(0o600);
    await expect(input.port.writeRecord("journal", { payload: "x".repeat(70_000) }))
      .rejects.toThrow(/bounded size/u);

    const whitespaceSensitiveRecord: any = Object.fromEntries(
      Array.from({ length: 4_000 }, (_?: any, index?: any) : any => [`field${index}`, "x"])
    );
    expect(Buffer.byteLength(JSON.stringify(whitespaceSensitiveRecord), "utf8")).toBeLessThanOrEqual(64 * 1024);
    await input.port.writeRecord("journal", whitespaceSensitiveRecord);
    await expect(input.port.readRecord("journal")).resolves.toEqual(whitespaceSensitiveRecord);

    await fs.symlink(path.join(input.stateRoot, "journal.json"), path.join(input.stateRoot, "ledger.json"));
    await expect(input.port.readRecord("ledger"))
      .rejects.toMatchObject({ code: "PLUGIN_LIFECYCLE_STATE_READ_FAILED" });
    await expect(input.port.writeRecord("ledger", { state: "inactive" }))
      .rejects.toMatchObject({ code: "PLUGIN_LIFECYCLE_STATE_WRITE_FAILED" });
  });

  it("serializes same-process callers across two port instances", async () : Promise<any> => {
    const input: any = await fixture();
    const second: any = await createPluginLifecycleStatePort({
      userDataPath: input.userDataPath,
      pluginId: "alpha",
      lockPolicy: POLICY
    });
    const events: any[] = [];
    let releaseFirst: any;
    const gate: any = new Promise((resolve?: any) : any => { releaseFirst = resolve; });
    const first: any = input.port.runExclusive(async () : Promise<any> => {
      events.push("first:start");
      await gate;
      await input.port.writeRecord("journal", { owner: "first" });
      events.push("first:end");
    });
    const queued: any = second.runExclusive(async () : Promise<any> => {
      events.push("second:start");
      await second.writeRecord("journal", { owner: "second" });
      events.push("second:end");
    });
    await new Promise((resolve?: any) : any => setTimeout(resolve, POLICY.heartbeatIntervalMs * 2));
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, queued]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    await expect(second.readRecord("journal")).resolves.toEqual({ owner: "second" });
  });

  it("reuses the same owned lease for nested transactions on the same plugin root", async () : Promise<any> => {
    const input: any = await fixture();
    const second: any = await createPluginLifecycleStatePort({
      userDataPath: input.userDataPath,
      pluginId: "alpha",
      lockPolicy: POLICY
    });
    const owners: any[] = [];
    await input.port.runExclusive(async () : Promise<any> => {
      owners.push(JSON.parse(await fs.readFile(path.join(input.leasePath, "owner.json"), "utf8")).ownerToken);
      await second.runExclusive(async () : Promise<any> => {
        owners.push(JSON.parse(await fs.readFile(path.join(input.leasePath, "owner.json"), "utf8")).ownerToken);
        await second.writeRecord("journal", { nested: true });
      });
      await input.port.writeRecord("ledger", { outer: true });
    });
    expect(owners).toHaveLength(2);
    expect(owners[0]).toBe(owners[1]);
    await expect(input.port.readRecord("journal")).resolves.toEqual({ nested: true });
    await expect(input.port.readRecord("ledger")).resolves.toEqual({ outer: true });
  });

  it("does not publish a canonical lease when acquisition fails before the owner record write", async () : Promise<any> => {
    const input: any = await fixture();
    const failing: any = await createPluginLifecycleStatePort({
      userDataPath: input.userDataPath,
      pluginId: "alpha",
      lockPolicy: {
        ...POLICY,
        now() : any {
          throw new Error("injected acquisition failure");
        }
      }
    });
    await expect(failing.runExclusive(async () : Promise<any> => {}))
      .rejects.toMatchObject({ code: "PLUGIN_LIFECYCLE_DURABILITY_FAILED" });
    await expect(fs.access(input.leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(input.stateRoot)).filter((name?: any) : any => name.startsWith("lease.acquire-")))
      .toEqual([]);

    await input.port.runExclusive(() : any => input.port.writeRecord("journal", { recovered: true }));
    await expect(input.port.readRecord("journal")).resolves.toEqual({ recovered: true });
  });

  it("rejects a live cross-process contender while heartbeat keeps the lease fresh", async () : Promise<any> => {
    const input: any = await fixture();
    let contention: any;
    await input.port.runExclusive(async () : Promise<any> => {
      await new Promise((resolve?: any) : any => setTimeout(resolve, POLICY.staleThresholdMs + 40));
      contention = await contendFromProcess(input.userDataPath);
    });
    expect(contention).toEqual({ acquired: false, code: "PLUGIN_LIFECYCLE_BUSY" });
  });

  it("takes over a stale crash lease and preserves private lease modes", async () : Promise<any> => {
    const input: any = await fixture();
    await writeLease(input.leasePath, "alpha", "a".repeat(64));
    const staleAt: any = new Date(Date.now() - POLICY.staleThresholdMs - 50);
    await fs.utimes(input.leasePath, staleAt, staleAt);
    let modes: any;
    await input.port.runExclusive(async () : Promise<any> => {
      modes = [
        (await fs.stat(input.leasePath)).mode & 0o777,
        (await fs.stat(path.join(input.leasePath, "owner.json"))).mode & 0o777
      ];
      await input.port.writeRecord("ledger", { state: "removal_pending" });
    });
    expect(modes).toEqual([0o700, 0o600]);
    await expect(fs.access(input.leasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(input.port.readRecord("ledger")).resolves.toEqual({ state: "removal_pending" });
  });

  it("recovers a lease left by a terminated process", async () : Promise<any> => {
    const input: any = await fixture();
    await expect(leaveCrashLease(input.userDataPath)).resolves.toBe("lease-acquired");
    await expect(fs.access(path.join(input.leasePath, "owner.json"))).resolves.toBeUndefined();
    const staleAt: any = new Date(Date.now() - POLICY.staleThresholdMs - 50);
    await fs.utimes(input.leasePath, staleAt, staleAt);

    await input.port.runExclusive(() : any => input.port.writeRecord("journal", { recovered: true }));

    await expect(input.port.readRecord("journal")).resolves.toEqual({ recovered: true });
    await expect(fs.access(input.leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for malformed stale lease metadata", async () : Promise<any> => {
    const input: any = await fixture();
    await fs.mkdir(input.leasePath, { mode: 0o700 });
    await fs.writeFile(path.join(input.leasePath, "owner.json"), "{\"unexpected\":true}\n", { mode: 0o600 });
    const staleAt: any = new Date(Date.now() - POLICY.staleThresholdMs - 50);
    await fs.utimes(input.leasePath, staleAt, staleAt);
    await expect(input.port.runExclusive(async () : Promise<any> => {}))
      .rejects.toMatchObject({ code: "PLUGIN_LIFECYCLE_LOCK_INVALID" });
    await expect(fs.access(input.leasePath)).resolves.toBeUndefined();
  });

  it("checks the owner fence immediately before commit and preserves a foreign lease", async () : Promise<any> => {
    const input: any = await fixture();
    const displaced: any = `${input.leasePath}.displaced`;
    let commitCode: any = "";
    await expect(input.port.runExclusive(async () : Promise<any> => {
      await fs.rename(input.leasePath, displaced);
      await writeLease(input.leasePath, "alpha", "b".repeat(64));
      try {
        await input.port.writeRecord("ledger", { state: "inactive" });
      } catch (error: any) {
        commitCode = error?.code || "unknown";
      }
    })).rejects.toMatchObject({ code: "PLUGIN_LIFECYCLE_LOCK_FENCE_LOST" });
    expect(commitCode).toBe("PLUGIN_LIFECYCLE_LOCK_FENCE_LOST");
    await expect(input.port.readRecord("ledger")).resolves.toBeNull();
    expect(JSON.parse(await fs.readFile(path.join(input.leasePath, "owner.json"), "utf8")))
      .toMatchObject({ ownerToken: "b".repeat(64) });
  });
});
