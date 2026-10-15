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

const port = integerEnvironment("PORT", 8080, 0, 65535);
const host = String(process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
if (!isLoopbackHost(host) && !booleanEnvironment("MODEL_GATEWAY_ALLOW_PUBLIC_BIND")) {
  throw new Error(
    "model-gateway refuses to bind a non-loopback address by default. " +
    "Set MODEL_GATEWAY_ALLOW_PUBLIC_BIND=1 and place the service behind your network access controls."
  );
}
const maxRequestBytes = integerEnvironment("MAX_REQUEST_BYTES", 2 * 1024 * 1024, 1024, 4 * 1024 * 1024);
const dataRoot = String(process.env.MODEL_GATEWAY_DATA_ROOT || "/var/lib/model-gateway").trim();
if (!dataRoot) throw new Error("MODEL_GATEWAY_DATA_ROOT is required.");
const clients = jsonEnvironment("MODEL_GATEWAY_CLIENTS", {});

const bounds = {
  maxRatePerSecond: integerEnvironment("MODEL_GATEWAY_MAX_RATE_PER_SECOND", 100, 1, 1_000_000),
  maxInputTokenBudget: integerEnvironment("MODEL_GATEWAY_MAX_INPUT_TOKEN_BUDGET", 1_000_000, 1, 1_000_000_000),
  maxRequestedOutputTokenBudget: integerEnvironment("MODEL_GATEWAY_MAX_REQUESTED_OUTPUT_TOKEN_BUDGET", 200_000, 1, 1_000_000_000),
  maxTotalTokenQuota: integerEnvironment("MODEL_GATEWAY_MAX_TOTAL_TOKEN_QUOTA", 10_000_000, 1, 1_000_000_000),
  maxConcurrentCalls: integerEnvironment("MODEL_GATEWAY_MAX_CONCURRENT_CALLS", 64, 1, 10_000),
  maxCostQuotaMicros: integerEnvironment("MODEL_GATEWAY_MAX_COST_QUOTA_UNITS", 100, 1, 1_000_000_000) * 1_000_000,
  maxGlobalConcurrentCalls: integerEnvironment("MODEL_GATEWAY_MAX_GLOBAL_CONCURRENT_CALLS", 256, 1, 100_000),
  maxSubjectConcurrentCalls: integerEnvironment("MODEL_GATEWAY_MAX_SUBJECT_CONCURRENT_CALLS", 64, 1, 10_000),
  maxGlobalRequestBytes: integerEnvironment("MODEL_GATEWAY_MAX_GLOBAL_REQUEST_BYTES", 64 * 1024 * 1024, 1, 1 << 30),
  maxSubjectRequestBytes: integerEnvironment("MODEL_GATEWAY_MAX_SUBJECT_REQUEST_BYTES", 16 * 1024 * 1024, 1, 1 << 30),
  maxLedgerSettledEntries: integerEnvironment("MODEL_GATEWAY_MAX_LEDGER_SETTLED_ENTRIES", 512, 1, 1_000_000),
  maxSubjectRequestRatePerSecond: integerEnvironment("MODEL_GATEWAY_MAX_SUBJECT_REQUEST_RATE_PER_SECOND", 100, 1, 1_000_000),
  maxGlobalRequestRatePerSecond: integerEnvironment("MODEL_GATEWAY_MAX_GLOBAL_REQUEST_RATE_PER_SECOND", 400, 1, 1_000_000),
  maxLedgerPendingEntries: integerEnvironment("MODEL_GATEWAY_MAX_LEDGER_PENDING_ENTRIES", 1024, 1, 1_000_000),
  maxLedgerResponseBytes: integerEnvironment("MODEL_GATEWAY_MAX_LEDGER_RESPONSE_BYTES", 16 * 1024 * 1024, 1, 1 << 30),
  currency: String(process.env.MODEL_GATEWAY_CURRENCY || "USD").trim().toUpperCase()
};

for (const [name, key] of [
  ["MODEL_GATEWAY_MAX_SUBJECT_TOTAL_TOKEN_QUOTA", "maxSubjectTotalTokenQuota"],
  ["MODEL_GATEWAY_MAX_GLOBAL_TOTAL_TOKEN_QUOTA", "maxGlobalTotalTokenQuota"],
  ["MODEL_GATEWAY_MAX_SUBJECT_COST_QUOTA_MICROS", "maxSubjectCostQuotaMicros"],
  ["MODEL_GATEWAY_MAX_GLOBAL_COST_QUOTA_MICROS", "maxGlobalCostQuotaMicros"],
  ["MODEL_GATEWAY_MAX_SUBJECT_RATE_PER_SECOND", "maxSubjectRatePerSecond"],
  ["MODEL_GATEWAY_MAX_GLOBAL_RATE_PER_SECOND", "maxGlobalRatePerSecond"]
]) {
  if (process.env[name]) bounds[key] = integerEnvironment(name, 1, 1, Number.MAX_SAFE_INTEGER);
}

const handler = await createModelGatewayHttpHandler({
  dataRoot,
  maxRequestBytes,
  clients,
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
