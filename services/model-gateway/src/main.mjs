import { createServer } from "node:http";
import process from "node:process";

import { createModelGatewayHttpHandler } from "../internal/http-service.mjs";

function integerEnvironment(name, fallback, minimum, maximum) {
  const raw = String(process.env[name] || "").trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function jsonEnvironment(name, fallback) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
}

const port = integerEnvironment("PORT", 8080, 0, 65535);
const host = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const maxRequestBytes = integerEnvironment("MAX_REQUEST_BYTES", 2 * 1024 * 1024, 1024, 4 * 1024 * 1024);
const dataRoot = String(process.env.MODEL_GATEWAY_DATA_ROOT || "/var/lib/model-gateway").trim();
if (!dataRoot) throw new Error("MODEL_GATEWAY_DATA_ROOT is required.");
const requestTimeoutMs = integerEnvironment("MODEL_GATEWAY_REQUEST_TIMEOUT_MS", 30_000, 1, 300_000);
const maxAttempts = integerEnvironment("MODEL_GATEWAY_MAX_ATTEMPTS", 3, 1, 16);
const clients = jsonEnvironment("MODEL_GATEWAY_CLIENTS", {});

const bounds = {
  maxRatePerSecond: integerEnvironment("MODEL_GATEWAY_MAX_RATE_PER_SECOND", 100, 1, 1_000_000),
  maxInputTokenBudget: integerEnvironment("MODEL_GATEWAY_MAX_INPUT_TOKEN_BUDGET", 1_000_000, 1, 1_000_000_000),
  maxRequestedOutputTokenBudget: integerEnvironment("MODEL_GATEWAY_MAX_REQUESTED_OUTPUT_TOKEN_BUDGET", 200_000, 1, 1_000_000_000),
  maxTotalTokenQuota: integerEnvironment("MODEL_GATEWAY_MAX_TOTAL_TOKEN_QUOTA", 10_000_000, 1, 1_000_000_000),
  maxConcurrentCalls: integerEnvironment("MODEL_GATEWAY_MAX_CONCURRENT_CALLS", 64, 1, 10_000),
  maxCostQuotaMicros: integerEnvironment("MODEL_GATEWAY_MAX_COST_QUOTA_UNITS", 100, 1, 1_000_000_000) * 1_000_000,
  currency: String(process.env.MODEL_GATEWAY_CURRENCY || "USD").trim().toUpperCase()
};

const handler = await createModelGatewayHttpHandler({
  dataRoot,
  maxRequestBytes,
  clients,
  requestTimeoutMs,
  maxAttempts,
  bounds
});
const server = createServer({ requestTimeout: 35_000, headersTimeout: 10_000 }, handler);
server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(`${JSON.stringify({ event: "model_gateway.started", port: actualPort })}\n`);
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
