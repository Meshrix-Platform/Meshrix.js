import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { activatePlugin, validateModelGatewayConfiguration } from "../runtime.mjs";

const manifest = JSON.parse(fs.readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));

function authorizedCall() {
  return Object.freeze({
    auth: Object.freeze({ authenticated: true }),
    governance: Object.freeze({ authorized: true, current: true, revoked: false })
  });
}

test("configuration is closed, bounded, and requires an explicit service reference when enabled", () => {
  assert.deepEqual(validateModelGatewayConfiguration({ enabled: false, serviceRef: null, timeoutMs: 30_000 }), {
    schemaVersion: "v0.0.1:model-gateway:adapter-config-1",
    enabled: false,
    serviceRef: null,
    timeoutMs: 30_000
  });
  assert.throws(() => validateModelGatewayConfiguration({ enabled: true, serviceRef: null, timeoutMs: 30_000 }));
  assert.throws(() => validateModelGatewayConfiguration({ enabled: true, serviceRef: "svc_model", timeoutMs: 30_000, token: "forbidden" }));
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
    context: { configuration: { enabled: true, serviceRef: "svc_model", timeoutMs: 10_000 } }
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
    context: { configuration: { enabled: true, serviceRef: "svc_model", timeoutMs: 10_000 } }
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
    context: { configuration: { enabled: true, serviceRef: "svc_model", timeoutMs: 10_000 } }
  });
  const response = await runtime.contributions.operations["model_gateway.call"].execute({
    input: {
      modelRef: "model.primary",
      providerRef: "provider.primary",
      inputRefs: ["input:one"],
      idempotencyKey: "call-one",
      deadlineMs: 5_000,
      stream: false
    },
    call: authorizedCall(),
    signal: controller.signal,
    host: {
      externalService: {
        async request(request, options) {
          observed.push({ request, signal: options.signal });
          return { ok: true, status: 200, data: { ledgerState: "settled", outcomeRef: "outcome:one" } };
        }
      }
    }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].request.serviceRef, "svc_model");
  assert.equal(Object.hasOwn(observed[0].request.input, "serviceRef"), false);
  assert.equal(observed[0].request.timeoutMs, 5_000);
  assert.equal(observed[0].signal, controller.signal);
  await runtime.close();
});
