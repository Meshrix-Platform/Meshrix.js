import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMountManager } from "../../../packages/foundation/src/module-system/mount-manager.ts";
import { PLUGIN_MANIFEST_SCHEMA_VERSION } from "../../../packages/foundation/src/module-system/plugin-registry.ts";
import { stagePluginArtifactVerificationFixture } from "../../../tools/server-scripts/lib/plugin-artifact-verification-fixture.ts";
import { createTestPluginProcessHost } from "./support/test-plugin-process-host.ts";

const roots: any[] = [];
const captureKey: any = Symbol.for("meshrix.plugin-data-capability.capture");

async function fixtureRoot() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-data-test-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  return root;
}

async function writePlugin(root?: any, source?: any) : Promise<any> {
  const directory: any = path.join(root, "plugins", "demo");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "plugin.json"), JSON.stringify({
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    id: "demo",
    label: "demo",
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
  await fs.writeFile(path.join(directory, "runtime.mjs"), source, "utf8");
}

async function createManager(root?: any, runtime: Record<string, any> = {}) : Promise<any> {
  await fs.rm(path.join(root, "data", "plugin-lifecycle"), { recursive: true, force: true });
  const artifactFixture: any = await stagePluginArtifactVerificationFixture({
    sourcePluginRoot: path.join(root, "plugins"),
    userDataPath: path.join(root, "data")
  });
  let manager: any;
  try {
    manager = await createMountManager({
      userDataPath: path.join(root, "data"),
      runtimeOptions: { cwd: root, enabledPlugins: ["demo"], ...runtime },
      pluginHostPorts: {
        artifactAuthority: artifactFixture.authority,
        pluginProcessHostForPlugin: () : any => createTestPluginProcessHost()
      }
    });
  } catch (error: any) {
    await artifactFixture.close();
    throw error;
  }
  let closePromise: any = null;
  return Object.freeze({
    ...manager,
    close() : any {
      closePromise ||= (async () : Promise<any> => {
        try {
          return await manager.close();
        } finally {
          await artifactFixture.close();
        }
      })();
      return closePromise;
    }
  });
}

afterEach(async () : Promise<any> => {
  delete globalThis[captureKey];
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("plugin data capability", () : any => {
  it("provides scoped storage operations without exposing a host path", async () : Promise<any> => {
    const root: any = await fixtureRoot();
    globalThis[captureKey] = {};
    await writePlugin(root, `
const capture = globalThis[Symbol.for("meshrix.plugin-data-capability.capture")];
export async function activatePlugin({ manifest, context }) {
  capture.prototype = Object.getPrototypeOf(context.pluginData);
  capture.configurationFrozen = Object.isFrozen(context.configuration);
  capture.configurationNestedFrozen = Object.isFrozen(context.configuration.nested);
  try { context.configuration.nested.value = "changed"; } catch (error) { capture.configurationMutationError = error.name; }
  capture.configurationValue = context.configuration.nested.value;
  capture.keys = Object.keys(context.pluginData);
  capture.json = JSON.stringify(context.pluginData);
  try { capture.primitive = String(context.pluginData); } catch (error) { capture.primitiveError = error.name; }
  capture.cloneKeys = Object.keys(structuredClone(context.pluginData));
  try {
    await context.pluginData.readFile("missing.txt", "utf8");
  } catch (error) {
    capture.missingError = {
      code: error.code,
      message: error.message,
      hasPath: Object.hasOwn(error, "path"),
      hasCause: Object.hasOwn(error, "cause")
    };
  }
  await context.pluginData.writeFile("state/value.txt", "one", "utf8");
  const nested = await context.pluginData.scope("namespaces/demo");
  await nested.writeFile("value.txt", "two", "utf8");
  capture.first = await context.pluginData.readFile("state/value.txt", "utf8");
  capture.second = await nested.readFile("value.txt", "utf8");
  capture.list = await context.pluginData.list("state");
  capture.stat = await context.pluginData.stat("state/value.txt");
  return { id: manifest.id, mounts: {}, close() {} };
}`);

    const manager: any = await createManager(root, {
      deploymentProfileId: "private-runtime",
      pluginConfigurations: { demo: { nested: { value: "original" } } }
    });

    expect(globalThis[captureKey]).toMatchObject({
      prototype: null,
      configurationFrozen: true,
      configurationNestedFrozen: true,
      configurationMutationError: "TypeError",
      configurationValue: "original",
      keys: [],
      json: "{}",
      primitiveError: "TypeError",
      cloneKeys: [],
      missingError: {
        code: "PLUGIN_DATA_NOT_FOUND",
        message: "Plugin data operation did not complete.",
        hasPath: false,
        hasCause: false
      },
      first: "one",
      second: "two",
      list: ["value.txt"],
      stat: { type: "file", size: 3, executable: false }
    });
    expect(manager.plugins.deploymentProfile).toMatchObject({
      id: "private-runtime",
      configuredPluginIds: ["demo"]
    });
    await manager.close();

    if (process.platform !== "win32") {
      const pluginRoot: any = path.join(root, "data", "plugins", "demo");
      expect((await fs.stat(pluginRoot)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(pluginRoot, "state", "value.txt"))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.join(pluginRoot, "namespaces", "demo"))).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects traversal, absolute names, and symlink escapes", async () : Promise<any> => {
    const root: any = await fixtureRoot();
    const outside: any = path.join(root, "outside");
    const pluginRoot: any = path.join(root, "data", "plugins", "demo");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await fs.mkdir(pluginRoot, { recursive: true });
    await fs.symlink(outside, path.join(pluginRoot, "escape"));
    await writePlugin(root, `
export async function activatePlugin({ context }) {
  await context.pluginData.readFile("escape/secret.txt", "utf8");
}
`);

    await expect(createManager(root)).rejects.toMatchObject({
      code: "PLUGIN_RUNTIME_ACTIVATION_FAILED",
      pluginId: "demo",
      stage: "activation"
    });

    await fs.rm(path.join(pluginRoot, "escape"));
    await writePlugin(root, `
export async function activatePlugin({ context }) {
  await context.pluginData.writeFile("../escape.txt", "no");
}
`);
    await expect(createManager(root)).rejects.toMatchObject({
      code: "PLUGIN_RUNTIME_ACTIVATION_FAILED",
      pluginId: "demo",
      stage: "activation"
    });
    await expect(fs.stat(path.join(root, "data", "plugins", "escape.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
