import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireClientAdapter,
  describeClientAdapter,
  runClientAdapter
} from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/client-adapter-runner.ts";

const tempRoots: any[] = [];
const originalCanary: any = process.env.MESHRIX_MCP_ADAPTER_SECRET_CANARY;

async function fixtureRoot() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-neutral-adapter-"));
  tempRoots.push(root);
  return root;
}

function fixtureInstaller(counter?: any) : any {
  return async (adapter?: any, tree?: any) : Promise<any> => {
    counter.count += 1;
    const packageRoot: any = path.join(tree, "node_modules", ...adapter.packageName.split("/"));
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: adapter.packageName,
      version: adapter.version,
      type: "module"
    }));
    await fs.writeFile(path.join(packageRoot, "adapter.ts"), `
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const request = JSON.parse(input);
      const action = process.argv[2];
      const base = { schemaVersion: "v0.0.1:meshrix:client-adapter-json-stdio-1", ok: true };
      const results = {
        describe: {
          schemaVersion: "v0.0.1:meshrix:client-adapter-descriptor-1",
          protocol: "v0.0.1:meshrix:client-adapter-json-stdio-1",
          target: "codex",
          label: "Neutral client",
          version: "0.0.1",
          packageName: "@meshrix/agent-codex-adapter",
          commandNames: ["neutral-client"],
          locations: ["local"],
          actions: ["describe", "scan", "install", "verify", "uninstall"],
          installMode: "external-client-adapter"
        },
        scan: { available: true, installed: false, secretInherited: Boolean(process.env.MESHRIX_MCP_ADAPTER_SECRET_CANARY) },
        install: { installed: true },
        verify: { installed: true },
        uninstall: { removed: true, installed: false }
      };
      process.stdout.write(JSON.stringify({ ...base, result: results[action], requestSeen: request.schemaVersion }));
    `);
  };
}

afterEach(async () : Promise<any> => {
  await Promise.all(tempRoots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
  if (originalCanary === undefined) delete process.env.MESHRIX_MCP_ADAPTER_SECRET_CANARY;
  else process.env.MESHRIX_MCP_ADAPTER_SECRET_CANARY = originalCanary;
});

describe("external MCP client adapter runner", () : any => {
  it("reuses a digest-verified local cache without reinstalling", async () : Promise<any> => {
    const cacheRoot: any = await fixtureRoot();
    const counter: Record<string, any> = { count: 0 };
    const installPackage: any = fixtureInstaller(counter);
    const first: any = await acquireClientAdapter({ target: "codex", cacheRoot, installPackage });
    const second: any = await acquireClientAdapter({ target: "codex", cacheRoot, installPackage });
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(first.sha256).toBe(second.sha256);
    expect(counter.count).toBe(1);
  });

  it("validates the trusted descriptor and strips unrelated secrets from the child environment", async () : Promise<any> => {
    const cacheRoot: any = await fixtureRoot();
    const installPackage: any = fixtureInstaller({ count: 0 });
    process.env.MESHRIX_MCP_ADAPTER_SECRET_CANARY = "must-not-cross-process-boundary";
    const described: any = await describeClientAdapter({ target: "codex", cacheRoot, installPackage });
    expect(described.result.target).toBe("codex");
    const scanned: any = await runClientAdapter({
      target: "codex",
      action: "scan",
      cacheRoot,
      installPackage,
      request: { client: { command: "neutral-client" }, tokenEnv: "MESHRIX_MCP_TOKEN" }
    });
    expect(scanned.result).toMatchObject({ available: true, secretInherited: false });
  });

  it("rejects raw secret fields before adapter execution", async () : Promise<any> => {
    const cacheRoot: any = await fixtureRoot();
    await expect(runClientAdapter({
      target: "codex",
      action: "install",
      cacheRoot,
      installPackage: fixtureInstaller({ count: 0 }),
      request: { token: "not-allowed" }
    })).rejects.toMatchObject({ code: "CLIENT_ADAPTER_SECRET_REJECTED" });
  });
});
