import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createModelGatewayApplication } from "../internal/application.mjs";
import { ADMIN_CLIENTS, provision, provisionModel, startService } from "./helpers.mjs";

async function openAiCall(service, body, headers = {}) {
  return fetch(`${service.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${service.clientSecret}`,
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

async function provisionAnthropic(service) {
  const headers = {
    authorization: `Bearer ${service.clientSecret}`,
    "content-type": "application/json"
  };
  await fetch(`${service.baseUrl}/v1/model-gateway/providers`, {
    method: "POST",
    headers,
    body: JSON.stringify({ providerId: "prov2", protocol: "anthropic", enabled: true })
  });
  await fetch(`${service.baseUrl}/v1/model-gateway/pricing-revisions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      revisionRef: "price-2",
      modelRef: "model-2",
      currency: "USD",
      inputTokenRate: { currency: "USD", units: 0, nanos: 1_000_000 },
      outputTokenRate: { currency: "USD", units: 0, nanos: 2_000_000 },
      immutable: true
    })
  });
  await fetch(`${service.baseUrl}/v1/model-gateway/models`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      modelId: "model-2",
      providerRef: "prov2",
      pricingRevisionRef: "price-2",
      enabled: true
    })
  });
}

async function anthropicCall(service, body, headers = {}) {
  return fetch(`${service.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${service.clientSecret}`,
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

const CALL = { model: "model-1", messages: [{ role: "user", content: "hello admission fixture" }] };

test("input token budget denial resolves no credential and performs no egress", async (t) => {
  const service = await startService({ bounds: { maxInputTokenBudget: 1 } });
  t.after(() => service.close());
  await provision(service);
  const response = await openAiCall(service, CALL);
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.error.code, "budget_exceeded");
  assert.equal(service.fixture.openAiCalls(), 0, "denial must not reach the provider");
});

test("input preflight includes UTF-8 CJK and all accepted request metadata", async (t) => {
  const service = await startService({ bounds: { maxInputTokenBudget: 128 } });
  t.after(() => service.close());
  await provision(service);

  const cjkAndEmoji = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "猫🙂".repeat(40) }]
  });
  assert.equal(cjkAndEmoji.status, 429);
  assert.equal((await cjkAndEmoji.json()).error.code, "budget_exceeded");

  const toolSchema = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "x" }],
    tools: [{
      type: "function",
      function: { name: "fixture_tool", description: "d".repeat(256), parameters: { type: "object" } }
    }]
  });
  assert.equal(toolSchema.status, 429);
  assert.equal((await toolSchema.json()).error.code, "budget_exceeded");

  const anthropicSystem = await fetch(`${service.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${service.clientSecret}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "model-1",
      max_tokens: 1,
      system: "s".repeat(256),
      messages: [{ role: "user", content: "x" }]
    })
  });
  assert.equal(anthropicSystem.status, 429);
  assert.equal((await anthropicSystem.json()).error.type, "quota");
  assert.equal(service.fixture.openAiCalls(), 0, "oversized preflight inputs must not reach provider egress");
  assert.equal(service.fixture.anthropicCalls(), 0, "oversized preflight inputs must not reach provider egress");
});

