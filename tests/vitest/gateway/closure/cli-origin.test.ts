import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { modernHttpRequest } from "../support.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }));
});

async function postWithRawHeaders(endpoint: string, id: string, origins: readonly string[], body?: string): Promise<number> {
  const wire = modernHttpRequest("tools/call", id, { name: "synthetic", arguments: {} });
  const target = new URL(endpoint);
  const payload = body ?? JSON.stringify(wire.body);
  const headers = [
    `POST ${target.pathname} HTTP/1.1`,
    `Host: ${target.host}`,
    ...Object.entries(wire.headers).map(([name, value]) => `${name}: ${value}`),
    ...origins.map((origin) => `Origin: ${origin}`),
    `Content-Length: ${Buffer.byteLength(payload)}`,
    "Connection: close",
    "",
    payload
  ].join("\r\n");
  return new Promise((resolve, reject) => {
    const socket = connectTcp(Number(target.port), target.hostname);
    let response = "";
    socket.once("connect", () => socket.end(headers));
    socket.on("data", (chunk) => { response += chunk.toString("utf8"); });
    socket.once("end", () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(response)?.[1] ?? 0);
      resolve(status);
    });
    socket.once("error", reject);
  });
}

describe("standalone gateway Origin boundary", () => {
  it("allows absent and actual local origins, while rejecting malformed and untrusted origins before tool effects", async () => {
    let toolCalls = 0;
    const peer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = wire.method === "server/discover"
        ? { resultType: "complete", supportedVersions: ["2026-07-28"] }
        : wire.method === "tools/list"
          ? { resultType: "complete", tools: [{ name: "synthetic", inputSchema: { type: "object" } }] }
          : wire.method === "tools/call"
            ? (toolCalls += 1, { resultType: "complete", structuredContent: { source: "peer" } })
            : { resultType: "complete", resources: [], resourceTemplates: [], prompts: [] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id, result }));
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const directory = await mkdtemp(join(tmpdir(), "meshrix-gateway-origin-"));
    try {
      const address = peer.address();
      if (!address || typeof address === "string") throw new Error("Synthetic peer is unavailable.");
      const config = join(directory, "gateway.json");
      await writeFile(config, JSON.stringify({ profile: "local", services: [{ serviceId: "synthetic", baseUrl: `http://127.0.0.1:${address.port}/mcp`, toolRisk: { synthetic: "read" } }] }));
      const installed = process.env.MESHRIX_TEST_INSTALLED_GATEWAY_ENTRY;
      const child = spawn(process.execPath, [...(installed ? [] : ["--conditions=source"]), installed ?? join(repo, "apps/mcp-gateway-installer/src/cli.ts"), "serve", "--config", config], {
        cwd: installed ? dirname(installed) : repo, stdio: ["ignore", "pipe", "pipe"]
      });
      children.push(child);
      const endpoint = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => reject(new Error("gateway readiness timed out")), 10_000);
        child.once("exit", () => { clearTimeout(timeout); reject(new Error("gateway exited before readiness")); });
        child.stdout!.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          const line = output.split("\n")[0];
          if (!line.endsWith("}")) return;
          clearTimeout(timeout);
          resolve(JSON.parse(line).interopEndpoint);
        });
      });
      const send = async (id: string, origin?: string) => {
        const wire = modernHttpRequest("tools/call", id, { name: "synthetic", arguments: {} }, {}, origin === undefined ? {} : { Origin: origin });
        return fetch(endpoint, { method: wire.method, headers: wire.headers, body: JSON.stringify(wire.body) });
      };

      const localOrigin = new URL(endpoint).origin;
      const local = await send("local", localOrigin);
      const native = await send("native");
      const effectsBeforeRejections = toolCalls;
      const rejected = await Promise.all([
        send("null", "null"),
        send("malformed", "not-an-origin"),
        send("other-host", `http://localhost:${address.port}`),
        send("other-scheme", `https://127.0.0.1:${new URL(endpoint).port}`),
        send("other-port", `http://127.0.0.1:${Number(new URL(endpoint).port) + 1}`),
        send("path", `${localOrigin}/path`),
        send("credentials", `http://@127.0.0.1:${new URL(endpoint).port}`)
      ]);
      const invalidJson = modernHttpRequest("tools/call", "bad-json", { name: "synthetic", arguments: {} });
      const beforeMalformed = toolCalls;
      const malformed = await fetch(endpoint, { method: invalidJson.method, headers: { ...invalidJson.headers, Origin: "null" }, body: "{" });
      const beforeDuplicate = toolCalls;
      const duplicateOrigin = await postWithRawHeaders(endpoint, "duplicate", [localOrigin, "https://untrusted.example"]);

      expect({
        permitted: [local.status, native.status],
        denied: rejected.map((response) => response.status),
        malformedOriginBeforeBodyParse: malformed.status,
        duplicateOrigin,
        rejectedEffects: toolCalls - effectsBeforeRejections,
        malformedBodyEffects: toolCalls - beforeMalformed,
        duplicateOriginEffects: toolCalls - beforeDuplicate
      }).toEqual({
        permitted: [200, 200],
        denied: [403, 403, 403, 403, 403, 403, 403],
        malformedOriginBeforeBodyParse: 403,
        duplicateOrigin: 403,
        rejectedEffects: 0,
        malformedBodyEffects: 0,
        duplicateOriginEffects: 0
      });
    } finally {
      await new Promise<void>((resolve) => peer.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 25_000);
});
