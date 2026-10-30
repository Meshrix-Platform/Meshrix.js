import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { activatePlugin, validateModelGatewayConfiguration } from "../runtime.mjs";

const manifest = JSON.parse(fs.readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));

const cannedForbidden = "forbidden";
const cannedCall = "call-one";

function authorizedCall() {
  return Object.freeze({
    auth: Object.freeze({ authenticated: true }),
    governance: Object.freeze({ authorized: true, current: true, revoked: false })
  });
}

test("configuration is closed and requires an explicit service reference when enabled", () => {
  assert.deepEqual(validateModelGatewayConfiguration({ enabled: false, serviceRef: null }), {
    schemaVersion: "v0.0.1:model-gateway:adapter-config-1",
    enabled: false,
    serviceRef: null
  });
  assert.deepEqual(validateModelGatewayConfiguration({ enabled: true, serviceRef: "svc_model" }), {
    schemaVersion: "v0.0.1:model-gateway:adapter-config-1",
    enabled: true,
    serviceRef: "svc_model"
  });
  assert.equal(validateModelGatewayConfiguration({ enabled: true, serviceRef: "svc_model", timeoutMs: 120_000 }).timeoutMs,
    120_000);
  assert.throws(() => validateModelGatewayConfiguration({ enabled: true, serviceRef: null }));
  assert.throws(() => validateModelGatewayConfiguration({ enabled: true, serviceRef: "svc_model", unexpected: true }));
  assert.throws(() => validateModelGatewayConfiguration({ enabled: true, serviceRef: "svc_model", token: cannedForbidden }));
  assert.throws(() => validateModelGatewayConfiguration({ enabled: true, serviceRef: "svc_model", timeoutMs: 120_001 }));
});

test("default-disabled activation publishes no operation, route, or MCP contribution", async () => {
  const runtime = await activatePlugin({ manifest, context: {} });
  assert.deepEqual(runtime.contributions.operations, {});
  assert.deepEqual(runtime.contributions.routes, {});
  assert.deepEqual(runtime.contributions.mcpTools, {});
  assert.deepEqual(await runtime.close(), { ok: true, alreadyClosed: false });
});

test("enabled activation publishes exactly three gateway-transit operations", async () => {
  const runtime = await activatePlugin({
    manifest,
    context: { configuration: { enabled: true, serviceRef: "svc_model" } }
  });
  assert.deepEqual(Object.keys(runtime.contributions.operations).sort(), ["model_gateway.call", "models.get", "models.list"]);
  assert.ok(Object.values(runtime.contributions.operations).every(({ definition }) => definition.trafficModel === "gateway_transit"));
  assert.deepEqual(Object.keys(runtime.contributions.routes), []);
  await runtime.close();
});

test("denial and malformed input reach no external service sink", async () => {
  let calls = 0;
  const runtime = await activatePlugin({
    manifest,
    context: { configuration: { enabled: true, serviceRef: "svc_model" } }
  });
  const execute = runtime.contributions.operations["model_gateway.call"].execute;
  const host = { externalService: { request: async () => { calls += 1; return { ok: true, status: 200, data: {} }; } } };
  assert.equal((await execute({ input: {}, call: {}, host })).statusCode, 403);
  assert.equal((await execute({ input: { serviceRef: "svc_override" }, call: authorizedCall(), host })).statusCode, 400);
  assert.equal(calls, 0);
  await runtime.close();
});

test("the configured service reference cannot be overridden and cancellation is forwarded", async () => {
  const observed = [];
  const controller = new AbortController();
  const runtime = await activatePlugin({
    manifest,
    context: { configuration: { enabled: true, serviceRef: "svc_model", timeoutMs: 1_000 } }
  });
  const response = await runtime.contributions.operations["model_gateway.call"].execute({
    input: {
      modelRef: "model.primary",
      providerRef: "provider.primary",
      inputRefs: ["input:one"],
      idempotencyKey: cannedCall,
      deadlineMs: 5_000,
      stream: false
    },
    call: authorizedCall(),
    signal: controller.signal,
    host: {
      externalService: {
        async request(request, options) {
          observed.push({ request, options });
          return { ok: true, status: 200, data: { ledgerState: "settled", outcomeRef: "outcome:one" } };
        }
      }
    }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].request.serviceRef, "svc_model");
  assert.equal(Object.hasOwn(observed[0].request.input, "serviceRef"), false);
  assert.equal(Object.hasOwn(observed[0].request.input, "deadlineMs"), false);
  assert.deepEqual(Object.keys(observed[0].request).sort(), ["idempotencyKey", "input", "operationRef", "serviceRef"]);
  assert.equal(observed[0].options.signal, controller.signal);
  assert.equal(observed[0].options.timeoutMs, 1_000);
  await runtime.close();
});

test("per-call deadline becomes a Host timeout and never enters provider data", async () => {
  let captured;
  const runtime = await activatePlugin({
    manifest,
    context: { configuration: { enabled: true, serviceRef: "svc_model" } }
  });
  const response = await runtime.contributions.operations["model_gateway.call"].execute({
    input: {
      modelRef: "model.primary",
      providerRef: "provider.primary",
      inputRefs: ["input:one"],
      idempotencyKey: cannedCall,
      deadlineMs: 5_000,
      stream: false
    },
    call: authorizedCall(),
    host: { externalService: { async request(request, options) {
      captured = { request, options };
      return { ok: true, status: 200, data: { settled: true } };
    } } }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(captured.options.timeoutMs, 5_000);
  assert.equal(Object.hasOwn(captured.request.input, "deadlineMs"), false);
  await runtime.close();
});