test("unpriced modalities, provider features, and billing selectors fail before egress", async (t) => {
  const service = await startService();
  t.after(() => service.close());
  await provision(service);
  await provisionAnthropic(service);

  const baseOpenAi = { model: "model-1", messages: [{ role: "user", content: "metered text" }] };
  const openAiCases = [
    { ...baseOpenAi, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://image.invalid/x" } }] }] },
    { ...baseOpenAi, service_tier: "priority" },
    { ...baseOpenAi, parallel_tool_calls: "yes" },
    { ...baseOpenAi, modalities: ["audio"], audio: { voice: "alloy" } },
    { ...baseOpenAi, web_search_options: { search_context_size: "high" } },
    { ...baseOpenAi, prompt_cache_retention: "24h" },
    { ...baseOpenAi, tools: [{ type: "web_search_preview", search_context_size: "high" }] },
    { ...baseOpenAi, tools: [{ type: "function", function: { name: "lookup" }, server_url: "https://tools.invalid" }] },
    { ...baseOpenAi, tool_choice: { type: "function", function: { name: "lookup", server_url: "https://tools.invalid" } } },
    { ...baseOpenAi, prediction: { type: "content", content: [{ type: "image", url: "https://image.invalid/x" }] } },
    { ...baseOpenAi, messages: [{ role: "user", content: "metered text", service_tier: "priority" }] }
  ];
  for (const body of openAiCases) {
    const response = await openAiCall(service, body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_request");
  }
  for (const name of ["openai-organization", "openai-project"]) {
    const response = await openAiCall(service, baseOpenAi, { [name]: "caller-selected-billing-target" });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_request");
  }

  const baseAnthropic = { model: "model-2", max_tokens: 16, messages: [{ role: "user", content: "metered text" }] };
  const anthropicCases = [
    { ...baseAnthropic, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://image.invalid/x" } }] }] },
    { ...baseAnthropic, tools: [{ type: "custom", name: "lookup", input_schema: { type: "object" } }], messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-image", content: [{ type: "image", source: { type: "url", url: "https://image.invalid/x" } }] }] }] },
    { ...baseAnthropic, system: [{ type: "text", text: "system" }] },
    { ...baseAnthropic, mcp_servers: [{ name: "remote", url: "https://tools.invalid" }] },
    { ...baseAnthropic, service_tier: "priority" },
    { ...baseAnthropic, speed: "fast" },
    { ...baseAnthropic, tools: [{ type: "web_search_20250305", name: "search" }] },
    { ...baseAnthropic, tools: [{ name: "lookup", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }] },
    { ...baseAnthropic, tools: [{ name: "lookup", input_schema: { type: "object" }, defer_loading: true }] },
    { ...baseAnthropic, tool_choice: { type: "auto", service_tier: "priority" } },
    { ...baseAnthropic, output_config: { effort: "high", service_tier: "priority" } }
  ];
  for (const body of anthropicCases) {
    const response = await anthropicCall(service, body, { "anthropic-version": "2023-06-01" });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).type, "error");
  }
  const beta = await anthropicCall(service, baseAnthropic, {
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "context-or-pricing-feature"
  });
  assert.equal(beta.status, 400);
  assert.equal((await beta.json()).type, "error");

  assert.equal(service.fixture.openAiCalls(), 0, "unsupported OpenAI requests must be rejected before provider egress");
  assert.equal(service.fixture.anthropicCalls(), 0, "unsupported Anthropic requests must be rejected before provider egress");
});

test("metered client function tools remain available and Anthropic reserves documented tool overhead", async (t) => {
  const anthropicTool = {
    model: "model-2",
    max_tokens: 16,
    messages: [{ role: "user", content: "look this up" }],
    tools: [{ type: "custom", name: "lookup", description: "client-side lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }]
  };
  const anthropicBodyBytes = Buffer.byteLength(JSON.stringify(anthropicTool), "utf8");
  const service = await startService({ bounds: { maxInputTokenBudget: anthropicBodyBytes + 803 } });
  t.after(() => service.close());
  await provision(service);
  await provisionAnthropic(service);
  const anthropicDenied = await anthropicCall(service, anthropicTool, { "anthropic-version": "2023-06-01" });
  assert.equal(anthropicDenied.status, 429);
  assert.equal((await anthropicDenied.json()).error.type, "quota");
  assert.equal(service.fixture.anthropicCalls(), 0, "tool prompt overhead must be reserved before egress");

  const openAiTool = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "look this up" }],
    max_completion_tokens: 16,
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { key: { type: "string" } } } } }],
    tool_choice: "auto"
  });
  assert.equal(openAiTool.status, 200);
  assert.equal(service.fixture.openAiCalls(), 1, "a priced client function call remains available");

  const acceptedAnthropicBody = {
    ...anthropicTool,
    tool_choice: { type: "tool", name: "lookup" }
  };
  const acceptedAnthropicBodyBytes = Buffer.byteLength(JSON.stringify(acceptedAnthropicBody), "utf8");
  const acceptedAnthropic = await startService({ bounds: { maxInputTokenBudget: acceptedAnthropicBodyBytes + 804 } });
  t.after(() => acceptedAnthropic.close());
  await provisionAnthropic(acceptedAnthropic);
  const anthropicToolAccepted = await anthropicCall(acceptedAnthropic, acceptedAnthropicBody, { "anthropic-version": "2023-06-01" });
  assert.equal(anthropicToolAccepted.status, 200);
  const forwardedAnthropicTool = acceptedAnthropic.fixture.anthropicRequestBodies()[0].tools[0];
  assert.equal(forwardedAnthropicTool.name, "lookup");
  assert.equal(acceptedAnthropic.fixture.anthropicCalls(), 1, "a priced client custom tool remains available");
});

