import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

const [transport, effectFileArg, markerFileArg] = process.argv.slice(2);
const effectFile = resolve(effectFileArg);
const markerFile = resolve(markerFileArg);

// The other process treats existence as readiness, so publish complete bytes.
function publishFile(target, value, options) {
  const pending = `${target}.writing`;
  writeFileSync(pending, value, options);
  renameSync(pending, target);
}

function nextEffect() {
  let count = 0;
  try { count = Number.parseInt(readFileSync(effectFile, "utf8"), 10) || 0; } catch { /* first effect */ }
  count += 1;
  publishFile(effectFile, String(count), { mode: 0o600 });
  return count;
}

function responseFor(message) {
  const method = message?.method;
  if (method === "server/discover") return { resultType: "complete", supportedVersions: ["2026-07-28"] };
  if (method === "tools/list") return { resultType: "complete", tools: [{ name: "synthetic", inputSchema: { type: "object" } }] };
  if (method === "tools/call") return { resultType: "complete", content: [{ type: "text", text: "synthetic peer" }], structuredContent: { effectCount: nextEffect() } };
  if (method === "prompts/list") publishFile(`${markerFile}.ready`, "ready", { mode: 0o600 });
  if (method === "resources/list") return { resultType: "complete", resources: [] };
  if (method === "resources/templates/list") return { resultType: "complete", resourceTemplates: [] };
  if (method === "prompts/list") return { resultType: "complete", prompts: [] };
  return { resultType: "complete" };
}

function jsonRpc(message, result) {
  return JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
}

if (transport === "http") {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let message;
    try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { response.writeHead(400).end(); return; }
    if (message.method === "tools/call" && message.params?.arguments?.hold === true) {
      const count = nextEffect();
      publishFile(`${markerFile}.effect`, String(count), { mode: 0o600 });
      await new Promise((resolvePromise) => response.once("close", resolvePromise));
      return;
    }
    const result = message.method === "tools/call"
      ? { resultType: "complete", content: [{ type: "text", text: "synthetic peer" }], structuredContent: { effectCount: nextEffect() } }
      : responseFor(message);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(jsonRpc(message, result));
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Synthetic peer listener has no TCP address.");
    publishFile(markerFile, JSON.stringify({ port: address.port }), { mode: 0o600 });
    publishFile(`${markerFile}.ready`, "ready", { mode: 0o600 });
  });
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  process.on("SIGINT", () => server.close(() => process.exit(0)));
} else if (transport === "stdio") {
  let buffer = "";
  const inputClosed = new Promise((resolvePromise) => process.stdin.once("end", resolvePromise));
  publishFile(`${markerFile}.pid`, String(process.pid), { mode: 0o600 });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let boundary;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === "tools/call" && message.params?.arguments?.hold === true) {
        const count = nextEffect();
        publishFile(`${markerFile}.effect`, String(count), { mode: 0o600 });
        void inputClosed.then(() => { publishFile(`${markerFile}.closed`, "closed", { mode: 0o600 }); process.exit(0); });
        continue;
      }
      const result = responseFor(message);
      if (message.id !== undefined) process.stdout.write(`${jsonRpc(message, result)}\n`);
    }
  });
  process.stdin.once("end", () => { publishFile(`${markerFile}.closed`, "closed", { mode: 0o600 }); });
  process.on("SIGTERM", () => { publishFile(`${markerFile}.closed`, "closed", { mode: 0o600 }); process.exit(0); });
  process.on("SIGINT", () => { publishFile(`${markerFile}.closed`, "closed", { mode: 0o600 }); process.exit(0); });
} else {
  throw new Error("Unknown synthetic peer transport.");
}
