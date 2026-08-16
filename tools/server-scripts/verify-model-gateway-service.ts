#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVICE_DIR = path.join(ROOT, "services", "model-gateway");
const SERVICE_ENTRY = path.join(SERVICE_DIR, "src", "main.mjs");

const CLIENT_ID = "verifier-admin";
const CLIENT_SECRET = "model-gateway-verifier-secret-000000000000000000000000";
const CLIENT_SCOPES = ["model:call", "model:manage", "ledger:read"];
const CLIENT_JSON = JSON.stringify({
  [CLIENT_ID]: { subject: "verifier-subject", secret: CLIENT_SECRET, scopes: CLIENT_SCOPES }
});

const IDEMPOTENCY_KEY = "verify-settled-once";

type JsonObject = Record<string, unknown>;
type JsonArray = unknown[];

function asObject(value: unknown): JsonObject {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "expected a JSON object");
  return value as JsonObject;
}

function asArray(value: unknown): JsonArray {
  assert.ok(Array.isArray(value), "expected a JSON array");
  return value as JsonArray;
}

function asString(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}

function asNumber(value: unknown): number {
  assert.equal(typeof value, "number");
  return value as number;
}

interface ServiceHandle {
  child: ChildProcess;
  baseUrl: string;
  dataRoot: string;
}

interface FixtureHandle {
  baseUrl: string;
  calls: () => number;
  close: () => Promise<void>;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("service did not exit before timeout"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForStarted(child: ChildProcess): Promise<number> {
  const stream = child.stdout;
  if (!stream) throw new Error("service stdout is unavailable");
  const output: Readable = stream;
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("service did not report a listening port before timeout"));
    }, 15_000);
    function cleanup() {
      clearTimeout(timer);
      output.off("data", onData);
      child.off("exit", onExit);
    }
    function onData(chunk: Buffer) {
      buffer += chunk.toString("utf8");
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd < 0) return;
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      let parsed: { event?: string; port?: number } | null = null;
      try {
        parsed = JSON.parse(line) as { event?: string; port?: number };
      } catch {
        return;
      }
      if (parsed?.event === "model_gateway.started" && Number.isSafeInteger(parsed.port)) {
        cleanup();
        resolve(parsed.port as number);
      }
    }
    function onExit(code: number | null) {
      cleanup();
      reject(new Error(`service exited before listening (code ${code ?? "unknown"})`));
    }
    output.on("data", onData);
    child.once("exit", onExit);
  });
}

async function startService(options: {
  dataRoot: string;
  clients: string;
  bounds?: Record<string, string>;
}): Promise<ServiceHandle> {
  const child = spawn(process.execPath, [SERVICE_ENTRY], {
    cwd: SERVICE_DIR,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      MODEL_GATEWAY_DATA_ROOT: options.dataRoot,
      MODEL_GATEWAY_CLIENTS: options.clients,
      MODEL_GATEWAY_MAX_ATTEMPTS: "2",
      ...options.bounds
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr?.on("data", () => {
    // Consumed and never printed; failures surface as assertions only.
  });
  const port = await waitForStarted(child);
  return { child, baseUrl: `http://127.0.0.1:${port}`, dataRoot: options.dataRoot };
}

async function stopService(handle: ServiceHandle): Promise<void> {
  if (handle.child.exitCode !== null) return;
  handle.child.kill("SIGTERM");
  const code = await waitForExit(handle.child, 10_000);
  assert.equal(code, 0, "service must shut down cleanly on SIGTERM");
}

async function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: { ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(10_000)
  });
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { unparsed: true };
    }
  }
  return { status: response.status, body };
}