test("priced text client-tool conversations complete a bounded two-call round-trip", async (t) => {
  const openAiRequests = [];
  const openAi = await startService({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      openAiRequests.push(body);
      const message = openAiRequests.length === 1
        ? {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{\"service_tier\":\"data\"}" } }]
        }
        : { role: "assistant", content: "done" };
      return Response.json({
        id: `chatcmpl-${openAiRequests.length}`,
        object: "chat.completion",
        model: "model-1",
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 16, completion_tokens: 7, total_tokens: 23 }
      });
    }
  });
  t.after(() => openAi.close());
  await provision(openAi);
  const openAiTools = [{
    type: "function",
    function: {
      name: "lookup",
      parameters: { type: "object", properties: { service_tier: { type: "string" } } }
    }
  }];
  const firstOpenAi = await openAiCall(openAi, {
    model: "model-1",
    messages: [{ role: "user", content: "look up this value" }],
    tools: openAiTools,
    tool_choice: "auto",
    parallel_tool_calls: true,
    max_completion_tokens: 32
  });
  assert.equal(firstOpenAi.status, 200);
  const firstOpenAiBody = await firstOpenAi.json();
  const secondOpenAi = await openAiCall(openAi, {
    model: "model-1",
    messages: [
      { role: "user", content: "look up this value" },
      firstOpenAiBody.choices[0].message,
      { role: "tool", tool_call_id: "call-1", content: "service_tier is ordinary tool output data" }
    ],
    tools: openAiTools,
    tool_choice: "auto",
    parallel_tool_calls: true,
    max_completion_tokens: 32
  });
  assert.equal(secondOpenAi.status, 200);
  assert.equal(openAiRequests.length, 2);
  assert.equal(openAiRequests[1].messages[1].content, null);
  assert.equal(openAiRequests[1].messages[2].content, "service_tier is ordinary tool output data");
  assert.equal(openAiRequests[0].parallel_tool_calls, true);
  assert.equal(openAiRequests[1].parallel_tool_calls, true);

  const anthropicRequests = [];
  const anthropic = await startService({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      anthropicRequests.push(body);
      const content = anthropicRequests.length === 1
        ? [{ type: "tool_use", id: "toolu-1", name: "lookup", input: { service_tier: "data" } }]
        : [{ type: "text", text: "done" }];
      return Response.json({
        id: `msg-${anthropicRequests.length}`,
        type: "message",
        role: "assistant",
        model: "model-2",
        content,
        stop_reason: anthropicRequests.length === 1 ? "tool_use" : "end_turn",
        usage: { input_tokens: 16, output_tokens: 7 }
      });
    }
  });
  t.after(() => anthropic.close());
  await provisionAnthropic(anthropic);
  const anthropicTools = [{
    type: "custom",
    name: "lookup",
    input_schema: { type: "object", properties: { service_tier: { type: "string" } } }
  }];
  const firstAnthropic = await anthropicCall(anthropic, {
    model: "model-2",
    max_tokens: 32,
    messages: [{ role: "user", content: "look up this value" }],
    tools: anthropicTools,
    tool_choice: { type: "auto" }
  }, { "anthropic-version": "2023-06-01" });
  assert.equal(firstAnthropic.status, 200);
  const firstAnthropicBody = await firstAnthropic.json();
  const secondAnthropic = await anthropicCall(anthropic, {
    model: "model-2",
    max_tokens: 32,
    messages: [
      { role: "user", content: "look up this value" },
      { role: "assistant", content: firstAnthropicBody.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "service_tier is ordinary tool output data" }] }
    ],
    tools: anthropicTools,
    tool_choice: { type: "auto" }
  }, { "anthropic-version": "2023-06-01" });
  assert.equal(secondAnthropic.status, 200);
  assert.equal(anthropicRequests.length, 2);
  assert.equal(anthropicRequests[1].messages[2].content[0].type, "tool_result");
  assert.equal(anthropicRequests[1].messages[2].content[0].content, "service_tier is ordinary tool output data");
});

