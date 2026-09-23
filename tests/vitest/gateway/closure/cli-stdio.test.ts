import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const children: ChildProcess[] = [];
afterEach(async () => { await Promise.all(children.splice(0).map(async (child) => { if (child.exitCode !== null) return; child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); })); });

describe("real local stdio gateway", () => {
  it("[GC-057 partial] executes two newline-framed MCP methods and exits on EOF", async () => {
    const peer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = rpc.method === "server/discover" ? { resultType: "complete", supportedVersions: ["2026-07-28"] }
        : rpc.method === "tools/list" ? { resultType: "complete", tools: [{ name: "synthetic", inputSchema: { type: "object" } }] }
          : rpc.method === "tools/call" ? { resultType: "complete", content: [{ type: "text", text: "stdio-peer" }] }
            : { resultType: "complete", resources: [], resourceTemplates: [], prompts: [] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const directory = await mkdtemp(join(tmpdir(), "meshrix-stdio-cli-"));
    try {
      const address = peer.address();
      if (!address || typeof address === "string") throw new Error("synthetic peer is unavailable");
      const config = join(directory, "gateway.json");
      await writeFile(config, JSON.stringify({ profile: "local", services: [{ serviceId: "synthetic", baseUrl: "$MESHRIX_INTEROP_PEER_ENDPOINT", toolRisk: { synthetic: "read" } }] }));
      const installed = process.env.MESHRIX_TEST_INSTALLED_GATEWAY_ENTRY;
      const child = spawn(process.execPath, [...(installed ? [] : ["--conditions=source"]), installed ?? join(repo, "apps/mcp-gateway-installer/src/cli.ts"), "serve", "--transport", "stdio", "--config", config], {
        cwd: installed ? dirname(installed) : repo, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MESHRIX_INTEROP_PEER_ENDPOINT: `http://127.0.0.1:${address.port}/mcp` }
      });
      children.push(child);
      const output = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      const request = async (method: string, params: Record<string, unknown> = {}) => {
        const reply = new Promise<Record<string, any>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("stdio response timed out")), 10_000);
          output.once("line", (line) => { clearTimeout(timer); resolve(JSON.parse(line)); });
          child.once("exit", () => { clearTimeout(timer); reject(new Error("stdio gateway exited")); });
        });
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: method, method, params })}\n`);
        return reply;
      };
      expect((await request("tools/list")).result.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "synthetic" })]));
      expect((await request("tools/call", { name: "synthetic", arguments: {} })).result).toMatchObject({ resultType: "complete", content: [{ text: "stdio-peer" }] });
      child.stdin!.end();
      await new Promise<void>((resolve) => child.once("exit", resolve));
      expect(child.exitCode).toBe(0);
      output.close();
    } finally { await new Promise<void>((resolve) => peer.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
  }, 20_000);
});
