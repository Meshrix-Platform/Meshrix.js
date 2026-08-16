import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PLUGIN_CONSOLE_ISOLATION_BRIDGE_VERSION,
  PLUGIN_CONSOLE_ISOLATION_SANDBOX,
  admitPluginConsoleIsolationVerification,
  registerPluginConsoleIsolationVerification
} from "../../../packages/foundation/src/module-system/plugin-console-isolation.ts";
import {
  loadPluginRegistry,
  PLUGIN_MANIFEST_SCHEMA_VERSION
} from "../../../packages/foundation/src/module-system/plugin-registry.ts";
import { activatePluginDeployment } from "../../../packages/foundation/src/module-system/plugin-runtime.ts";
import { stagePluginArtifactFixture } from "./support/plugin-artifact-authority-fixture.ts";

const roots: any[] = [];
const fixtures: any[] = [];

afterEach(async () : Promise<any> => {
  await Promise.all(fixtures.splice(0).map((fixture?: any) : any => fixture.close()));
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

function manifest(id?: any, patch: Record<string, any> = {}) : any {
  return {
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    id,
    label: id,
    version: "0.0.1",
    defaultEnabled: false,
    dependencies: [],
    features: [],
    operations: ["sample-plugin.inspect"],
    routes: [],
    mcpTools: [],
    consoleEntries: ["admin.sample-plugin"],
    stateMachines: [],
    verifierHooks: [],
    runtime: { module: "./runtime.mjs" },
    ...patch
  };
}

describe("plugin console isolation verification", () : any => {
  it("registers verified plugin Console isolation and revalidates identity", () : any => {
    const record: any = registerPluginConsoleIsolationVerification({
      pluginId: "sample-plugin",
      enabled: true,
      consoleEntryIds: ["admin.sample-plugin"],
      artifactDigest: `sha256:${"a".repeat(64)}`,
      artifactGeneration: 1,
      ownedToolIds: ["sample-plugin.inspect"],
      toolIdsByEntry: { "admin.sample-plugin": ["sample-plugin.inspect"] }
    });
    expect(record).toMatchObject({
      schemaVersion: PLUGIN_CONSOLE_ISOLATION_BRIDGE_VERSION,
      sandbox: PLUGIN_CONSOLE_ISOLATION_SANDBOX,
      pluginId: "sample-plugin",
      artifactGeneration: 1
    });
    expect(admitPluginConsoleIsolationVerification(record, {
      pluginId: "sample-plugin",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      artifactGeneration: 1
    })).toBe(record);
  });

  it("fails closed without verified registration or foreign tools", () : any => {
    expect(() : any => registerPluginConsoleIsolationVerification({
      pluginId: "sample-plugin",
      enabled: true,
      consoleEntryIds: ["admin.sample-plugin"],
      artifactDigest: "",
      artifactGeneration: 1
    })).toThrow(/verified artifact identity/u);
    expect(() : any => registerPluginConsoleIsolationVerification({
      pluginId: "sample-plugin",
      enabled: false,
      consoleEntryIds: ["admin.sample-plugin"],
      artifactDigest: `sha256:${"a".repeat(64)}`,
      artifactGeneration: 1
    })).toThrow(/enabled verified plugin/u);
    expect(() : any => registerPluginConsoleIsolationVerification({
      pluginId: "sample-plugin",
      enabled: true,
      consoleEntryIds: ["admin.sample-plugin"],
      artifactDigest: `sha256:${"a".repeat(64)}`,
      artifactGeneration: 1,
      ownedToolIds: ["sample-plugin.inspect"],
      toolIdsByEntry: { "admin.sample-plugin": ["other-plugin.secret"] }
    })).toThrow(/owned by the same plugin/u);
  });

  it("requires verified plugin registration before Console contributions activate", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-console-isolation-"));
    roots.push(root);
    const directory: any = path.join(root, "plugins", "sample-plugin");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "plugin.json"), `${JSON.stringify(manifest("sample-plugin"), null, 2)}\n`);
    await fs.writeFile(path.join(directory, "runtime.mjs"), `
export async function activatePlugin({ manifest }) {
  return {
    id: manifest.id,
    mounts: {},
    contributions: {
      operations: { "sample-plugin.inspect": async () => ({ ok: true }) },
      consoleEntries: { "admin.sample-plugin": { component: "AdminView" } }
    },
    close() {}
  };
}
`);
    const fixture: any = await stagePluginArtifactFixture({ sourcePluginRoot: path.join(root, "plugins") });
    fixtures.push(fixture);
    const registry: any = await loadPluginRegistry({ artifactAuthority: fixture.authority });
    await expect(activatePluginDeployment({
      deployment: registry.resolveDeployment({ enabledPluginIds: ["sample-plugin"] }),
      createContext: () : any => ({
        lifecycleStatePort: fixture.installed.get("sample-plugin").lifecycleStatePort
      })
    })).rejects.toMatchObject({
      code: "PLUGIN_RUNTIME_ACTIVATION_FAILED",
      stage: "activation contract validation"
    });
  });
});