test("cost quota includes large request metadata before provider egress", async (t) => {
  const service = await startService({ bounds: { maxCostQuotaMicros: 100 } });
  t.after(() => service.close());
  await provision(service, {
    prices: {
      inputTokenRate: { currency: "USD", units: 0, nanos: 1_000 },
      outputTokenRate: { currency: "USD", units: 0, nanos: 0 }
    }
  });
  const response = await openAiCall(service, {
    model: "model-1",
    max_completion_tokens: 1,
    messages: [{ role: "user", content: "x" }],
    tools: [{ type: "function", function: { name: "fixture_tool", description: "d".repeat(256) } }]
  });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "quota_exceeded");
  assert.equal(service.fixture.openAiCalls(), 0, "cost denial must happen before provider egress");
});

test("requested output token budget denial causes no egress", async (t) => {
  const service = await startService({ bounds: { maxRequestedOutputTokenBudget: 1 } });
  t.after(() => service.close());
  await provision(service);
  const response = await openAiCall(service, { ...CALL, max_tokens: 32 });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "budget_exceeded");
  assert.equal(service.fixture.openAiCalls(), 0);
});

test("max_completion_tokens and n are both included in the output budget", async (t) => {
  const service = await startService({ bounds: { maxRequestedOutputTokenBudget: 100 } });
  t.after(() => service.close());
  await provision(service);
  const response = await openAiCall(service, {
    ...CALL,
    max_completion_tokens: 32,
    n: 4
  });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "budget_exceeded");
  assert.equal(service.fixture.openAiCalls(), 0, "the full requested choice budget must be reserved before egress");
});

test("total token quota denial causes no egress", async (t) => {
  const service = await startService({ bounds: { maxTotalTokenQuota: 1 } });
  t.after(() => service.close());
  await provision(service);
  const response = await openAiCall(service, CALL);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "budget_exceeded");
  assert.equal(service.fixture.openAiCalls(), 0);
});

test("cost quota denial causes no egress", async (t) => {
  const service = await startService({ bounds: { maxCostQuotaMicros: 1 } });
  t.after(() => service.close());
  await provision(service);
  const response = await openAiCall(service, CALL);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "quota_exceeded");
  assert.equal(service.fixture.openAiCalls(), 0);
});

test("fractional token rates aggregate exactly and reserve one conservative micro-unit", async (t) => {
  let service = await startService({ bounds: { maxCostQuotaMicros: 1 } });
  let dataRoot = service.dataRoot;
  t.after(async () => {
    if (service) await service.close({ keepDataRoot: true });
    await rm(dataRoot, { recursive: true, force: true });
  });
  await provision(service, {
    prices: {
      inputTokenRate: { currency: "USD", units: 0, nanos: 3 },
      outputTokenRate: { currency: "USD", units: 0, nanos: 3 }
    }
  });
  await service.close({ keepDataRoot: true });
  service = null;
  service = await startService({ bounds: { maxCostQuotaMicros: 1 }, dataRoot });
  dataRoot = service.dataRoot;
  const persistedRate = await fetch(`${service.baseUrl}/v1/model-gateway/pricing`, {
    headers: { authorization: `Bearer ${service.clientSecret}` }
  }).then((response) => response.json());
  assert.deepEqual(persistedRate[0].inputTokenRate, { currency: "USD", units: 0, nanos: 3 });
  assert.deepEqual(persistedRate[0].outputTokenRate, { currency: "USD", units: 0, nanos: 3 });

  const first = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "x" }],
    max_completion_tokens: 1
  });
  assert.equal(first.status, 200);
  const callId = (await first.json()).service_call_id;
  const ledger = await fetch(`${service.baseUrl}/v1/model-gateway/ledger/${callId}`, {
    headers: { authorization: `Bearer ${service.clientSecret}` }
  }).then((response) => response.json());
  assert.deepEqual(ledger.amount, { currency: "USD", units: 0, nanos: 1_000 });

  const second = await openAiCall(service, {
    model: "model-1",
    messages: [{ role: "user", content: "y" }],
    max_completion_tokens: 1
  });
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, "quota_exceeded");
  assert.equal(service.fixture.openAiCalls(), 1, "the second conservatively rounded reservation must be denied before egress");
});

