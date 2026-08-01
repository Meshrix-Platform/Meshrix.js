import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildServerStartupArgs } from "../../../tools/scripts/start-console.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const resolveScriptPath: any = path.join(repoRoot, "tools", "server-scripts", "resolve-server-data-dir.ts");

async function withTempHome(testCase?: any) : Promise<any> {
  const homeDir: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-startup-home-"));
  try {
    return await testCase(homeDir);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function scriptEnv(homeDir?: any) : any {
  const env: Record<string, any> = {
    ...process.env,
    HOME: homeDir,
    MESHRIX_CONFIG_FILE: path.join(homeDir, ".missing-meshrix-config.json"),
  };
  delete env.MESHRIX_SERVER_DATA_DIR;
  return env;
}

function runResolveDataDir(args?: any, homeDir?: any, envOverrides: Record<string, any> = {}) : any {
  return spawnSync(process.execPath, [resolveScriptPath, ...args], {
    cwd: repoRoot,
    env: { ...scriptEnv(homeDir), ...envOverrides },
    encoding: "utf8",
  });
}

describe("startup data-dir resolver", () : any => {
  it("supports --data-dir=value without falling back", async () : Promise<any> => {
    await withTempHome(async (homeDir?: any) : Promise<any> => {
      const explicitDataDir: any = path.join(homeDir, "explicit-data");
      const result: any = runResolveDataDir([`--data-dir=${explicitDataDir}`], homeDir);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(path.resolve(explicitDataDir));
      expect(result.stderr.trim()).toBe("");
    });
  });

  it("uses the fresh Meshrix data directory by default", async () : Promise<any> => {
    await withTempHome(async (homeDir?: any) : Promise<any> => {
      const defaultDataDir: any = path.join(homeDir, "meshrix-data");

      const result: any = runResolveDataDir([], homeDir);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(defaultDataDir);
      expect(result.stderr.trim()).toBe("");
    });
  });

  it("keeps the shared MESHRIX_SERVER_DATA_DIR override", async () : Promise<any> => {
    await withTempHome(async (homeDir?: any) : Promise<any> => {
      const configuredDataDir: any = path.join(homeDir, "configured-data");

      const result: any = runResolveDataDir([], homeDir, {
        MESHRIX_SERVER_DATA_DIR: configuredDataDir,
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(configuredDataDir);
      expect(result.stderr.trim()).toBe("");
    });
  });

  it("preserves an explicit data directory", async () : Promise<any> => {
    await withTempHome(async (homeDir?: any) : Promise<any> => {
      const explicitDataDir: any = path.join(homeDir, "explicit-data");

      const result: any = runResolveDataDir(["--data-dir", explicitDataDir], homeDir);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(path.resolve(explicitDataDir));
      expect(result.stderr.trim()).toBe("");
    });
  });
});

describe("server console startup args", () : any => {
  it("preserves duplicate passthrough values when forcing UI mode", () : any => {
    const serviceUrl: any = "http://127.0.0.1:7232";
    const args: any = buildServerStartupArgs([
      "--port",
      "7232",
      "--active-service-url",
      serviceUrl,
      "--advertised-base-url",
      serviceUrl,
    ]);

    expect(args).toEqual([
      "apps/server/bin/meshrix.ts",
      "--port",
      "7232",
      "--active-service-url",
      serviceUrl,
      "--advertised-base-url",
      serviceUrl,
      "--with-ui",
    ]);
    expect(args.filter((arg?: any) : any => arg === serviceUrl)).toHaveLength(2);
  });
});
