import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedPluginProcessHost } from "../../../packages/foundation/src/module-system/isolated-plugin-process-host.ts";

const roots: any[] = [];
const hosts: any[] = [];

afterEach(async () : Promise<any> => {
  await Promise.all(hosts.splice(0).map((host?: any) : any => host.close()));
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("isolated plugin process host", () : any => {
  it("imports and invokes plugin code outside the main process with bidirectional host RPC", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-isolated-plugin-"));
    roots.push(root);
    const modulePath: any = path.join(root, "runtime.ts");
    const marker: any = "meshrix-isolated-plugin-marker";
    delete globalThis[marker];
    await fs.writeFile(modulePath, `
globalThis[${JSON.stringify(marker)}] = process.pid;
export async function invoke(input) {
  const hostValue = await input.hostPort(input.value);
  return { childPid: process.pid, hostValue };
}
`, "utf8");

    const host: any = await createIsolatedPluginProcessHost();
    hosts.push(host);
    const runtimeModule: any = await host.loadModule({ moduleUrl: pathToFileURL(modulePath).href });
    const result: any = await runtimeModule.invoke({
      value: 7,
      hostPort: async (value?: any) : Promise<any> => value * 3
    });

    expect(globalThis[marker]).toBeUndefined();
    expect(result).toEqual({ childPid: host.processId, hostValue: 21 });
    expect(result.childPid).not.toBe(process.pid);
  });
});
