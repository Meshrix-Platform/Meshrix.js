import { createServer } from "node:http";
import process from "node:process";

import { createSkillHubHttpHandler } from "../internal/http-service.mjs";

function integerEnvironment(name, fallback, minimum, maximum) {
  const raw = String(process.env[name] || "").trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

const port = integerEnvironment("PORT", 8080, 1, 65535);
const maxRequestBytes = integerEnvironment("MAX_REQUEST_BYTES", 2 * 1024 * 1024, 1024, 4 * 1024 * 1024);
const dataRoot = String(process.env.SKILL_HUB_DATA_ROOT || "/var/lib/skill-hub").trim();
if (!dataRoot) throw new Error("SKILL_HUB_DATA_ROOT is required.");
const authToken = String(process.env.SKILL_HUB_AUTH_TOKEN || "");
if (Buffer.byteLength(authToken, "utf8") < 32 || Buffer.byteLength(authToken, "utf8") > 512) {
  throw new Error("SKILL_HUB_AUTH_TOKEN must contain between 32 and 512 bytes.");
}

const handler = await createSkillHubHttpHandler({ dataRoot, maxRequestBytes, authToken });
const server = createServer({ requestTimeout: 35_000, headersTimeout: 10_000 }, handler);
server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`${JSON.stringify({ event: "skill_hub.started", port })}\n`);
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.closeIdleConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await handler.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    close().then(() => process.exit(0), () => process.exit(1));
  });
}