async function provision(service: ServiceHandle): Promise<void> {
  const auth = { authorization: `Bearer ${CLIENT_SECRET}`, "content-type": "application/json" };
  const provider = await requestJson(`${service.baseUrl}/v1/model-gateway/providers`, {
    method: "POST",
    headers: auth,
    body: { providerId: "prov1", protocol: "openai", enabled: true }
  });
  assert.equal(provider.status, 200, "provider management must accept a valid provider");
  const pricing = await requestJson(`${service.baseUrl}/v1/model-gateway/pricing-revisions`, {
    method: "POST",
    headers: auth,
    body: {
      revisionRef: "price-1",
      modelRef: "model-1",
      currency: "USD",
      inputTokenRate: { currency: "USD", units: 0, nanos: 1_000_000 },
      outputTokenRate: { currency: "USD", units: 0, nanos: 2_000_000 },
      immutable: true
    }
  });
  assert.equal(pricing.status, 200, "pricing revision management must accept an immutable revision");
  const model = await requestJson(`${service.baseUrl}/v1/model-gateway/models`, {
    method: "POST",
    headers: auth,
    body: { modelId: "model-1", providerRef: "prov1", pricingRevisionRef: "price-1", enabled: true }
  });
  assert.equal(model.status, 200, "model management must accept a model bound to provider and pricing");
  const provider2 = await requestJson(`${service.baseUrl}/v1/model-gateway/providers`, {
    method: "POST",
    headers: auth,
    body: { providerId: "prov2", protocol: "anthropic", enabled: true }
  });
  assert.equal(provider2.status, 200, "provider management must accept an anthropic provider");
  const pricing2 = await requestJson(`${service.baseUrl}/v1/model-gateway/pricing-revisions`, {
    method: "POST",
    headers: auth,
    body: {
      revisionRef: "price-2",
      modelRef: "model-2",
      currency: "USD",
      inputTokenRate: { currency: "USD", units: 0, nanos: 1_000_000 },
      outputTokenRate: { currency: "USD", units: 0, nanos: 2_000_000 },
      immutable: true
    }
  });
  assert.equal(pricing2.status, 200, "pricing management must accept the anthropic pricing revision");
  const model2 = await requestJson(`${service.baseUrl}/v1/model-gateway/models`, {
    method: "POST",
    headers: auth,
    body: { modelId: "model-2", providerRef: "prov2", pricingRevisionRef: "price-2", enabled: true }
  });
  assert.equal(model2.status, 200, "model management must accept the anthropic model");
}

async function startFixture(): Promise<FixtureHandle> {
  let calls = 0;
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://fixture.invalid");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as JsonObject;
    const respond = (status: number, payload: unknown) => {
      const bytes = Buffer.from(JSON.stringify(payload));
      response.writeHead(status, { "content-type": "application/json", "content-length": bytes.byteLength });
      response.end(bytes);
    };
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      calls += 1;
      respond(200, {
        id: "chatcmpl-verifier",
        object: "chat.completion",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "verifier reply" } }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 }
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      calls += 1;
      respond(200, {
        id: "msg_verifier",
        type: "message",
        model: body.model,
        content: [{ type: "text", text: "verifier reply" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 9, output_tokens: 5 }
      });
      return;
    }
    respond(404, { error: "fixture route not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object", "fixture must listen on a local port");
  return {
    baseUrl: `http://127.0.0.1:${(address as { port: number }).port}`,
    calls: () => calls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function writeEgressFiles(dataRoot: string, fixtureBaseUrl: string): Promise<void> {
  await writeFile(
    path.join(dataRoot, "provider-egress.json"),
    JSON.stringify({
      prov1: { baseUrl: fixtureBaseUrl, timeoutMs: 5000 },
      prov2: { baseUrl: fixtureBaseUrl, timeoutMs: 5000 }
    })
  );
  await writeFile(
    path.join(dataRoot, "secrets.json"),
    JSON.stringify({
      prov1: "verifier-fixture-provider-secret-000000000000000000",
      prov2: "verifier-fixture-provider-secret-000000000000000000"
    })
  );
}

async function walkFiles(directory: string, relative = ""): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (["dist", "node_modules", "contracts", ".git"].includes(entry.name)) continue;
      results.push(...await walkFiles(path.join(directory, entry.name), relativePath));
    } else {
      results.push(relativePath);
    }
  }
  return results;
}

function fragment(...parts: string[]): string {
  return parts.join("");
}

// Tokens are assembled from code points so this verifier's own source never
// contains the architecture names it proves absent from the service closure.
const MESHRIX = String.fromCharCode(109, 101, 115, 104, 114, 105, 120);
const CONSOLE = String.fromCharCode(99, 111, 110, 115, 111, 108, 101);

