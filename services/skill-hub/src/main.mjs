import { createServer } from "node:http";
import process from "node:process";
import { readFile } from "node:fs/promises";

import { createSkillHubHttpHandler } from "../internal/http-service.mjs";

function integerEnvironment(name, fallback, minimum, maximum) {
  const raw = String(process.env[name] || "").trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function booleanEnvironment(name) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return !normalized ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]";
}

const port = integerEnvironment("PORT", 8080, 1, 65535);
const maxRequestBytes = integerEnvironment("MAX_REQUEST_BYTES", 2 * 1024 * 1024, 1024, 4 * 1024 * 1024);
const dataRoot = String(process.env.SKILL_HUB_DATA_ROOT || "/var/lib/skill-hub").trim();
if (!dataRoot) throw new Error("SKILL_HUB_DATA_ROOT is required.");
const authToken = String(process.env.SKILL_HUB_AUTH_TOKEN || "");
if (Buffer.byteLength(authToken, "utf8") < 32 || Buffer.byteLength(authToken, "utf8") > 512) {
  throw new Error("SKILL_HUB_AUTH_TOKEN must contain between 32 and 512 bytes.");
}

const ownershipFile = String(process.env.SKILL_HUB_REGISTRY_OWNERSHIP_FILE || "").trim();
const registryOwnership = ownershipFile ? JSON.parse(await readFile(ownershipFile, "utf8")) : [];
const host = String(process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
if (!isLoopbackHost(host) && !booleanEnvironment("SKILL_HUB_ALLOW_PUBLIC_BIND")) {
  throw new Error(
    "skill-hub refuses to bind a non-loopback address by default. " +
    "Set SKILL_HUB_ALLOW_PUBLIC_BIND=1 and place the service behind your network access controls."
  );
}
const handler = await createSkillHubHttpHandler({ dataRoot, maxRequestBytes, authToken, registryOwnership });
const server = createServer({ requestTimeout: 0, headersTimeout: 10_000 }, handler);
server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({ event: "skill_hub.started", port })}\n`);
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await handler.close();
  server.closeIdleConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    close().then(() => process.exit(0), () => process.exit(1));
  });
}
