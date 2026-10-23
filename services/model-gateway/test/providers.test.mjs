import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Agent } from "undici";

import { createGuardedLookup, createProviderEgress, ProviderEgressError } from "../internal/providers.mjs";

test("provider requests retain TLS and redirect boundaries and do not forward service idempotency keys", async () => {
  let observed;
  const providerCredential = ["fixture", "provider", "credential"].join("-");
  const egress = createProviderEgress({
    async fetchImpl(url, init) {
      observed = { url: String(url), init };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });
  await egress.call({
    protocol: "openai",
    baseUrl: "https://provider.example",
    credential: providerCredential,
    body: { model: "fixture", messages: [] },
    headers: {
      "idempotency-key": "caller-local-key",
      "x-client-request-id": "safe-correlation",
      "x-request-id": "caller-controlled-response-id",
      "x-meshrix.js-api-key": "caller",
      "x-private-context": "private-context-fixture",
      "openai-organization": "caller-selected-org",
      "openai-project": "project-fixture"
    }
  });
  assert.equal(observed.url, "https://provider.example/v1/chat/completions");
  assert.equal(observed.init.redirect, "error");
  assert.equal(observed.init.headers.authorization, ["Bearer", providerCredential].join(" "));
  assert.equal(Object.hasOwn(observed.init.headers, "idempotency-key"), false);
  assert.equal(observed.init.headers["x-client-request-id"], "safe-correlation");
  assert.equal(Object.hasOwn(observed.init.headers, "x-request-id"), false);
  assert.equal(Object.hasOwn(observed.init.headers, "openai-organization"), false);
  assert.equal(Object.hasOwn(observed.init.headers, "openai-project"), false);
  assert.equal(Object.hasOwn(observed.init.headers, "x-meshrix.js-api-key"), false);
  assert.equal(Object.hasOwn(observed.init.headers, "x-private-context"), false);
});

test("Anthropic forwards only its protocol headers", async () => {
  let observed;
  const egress = createProviderEgress({
    async fetchImpl(url, init) {
      observed = { url: String(url), init };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });
  await egress.call({
    protocol: "anthropic",
    baseUrl: "https://provider.example",
    credential: "fixture",
    body: { model: "fixture", messages: [] },
    headers: {
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "unpriced-feature-fixture",
      "openai-project": "wrong-protocol-fixture",
      "x-meshrix.js-api-key": "caller"
    }
  });
  assert.equal(observed.url, "https://provider.example/v1/messages");
  assert.equal(observed.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(Object.hasOwn(observed.init.headers, "anthropic-beta"), false);
  assert.equal(observed.init.headers["x-api-key"], "fixture");
  assert.equal(Object.hasOwn(observed.init.headers, "openai-project"), false);
  assert.equal(Object.hasOwn(observed.init.headers, "x-meshrix.js-api-key"), false);
});

test("remote HTTP provider URLs are rejected before credentials or request leave the service", async () => {
  let calls = 0;
  const egress = createProviderEgress({ fetchImpl: async () => { calls += 1; } });
  await assert.rejects(
    egress.call({ protocol: "openai", baseUrl: "http://provider.example", credential: "fixture", body: {} }),
    ProviderEgressError
  );
  assert.equal(calls, 0);
});

test("loopback HTTP provider URLs remain available for local development", async () => {
  let calls = 0;
  const egress = createProviderEgress({
    async fetchImpl() {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });
  const result = await egress.call({
    protocol: "openai",
    baseUrl: "http://127.0.0.1:45000",
    credential: "local-fixture",
    body: {}
  });
  assert.equal(result.status, 200);
  assert.equal(calls, 1);
});

test("provider response size is bounded and does not trigger a retry", async () => {
  let calls = 0;
  const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
  const egress = createProviderEgress({
    async fetchImpl() {
      calls += 1;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(oversized);
          controller.close();
        }
      }), { status: 200 });
    }
  });
  await assert.rejects(
    egress.call({ protocol: "openai", baseUrl: "https://provider.example", credential: "fixture", body: {} }),
    /configured service bound/u
  );
  assert.equal(calls, 1);
});