async function scanServiceClosure(): Promise<string[]> {
  const violations: string[] = [];
  const files = await walkFiles(SERVICE_DIR);
  const forbidden = [
    fragment("external", "-", "gateway"),
    fragment("plugin", "-", "runtime"),
    fragment("runtime", "-", "ui"),
    fragment("offline", "-", "bundle"),
    fragment("operation", "-", "permission"),
    fragment("agent", "-", "gateway"),
    `${MESHRIX}-runtime`,
    `${MESHRIX}-server`,
    "/Users/",
    "/home/",
    "C:\\",
    `/var/lib/${MESHRIX}`
  ];
  const consolePattern = new RegExp(`\\b${CONSOLE}\\b`, "iu");
  const meshrixPattern = new RegExp(`\\b${MESHRIX}\\b`, "iu");
  const labelPattern = /^\s*LABEL\s+org\.opencontainers\.image\.source=/iu;
  for (const relativePath of files) {
    const absolutePath = path.join(SERVICE_DIR, relativePath);
    if (!/\.(?:mjs|json)$/u.test(relativePath) && relativePath !== "Dockerfile") continue;
    const content = await readFile(absolutePath, "utf8");
    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (relativePath === "Dockerfile" && labelPattern.test(line)) continue;
      if (consolePattern.test(line)) violations.push(`${relativePath}:${index + 1} forbidden console reference`);
      if (meshrixPattern.test(line)) {
        violations.push(`${relativePath}:${index + 1} forbidden Meshrix reference`);
      }
      for (const token of forbidden) {
        if (line.toLowerCase().includes(token)) {
          violations.push(`${relativePath}:${index + 1} forbidden runtime reference`);
        }
      }
    }
    if (relativePath.endsWith(".mjs")) {
      const importPattern = /^import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gmu;
      for (const match of content.matchAll(importPattern)) {
        const specifier = match[1];
        if (specifier.startsWith("node:")) continue;
        if (!specifier.startsWith(".")) {
          violations.push(`${relativePath} imports outside the service: ${specifier}`);
          continue;
        }
        const resolved = path.resolve(path.dirname(absolutePath), specifier);
        if (resolved !== SERVICE_DIR && !resolved.startsWith(`${SERVICE_DIR}${path.sep}`)) {
          violations.push(`${relativePath} resolves outside the service: ${specifier}`);
        }
      }
    }
  }
  return violations;
}

const cleanups: Array<() => Promise<void>> = [];

