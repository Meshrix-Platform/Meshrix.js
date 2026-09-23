import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));

function command(...args: string[]) {
  const installed = process.env.MESHRIX_TEST_INSTALLED_GATEWAY_ENTRY;
  return spawnSync(process.execPath, [...(installed ? [] : ["--conditions=source"]), installed ?? join(repo, "apps/mcp-gateway-installer/src/cli.ts"), "migrate", ...args], { cwd: installed ? dirname(installed) : repo, encoding: "utf8", timeout: 10_000 });
}

describe("one canonical migration owner from the standalone CLI", () => {
  it("[GC-054 GC-055 partial] previews, fences apply, preserves earliest backup, restores exact bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-cli-migration-"));
    const file = join(directory, "gateway.json");
    const original = '{"services":[{"serviceKey":"synthetic","transport":"stdio","command":"node","args":["peer.mjs"]}]}\n';
    try {
      await writeFile(file, original);
      const preview = command("preview", "--input", file);
      expect(preview.status).toBe(0);
      const report = JSON.parse(preview.stdout);
      expect(report).toMatchObject({ applied: false, errors: [], sourceRevision: expect.stringMatching(/^sha256:/) });
      expect(command("apply", "--input", file).status).toBe(1);
      const applied = command("apply", "--input", file, "--expected-revision", report.sourceRevision);
      expect(applied.status).toBe(0);
      expect(JSON.parse(applied.stdout)).toMatchObject({ applied: true });
      const after = JSON.parse(command("preview", "--input", file).stdout);
      expect(after.sourceRevision).not.toBe(report.sourceRevision);
      expect(command("restore", "--input", file, "--expected-revision", after.sourceRevision, "--backup-revision", "sha256:forged").status).toBe(1);
      expect(command("apply", "--input", file, "--expected-revision", after.sourceRevision).status).toBe(0);
      expect(await readFile(`${file}.backup`, "utf8")).toBe(original);
      const restored = command("restore", "--input", file, "--expected-revision", after.sourceRevision, "--backup-revision", report.sourceRevision);
      expect(restored.status).toBe(0);
      expect(await readFile(file, "utf8")).toBe(original);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000);

  it("[GC-053] loads a migrated stdio upstream, makes a real call, and retires its owned child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-migrated-stdio-"));
    const file = join(directory, "gateway.json");
    const script = join(directory, "peer.mjs");
    const marker = join(directory, "stopped");
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await writeFile(script, `import fs from 'node:fs';\nlet pending='';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', chunk => { pending += chunk; let end; while ((end=pending.indexOf('\\n'))>=0) { const raw=pending.slice(0,end); pending=pending.slice(end+1); const wire=JSON.parse(raw); if (!wire.id) continue; const result=wire.method==='server/discover' ? {resultType:'complete',supportedVersions:['2026-07-28']} : wire.method==='tools/list' ? {resultType:'complete',tools:[{name:'synthetic',inputSchema:{type:'object'}}]} : wire.method==='tools/call' ? {resultType:'complete',content:[{type:'text',text:'stdio-upstream'}]} : {resultType:'complete',resources:[],resourceTemplates:[],prompts:[]}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:wire.id,result})+'\\n'); } });\nprocess.on('SIGTERM',()=>process.exit(0));\nprocess.on('exit',()=>fs.writeFileSync(process.env.MCP_EXIT_MARKER,'closed'));\n`);
      await writeFile(file, JSON.stringify({ services: [{ serviceKey: "synthetic", transport: "stdio", command: process.execPath, args: [script], envBindings: { MCP_EXIT_MARKER: "env:MESH_TEST_MARKER" }, toolRisk: { synthetic: "read" } }] }));
      const preview = JSON.parse(command("preview", "--input", file).stdout);
      expect(command("apply", "--input", file, "--expected-revision", preview.sourceRevision).status).toBe(0);
      const installed = process.env.MESHRIX_TEST_INSTALLED_GATEWAY_ENTRY;
      child = spawn(process.execPath, [...(installed ? [] : ["--conditions=source"]), installed ?? join(repo, "apps/mcp-gateway-installer/src/cli.ts"), "serve", "--config", file], { cwd: installed ? dirname(installed) : repo, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MESH_TEST_MARKER: marker } });
      let failureCode = "";
      child.stderr?.on("data", (chunk: Buffer) => { failureCode += chunk.toString("utf8").slice(0, 120); });
      const endpoint = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => reject(new Error("gateway readiness timeout")), 10_000);
        child!.once("exit", () => { clearTimeout(timeout); reject(new Error(`gateway exited during discovery: ${failureCode.trim()}`)); });
        child!.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); const line = output.split("\n")[0]; if (line.endsWith("}")) { clearTimeout(timeout); resolve(JSON.parse(line).interopEndpoint); } });
      });
      const send = async (method: string, params: Record<string, unknown> = {}) => (await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }) })).json();
      expect((await send("tools/list")).result.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "synthetic" })]));
      expect((await send("tools/call", { name: "synthetic", arguments: {} })).result).toMatchObject({ resultType: "complete", content: [{ text: "stdio-upstream" }] });
      child.kill("SIGTERM");
      await new Promise((resolve) => child!.once("exit", resolve));
      expect(child.exitCode).toBe(0);
      expect(await readFile(marker, "utf8")).toBe("closed");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child!.once("exit", resolve)); }
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);
});
