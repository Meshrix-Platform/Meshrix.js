import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { modernHttpRequest, modernRequestMessage } from "../support.ts";
import { assertPeerReady, readHttpPeerPort } from "./cli-fixture-readiness.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const cliEntry = join(repo, "apps/mcp-gateway-installer/src/cli.ts");
const peerEntry = fileURLToPath(new URL("./cli-durable-intent-peer.mjs", import.meta.url));
const children: ChildProcess[] = [];

async function exitOf(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exitOf(child),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000); })
  ]);
  if (timer) clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exitOf(child);
  }
}

async function stopStartedClis(...clis: Array<StartedCli | undefined>): Promise<void> {
  const outcomes = await Promise.allSettled(clis.filter((cli): cli is StartedCli => cli !== undefined).map(async (cli) => {
    try { await stopChild(cli.child); }
    finally { cli.lines.close(); }
  }));
  const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, "One or more isolated CLI children did not close cleanly.");
}

afterEach(async () => { await Promise.all(children.splice(0).map(stopChild)); });

function withTestWatchdog<T>(promise: Promise<T>, message: string, timeoutMs = 8_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function waitForFile(path: string, message: string, timeoutMs = 8_000, owner?: ChildProcess): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(path, "utf8"); }
    catch (error) {
      if (!isMissingFile(error)) throw error;
      if (owner && (owner.exitCode !== null || owner.signalCode !== null)) throw new Error(`${message} The owning peer exited before publishing it.`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(message);
}

async function startHttpPeer(directory: string, name: string) {
  const effectFile = join(directory, `${name}.effects`);
  const markerFile = join(directory, `${name}.peer`);
  const peer = spawn(process.execPath, [peerEntry, "http", effectFile, markerFile], { stdio: ["ignore", "ignore", "ignore"] });
  children.push(peer);
  assertPeerReady(await waitForFile(`${markerFile}.ready`, "The isolated HTTP peer did not finish startup.", 8_000, peer));
  const port = readHttpPeerPort(await waitForFile(markerFile, "The isolated HTTP peer did not bind.", 8_000, peer));
  return { peer, effectFile, markerFile, endpoint: `http://127.0.0.1:${port}/mcp` };
}

async function writeConfig(directory: string, service: Record<string, unknown>, name = "gateway.json"): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify({ profile: "local", services: [service] }));
  return path;
}

interface StartedCli {
  readonly child: ChildProcess;
  readonly lines: ReturnType<typeof createInterface>;
  readonly stderr: string[];
  readonly queuedLines: string[];
  readonly lineWaiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }>;
}

function spawnCli(config: string, dataRoot: string, transport: "http" | "stdio" = "http"): StartedCli {
  const installed = process.env.MESHRIX_TEST_INSTALLED_GATEWAY_ENTRY;
  const child = spawn(process.execPath, [...(installed ? [] : ["--conditions=source"]), installed ?? cliEntry, "serve", ...(transport === "stdio" ? ["--transport", "stdio"] : []), "--config", config], {
    cwd: installed ? dirname(installed) : repo,
    stdio: [transport === "stdio" ? "pipe" : "ignore", "pipe", "pipe"],
    env: { ...process.env, MESHRIX_SERVER_DATA_DIR: dataRoot }
  });
  children.push(child);
  const stderr: string[] = [];
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr.push(chunk); });
  const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const queuedLines: string[] = [];
  const lineWaiters: StartedCli["lineWaiters"] = [];
  lines.on("line", (line) => {
    const waiter = lineWaiters.shift();
    if (waiter) waiter.resolve(line);
    else queuedLines.push(line);
  });
  lines.once("close", () => {
    for (const waiter of lineWaiters.splice(0)) waiter.reject(new Error("The isolated CLI closed before its response."));
  });
  return { child, lines, stderr, queuedLines, lineWaiters };
}

async function nextCliLine(cli: StartedCli): Promise<string> {
  if (cli.queuedLines.length > 0) return cli.queuedLines.shift()!;
  let waiter: StartedCli["lineWaiters"][number] | undefined;
  const pending = new Promise<string>((resolve, reject) => {
    waiter = { resolve, reject };
    cli.lineWaiters.push(waiter);
  });
  try { return await withTestWatchdog(pending, "The isolated CLI response did not arrive."); }
  finally {
    if (waiter) {
      const index = cli.lineWaiters.indexOf(waiter);
      if (index >= 0) cli.lineWaiters.splice(index, 1);
    }
  }
}

async function httpEndpoint(cli: StartedCli): Promise<string> {
  try {
    const line = await nextCliLine(cli);
    const value = JSON.parse(line) as { interopEndpoint?: unknown };
    if (typeof value.interopEndpoint !== "string") throw new Error("HTTP readiness did not contain an endpoint.");
    return value.interopEndpoint;
  } catch (error) {
    if (cli.child.exitCode === null && cli.child.signalCode === null) await exitOf(cli.child);
    if (cli.child.exitCode !== null || cli.child.signalCode !== null) throw new Error(`CLI exited before HTTP readiness (${cli.stderr.join("").trim() || "no diagnostic"}).`);
    throw error;
  }
}