test("concurrent cost reservations count an in-flight call before admitting another", async (t) => {
  const service = await startService({ bounds: { maxCostQuotaMicros: 3_000_000 } });
  t.after(() => service.close());
  const modelId = "fixture-openai-hold";
  await provision(service, { modelId });
  const body = { ...CALL, model: modelId };
  const first = openAiCall(service, body);
  for (let attempt = 0; attempt < 100 && service.fixture.openAiCalls() === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(service.fixture.openAiCalls(), 1, "the first provider request should be held in flight");
  const second = await openAiCall(service, body);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, "quota_exceeded");
  assert.equal(service.fixture.openAiCalls(), 1, "the rejected reservation must not reach egress");
  service.fixture.release(modelId);
  assert.equal((await first).status, 200);
});

test("missing or inconsistent pricing fails closed before provider egress", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "model-gateway-pricing-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  let providerCalls = 0;
  const application = await createModelGatewayApplication({
    dataRoot,
    clients: ADMIN_CLIENTS,
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response("{}", { status: 200 });
    }
  });
  t.after(() => application.close());
  application.state.providers.prov1 = { providerId: "prov1", protocol: "openai", enabled: true };
  application.state.models.model1 = {
    modelId: "model1", providerRef: "prov1", pricingRevisionRef: "missing", enabled: true
  };
  const client = application.authenticate({ authorization: `Bearer ${ADMIN_CLIENTS["service-admin"].secret}` });
  const body = { model: "model1", messages: [{ role: "user", content: "synthetic pricing check" }] };
  const missing = await application.callOpenAi({ client, body, requestId: "req-missing-price" });
  assert.equal(missing.error.error.code, "provider_unavailable");

  application.state.pricingRevisions.mismatched = {
    revisionRef: "mismatched",
    modelRef: "model1",
    currency: "USD",
    inputTokenRate: { currency: "CAD", units: 1, nanos: 0 },
    outputTokenRate: { currency: "USD", units: 1, nanos: 0 },
    immutable: true
  };
  application.state.models.model1.pricingRevisionRef = "mismatched";
  const invalid = await application.callOpenAi({ client, body, requestId: "req-invalid-price" });
  assert.equal(invalid.error.error.code, "provider_unavailable");
  assert.equal(providerCalls, 0, "unknown and mismatched prices must never be treated as free work");
});

test("request rate limiting rejects a second call without egress", async (t) => {
  const service = await startService({ bounds: { maxRatePerSecond: 1 } });
  t.after(() => service.close());
  await provision(service);
  const first = await openAiCall(service, CALL);
  assert.equal(first.status, 200);
  const second = await openAiCall(service, CALL);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, "rate_limited");
  assert.equal(service.fixture.openAiCalls(), 1);
});

test("concurrent call bound rejects parallel admission without egress", async (t) => {
  const service = await startService({ bounds: { maxConcurrentCalls: 1 } });
  t.after(() => service.close());
  const modelId = "fixture-openai-hold";
  await provision(service, { modelId });
  const held = openAiCall(service, { ...CALL, model: modelId });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = await openAiCall(service, { ...CALL, model: modelId });
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, "rate_limited");
  assert.equal(service.fixture.openAiCalls(), 1, "the second call must not reach the provider");
  service.fixture.release(modelId);
  const first = await held;
  assert.equal(first.status, 200);
  assert.equal(service.fixture.openAiCalls(), 1, "the released call is the only provider request");
});