async function main(): Promise<void> {
  const fixture = await startFixture();
  cleanups.push(() => fixture.close());
  const rootA = await mkdtemp(path.join(os.tmpdir(), "model-gateway-verify-"));
  const rootB = await mkdtemp(path.join(os.tmpdir(), "model-gateway-verify-"));
  cleanups.push(() => rm(rootA, { recursive: true, force: true }));
  cleanups.push(() => rm(rootB, { recursive: true, force: true }));
  await writeEgressFiles(rootA, fixture.baseUrl);
  await writeEgressFiles(rootB, fixture.baseUrl);

  const service = await startService({ dataRoot: rootA, clients: CLIENT_JSON });
  cleanups.push(() => stopService(service).catch(() => undefined));
  try {
    const health = await requestJson(`${service.baseUrl}/health`);
    assert.equal(health.status, 200, "health must be served");
    assert.deepEqual(health.body, { status: "ok" });
    const ready = await requestJson(`${service.baseUrl}/ready`);
    assert.equal(ready.status, 200, "readiness must report ready");
    assert.deepEqual(ready.body, { status: "ready" });

    const anonymous = await requestJson(`${service.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { model: "model-1", messages: [{ role: "user", content: "hi" }] }
    });
    assert.equal(anonymous.status, 401, "native calls must require client authentication");

    const emptyModels = await requestJson(`${service.baseUrl}/v1/model-gateway/models`, {
      headers: { authorization: `Bearer ${CLIENT_SECRET}` }
    });
    assert.deepEqual(emptyModels.body, [], "fresh service must start with empty model configuration");

    await provision(service);
    const first = await requestJson(`${service.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CLIENT_SECRET}`,
        "content-type": "application/json",
        "idempotency-key": IDEMPOTENCY_KEY
      },
      body: { model: "model-1", messages: [{ role: "user", content: "hello verifier" }] }
    });
    assert.equal(first.status, 200, "an authenticated native call must succeed");
    const firstObject = asObject(first.body);
    const firstChoice = asObject(asArray(firstObject.choices)[0]);
    const firstMessage = asObject(firstChoice.message);
    assert.equal(asString(firstMessage.content), "verifier reply");
    assert.equal(asNumber(asObject(firstObject.usage).total_tokens), 19);
    const callId = asString(firstObject.service_call_id);
    assert.equal(fixture.calls(), 1, "exactly one provider egress for the first call");

    const ledger = await requestJson(`${service.baseUrl}/v1/model-gateway/ledger/${callId}`, {
      headers: { authorization: `Bearer ${CLIENT_SECRET}` }
    });
    assert.equal(ledger.status, 200, "ledger must expose the settled call");
    const ledgerObject = asObject(ledger.body);
    assert.equal(asString(ledgerObject.state), "settled");
    assert.equal(asNumber(ledgerObject.attempts), 1);
    assert.equal(asString(ledgerObject.currency), "USD");
    assert.equal(asNumber(ledgerObject.inputTokens), 12);
    assert.equal(asNumber(ledgerObject.outputTokens), 7);
    assert.deepEqual(ledgerObject.amount, { currency: "USD", units: 0, nanos: 26_000_000 });

    const replay = await requestJson(`${service.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CLIENT_SECRET}`,
        "content-type": "application/json",
        "idempotency-key": IDEMPOTENCY_KEY
      },
      body: { model: "model-1", messages: [{ role: "user", content: "hello verifier" }] }
    });
    assert.equal(replay.status, 200, "idempotent replay must succeed");
    assert.deepEqual(replay.body, first.body, "replay must return the settled response");
    assert.equal(fixture.calls(), 1, "idempotent replay must not cause a second egress");

    const anthropic = await requestJson(`${service.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": CLIENT_SECRET,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "idempotency-key": "verify-anthropic"
      },
      body: { model: "model-2", max_tokens: 16, messages: [{ role: "user", content: "hello verifier" }] }
    });
    assert.equal(anthropic.status, 200, "native Anthropic messages must succeed");
    const anthropicObject = asObject(anthropic.body);
    assert.equal(asString(anthropicObject.type), "message");
    assert.equal(asString(asObject(asArray(anthropicObject.content)[0]).text), "verifier reply");
    assert.equal(fixture.calls(), 2, "Anthropic call must reach the provider once");
  } finally {
    await stopService(service);
  }

  const restarted = await startService({ dataRoot: rootA, clients: CLIENT_JSON });
  cleanups.push(() => stopService(restarted).catch(() => undefined));
  try {
    const models = await requestJson(`${restarted.baseUrl}/v1/model-gateway/models`, {
      headers: { authorization: `Bearer ${CLIENT_SECRET}` }
    });
    assert.equal(models.status, 200, "management API must be reachable after restart");
    assert.equal(asArray(models.body).length, 2, "model configuration must survive a restart");
    const callsBefore = fixture.calls();
    const replay = await requestJson(`${restarted.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CLIENT_SECRET}`,
        "content-type": "application/json",
        "idempotency-key": IDEMPOTENCY_KEY
      },
      body: { model: "model-1", messages: [{ role: "user", content: "hello verifier" }] }
    });
    assert.equal(replay.status, 200, "settled idempotent call must replay after restart");
    assert.equal(fixture.calls(), callsBefore, "restart replay must not reach the provider");
  } finally {
    await stopService(restarted);
  }

  const denied = await startService({
    dataRoot: rootB,
    clients: CLIENT_JSON,
    bounds: { MODEL_GATEWAY_MAX_INPUT_TOKEN_BUDGET: "2" }
  });
  cleanups.push(() => stopService(denied).catch(() => undefined));
  try {
    await provision(denied);
    const callsBefore = fixture.calls();
    const response = await requestJson(`${denied.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${CLIENT_SECRET}`, "content-type": "application/json" },
      body: { model: "model-1", messages: [{ role: "user", content: "this request exceeds the input token budget" }] }
    });
    assert.equal(response.status, 429, "admission denial must return a stable 429");
    assert.equal(asString(asObject(asObject(response.body).error).code), "budget_exceeded");
    assert.equal(fixture.calls(), callsBefore, "denial must cause no provider egress");
    const state = JSON.parse(await readFile(path.join(rootB, "state.json"), "utf8")) as unknown;
    const ledgerMap = asObject(asObject(state).ledger);
    assert.equal(Object.keys(ledgerMap).length, 0, "denial must create no ledger entry");
  } finally {
    await stopService(denied);
  }

  const violations = await scanServiceClosure();
  assert.deepEqual(violations, [], "service closure must stay isolated from host runtimes and shared paths");

  process.stdout.write("model-gateway verifier ok: health, readiness, auth, native calls, settlement, idempotent replay, restart persistence, denial without egress, clean shutdown, isolated closure\n");
}

try {
  await main();
} catch (error) {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      // Best-effort cleanup never masks the original failure.
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`model-gateway verifier failed: ${message}\n`);
  process.exit(1);
}

for (const cleanup of cleanups.reverse()) {
  try {
    await cleanup();
  } catch {
    // Best-effort cleanup never masks the verified result.
  }
}
