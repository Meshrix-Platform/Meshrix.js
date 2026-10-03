import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { modernRequestMessage } from "../support.ts";
import { assertPeerReady } from "./cli-fixture-readiness.ts";

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

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function waitForFile(path: string, timeoutMs = 5_000, owner?: ChildProcess): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(path, "utf8"); }
    catch (error) {
      if (!isMissingFile(error)) throw error;
      if (owner && (owner.exitCode !== null || owner.signalCode !== null)) throw new Error("The owning CLI exited before its fixture marker was published.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("The controlled stdio upstream did not write its marker.");
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number, message: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off("exit", onExit); };
    const onExit = () => { cleanup(); resolve(); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(message)); }, timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

async function waitForStdoutBackpressure(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  const stream = child.stdout;
  if (!stream) throw new Error("The CLI stdout fixture pipe is unavailable.");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stream.readableLength >= stream.readableHighWaterMark) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The CLI stdout fixture pipe did not fill without a reader.");
}

function withTestWatchdog<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("The controlled stdio CLI did not settle.")), timeoutMs); })
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

const controlledOwnedStdioPeer = `import { renameSync, writeFileSync } from 'node:fs';
function publishFile(suffix, value) {
  const target = process.argv[2] + suffix;
  const pending = target + '.writing';
  writeFileSync(pending, value);
  renameSync(pending, target);
}
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffered += chunk;
  let boundary;
  while ((boundary = buffered.indexOf('\\n')) >= 0) {
    const line = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 1);
    if (!line) continue;
    const wire = JSON.parse(line);
    if (wire.id === undefined) continue;
    if (wire.method === 'prompts/list') publishFile('.ready', 'ready');
    if (wire.method === 'tools/call') {
      publishFile('.call', String(wire.id));
      if (wire.params?.arguments?.__exitSignal === 'SIGUSR2') process.kill(process.pid, 'SIGUSR2');
      continue;
    }
    const result = wire.method === 'server/discover' ? { resultType: 'complete', supportedVersions: ['2026-07-28'] }
      : wire.method === 'tools/list' ? { resultType: 'complete', tools: [{ name: 'synthetic', inputSchema: { type: 'object' } }] }
        : { resultType: 'complete', resources: [], resourceTemplates: [], prompts: [] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result }) + '\\n');
  }
});
process.on('SIGTERM', () => { publishFile('.closed', 'closed'); process.exit(0); });
`;

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
    let child: ChildProcess | undefined;
    let output: ReturnType<typeof createInterface> | undefined;
    try {
      const address = peer.address();
      if (!address || typeof address === "string") throw new Error("synthetic peer is unavailable");
      const config = join(directory, "gateway.json");
      await writeFile(config, JSON.stringify({ profile: "local", services: [{ serviceId: "synthetic", baseUrl: "$MESHRIX_INTEROP_PEER_ENDPOINT", toolRisk: { synthetic: "read" } }] }));
      const installed = process.env.MESHRIX_TEST_INSTALLED_GATEWAY_ENTRY;
      const cli = spawn(process.execPath, [...(installed ? [] : ["--conditions=source"]), installed ?? join(repo, "apps/mcp-gateway-installer/src/cli.ts"), "serve", "--transport", "stdio", "--config", config], {
        cwd: installed ? dirname(installed) : repo, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MESHRIX_INTEROP_PEER_ENDPOINT: `http://127.0.0.1:${address.port}/mcp` }
      });
      child = cli;
      children.push(cli);
      const lines = createInterface({ input: cli.stdout!, crlfDelay: Infinity });
      output = lines;
      const request = async (method: string, params: Record<string, unknown> = {}) => {
        const reply = new Promise<Record<string, any>>((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); lines.off("line", onLine); cli.off("exit", onExit); };
          const onLine = (line: string) => { cleanup(); resolve(JSON.parse(line)); };
          const onExit = () => { cleanup(); reject(new Error("stdio gateway exited")); };
          const timer = setTimeout(() => { cleanup(); reject(new Error("stdio response timed out")); }, 10_000);
          lines.once("line", onLine);
          cli.once("exit", onExit);
          if (cli.exitCode !== null || cli.signalCode !== null) onExit();
        });
        if (cli.exitCode === null && cli.signalCode === null) cli.stdin!.write(`${JSON.stringify(modernRequestMessage(method, method, params))}\n`);
        return reply;
      };
      expect((await request("tools/list")).result.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "synthetic" })]));
      expect((await request("tools/call", { name: "synthetic", arguments: {} })).result).toMatchObject({ resultType: "complete", content: [{ text: "stdio-peer" }] });
      cli.stdin!.end();
      await waitForChildExit(cli, 5_000, "The stdio CLI did not exit after EOF.");
      expect(cli.exitCode).toBe(0);
    } finally {
      try {
        if (child && child.exitCode === null && child.signalCode === null) await stopTestChild(child);
      } finally {
        output?.close();
        try { await new Promise<void>((resolve) => peer.close(() => resolve())); }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
  }, 20_000);

  it("settles a held owned stdio peer on CLI SIGTERM and closes the peer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-stdio-cancel-cli-"));
    const script = join(directory, "peer.mjs");
    const marker = join(directory, "peer");
    const config = join(directory, "gateway.json");
    let child: ChildProcess | undefined;
    let output: ReturnType<typeof createInterface> | undefined;
    try {
      await writeFile(script, controlledOwnedStdioPeer);
      await writeFile(config, JSON.stringify({ profile: "local", services: [{ serviceId: "held-stdio", transport: "stdio", command: process.execPath, args: [script, marker], toolRisk: { synthetic: "read" } }] }));
      const installed = process.env.MESHRIX_TEST_INSTALLED_GATEWAY_ENTRY;
      child = spawn(process.execPath, [...(installed ? [] : ["--conditions=source"]), installed ?? join(repo, "apps/mcp-gateway-installer/src/cli.ts"), "serve", "--transport", "stdio", "--config", config], {
        cwd: installed ? dirname(installed) : repo, stdio: ["pipe", "pipe", "pipe"]
      });
      children.push(child);
      output = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      assertPeerReady(await waitForFile(`${marker}.ready`, 5_000, child));
      const request = (method: string, id: string, params: Record<string, unknown> = {}) => withTestWatchdog(new Promise<Record<string, unknown>>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); output!.off("line", onLine); child!.off("exit", onExit); };
        const onLine = (line: string) => { cleanup(); resolve(JSON.parse(line) as Record<string, unknown>); };
        const onExit = () => { cleanup(); reject(new Error("CLI exited before its stdio reply.")); };
        const timer = setTimeout(() => { cleanup(); reject(new Error("CLI stdio reply watchdog expired.")); }, 5_000);
        output!.once("line", onLine);
        child!.once("exit", onExit);
        child!.stdin!.write(`${JSON.stringify(modernRequestMessage(method, id, params))}\n`);
      }), 6_000);

      expect(await request("tools/list", "list")).toMatchObject({ id: "list", result: { tools: [expect.objectContaining({ name: "synthetic" })] } });
      const heldCall = request("tools/call", "held-call", { name: "synthetic", arguments: {} });
      await waitForFile(`${marker}.call`, 5_000, child);
      child.kill("SIGTERM");
      expect(await heldCall).toMatchObject({ id: "held-call" });
      await waitForChildExit(child, 5_000, "CLI did not exit after upstream cancellation.");
      expect(child.exitCode).toBe(0);
      expect(await waitForFile(`${marker}.closed`)).toBe("closed");
    } finally {
      try { if (child && child.exitCode === null && child.signalCode === null) await stopTestChild(child); }
      finally {
        try { output?.close(); }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
  }, 15_000);

  it("returns a failed MCP call when its owned stdio peer exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-stdio-peer-failure-"));
    const script = join(directory, "peer.mjs");
    const marker = join(directory, "peer");
    const config = join(directory, "gateway.json");
    let child: ChildProcess | undefined;
    let output: ReturnType<typeof createInterface> | undefined;
    try {
      await writeFile(script, controlledOwnedStdioPeer);
      await writeFile(config, JSON.stringify({ profile: "local", services: [{ serviceId: "failed-stdio", transport: "stdio", command: process.execPath, args: [script, marker], toolRisk: { synthetic: "read" } }] }));
      const installed = process.env.MESHRIX_TEST_INSTALLED_GATEWAY_ENTRY;
      child = spawn(process.execPath, [...(installed ? [] : ["--conditions=source"]), installed ?? join(repo, "apps/mcp-gateway-installer/src/cli.ts"), "serve", "--transport", "stdio", "--config", config], {
        cwd: installed ? dirname(installed) : repo, stdio: ["pipe", "pipe", "pipe"]
      });
      children.push(child);
      output = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      assertPeerReady(await waitForFile(`${marker}.ready`, 5_000, child));
      const request = (method: string, id: string, params: Record<string, unknown> = {}) => withTestWatchdog(new Promise<Record<string, unknown>>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); output!.off("line", onLine); child!.off("exit", onExit); };
        const onLine = (line: string) => { cleanup(); resolve(JSON.parse(line) as Record<string, unknown>); };
        const onExit = () => { cleanup(); reject(new Error("CLI exited before its stdio reply.")); };
        const timer = setTimeout(() => { cleanup(); reject(new Error("CLI stdio reply watchdog expired.")); }, 5_000);
        output!.once("line", onLine);
        child!.once("exit", onExit);
        child!.stdin!.write(`${JSON.stringify(modernRequestMessage(method, id, params))}\n`);
      }), 6_000);

      expect(await request("tools/list", "list")).toMatchObject({ id: "list", result: { tools: [expect.objectContaining({ name: "synthetic" })] } });
      const failedCall = request("tools/call", "peer-failure", { name: "synthetic", arguments: { __exitSignal: "SIGUSR2" } });
      await waitForFile(`${marker}.call`, 5_000, child);
      expect(await failedCall).toMatchObject({ id: "peer-failure", error: expect.any(Object) });
      child.stdin!.end();
      await waitForChildExit(child, 5_000, "CLI did not exit after the stdio peer failure.");
      expect(child.exitCode).toBe(0);
    } finally {
      try { if (child && child.exitCode === null && child.signalCode === null) await stopTestChild(child); }
      finally {
        try { output?.close(); }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
  }, 15_000);

  it("closes gateway-owned peers on SIGTERM while a completed reply is blocked on stdout drain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-stdio-output-drain-"));
    const script = join(directory, "peer.mjs");
    const marker = join(directory, "peer");
    const config = join(directory, "gateway.json");
    let child: ChildProcess | undefined;
    try {
      await writeFile(script, `import { renameSync, writeFileSync } from 'node:fs';
function publishFile(suffix, value) {
  const target = process.argv[2] + suffix;
  const pending = target + '.writing';
  writeFileSync(pending, value);
  renameSync(pending, target);
}
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffered += chunk;
  let boundary;
  while ((boundary = buffered.indexOf('\\n')) >= 0) {
    const line = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 1);
    if (!line) continue;
    const wire = JSON.parse(line);
    if (wire.id === undefined) continue;
    if (wire.method === 'prompts/list') publishFile('.ready', 'ready');
    if (wire.method === 'tools/call') {
      publishFile('.call', String(wire.id));
      const result = { resultType: 'complete', content: [{ type: 'text', text: 'x'.repeat(700 * 1024) }] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result }) + '\\n');
      continue;
    }
    const result = wire.method === 'server/discover' ? { resultType: 'complete', supportedVersions: ['2026-07-28'] }
      : wire.method === 'tools/list' ? { resultType: 'complete', tools: [{ name: 'synthetic', inputSchema: { type: 'object' } }] }
        : { resultType: 'complete', resources: [], resourceTemplates: [], prompts: [] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result }) + '\\n');
  }
});
process.on('SIGTERM', () => { publishFile('.closed', 'closed'); process.exit(0); });
`);
      await writeFile(config, JSON.stringify({ profile: "local", services: [{ serviceId: "large-stdio", transport: "stdio", command: process.execPath, args: [script, marker], toolRisk: { synthetic: "read" } }] }));
      const installed = process.env.MESHRIX_TEST_INSTALLED_GATEWAY_ENTRY;
      child = spawn(process.execPath, [...(installed ? [] : ["--conditions=source"]), installed ?? join(repo, "apps/mcp-gateway-installer/src/cli.ts"), "serve", "--transport", "stdio", "--config", config], {
        cwd: installed ? dirname(installed) : repo, stdio: ["pipe", "pipe", "pipe"]
      });
      children.push(child);
      assertPeerReady(await waitForFile(`${marker}.ready`, 5_000, child));
      child.stdin!.write(`${JSON.stringify(modernRequestMessage("tools/call", "large-reply", { name: "synthetic", arguments: {} }))}\n`);
      await waitForFile(`${marker}.call`, 5_000, child);
      await waitForStdoutBackpressure(child);

      child.kill("SIGTERM");
      expect(await waitForFile(`${marker}.closed`, 1_500)).toBe("closed");
      await waitForChildExit(child, 1_500, `CLI did not exit after stdout cancellation (exitCode=${child.exitCode}, signalCode=${child.signalCode}).`);
      expect(child.exitCode).toBe(0);
    } finally {
      try { if (child && child.exitCode === null && child.signalCode === null) await stopTestChild(child); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, 12_000);
});
