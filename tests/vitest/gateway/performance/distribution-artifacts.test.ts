import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolveReleaseWorkspaceDirectories } from "../../../../tools/server-scripts/publish-release-set.ts";
import { createServerSourcePackage } from "../../../../tools/server-scripts/package-server-source.ts";
import { rewritePackedVendoredFileDependencies } from "../../../../tools/server-scripts/lib/lock-backed-npm-registry.ts";

const root = resolve(import.meta.dirname, "../../../..");
const forbidden = /(?:^|\/)(?:meshrix-node-benchmark|node-benchmark|gateway-benchmark(?:\.[^.]+)?|gateway-benchmark\/|benchmark-gateway\.(?:ts|js|d\.ts|js\.map|d\.ts\.map))(?:\/|$)/u;
const npm = (args: string[], cwd = root) => {
  const env = { ...process.env };
  // npm run propagates CLI-only configuration; an independent consumer has its own configuration.
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  const result = spawnSync("npm", args, { cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
  if (result.status !== 0) throw Error(`npm_artifact_failure_${result.status}_${result.stderr.match(/npm error code (E[A-Z]+)/u)?.[1] ?? 'unknown'}`);
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
  if (result.status !== 0) throw Error(`original_docker_command_failed_${result.status}`);
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

describe("materialized product benchmark exclusion", () => {
  it("packs a standalone tarball that imports from an empty consumer with zero dependencies", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "benchmark-independent-consumer-"));
    try {
      const packed = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
        resolve(root, "../Meshrix.js-Benchmark/packages/node-benchmark")))[0];
      expect(packed.files.some((entry: { path: string }) => entry.path === "src/index.mjs")).toBe(true);
      expect(packed.files.some((entry: { path: string }) => entry.path.startsWith("../"))).toBe(false);
      npm(["install", "--prefix", scratch, "--ignore-scripts", "--no-audit", "--no-fund", "--offline",
        join(scratch, packed.filename)], scratch);
      const require = createRequire(join(scratch, "consumer.cjs"));
      const manifest = require("meshrix-node-benchmark/package.json");
      expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
      expect((await readdir(join(scratch, "node_modules"))).filter(name => !name.startsWith("."))).toEqual(["meshrix-node-benchmark"]);
      const generic = await import(pathToFileURL(require.resolve("meshrix-node-benchmark")).href);
      const adapter = await import(pathToFileURL(require.resolve("meshrix-node-benchmark/meshrix")).href);
      expect(generic.collectEnvironment().node).toEqual(process.versions.node);
      expect(adapter.describeGatewayBenchmark().evaluated).toBe(false);
      const allowed = [pathToFileURL(`${scratch}/`).href, pathToFileURL(`${await realpath(scratch)}/`).href];
      const loader = join(scratch, "deny-source-loader.mjs");
      await writeFile(loader, `export async function resolve(specifier, context, nextResolve) { const result = await nextResolve(specifier, context); if (result.url.startsWith('file:') && !${JSON.stringify(allowed)}.some(prefix => result.url.startsWith(prefix))) throw Error('source_checkout_access_forbidden'); return result; }`);
      const test = spawnSync(process.execPath, ["--no-warnings", "--experimental-loader", loader, "--input-type=module", "-e", `import {createServer} from 'node:http'; import {runHttpLoad} from '${require.resolve("meshrix-node-benchmark")}'; import {describeGatewayBenchmark} from '${require.resolve("meshrix-node-benchmark/meshrix")}'; if(describeGatewayBenchmark().evaluated!==false)process.exitCode=1; const server=createServer((req,res)=>{res.end('ok')}); await new Promise(r=>server.listen(0,'127.0.0.1',r)); const result=await runHttpLoad({endpoint:'http://127.0.0.1:'+server.address().port,rate:10,durationMs:100,maxInFlight:1,deadlineMs:1000,maxBodyBytes:128,buildRequest:()=>({method:'POST',headers:{},body:'ok'}),classifyResponse:({body})=>body.toString()==='ok'?'validSuccess':'invalidResponse'});server.closeAllConnections();await new Promise(r=>server.close(r));if(result.terminals.validSuccess!==1)process.exitCode=1;`], { cwd: scratch, encoding: "utf8", timeout: 10000 });
      expect(test.status).toBe(0);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }, 30000);

  it("fresh product build, real npm release packs and source archive contain no executable benchmark", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "benchmark-artifacts-"));
    try {
      const build = spawnSync("npm", ["run", "build:node"], { cwd: root, encoding: "utf8", timeout: 240000, maxBuffer: 32 * 1024 * 1024 });
      if (build.status !== 0) throw Error(`original_build_node_failed_${build.status}`);
      const dist = await readdir(resolve(root, "dist/tools/server-scripts"));
      expect(dist.filter(name => name.startsWith("benchmark-gateway."))).toEqual([]);
      expect(await readdir(resolve(root, "dist/tools/server-scripts/lib"))).not.toContain("gateway-benchmark");
      expect(await stat(resolve(root, "dist/apps/server/bin/meshrix.js"))).toBeDefined();
      const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
      const release = [".", ...await resolveReleaseWorkspaceDirectories({ rootDir: root, workspaces: manifest.workspaces }),
        "packages/protocols/mcp/adapter/gateway-installer"];
      for (const directory of release) {
        const record = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], resolve(root, directory)))[0];
        const archive = join(scratch, record.filename);
        assertClean(record.files.map((file: { path: string }) => file.path));
        assertClean(tar(["-tf", archive]));
        if (directory === ".") {
          expect(record.files.some((file: { path: string }) => file.path === "dist/apps/server/bin/meshrix.js")).toBe(true);
        } else if (directory === "packages/protocols/mcp/adapter/gateway-installer") {
          expect(record.files.some((file: { path: string }) => file.path === "dist/bin/meshrix-mcp.js")).toBe(true);
        }
        await rm(archive);
      }
      const sourceDir = join(scratch, "source");
      const source = await createServerSourcePackage({ repoRoot: root, outputDirectory: sourceDir });
      expect(source.ok).toBe(true);
      const entries = tar(["-tf", join(sourceDir, source.artifact.name)]);
      assertClean(entries);
      expect(entries.some(entry => entry.endsWith("/tools/server-scripts/start-server.ts"))).toBe(true);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }, 300000);

  it("installs actual release-set tarballs without benchmark in an omit-dev consumer", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "benchmark-product-consumer-"));
    try {
      const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
      const release = [".", ...await resolveReleaseWorkspaceDirectories({ rootDir: root, workspaces: manifest.workspaces }),
        "packages/protocols/mcp/adapter/gateway-installer"];
      const packages = [] as Array<{ name: string; file: string }>;
      for (const directory of release) {
        const record = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], resolve(root, directory)))[0];
        const file = join(scratch, record.filename);
        await rewritePackedVendoredFileDependencies(file);
        packages.push({ name: record.name, file });
      }
      const consumer = join(scratch, "consumer");
      await mkdir(consumer);
      await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "benchmark-exclusion-consumer", private: true,
        version: "0.0.0", dependencies: Object.fromEntries(packages.map(item => [item.name, `file:${item.file}`])) }));
      npm(["install", "--omit=dev", "--ignore-scripts=true", "--no-audit", "--no-fund"], consumer);
      const graph = JSON.parse(npm(["ls", "--json", "--omit=dev", "--all"], consumer));
      function walk(item: { dependencies?: Record<string, unknown> }, seen = new Set<object>()) {
        if (seen.has(item)) return;
        seen.add(item);
        for (const [name, value] of Object.entries(item.dependencies ?? {})) {
          expect(name).not.toBe("meshrix-node-benchmark");
          walk(value as { dependencies?: Record<string, unknown> }, seen);
        }
      }
      walk(graph);
      const require = createRequire(join(consumer, "probe.cjs"));
      expect(() => require.resolve("meshrix-node-benchmark")).toThrow();
      expect(() => require.resolve("meshrix.js/package.json")).not.toThrow();
      const installed = await readdir(join(consumer, "node_modules"));
      expect(installed).not.toContain("meshrix-node-benchmark");
      expect(installed).toContain("meshrix.js");
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }, 240000);

  it("inspects both actual committed runtime images and every retained application layer", async () => {
    // A source-tree Docker build could include the unrelated local support inventory.
    // Git archive is only a transport of the ordinary committed HEAD, not another filter.
    const owned = ["tools/server-scripts/benchmark-gateway.ts", "tests/vitest/gateway/performance/distribution-artifacts.test.ts",
      "docs/verification/gateway-benchmark.md", "docs/verification/gateway-benchmark.zh-CN.md"];
    for (const path of owned) {
      const tracked = spawnSync("git", ["ls-files", "--error-unmatch", path], { cwd: root, stdio: "ignore" });
      if (tracked.status !== 0) throw Error("image_candidate_not_checkpointed");
    }
    const dirty = spawnSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: root, stdio: "ignore" });
    if (dirty.status !== 0) throw Error("image_candidate_not_checkpointed");
    const sibling = resolve(root, "../Meshrix.js-Benchmark");
    const packageDirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "packages/node-benchmark"],
      { cwd: sibling, encoding: "utf8" });
    if (packageDirty.status !== 0 || packageDirty.stdout.trim()) throw Error("image_tool_not_checkpointed");
    const scratch = await mkdtemp(join(tmpdir(), "benchmark-image-"));
    const tags = ["final", "runtime-ui"].map(target => `meshrix-benchmark-proof-${process.pid}-${target}`);
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
