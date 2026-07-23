import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildServerStartupArgs } from "../../../tools/scripts/start-console.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const resolveScriptPath = path.join(repoRoot, "tools", "server-scripts", "resolve-server-data-dir.mjs");

async function withTempHome(testCase) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "lico-startup-home-"));
  try {
    return await testCase(homeDir);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function scriptEnv(homeDir) {
  const env = {
    ...process.env,
    HOME: homeDir,
    LICO_CONFIG_FILE: path.join(homeDir, ".missing-lico-config.json"),
  };
  delete env.LICO_SERVER_DATA_DIR;
  return env;
}

function runResolveDataDir(args, homeDir, envOverrides = {}) {
  return spawnSync(process.execPath, [resolveScriptPath, ...args], {
    cwd: repoRoot,
    env: { ...scriptEnv(homeDir), ...envOverrides },
    encoding: "utf8",
  });
}

describe("startup data-dir resolver", () => {
  it("supports --data-dir=value without falling back", async () => {
    await withTempHome(async (homeDir) => {
      const explicitDataDir = path.join(homeDir, "explicit-data");
      const result = runResolveDataDir([`--data-dir=${explicitDataDir}`], homeDir);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(path.resolve(explicitDataDir));
      expect(result.stderr.trim()).toBe("");
    });
  });

  it("uses the fresh LicoMesh data directory by default", async () => {
    await withTempHome(async (homeDir) => {
      const defaultDataDir = path.join(homeDir, "licomesh-data");

      const result = runResolveDataDir([], homeDir);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(defaultDataDir);
      expect(result.stderr.trim()).toBe("");
    });
  });

  it("keeps the shared LICO_SERVER_DATA_DIR override", async () => {
    await withTempHome(async (homeDir) => {
      const configuredDataDir = path.join(homeDir, "configured-data");

      const result = runResolveDataDir([], homeDir, {
        LICO_SERVER_DATA_DIR: configuredDataDir,
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(configuredDataDir);
      expect(result.stderr.trim()).toBe("");
    });
  });

  it("preserves an explicit data directory", async () => {
    await withTempHome(async (homeDir) => {
      const explicitDataDir = path.join(homeDir, "explicit-data");

      const result = runResolveDataDir(["--data-dir", explicitDataDir], homeDir);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(path.resolve(explicitDataDir));
      expect(result.stderr.trim()).toBe("");
    });
  });
});

describe("server console startup args", () => {
  it("preserves duplicate passthrough values when forcing UI mode", () => {
    const serviceUrl = "http://127.0.0.1:7232";
    const args = buildServerStartupArgs([
      "--port",
      "7232",
      "--active-service-url",
      serviceUrl,
      "--advertised-base-url",
      serviceUrl,
    ]);

    expect(args).toEqual([
      "apps/server/bin/lico.mjs",
      "--port",
      "7232",
      "--active-service-url",
      serviceUrl,
      "--advertised-base-url",
      serviceUrl,
      "--with-ui",
    ]);
    expect(args.filter((arg) => arg === serviceUrl)).toHaveLength(2);
  });
});