test("default provider egress uses an unbounded Undici dispatcher and waits for the complete response", async (t) => {
  let requestReceived;
  const requestReady = new Promise((resolve) => { requestReceived = resolve; });
  let headersReleased;
  const headersGate = new Promise((resolve) => { headersReleased = resolve; });
  let firstChunkSent;
  const firstChunkReady = new Promise((resolve) => { firstChunkSent = resolve; });
  let bodyReleased;
  const bodyGate = new Promise((resolve) => { bodyReleased = resolve; });

  const server = createServer((request, response) => {
    request.resume();
    request.once("end", async () => {
      requestReceived();
      await headersGate;
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"usage":{"prompt_tokens":1,');
      firstChunkSent();
      await bodyGate;
      response.end('"completion_tokens":1}}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  let dispatcherOptions;
  const egress = createProviderEgress({
    agentFactory(options) {
      dispatcherOptions = options;
      return new Agent(options);
    }
  });
  t.after(async () => {
    headersReleased();
    bodyReleased();
    await egress.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const pending = egress.call({
    protocol: "http",
    baseUrl: `http://127.0.0.1:${address.port}/provider`,
    credential: "fixture",
    body: { prompt: "synthetic" }
  });
  await requestReady;
  assert.equal(dispatcherOptions.connectTimeout, 0);
  assert.equal(dispatcherOptions.headersTimeout, 0);
  assert.equal(dispatcherOptions.bodyTimeout, 0);
  assert.equal(typeof dispatcherOptions.connect.lookup, "function");

  headersReleased();
  await firstChunkReady;
  const closePending = egress.close();
  let dispatcherClosed = false;
  void closePending.then(() => { dispatcherClosed = true; });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "provider egress waits while the peer is still streaming its response");
  assert.equal(dispatcherClosed, false, "owned dispatcher close waits for the active response body");

  bodyReleased();
  const [result] = await Promise.all([pending, closePending]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { usage: { prompt_tokens: 1, completion_tokens: 1 } });
});

test("default provider egress preserves caller cancellation while waiting for response headers", async (t) => {
  let requestReceived;
  const requestReady = new Promise((resolve) => { requestReceived = resolve; });
  const server = createServer((request) => {
    request.resume();
    request.once("end", requestReceived);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const egress = createProviderEgress();
  t.after(async () => {
    await egress.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const controller = new AbortController();
  const pending = egress.call({
    protocol: "http",
    baseUrl: `http://127.0.0.1:${address.port}/provider`,
    credential: "fixture",
    body: { prompt: "synthetic" },
    signal: controller.signal
  });
  await requestReady;
  controller.abort();
  await assert.rejects(pending, ProviderEgressError);
});

test("egress preserves explicitly configured LAN destinations and rejects unapproved special targets", async () => {
  let sends = 0;
  const egress = createProviderEgress({ fetchImpl: async () => { sends++; return new Response("{}"); } });
  for (const baseUrl of ["https://169.254.169.254", "https://[::ffff:169.254.169.254]", "https://[fe80::1]"]) {
    await assert.rejects(egress.call({ protocol: "http", baseUrl, credential: "synthetic", body: {} }), ProviderEgressError);
  }
  assert.equal(sends, 0);
  for (const baseUrl of ["https://10.0.0.1", "https://192.168.1.2", "https://[fd00::1]"]) {
    assert.equal((await egress.call({ protocol: "http", baseUrl, credential: "synthetic", body: {} })).status, 200);
  }
  assert.equal(sends, 3);
  const lookup = createGuardedLookup({ lookup: (_host, _options, callback) => callback(null, [{ address: "10.0.0.1", family: 4 }]) });
  await assert.rejects(new Promise((resolve,reject) => lookup("synthetic.example", {}, (error, ...address) => error ? reject(error) : resolve(address))), ProviderEgressError);
  const allowed = createGuardedLookup({ allowedAddresses: ["10.0.0.1"], lookup: (_host, _options, callback) => callback(null, [{ address: "10.0.0.1", family: 4 }]) });
  assert.deepEqual(await new Promise((resolve,reject) => allowed("synthetic.example", {}, (error, ...address) => error ? reject(error) : resolve(address))), ["10.0.0.1", 4]);
  await egress.close();
});

test("the actual Undici consumer rejects a DNS answer set containing an unapproved destination", async () => {
  let resolutions = 0;
  const egress = createProviderEgress({
    lookupImpl(_hostname, options, callback) {
      resolutions++;
      assert.equal(options.all, true);
      callback(null, [{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }]);
    }
  });
  try {
    await assert.rejects(egress.call({ protocol: "http", baseUrl: "https://synthetic.example", credential: "synthetic", body: {} }), ProviderEgressError);
    assert.equal(resolutions, 1, "the complete answer set is denied before any connection or credential transmission");
  } finally { await egress.close(); }
});

test("concurrent provider responses stay inside the aggregate buffer budget until release", async () => {
  // The aggregate floor is one per-response cap, so exercise the bound with
  // declared 8 MiB reservations and a 16 MiB budget; actual bodies stay tiny.
  const reservationBytes = 8 * 1024 * 1024;
  const controllers = [];
  const settledResults = [];
  const egress = createProviderEgress({
    maxAggregateResponseBufferBytes: 2 * reservationBytes,
    async fetchImpl() {
      const stream = new ReadableStream({
        start(controller) { controllers.push(controller); }
      });
      return new Response(stream, { status: 200, headers: { "content-length": String(reservationBytes) } });
    }
  });
  const feed = (controller) => {
    controller.enqueue(new TextEncoder().encode('{"ok":true}'));
    controller.close();
  };
  const settleTick = () => new Promise((resolve) => setTimeout(resolve, 30));
  try {
    const calls = Array.from({ length: 4 }, () => egress.call({ protocol: "http", baseUrl: "https://synthetic.example", credential: "synthetic", body: {} }).then((result) => { settledResults.push(result); return result; }));
    while (controllers.length < 4) await new Promise((resolve) => setTimeout(resolve, 5));
    feed(controllers[0]); feed(controllers[1]);
    await settleTick();
    assert.equal(settledResults.length, 2);
    feed(controllers[2]); feed(controllers[3]);
    await settleTick();
    assert.equal(settledResults.length, 2, "a parsed response keeps its reservation while the body is live");
    settledResults[0].release();
    settledResults[0].release();
    settledResults[1].release();
    const results = await Promise.all(calls);
    for (const result of results) {
      assert.equal(result.status, 200);
      result.release();
    }
    assert.equal(settledResults.length, 4);
  } finally { await egress.close(); }
});