async function stdioReady(cli: StartedCli, marker: string): Promise<void> {
  assertPeerReady(await waitForFile(`${marker}.ready`, "The isolated stdio peer did not finish MCP discovery.", 8_000, cli.child));
}

async function nextLine(cli: StartedCli): Promise<Record<string, unknown>> {
  return JSON.parse(await nextCliLine(cli)) as Record<string, unknown>;
}

async function sendHttp(endpoint: string, method: string, params: Record<string, unknown>, id: string) {
  const wire = modernHttpRequest(method, id, params);
  const response = await fetch(endpoint, { method: wire.method, headers: wire.headers, body: JSON.stringify(wire.body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function intentRows(filePath: string): Array<{ intent_id: string; state: string }> {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try { return db.prepare("SELECT intent_id, state FROM gateway_execution_intents ORDER BY intent_id").all() as Array<{ intent_id: string; state: string }>; }
  finally { db.close(); }
}

describe("standalone CLI durable non-read intent owner", () => {
  it("keeps a read-only profile artifact-free, then persists a normal HTTP write under the existing data-root lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-cli-intent-http-"));
    const dataRoot = join(directory, "data");
    const peer = await startHttpPeer(directory, "normal-http");
    let cli: StartedCli | undefined;
    try {
      const readConfig = await writeConfig(directory, { serviceId: "synthetic", baseUrl: peer.endpoint, toolRisk: { synthetic: "read" } });
      cli = spawnCli(readConfig, dataRoot);
      const endpoint = await httpEndpoint(cli);
      expect((await sendHttp(endpoint, "tools/call", { name: "synthetic", arguments: {} }, "standard-read")).status).toBe(200);
      expect(existsSync(join(dataRoot, "gateway"))).toBe(false);
      await stopChild(cli.child);
      cli.lines.close();

      const writeConfigPath = await writeConfig(directory, { serviceId: "synthetic", baseUrl: peer.endpoint, toolRisk: { synthetic: "safe_write" } });
      cli = spawnCli(writeConfigPath, dataRoot);
      const writeEndpoint = await httpEndpoint(cli);
      const response = await sendHttp(writeEndpoint, "tools/call", { name: "synthetic", arguments: {} }, "standard-write");
      expect(response.status).toBe(200);
      const filePath = join(dataRoot, "gateway", "execution.sqlite");
      expect(intentRows(filePath)).toMatchObject([{ state: "succeeded" }]);
      expect(statSync(filePath).mode & 0o077).toBe(0);
      expect(statSync(dirname(filePath)).mode & 0o077).toBe(0);
      expect(await readFile(peer.effectFile, "utf8")).toBe("2");
    } finally {
      try { await stopStartedClis(cli); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, 25_000);

  it("keeps an interrupted HTTP dispatch fenced and never resends it on restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-cli-intent-http-crash-"));
    const dataRoot = join(directory, "data");
    const peer = await startHttpPeer(directory, "crash-http");
    const config = await writeConfig(directory, { serviceId: "synthetic", baseUrl: peer.endpoint, toolRisk: { synthetic: "safe_write" } });
    let first: StartedCli | undefined;
    let restarted: StartedCli | undefined;
    try {
      first = spawnCli(config, dataRoot);
      const endpoint = await httpEndpoint(first);
      const pending = sendHttp(endpoint, "tools/call", { name: "synthetic", arguments: { hold: true } }, "interrupted-write").then(() => undefined, () => undefined);
      expect(await waitForFile(`${peer.markerFile}.effect`, "The HTTP peer did not durably record the held effect.")).toBe("1");
      first.child.kill("SIGKILL");
      await exitOf(first.child);
      await pending.catch(() => undefined);
      expect(await readFile(peer.effectFile, "utf8")).toBe("1");

      restarted = spawnCli(config, dataRoot);
      const restartedEndpoint = await httpEndpoint(restarted);
      expect((await sendHttp(restartedEndpoint, "tools/list", {}, "restart-list")).status).toBe(200);
      expect(intentRows(join(dataRoot, "gateway", "execution.sqlite"))).toMatchObject([{ state: "dispatch_started" }]);
      expect(await readFile(peer.effectFile, "utf8")).toBe("1");
    } finally {
      try { await stopStartedClis(first, restarted); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, 25_000);

  it("fails closed before HTTP effects when storage is unsafe and refuses a second active owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-cli-intent-owner-"));
    const dataRoot = join(directory, "data");
    const peerA = await startHttpPeer(directory, "owner-a");
    const peerB = await startHttpPeer(directory, "owner-b");
    const configA = await writeConfig(directory, { serviceId: "synthetic", baseUrl: peerA.endpoint, toolRisk: { synthetic: "safe_write" } }, "gateway-a.json");
    const configB = await writeConfig(directory, { serviceId: "synthetic", baseUrl: peerB.endpoint, toolRisk: { synthetic: "safe_write" } }, "gateway-b.json");
    let first: StartedCli | undefined;
    let second: StartedCli | undefined;
    let unsafeCli: StartedCli | undefined;
    try {
      const unsafeRoot = join(directory, "unsafe-data");
      await mkdir(unsafeRoot, { recursive: true });
      const blocker = join(directory, "not-a-directory");
      await writeFile(blocker, "synthetic");
      await symlink(blocker, join(unsafeRoot, "gateway"));
      unsafeCli = spawnCli(configA, unsafeRoot);
      const unsafeEndpoint = await httpEndpoint(unsafeCli);
      const unsafe = await sendHttp(unsafeEndpoint, "tools/call", { name: "synthetic", arguments: {} }, "unsafe-storage");
      expect(unsafe.body).toBeDefined();
      expect(existsSync(peerA.effectFile)).toBe(false);
      await stopChild(unsafeCli.child);
      unsafeCli.lines.close();
      unsafeCli = undefined;

      first = spawnCli(configA, dataRoot);
      const firstEndpoint = await httpEndpoint(first);
      const firstResponse = await sendHttp(firstEndpoint, "tools/call", { name: "synthetic", arguments: {} }, "owner-first-write");
      expect(firstResponse).toMatchObject({ status: 200, body: { result: { resultType: "complete", structuredContent: { effectCount: 1 } } } });
      expect(await readFile(peerA.effectFile, "utf8")).toBe("1");

      second = spawnCli(configB, dataRoot);
      const secondEndpoint = await httpEndpoint(second);
      const refused = await sendHttp(secondEndpoint, "tools/call", { name: "synthetic", arguments: {} }, "owner-second-write");
      expect(refused.body.error).toBeDefined();
      expect(existsSync(peerB.effectFile)).toBe(false);
      const retainedOwner = await sendHttp(firstEndpoint, "tools/call", { name: "synthetic", arguments: {} }, "owner-still-active");
      expect(retainedOwner).toMatchObject({ status: 200, body: { result: { resultType: "complete", structuredContent: { effectCount: 2 } } } });
      expect(await readFile(peerA.effectFile, "utf8")).toBe("2");
    } finally {
      try { await stopStartedClis(unsafeCli, second, first); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, 30_000);

  it("persists stdio completion and recovers a response-lost child effect without a second send", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-cli-intent-stdio-"));
    const dataRoot = join(directory, "data");
    const effectFile = join(directory, "stdio.effects");
    const firstMarker = join(directory, "stdio-first.peer");
    const secondMarker = join(directory, "stdio-second.peer");
    const config = await writeConfig(directory, { serviceId: "synthetic", transport: "stdio", command: process.execPath,
      args: [peerEntry, "stdio", effectFile, firstMarker], toolRisk: { synthetic: "safe_write" } });
    let first: StartedCli | undefined;
    let restarted: StartedCli | undefined;
    try {
      first = spawnCli(config, dataRoot, "stdio");
      await stdioReady(first, firstMarker);
      first.child.stdin!.write(`${JSON.stringify(modernRequestMessage("tools/call", "stdio-complete", { name: "synthetic", arguments: {} }))}\n`);
      const completed = await nextLine(first);
      expect((completed.result as { structuredContent?: unknown })?.structuredContent).toMatchObject({ effectCount: 1 });
      const filePath = join(dataRoot, "gateway", "execution.sqlite");
      expect(intentRows(filePath)).toMatchObject([{ state: "succeeded" }]);

      first.child.stdin!.write(`${JSON.stringify(modernRequestMessage("tools/call", "stdio-interrupted", { name: "synthetic", arguments: { hold: true } }))}\n`);
      expect(await waitForFile(`${firstMarker}.effect`, "The stdio peer did not persist its held effect.")).toBe("2");
      first.child.kill("SIGKILL");
      await exitOf(first.child);
      expect(await waitForFile(`${firstMarker}.closed`, "The owned stdio peer did not close after its parent exited.")).toBe("closed");
      expect(await readFile(effectFile, "utf8")).toBe("2");

      await writeFile(config, JSON.stringify({ profile: "local", services: [{ serviceId: "synthetic", transport: "stdio", command: process.execPath,
        args: [peerEntry, "stdio", effectFile, secondMarker], toolRisk: { synthetic: "safe_write" } }] }));
      restarted = spawnCli(config, dataRoot, "stdio");
      await stdioReady(restarted, secondMarker);
      expect(intentRows(filePath).map((row) => row.state).sort()).toEqual(["dispatch_started", "succeeded"]);
      restarted.child.stdin!.write(`${JSON.stringify(modernRequestMessage("tools/list", "stdio-restart-list", {}))}\n`);
      await nextLine(restarted);
      expect(await readFile(effectFile, "utf8")).toBe("2");
    } finally {
      try { await stopStartedClis(first, restarted); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, 30_000);
});
