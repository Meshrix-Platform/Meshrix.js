import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseNpmPackJson } from "../../../../tools/server-scripts/lib/npm-cli-invocation.ts";
const root = resolve(import.meta.dirname, "../../../..");
const npm = (args: string[], cwd = root) => {
  const env = { ...process.env };
  // npm run propagates CLI-only configuration; an independent consumer has its own configuration.
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  const result = spawnSync("npm", args, { cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
  if (result.status !== 0) throw Error(`npm_artifact_failure_${result.status}_${(result.stderr ?? '').match(/npm error code (E[A-Z]+)/u)?.[1] ?? 'unknown'}`);
  return result.stdout;
};
describe("independent Benchmark package", () => {
  it("packs a standalone tarball that imports from an empty consumer with zero dependencies", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "benchmark-independent-consumer-"));
    try {
      const packed = parseNpmPackJson(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
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

});