test("aggregate global concurrency bound rejects cross-model traffic with zero egress", async (t) => {
  const service = await startService({ bounds: { maxGlobalConcurrentCalls: 1, maxConcurrentCalls: 64 } });
  t.after(() => service.close());
  await provision(service, { modelId: "fixture-openai-hold" });
  await provisionModel(service, { modelId: "model-2", revisionRef: "price-2" });
  const held = openAiCall(service, {
    model: "fixture-openai-hold",
    messages: [{ role: "user", content: "hold aggregate admission" }]
  });
  for (let attempt = 0; attempt < 100 && service.fixture.openAiCalls() === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(service.fixture.openAiCalls(), 1, "the first provider request should be held in flight");
  const denied = await openAiCall(service, {
    model: "model-2",
    messages: [{ role: "user", content: "cross-model second call" }]
  });
  assert.equal(denied.status, 429);
  assert.equal((await denied.json()).error.code, "rate_limited");
  assert.equal(service.fixture.openAiCalls(), 1, "cross-model traffic must not exceed aggregate capacity");
  service.fixture.release("fixture-openai-hold");
  assert.equal((await held).status, 200);
});

test("aggregate per-subject bound denies only the saturated subject", async (t) => {
  const clients = {
    ...ADMIN_CLIENTS,
    "second-client": {
      subject: "second-subject",
      secret: "model-gateway-test-second-secret-000000000000000000",
      scopes: ["model:call"]
    }
  };
  const service = await startService({
    clients,
    bounds: { maxSubjectConcurrentCalls: 1, maxGlobalConcurrentCalls: 16, maxConcurrentCalls: 64 }
  });
  t.after(() => service.close());
  await provision(service, { modelId: "fixture-openai-hold" });
  const held = openAiCall(service, {
    model: "fixture-openai-hold",
    messages: [{ role: "user", content: "hold subject admission" }]
  });
  for (let attempt = 0; attempt < 100 && service.fixture.openAiCalls() === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const denied = await openAiCall(service, {
    model: "fixture-openai-hold",
    messages: [{ role: "user", content: "same subject second call" }]
  });
  assert.equal(denied.status, 429);
  assert.equal((await denied.json()).error.code, "rate_limited");
  const otherSubject = fetch(`${service.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${clients["second-client"].secret}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "fixture-openai-hold",
      messages: [{ role: "user", content: "different subject concurrent call" }]
    })
  });
  for (let attempt = 0; attempt < 100 && service.fixture.openAiCalls() < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(service.fixture.openAiCalls(), 2, "a different subject must keep its own aggregate budget");
  service.fixture.release("fixture-openai-hold");
  assert.equal((await held).status, 200);
  assert.equal((await otherSubject).status, 200);
});

test("aggregate request byte bound denies oversized declared bodies with zero egress", async (t) => {
  const service = await startService({ bounds: { maxSubjectRequestBytes: 8, maxGlobalRequestBytes: 64 * 1024 * 1024 } });
  t.after(() => service.close());
  await provision(service);
  const denied = await openAiCall(service, CALL);
  assert.equal(denied.status, 429);
  assert.equal((await denied.json()).error.code, "budget_exceeded");
  assert.equal(service.fixture.openAiCalls(), 0, "a denied request must buffer no body and reach no provider");
});

test("unconfigured provider egress leaves the ledger in_doubt without leaking credentials", async (t) => {
  const service = await startService({ configureEgress: false });
  t.after(() => service.close());
  await provision(service);
  const response = await openAiCall(service, CALL);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "provider_unavailable");
  assert.ok(!JSON.stringify(body).includes("fixture-provider-secret"), "credentials must never leak");
  assert.equal(service.fixture.openAiCalls(), 0);
});

test("cross-model subject quota persists over restart and denies zero provider effects", async (t) => {
  const bounds = { maxSubjectCostQuotaMicros: 3_000_000, maxGlobalCostQuotaMicros: 12_000_000 };
  const first = await startService({ bounds });
  const dataRoot = first.dataRoot;
  await provision(first);
  await provisionModel(first, { modelId: "model-2", revisionRef: "price-2" });
  const allowed = await openAiCall(first, CALL, { "idempotency-key": "durable-quota" });
  assert.equal(allowed.status, 200);
  await allowed.json();
  const denied = await openAiCall(first, { ...CALL, model: "model-2" });
  assert.equal(denied.status, 429);
  assert.equal((await denied.json()).error.code, "quota_exceeded");
  assert.equal(first.fixture.openAiCalls(), 1);
  await first.close({ keepDataRoot: true });
  const second = await startService({ dataRoot, bounds });
  t.after(() => second.close());
  const afterRestart = await openAiCall(second, { ...CALL, model: "model-2" });
  assert.equal(afterRestart.status, 429);
  assert.equal(second.fixture.openAiCalls(), 0, "restart must preserve quota reservations");
  const replay = await openAiCall(second, CALL, { "idempotency-key": "durable-quota" });
  assert.equal(replay.status, 200);
  assert.equal(second.fixture.openAiCalls(), 0, "a completed replay consumes no new quota or paid effect");
});
