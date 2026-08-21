import { createServer } from "node:http";
import fs from "node:fs/promises";

import {
  createProviderManifest
} from "../contracts/provider-manifest-contract.mjs";
const MODEL_SCENARIOS = new Map([
  ["model-1", "success"],
  ["model-2", "success"],
  ["fixture-openai", "success"],
  ["fixture-anthropic", "success"],
  ["fixture-openai-concurrent", "concurrency"],
  ["fixture-anthropic-concurrent", "concurrency"],
  ["fixture-openai-hold", "hold"],
  ["fixture-openai-cancel", "cancellation"],
  ["fixture-anthropic-cancel", "cancellation"],
  ["fixture-openai-fault", "provider-fault"],
  ["fixture-anthropic-fault", "provider-fault"]
]);
const MAX_HOLD_MS = 30_000;

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      total += chunk.byteLength;
      if (total > 2 * 1024 * 1024) {
        reject(new Error("fixture request too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks, total).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function scenarioFor(model) {
  return MODEL_SCENARIOS.get(String(model || ""));
}

function openAiResponse(model) {
  return {
    id: "chatcmpl-fixture",
    object: "chat.completion",
    model: model.startsWith("fixture-") ? "fixture-openai" : model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "fixture reply" },
        finish_reason: "stop"
      }
    ],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 }
  };
}

function anthropicResponse(model) {
  return {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: model.startsWith("fixture-") ? "fixture-anthropic" : model,
    content: [{ type: "text", text: "fixture reply" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 9, output_tokens: 5 }
  };
}

function providerFault() {
  return {
    error: {
      message: "fixture provider unavailable",
      code: "provider_unavailable",
      type: "provider_error"
    }
  };
}

function sendJson(response, status, payload) {
  try {
    const bytes = Buffer.from(JSON.stringify(payload));
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": bytes.byteLength
    });
    response.end(bytes);
  } catch {
    // The client may have aborted; the fixture only serves bounded local traffic.
  }
}

export async function startFixtureProvider(options = {}) {
  let openAiCalls = 0;
  let anthropicCalls = 0;
  const held = new Map();

  const releaseHeld = (model) => {
    const releases = held.get(model);
    if (!releases) return;
    held.delete(model);
    for (const release of releases) release();
  };

  const boundedHold = (model, request, response) => new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off("aborted", finish);
      response.off("close", finish);
      const releases = held.get(model);
      releases?.delete(finish);
      if (releases?.size === 0) held.delete(model);
      resolve();
    };
    const timeoutMs = Math.min(MAX_HOLD_MS, Math.max(1, Number(options.holdTimeoutMs) || MAX_HOLD_MS));
    const timer = setTimeout(finish, timeoutMs);
    const releases = held.get(model) || new Set();
    releases.add(finish);
    held.set(model, releases);
    request.once("aborted", finish);
    response.once("close", finish);
  });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://fixture.invalid");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    try {
      const body = await readJson(request);
      const scenario = scenarioFor(body.model);
      if (!scenario) {
        sendJson(response, 400, { error: "fixture model identifier is not registered" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        openAiCalls += 1;
        if (scenario === "provider-fault") {
          sendJson(response, 503, providerFault());
          return;
        }
        if (scenario === "cancellation") {
          await new Promise((resolve) => setTimeout(resolve, options.cancellationDelayMs || 2000));
          sendJson(response, 200, openAiResponse(body.model));
          return;
        }
        if (scenario === "hold") {
          await boundedHold(body.model, request, response);
        }
        sendJson(response, 200, openAiResponse(body.model));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        anthropicCalls += 1;
        if (scenario === "provider-fault") {
          sendJson(response, 503, providerFault());
          return;
        }
        if (scenario === "cancellation") {
          await new Promise((resolve) => setTimeout(resolve, options.cancellationDelayMs || 2000));
          sendJson(response, 200, anthropicResponse(body.model));
          return;
        }
        if (scenario === "hold") {
          await boundedHold(body.model, request, response);
        }
        sendJson(response, 200, anthropicResponse(body.model));
        return;
      }
      sendJson(response, 404, { error: "fixture route not found" });
    } catch {
      sendJson(response, 400, { error: "fixture invalid request" });
    }
  });

  const host = String(options.host || "127.0.0.1");
  await new Promise((resolve) => server.listen(options.port || 0, host, resolve));
  const advertiseHost = String(options.advertiseHost || (host === "0.0.0.0" ? "127.0.0.1" : host));
  const baseUrl = `http://${advertiseHost}:${server.address().port}`;
  return {
    baseUrl,
    port: server.address().port,
    openAiCalls: () => openAiCalls,
    anthropicCalls: () => anthropicCalls,
    release: releaseHeld,
    close: () => new Promise((resolve) => {
      for (const model of [...held.keys()]) releaseHeld(model);
      server.close(resolve);
      server.closeAllConnections?.();
    })
  };
}

async function cli() {
  const args = process.argv.slice(2);
  let port = 0;
  let manifestPath = "";
  let host = "127.0.0.1";
  let advertiseHost = "";
  let selfTest = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--port") port = Number(args[++index] || 0);
    else if (args[index] === "--manifest") manifestPath = String(args[++index] || "");
    else if (args[index] === "--host") host = String(args[++index] || "");
    else if (args[index] === "--advertise-host") advertiseHost = String(args[++index] || "");
    else if (args[index] === "--self-test") selfTest = true;
    else throw new Error(`fixture_provider_argument_invalid:${args[index]}`);
  }
  const provider = await startFixtureProvider({ port, host, advertiseHost });
  const manifest = createProviderManifest(provider.baseUrl);
  if (manifestPath) {
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  }
  if (selfTest) {
    const response = await fetch(`${provider.baseUrl}/health`);
    if (!response.ok) throw new Error("fixture_provider_health_failed");
    process.stdout.write(`${JSON.stringify({ ok: true, schemaVersion: manifest.schemaVersion })}\n`);
    await provider.close();
    return;
  }
  const shutdown = async () => {
    await provider.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("fixture-provider.mjs")) {
  cli().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.message || "fixture_provider_failed" })}\n`);
    process.exitCode = 1;
  });
}
