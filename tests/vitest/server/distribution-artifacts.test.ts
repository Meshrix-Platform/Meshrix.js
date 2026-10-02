import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { loadPreparedReleaseSet, prepareReleaseSet, type PreparedReleaseSet } from "../../../tools/server-scripts/publish-release-set.ts";
import { createServerSourcePackage } from "../../../tools/server-scripts/package-server-source.ts";

import { sanitizeVerificationLog } from "../../../tools/server-scripts/localize-verify-failure.ts";

const root = resolve(import.meta.dirname, "../../..");
const forbidden = /(?:^|\/)(?:meshrix-node-benchmark(?:-[^/]+\.tgz)?|node-benchmark|benchmark-gateway\.(?:ts|js|d\.ts|js\.map|d\.ts\.map))(?:\/|$)|(?:^|\/)(?:dist\/)?tools\/server-scripts\/lib\/gateway-benchmark(?:\/|$)|(?:^|\/)\.cache\/gateway-benchmark(?:\/|$)/u;
const npm = (args: string[], cwd = root) => {
  const env = { ...process.env };
  // npm run propagates CLI-only configuration; an independent consumer has its own configuration.
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  delete env.npm_config_offline;
  delete env.NPM_CONFIG_OFFLINE;
  const result = spawnSync("npm", args, { cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
  if (result.status !== 0) throw Error(`npm_artifact_failure_${result.status}\n${sanitizeVerificationLog(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, root)}`);
  return result.stdout;
};
const tar = (args: string[]) => {
  const result = spawnSync("tar", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
  if (result.status !== 0) throw Error(`archive_inspection_failure_${result.status}`);
  return result.stdout.split("\n").filter(Boolean);
};
const assertClean = (entries: string[]) => expect(entries.filter(entry => forbidden.test(entry))).toEqual([]);
const docker = (args: string[], cwd = root, timeout = 600000) => {
  const result = spawnSync("docker", args, { cwd, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw Error(`original_docker_command_failed_${result.status}\n${sanitizeVerificationLog(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, root)}`);
  return result.stdout;
};
function layerPaths(archive: string, layer: string): Promise<string[]> {
  return new Promise((resolvePaths, rejectPaths) => {
    const outer = spawn("tar", ["-xOf", archive, layer], { stdio: ["ignore", "pipe", "ignore"] });
    const inner = spawn("tar", ["-tf", "-"], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "", finished = false;
    outer.stdout.pipe(inner.stdin);
    inner.stdout.on("data", chunk => { output += String(chunk); if (output.length > 16 * 1024 * 1024) { outer.kill(); inner.kill(); } });
    const failure = () => { if (!finished) { finished = true; rejectPaths(Error("image_layer_inspection_failed")); } };
    outer.once("error", failure); inner.once("error", failure);
    outer.once("exit", code => { if (code !== 0) failure(); });
    inner.once("exit", code => { if (code !== 0) failure(); else if (!finished) { finished = true; resolvePaths(output.split("\n").filter(Boolean)); } });
  });
}

describe("materialized product distribution", () => {
  let scratch: string;
  let prepared: PreparedReleaseSet;
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "meshrix-product-artifacts-"));
    // This explicit serial engineering profile is the only build owner in this run.
    npm(["run", "build"]);
    const artifactDirectory = join(scratch, "npm-set");
    await prepareReleaseSet({ rootDir: root, artifactDirectory });
    prepared = await loadPreparedReleaseSet({ rootDir: root, artifactDirectory });
  }, 300000);
  afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });
  it("distinguishes allowed verification documentation from executable benchmark assets", () => {
    expect(forbidden.test("app/docs/verification/gateway-benchmark.md")).toBe(false);
    for (const path of ["app/tools/server-scripts/benchmark-gateway.ts",
      "app/dist/tools/server-scripts/benchmark-gateway.js",
      "app/tools/server-scripts/lib/gateway-benchmark/mock-upstream.ts",
      "app/.cache/gateway-benchmark/package.json",
      "app/tmp/meshrix-node-benchmark-0.1.0.tgz",
      "app/node_modules/meshrix-node-benchmark/src/index.mjs"]) expect(forbidden.test(path)).toBe(true);
  });

  it("fresh product build, real npm release packs and source archive contain no executable benchmark", async () => {
    expect(prepared.packages.map(item => item.name).sort()).toEqual(["@meshrix/gateway", "meshrix.js"]);
    for (const artifact of prepared.packages) {
      const entries = tar(["-tf", artifact.tarballPath]);
      assertClean(entries);
      if (artifact.name === "meshrix.js") {
        for (const [bin, entry] of Object.entries({ meshrix: "dist/apps/server/bin/meshrix.js", "meshrix-server": "dist/tools/server-scripts/start-server.js", "meshrix-mcp": "dist/apps/server/bin/meshrix-mcp.js" })) {
          expect(await stat(resolve(root, entry))).toBeDefined();
          expect(entries, `root archive must include ${bin}`).toContain(`package/${entry}`);
        }
        expect(entries.some(entry => entry.startsWith("package/dist/packages/"))).toBe(false);
        expect(entries).toContain("package/node_modules/@meshrix/protocols/dist/mcp/adapter/gateway-installer/bin/meshrix-mcp.js");
      }
    }
    const sourceDir = join(scratch, "source");
    const source = await createServerSourcePackage({ repoRoot: root, outputDirectory: sourceDir });
    expect(source.ok).toBe(true);
    const entries = tar(["-tf", join(sourceDir, source.artifact.name)]);
    assertClean(entries);
    expect(entries.some(entry => entry.endsWith("/tools/server-scripts/start-server.ts"))).toBe(true);
    expect(entries.some(entry => entry.endsWith("/THIRD_PARTY_NOTICES.md"))).toBe(true);
    const unpacked = join(scratch, "source-unpacked");
    await mkdir(unpacked);
    tar(["-xf", join(sourceDir, source.artifact.name), "-C", unpacked]);
    const packageRoot = entries.find(entry => entry.endsWith("/package.json"))!.split("/")[0]!;
    const skillPack = spawnSync(process.execPath, ["tools/pack-usage-skills.mjs"], { cwd: join(unpacked, packageRoot), encoding: "utf8" });
    expect(skillPack.status, "source archive must retain canonical usage skill build inputs").toBe(0);
  }, 300000);

  it("installs Gateway independently and root with its declared public release dependency", async () => {
    for (const [index, artifact] of prepared.packages.entries()) {
      const consumer = join(scratch, `consumer-${index}`);
      await mkdir(consumer);
      await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "product-distribution-consumer", private: true,
        version: "0.0.0", dependencies: Object.fromEntries(
          // Gateway is an independent consumer. Root declares the public Gateway dependency;
          // before first publication its matching archive supplies that registry prerequisite.
          (artifact.name === "@meshrix/gateway" ? [artifact] : prepared.packages)
            .map(item => [item.name, `file:${item.tarballPath}`])
        ) }));
      // This check owns dependency contents; native startup is exercised by the package matrix.
      npm(["install", "--omit=dev", "--ignore-scripts=true", "--no-audit", "--no-fund", "--cache", join(scratch, "consumer-npm-cache")], consumer);
      const graph = JSON.parse(npm(["ls", "--json", "--omit=dev", "--all"], consumer));
      function walk(item: { dependencies?: Record<string, unknown> }) {
        for (const [name, value] of Object.entries(item.dependencies ?? {})) {
          expect(name).not.toBe("meshrix-node-benchmark");
          walk(value as { dependencies?: Record<string, unknown> });
        }
      }
      walk(graph);
      const require = createRequire(join(consumer, "probe.cjs"));
      expect(() => require.resolve("meshrix-node-benchmark")).toThrow();
      if (artifact.name === "@meshrix/gateway") {
        expect(() => require.resolve("meshrix.js/package.json")).toThrow();
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        const imported = spawnSync(process.execPath, ["--input-type=module", "-e",
          "import { createGateway } from '@meshrix/gateway'; if (typeof createGateway !== 'function') process.exitCode = 1;"],
          { cwd: consumer, env, encoding: "utf8" });
        expect(imported.status, "Gateway must load from its own tarball without the root product").toBe(0);
      } else {
        expect(() => require.resolve("meshrix.js/package.json")).not.toThrow();
      }
    }
  }, 240000);

  it("inspects both actual committed runtime images and every retained application layer", async () => {
    // A source-tree Docker build could include the unrelated local support inventory.
    // Git archive is only a transport of the ordinary committed HEAD, not another filter.
    const dirty = spawnSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: root, stdio: "ignore" });
    if (dirty.status !== 0) throw Error("image_candidate_not_checkpointed");
    const scratch = await mkdtemp(join(tmpdir(), "meshrix-product-image-"));
    const tags = ["final", "runtime-ui"].map(target => `meshrix-product-proof-${process.pid}-${target}`);
    try {
      const archive = join(scratch, "candidate.tar");
      const context = join(scratch, "context");
      await mkdir(context);
      const result = spawnSync("git", ["archive", "--output", archive, "HEAD"], { cwd: root, stdio: "ignore", timeout: 60000 });
      if (result.status !== 0) throw Error("committed_source_archive_failed");
      const unpack = spawnSync("tar", ["-xf", archive, "-C", context], { stdio: "ignore", timeout: 60000 });
      if (unpack.status !== 0) throw Error("committed_source_unpack_failed");
      for (const [index, target] of ["final", "runtime-ui"].entries()) {
        docker(["build", "--target", target, "--tag", tags[index]!, "--file", "Dockerfile", "."], context);
        const probe = `const fs=require('node:fs'),path=require('node:path');const base='/app';const misses=['tools/server-scripts/benchmark-gateway.ts','tools/server-scripts/lib/gateway-benchmark','dist/tools/server-scripts/lib/gateway-benchmark','dist/tools/server-scripts/benchmark-gateway.js','dist/tools/server-scripts/benchmark-gateway.d.ts','.cache/gateway-benchmark','node_modules/meshrix-node-benchmark'];for(const name of misses)if(fs.existsSync(path.join(base,name)))process.exitCode=1;for(const name of ['tools/server-scripts/start-server.ts','dist/tools/server-scripts/start-server.js','apps/server/package.json'${target === "runtime-ui" ? ",'build/dist/index.html'" : ""}])if(!fs.existsSync(path.join(base,name)))process.exitCode=2;`;
        docker(["run", "--rm", "--entrypoint", "node", tags[index]!, "-e", probe]);
      }
      const saved = join(scratch, "runtime-images.tar");
      docker(["save", "--output", saved, ...tags]);
      const manifest = spawnSync("tar", ["-xOf", saved, "manifest.json"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
      if (manifest.status !== 0) throw Error("image_manifest_read_failed");
      const layers = new Set<string>((JSON.parse(manifest.stdout) as Array<{ Layers: string[] }>).flatMap(item => item.Layers));
      expect(layers.size).toBeGreaterThan(0);
      for (const layer of layers) {
        const paths = await layerPaths(saved, layer);
        assertClean(paths.filter(path => path.startsWith("app/") || path.startsWith("./app/")));
      }
    } finally {
      for (const tag of tags) spawnSync("docker", ["image", "rm", tag], { stdio: "ignore", timeout: 30000 });
      await rm(scratch, { recursive: true, force: true });
    }
  }, 1200000);
});
