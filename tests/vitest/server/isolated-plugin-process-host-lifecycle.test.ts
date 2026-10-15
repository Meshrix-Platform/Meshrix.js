import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const forkHarness: any = vi.hoisted(() => {
  class MiniEmitter {
    handlers = new Map<any, any[]>();

    on(event: any, handler: any) {
      const handlers = this.handlers.get(event) || [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    once(event: any, handler: any) {
      const wrapped = (...args: any[]) => {
        this.off(event, wrapped);
        handler(...args);
      };
      wrapped.listener = handler;
      return this.on(event, wrapped);
    }

    off(event: any, handler: any) {
      this.handlers.set(event, (this.handlers.get(event) || []).filter((current) => current !== handler && current.listener !== handler));
      return this;
    }

    emit(event: any, ...args: any[]) {
      for (const handler of [...(this.handlers.get(event) || [])]) handler(...args);
    }
  }

  const harness: any = { children: [], fork: null, readyOnFork: false };
  harness.fork = vi.fn(() => {
    const child: any = new MiniEmitter();
    child.pid = 42_424;
    child.exitCode = null;
    child.signalCode = null;
    child.send = vi.fn();
    child.kill = vi.fn((signal: string) => {
      if (harness.closeOnKill) {
        queueMicrotask(() => {
          child.emit("exit", null, signal);
          child.emit("close", null, signal);
        });
      }
      return true;
    });
    harness.children.push(child);
    if (harness.readyOnFork) queueMicrotask(() => child.emit("message", { type: "plugin-process.ready" }));
    return child;
  });
  harness.closeOnKill = false;
  return harness;
});

vi.mock("node:child_process", async (importOriginal: any) => ({
  ...await importOriginal(),
  fork: forkHarness.fork
}));

import { PLUGIN_MANIFEST_SCHEMA_VERSION } from "../../../packages/foundation/src/module-system/plugin-registry.ts";
import { createMountManager } from "../../../packages/foundation/src/module-system/mount-manager.ts";
import { createIsolatedPluginProcessHost } from "../../../packages/foundation/src/module-system/isolated-plugin-process-host.ts";
import { stagePluginArtifactFixture } from "./support/plugin-artifact-authority-fixture.ts";

const temporaryRoots: string[] = [];
const artifactFixtures: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  forkHarness.closeOnKill = true;
  forkHarness.readyOnFork = false;
  for (const child of forkHarness.children) {
    child.emit("exit", null, "SIGTERM");
    child.emit("close", null, "SIGTERM");
  }
  await Promise.allSettled(artifactFixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  forkHarness.children.length = 0;
  vi.useRealTimers();
});

describe("isolated plugin process ownership", () => {
  it("starts without an unselected cutoff and holds close until the child exits", async () => {
    vi.useFakeTimers();
    const starting = createIsolatedPluginProcessHost();
    const child = forkHarness.children[0];
    let startSettled = false;
    void starting.then(() => { startSettled = true; }, () => { startSettled = true; });

    await vi.advanceTimersByTimeAsync(30_001);
    expect(startSettled).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("message", { type: "plugin-process.ready" });
    const host = await starting;

    const closing = host.close();
    let closeSettled = false;
    void closing.then(() => { closeSettled = true; });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(closeSettled).toBe(false);
    child.emit("exit", null, "SIGTERM");
    child.emit("close", null, "SIGTERM");
    await closing;
    expect(closeSettled).toBe(true);
  });

  it("waits for child exit after an explicitly selected startup budget expires", async () => {
    vi.useFakeTimers();
    forkHarness.closeOnKill = false;
    const starting = createIsolatedPluginProcessHost({ startupTimeoutMs: 25 });
    const child = forkHarness.children[0];
    let startSettled = false;
    void starting.then(() => { startSettled = true; }, () => { startSettled = true; });

    await vi.advanceTimersByTimeAsync(25);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(startSettled).toBe(false);
    child.emit("exit", null, "SIGTERM");
    child.emit("close", null, "SIGTERM");
    await expect(starting).rejects.toMatchObject({ code: "plugin_process_startup_cancelled" });
  });

  it("closes the fallback process host when plugin activation fails before runtime ownership", async () => {
    forkHarness.closeOnKill = false;
    forkHarness.readyOnFork = true;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-startup-rollback-"));
    temporaryRoots.push(root);
    const pluginRoot = path.join(root, "plugins", "alpha");
    const dataRoot = path.join(root, "data");
    await fs.mkdir(pluginRoot, { recursive: true });
    await fs.mkdir(dataRoot, { recursive: true });
    await fs.writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({
      schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
      id: "alpha",
      label: "alpha",
      version: "0.0.1",
      defaultEnabled: false,
      dependencies: [],
      operations: [],
      routes: [],
      mcpTools: [],
      consoleEntries: [],
      stateMachines: [],
      verifierHooks: [],
      runtime: { module: "./runtime.mjs" }
    }), "utf8");
    await fs.writeFile(path.join(pluginRoot, "runtime.mjs"), "export async function activatePlugin() { return {}; }\n", "utf8");
    const fixture = await stagePluginArtifactFixture({
      sourcePluginRoot: path.join(root, "plugins"),
      lifecycleDataRoot: dataRoot
    });
    artifactFixtures.push(fixture);

    const startup = createMountManager({
      userDataPath: dataRoot,
      runtimeOptions: { cwd: root, enabledPlugins: ["alpha"] },
      pluginHostPorts: {
        artifactAuthority: fixture.authority,
        pluginInvocationAuthorizationAuthority: {
          id: "PluginInvocationAuthorizationAuthority",
          registerOwner() { throw new Error("synthetic activation failure"); }
        }
      }
    });
    const child = await vi.waitFor(() => {
      expect(forkHarness.children).toHaveLength(1);
      return forkHarness.children[0];
    });
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
    let startupSettled = false;
    void startup.then(() => { startupSettled = true; }, () => { startupSettled = true; });
    await Promise.resolve();
    expect(startupSettled).toBe(false);
    child.emit("exit", null, "SIGTERM");
    child.emit("close", null, "SIGTERM");

    await expect(startup).rejects.toThrow("Plugin alpha failed during context construction.");
  });
});
