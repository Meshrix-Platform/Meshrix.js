import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPluginProcessHost } from "../../../packages/foundation/src/module-system/isolated-plugin-process-host.mjs";

const roots = [];
const hosts = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("isolated plugin process host", () => {
  it("imports and invokes plugin code outside the main process with bidirectional host RPC", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-isolated-plugin-"));
    roots.push(root);
    const modulePath = path.join(root, "runtime.mjs");
    const marker = "licomesh-isolated-plugin-marker";
    delete globalThis[marker];
    await fs.writeFile(modulePath, `
globalThis[${JSON.stringify(marker)}] = process.pid;
export async function invoke(input) {
  const hostValue = await input.hostPort(input.value);
  return { childPid: process.pid, hostValue };
}
`, "utf8");

    const host = await createIsolatedPluginProcessHost();
    hosts.push(host);
    const runtimeModule = await host.loadModule({ moduleUrl: pathToFileURL(modulePath).href });
    const result = await runtimeModule.invoke({
      value: 7,
      hostPort: async (value) => value * 3
    });

    expect(globalThis[marker]).toBeUndefined();
    expect(result).toEqual({ childPid: host.processId, hostValue: 21 });
    expect(result.childPid).not.toBe(process.pid);
  });
});
