import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:https";
import { request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));

describe("explicit remote TLS gateway profile", () => {
  it("[GC-058] requires TLS, bearer auth, pinned HTTPS egress and an explicit service grant", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-gateway-remote-"));
    const keyPath = join(directory, "identity.key");
    const certPath = join(directory, "identity.crt");
    const configPath = join(directory, "gateway.json");
    let cli: ChildProcess | undefined;
    let peer: ReturnType<typeof createServer> | undefined;
    try {
      const certificate = spawnSync("openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyPath, "-out", certPath], { stdio: "ignore", timeout: 10_000 });
      if (certificate.status !== 0) throw new Error("Local synthetic TLS certificate generation failed.");
      const key = await readFile(keyPath, "utf8");
      const cert = await readFile(certPath, "utf8");
      peer = createServer({ key, cert }, async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = wire.method === "server/discover" ? { resultType: "complete", supportedVersions: ["2026-07-28"] }
          : wire.method === "tools/list" ? { resultType: "complete", tools: [{ name: "synthetic", inputSchema: { type: "object" } }] }
            : wire.method === "tools/call" ? { resultType: "complete", structuredContent: { source: "tls-peer" }, content: [{ type: "text", text: "tls-peer" }] }
              : { resultType: "complete", resources: [], resourceTemplates: [], prompts: [] };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id, result }));
      });
      await new Promise<void>((resolve) => peer!.listen(0, "127.0.0.1", resolve));
      const address = peer.address();
      if (!address || typeof address === "string") throw new Error("Synthetic TLS peer is unavailable.");
      const service = (id: string) => ({ serviceId: id, baseUrl: `https://127.0.0.1:${address.port}/mcp`, allowedHosts: ["127.0.0.1"], toolRisk: { synthetic: "read" } });
      const config = { profile: "remote", listen: { host: "127.0.0.1", port: 0 }, remoteAuth: { bearerToken: "env:MESH_TEST_REMOTE_TOKEN", tlsCert: "env:MESH_TEST_REMOTE_CERT", tlsKey: "env:MESH_TEST_REMOTE_KEY", allowedServiceIds: ["alpha"], allowLoopbackUpstreams: true }, services: [service("alpha"), service("beta")] };
      await writeFile(configPath, JSON.stringify(config));
      const installed = process.env.MESHRIX_TEST_INSTALLED_GATEWAY_ENTRY;
      cli = spawn(process.execPath, [...(installed ? [] : ["--conditions=source"]), installed ?? join(repo, "apps/mcp-gateway-installer/src/cli.ts"), "serve", "--config", configPath], {
        cwd: installed ? dirname(installed) : repo, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath, MESH_TEST_REMOTE_TOKEN: "synthetic-bearer", MESH_TEST_REMOTE_CERT: cert, MESH_TEST_REMOTE_KEY: key }
      });
      const endpoint = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("remote TLS gateway readiness timeout")), 10_000);
        cli!.once("exit", () => { clearTimeout(timer); reject(new Error("remote TLS gateway exited")); });
        cli!.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); const line = output.split("\n")[0]; if (line.endsWith("}")) { clearTimeout(timer); resolve(JSON.parse(line).interopEndpoint); } });
      });
      expect(endpoint.startsWith("https://")).toBe(true);
      const send = async (authorized: boolean, method: string, params: Record<string, unknown> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
        const request = httpsRequest(endpoint, { method: "POST", ca: cert, headers: { "content-type": "application/json", ...(authorized ? { Authorization: "Bearer synthetic-bearer" } : {}) } }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null }));
        });
        request.once("error", reject);
        request.end(JSON.stringify({ jsonrpc: "2.0", id: method, method, params }));
      });
      expect((await send(false, "tools/list")).status).toBe(401);
      const listing = await send(true, "tools/list");
      expect(listing.status).toBe(200);
      expect(listing.body.result.tools).toHaveLength(1);
      const publishedName = listing.body.result.tools[0].name;
      expect((await send(true, "tools/call", { name: publishedName, arguments: {} })).body.result.structuredContent).toEqual({ source: "tls-peer" });
      cli.kill("SIGTERM");
      await new Promise((resolve) => cli!.once("exit", resolve));
      expect(cli.exitCode).toBe(0);
    } finally {
      if (cli && cli.exitCode === null && cli.signalCode === null) { cli.kill("SIGTERM"); await new Promise((resolve) => cli!.once("exit", resolve)); }
      if (peer) await new Promise<void>((resolve) => peer!.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);
});
