import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { modernHttpRequest } from "../support.ts";
const canned1 = "env:MESH_TEST_REMOTE_TOKEN";



const repo = fileURLToPath(new URL("../../../../", import.meta.url));

const cannedRemote = ["synthetic", "remote", "test", "credential"].join("-");

describe("explicit remote gateway profile behind an edge proxy", () => {
  it("[GC-058] serves plain HTTP with bearer auth, origin checks and pinned HTTPS egress", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-gateway-remote-"));
    const keyPath = join(directory, "identity.key");
    const certPath = join(directory, "identity.crt");
    const configPath = join(directory, "gateway.json");
    let cli: ChildProcess | undefined;
    let peer: ReturnType<typeof createServer> | undefined;
    let toolCalls = 0;
    try {
      const certificate = spawnSync("openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyPath, "-out", certPath], { stdio: "ignore", timeout: 10_000 });
      if (certificate.status !== 0) throw new Error("Local synthetic upstream certificate generation failed.");
      const key = await readFile(keyPath, "utf8");
      const cert = await readFile(certPath, "utf8");
      peer = createServer({ key, cert }, async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = wire.method === "server/discover" ? { resultType: "complete", supportedVersions: ["2026-07-28"] }
          : wire.method === "tools/list" ? { resultType: "complete", tools: [{ name: "synthetic", inputSchema: { type: "object" } }] }
            : wire.method === "tools/call" ? (toolCalls += 1, { resultType: "complete", structuredContent: { source: "tls-peer" }, content: [{ type: "text", text: "tls-peer" }] })
              : { resultType: "complete", resources: [], resourceTemplates: [], prompts: [] };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id, result }));
      });
      await new Promise<void>((resolve) => peer!.listen(0, "127.0.0.1", resolve));
      const address = peer.address();
      if (!address || typeof address === "string") throw new Error("Synthetic HTTPS peer is unavailable.");
      const service = (id: string) => ({ serviceId: id, baseUrl: `https://127.0.0.1:${address.port}/mcp`, allowedHosts: ["127.0.0.1"], toolRisk: { synthetic: "read" } });
      const installed = process.env.MESHRIX_TEST_INSTALLED_GATEWAY_ENTRY;
      const start = async (allowedOrigins?: string[]) => {
        const config = { profile: "remote", listen: { host: "127.0.0.1", port: 0 }, remoteAuth: { bearerToken: canned1, allowedServiceIds: ["alpha"], ...(allowedOrigins === undefined ? {} : { allowedOrigins }), allowLoopbackUpstreams: true }, services: [service("alpha"), service("beta")] };
        await writeFile(configPath, JSON.stringify(config));
        cli = spawn(process.execPath, [...(installed ? [] : ["--conditions=source"]), installed ?? join(repo, "apps/mcp-gateway-installer/src/cli.ts"), "serve", "--config", configPath], {
          cwd: installed ? dirname(installed) : repo, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath, MESH_TEST_REMOTE_TOKEN: cannedRemote }
        });
        return new Promise<string>((resolve, reject) => {
          let output = "";
          const timer = setTimeout(() => reject(new Error("remote gateway readiness timeout")), 10_000);
          cli!.once("exit", () => { clearTimeout(timer); reject(new Error("remote gateway exited")); });
          cli!.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); const line = output.split("\n")[0]; if (line.endsWith("}")) { clearTimeout(timer); resolve(JSON.parse(line).interopEndpoint); } });
        });
      };
      const stop = async () => {
        if (!cli || cli.exitCode !== null || cli.signalCode !== null) return;
        const exiting = new Promise<void>((resolve) => cli!.once("exit", () => resolve()));
        cli.kill("SIGTERM");
        await exiting;
      };
      const send = async (endpoint: string, authorized: boolean, method: string, params: Record<string, unknown> = {}, origin?: string) => {
        const wire = modernHttpRequest(method, method, params, {}, origin === undefined ? {} : { Origin: origin });
        const response = await fetch(endpoint, {
          method: wire.method,
          headers: { ...wire.headers, ...(authorized ? { Authorization: ("Bearer " + cannedRemote) } : {}) },
          body: JSON.stringify(wire.body)
        });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
      };

      const defaultEndpoint = await start();
      expect(defaultEndpoint.startsWith("http://127.0.0.1:")).toBe(true);
      expect((await send(defaultEndpoint, false, "tools/list")).status).toBe(401);
      const defaultListing = await send(defaultEndpoint, true, "tools/list");
      expect(defaultListing.status).toBe(200);
      expect((await send(defaultEndpoint, true, "tools/call", { name: "synthetic", arguments: {} }, "https://client.example")).status).toBe(403);
      expect(toolCalls).toBe(0);
      await stop();

      const endpoint = await start(["https://client.example", "HTTPS://CLIENT.EXAMPLE:443"]);
      const listing = await send(endpoint, true, "tools/list");
      expect(listing.status).toBe(200);
      expect(listing.body.result.tools).toHaveLength(1);
      const publishedName = listing.body.result.tools[0].name;
      expect((await send(endpoint, true, "tools/call", { name: publishedName, arguments: {} }, "HTTPS://CLIENT.EXAMPLE:443")).body.result.structuredContent).toEqual({ source: "tls-peer" });
      const effectsBeforeDenials = toolCalls;
      const deniedOrigins = await Promise.all([
        send(endpoint, false, "tools/call", { name: publishedName, arguments: {} }, "null"),
        send(endpoint, true, "tools/call", { name: publishedName, arguments: {} }, "not-an-origin"),
        send(endpoint, true, "tools/call", { name: publishedName, arguments: {} }, "https://client.example/path"),
        send(endpoint, true, "tools/call", { name: publishedName, arguments: {} }, "https://@client.example"),
        send(endpoint, true, "tools/call", { name: publishedName, arguments: {} }, "http://client.example"),
        send(endpoint, true, "tools/call", { name: publishedName, arguments: {} }, "https://client.example:444"),
        send(endpoint, true, "tools/call", { name: publishedName, arguments: {} }, "https://untrusted.example")
      ]);
      expect({ deniedStatuses: deniedOrigins.map((item) => item.status), effectsAfterDenials: toolCalls }).toEqual({
        deniedStatuses: [403, 403, 403, 403, 403, 403, 403], effectsAfterDenials: effectsBeforeDenials
      });
      await stop();
      expect({ exitCode: cli?.exitCode, signalCode: cli?.signalCode }).toEqual({ exitCode: 0, signalCode: null });
    } finally {
      if (cli && cli.exitCode === null && cli.signalCode === null) { cli.kill("SIGTERM"); await new Promise((resolve) => cli!.once("exit", resolve)); }
      if (peer) await new Promise<void>((resolve) => peer!.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);
});
