import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { modernHttpRequest } from "../support.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const children: ChildProcess[] = [];
async function stopTestChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { child.off("exit", onExit); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); resolve(); }, 1_000);
    child.once("exit", onExit);
  });
  if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
afterEach(async () => { await Promise.all(children.splice(0).map(stopTestChild)); });

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function withTestWatchdog<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Controlled upstream fixture did not settle.")), timeoutMs); })
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

describe("gateway-only installed command entry surface", () => {
  it("[GC-056 GC-057 partial] serves a real local MCP endpoint and sends modern metadata without initialize", async () => {
    const observed: Array<{ method: string; params: Record<string, unknown> }> = [];
    const heldCalls: Array<{ readonly started: ReturnType<typeof deferred<void>>; readonly closed: ReturnType<typeof deferred<boolean>>; readonly release: ReturnType<typeof deferred<void>> }> = [];
    const allHolds: Array<{ readonly started: ReturnType<typeof deferred<void>>; readonly closed: ReturnType<typeof deferred<boolean>>; readonly release: ReturnType<typeof deferred<void>> }> = [];
    const peer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      observed.push(wire);
      if (wire.method === "tools/call" && wire.params?.arguments?.hold === true) {
        const hold = heldCalls.shift();
        if (!hold) throw new Error("No controlled hold was prepared for the upstream call.");
        hold.started.resolve();
        const peerClosed = new Promise<boolean>((resolve) => response.once("close", () => resolve(true)));
        const fixtureReleased = hold.release.promise.then(() => false);
        const cancelled = await Promise.race([peerClosed, fixtureReleased]);
        hold.closed.resolve(cancelled);
        if (cancelled) return;
      }
      const result = wire.method === "server/discover"
        ? { resultType: "complete", supportedVersions: ["2026-07-28"] }
        : wire.method === "tools/list"
        ? { resultType: "complete", tools: [{ name: "synthetic", inputSchema: { type: "object" } }] }
        : wire.method === "tools/call"
          ? { resultType: "complete", content: [{ type: "text", text: "genuine" }], structuredContent: { source: "peer" } }
          : { resultType: "complete", resources: [], resourceTemplates: [], prompts: [] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id, result }));
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const directory = await mkdtemp(join(tmpdir(), "meshrix-installed-cli-"));
    try {
      const address = peer.address();
      if (!address || typeof address === "string") throw new Error("synthetic peer has no TCP address");
      const config = join(directory, "gateway.json");
      await writeFile(config, JSON.stringify({ profile: "local", services: [{ serviceId: "synthetic", baseUrl: "$MESHRIX_INTEROP_PEER_ENDPOINT", toolRisk: { synthetic: "read" } }] }));
      const installedEntry = process.env.MESHRIX_TEST_INSTALLED_GATEWAY_ENTRY;
      const cli = spawn(process.execPath, [...(installedEntry ? [] : ["--conditions=source"]), installedEntry ?? join(repo, "apps/mcp-gateway-installer/src/cli.ts"), "serve", "--config", config], {
        cwd: installedEntry ? dirname(installedEntry) : repo, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, MESHRIX_INTEROP_PEER_ENDPOINT: `http://127.0.0.1:${address.port}/mcp` }
      });
      children.push(cli);
      const endpoint = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => reject(new Error("gateway readiness timeout")), 10_000);
        cli.once("exit", () => { clearTimeout(timeout); reject(new Error("gateway exited before readiness")); });
        cli.stdout!.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          const line = output.split("\n")[0];
          if (!line.endsWith("}")) return;
          clearTimeout(timeout);
          resolve(JSON.parse(line).interopEndpoint);
        });
      });
      const send = async (method: string, params: Record<string, unknown> = {}) => {
        const wire = modernHttpRequest(method, method, params);
        const response = await fetch(endpoint, { method: wire.method, headers: wire.headers, body: JSON.stringify(wire.body) });
        return response.json();
      };
      expect((await send("tools/list")).result.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "synthetic" })]));
      const result = await send("tools/call", { name: "synthetic", arguments: {} });
      expect(result.result).toMatchObject({ resultType: "complete", structuredContent: { source: "peer" } });
      expect((await send("tools/call", { name: "synthetic", arguments: {} })).result).toMatchObject({ resultType: "complete", structuredContent: { source: "peer" } });
      const callCountBeforeMalformed = observed.filter((item) => item.method === "tools/call").length;
      const malformedRequest = modernHttpRequest("tools/list", "malformed-json");
      const malformedResponse = await fetch(endpoint, { method: malformedRequest.method, headers: malformedRequest.headers, body: "{", signal: AbortSignal.timeout(1_000) });
      expect(malformedResponse.status).toBe(400);
      expect(await malformedResponse.json()).toMatchObject({ error: { code: -32600 } });
      expect(observed.filter((item) => item.method === "tools/call")).toHaveLength(callCountBeforeMalformed);

      const clientDisconnect = { started: deferred<void>(), closed: deferred<boolean>(), release: deferred<void>() };
      heldCalls.push(clientDisconnect);
      allHolds.push(clientDisconnect);
      const disconnected = new AbortController();
      const heldCall = modernHttpRequest("tools/call", "client-disconnect", { name: "synthetic", arguments: { hold: true } });
      const disconnectedCall = fetch(endpoint, { method: heldCall.method, headers: heldCall.headers, body: JSON.stringify(heldCall.body), signal: disconnected.signal });
      await clientDisconnect.started.promise;
      disconnected.abort();
      await expect(disconnectedCall).rejects.toMatchObject({ name: "AbortError" });
      await expect(withTestWatchdog(clientDisconnect.closed.promise, 2_000)).resolves.toBe(true);

      expect(observed.some((item) => item.method === "initialize")).toBe(false);
      expect(observed.find((item) => item.method === "tools/call")?.params._meta).toMatchObject({ "io.modelcontextprotocol/protocolVersion": "2026-07-28" });

      const shutdown = { started: deferred<void>(), closed: deferred<boolean>(), release: deferred<void>() };
      heldCalls.push(shutdown);
      allHolds.push(shutdown);
      const heldDuringShutdown = modernHttpRequest("tools/call", "cli-shutdown", { name: "synthetic", arguments: { hold: true } });
      const shutdownCall = fetch(endpoint, { method: heldDuringShutdown.method, headers: heldDuringShutdown.headers, body: JSON.stringify(heldDuringShutdown.body) })
        .then(async (response) => ({ status: response.status, body: await response.json() }), (error: unknown) => ({ error }));
      await shutdown.started.promise;
      cli.kill("SIGTERM");
      const shutdownOutcome = await withTestWatchdog(shutdownCall, 8_000);
      expect(shutdownOutcome).toBeDefined();
      await expect(withTestWatchdog(shutdown.closed.promise, 2_000)).resolves.toBe(true);
      if (cli.exitCode === null && cli.signalCode === null) {
        await withTestWatchdog(new Promise<void>((resolve) => cli.once("exit", () => resolve())), 2_000);
      }
      expect(cli.exitCode).toBe(0);
    } finally {
      for (const hold of allHolds) hold.release.resolve();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("[GC-065] returns two independently owned peer facts unchanged across a gateway restart", async () => {
    const peers: ReturnType<typeof createServer>[] = [];
    const peerVersions: Record<string, number> = { alpha: 0, beta: 0 };
    const directory = await mkdtemp(join(tmpdir(), "meshrix-two-neutral-services-"));
    let child: ChildProcess | undefined;
    try {
      const services = [];
      for (const label of ["alpha", "beta"]) {
        const peer = createServer(async (request, response) => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk);
          const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const result = wire.method === "server/discover" ? { resultType: "complete", supportedVersions: ["2026-07-28"] }
            : wire.method === "tools/list" ? { resultType: "complete", tools: [{ name: label, inputSchema: { type: "object" } }] }
              : wire.method === "tools/call" ? { resultType: "complete", structuredContent: { source: label, version: ++peerVersions[label] }, content: [{ type: "text", text: label }] }
                : { resultType: "complete", resources: [], resourceTemplates: [], prompts: [] };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id, result }));
        });
        peers.push(peer);
        await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
        const address = peer.address();
        if (!address || typeof address === "string") throw new Error("synthetic peer has no TCP address");
        services.push({ serviceId: label, baseUrl: `http://127.0.0.1:${address.port}/mcp`, toolRisk: { [label]: "read" } });
      }
      const config = join(directory, "gateway.json");
      await writeFile(config, JSON.stringify({ profile: "local", services }));
      const installed = process.env.MESHRIX_TEST_INSTALLED_GATEWAY_ENTRY;
      const start = async () => {
        child = spawn(process.execPath, [...(installed ? [] : ["--conditions=source"]), installed ?? join(repo, "apps/mcp-gateway-installer/src/cli.ts"), "serve", "--config", config], { cwd: installed ? dirname(installed) : repo, stdio: ["ignore", "pipe", "pipe"] });
        children.push(child);
        return new Promise<string>((resolve, reject) => {
          let output = "";
          const timeout = setTimeout(() => reject(new Error("two-service gateway readiness timeout")), 10_000);
          child!.once("exit", () => { clearTimeout(timeout); reject(new Error("two-service gateway exited early")); });
          child!.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); const line = output.split("\n")[0]; if (line.endsWith("}")) { clearTimeout(timeout); resolve(JSON.parse(line).interopEndpoint); } });
        });
      };
      let endpoint = await start();
      const send = async (method: string, params: Record<string, unknown> = {}) => {
        const wire = modernHttpRequest(method, method, params);
        return (await fetch(endpoint, { method: wire.method, headers: wire.headers, body: JSON.stringify(wire.body) })).json();
      };
      const listed = (await send("tools/list")).result.tools.map((item: { name: string }) => item.name);
      expect(listed).toEqual(expect.arrayContaining(["alpha", "beta"]));
      expect((await send("tools/call", { name: "alpha", arguments: {} })).result.structuredContent).toEqual({ source: "alpha", version: 1 });
      expect((await send("tools/call", { name: "beta", arguments: {} })).result.structuredContent).toEqual({ source: "beta", version: 1 });
      expect((await send("tools/call", { name: "alpha", arguments: {} })).result.structuredContent).toEqual({ source: "alpha", version: 2 });
      expect(peerVersions).toEqual({ alpha: 2, beta: 1 });
      child.kill("SIGTERM");
      await new Promise((resolve) => child!.once("exit", resolve));
      expect(child.exitCode).toBe(0);
      endpoint = await start();
      expect((await send("tools/call", { name: "alpha", arguments: {} })).result.structuredContent).toEqual({ source: "alpha", version: 3 });
      expect((await send("tools/call", { name: "beta", arguments: {} })).result.structuredContent).toEqual({ source: "beta", version: 2 });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child!.once("exit", resolve)); }
      await Promise.all(peers.map((peer) => new Promise<void>((resolve) => peer.close(() => resolve()))));
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
