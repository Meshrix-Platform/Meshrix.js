import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createDownstreamGatewayEnvelope,
  createUpstreamGatewayEnvelope,
  createWorkspaceApplicationEnvelope
} from "@meshrix/contracts/agent-mcp-traffic";
import { activatePlugin, validateExternalGatewayConfiguration } from "../runtime.mjs";

const manifest = Object.freeze(JSON.parse(await readFile(new URL("../plugin.json", import.meta.url), "utf8")));

function channelConfig(adapter, overrides = {}) {
  return {
    adapter,
    endpointRefs: adapter === "direct" ? ["direct.primary"] : [`${adapter}.primary`, `${adapter}.secondary`],
    maxConcurrency: 2,
    maxRatePerSecond: 100,
    maxQueueDepth: 2,
    circuitFailureThreshold: 2,
    circuitResetMs: 100,
    ...overrides
  };
}

function configuration(downstream = channelConfig("caddy"), upstream = channelConfig("nginx")) {
  return { enabled: true, downstream, upstream };
}

function refs(trafficModel, suffix = "one", overrides = {}) {
  return {
    operationId: `operation.${suffix}`,
    subjectRef: `subject.${suffix}`,
    targetRef: `target.${suffix}`,
    resourceRefs: [`resource.${suffix}`],
    inputRefs: [`input.${suffix}`],
    policyRef: `policy.${suffix}`,
    approvalBinding: `approval.${suffix}`,
    idempotencyKey: `idempotency.${suffix}`,
    deadlineMs: 500,
    cancellationRef: null,
    streamingMode: "sse",
    traceRefs: [`trace.${suffix}`],
    evidenceRefs: [`evidence.${suffix}`],
    trafficModel,
    ...overrides
  };
}

function downstream(trafficModel, suffix, overrides) {
  return createDownstreamGatewayEnvelope(refs(trafficModel, suffix, overrides));
}

function upstream(trafficModel, suffix, overrides) {
  return createUpstreamGatewayEnvelope({
    ...refs(trafficModel, suffix, overrides),
    sourceDownstreamGeneration: "downstream.generation",
    sourceApplicationGeneration: trafficModel === "workspace_application" ? "application.generation" : null
  });
}

async function runtimeWith(transport, configured = configuration()) {
  return activatePlugin({ manifest, context: { configuration: configured, gatewayTransport: transport } });
}

test("manifest and disabled activation expose availability only and change no traffic", async () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.equal(manifest.contributionMode, "selected");
  assert.deepEqual(manifest.hostCapabilities, []);
  assert.deepEqual(manifest.operations, []);
  assert.deepEqual(manifest.routes, []);
  const runtime = await activatePlugin({ manifest, context: { configuration: {} } });
  assert.deepEqual(runtime.activation, { trafficChanged: false, availableChoices: [] });
  assert.deepEqual(runtime.contributions.gatewayChannels, {});
  assert.equal(runtime.confinement.lifecycleAuthority, "availability_only");
  for (const authority of [
    "workspace", "application_stage", "semantics", "identity", "authorization", "credential",
    "policy", "channel_selection", "model_gateway_lifecycle", "maintenance"
  ]) assert.ok(runtime.confinement.forbiddenAuthorities.includes(authority));
});

test("configuration is closed, bounded, and direct is explicit with no fallback target", () => {
  assert.throws(() => validateExternalGatewayConfiguration({ enabled: false, downstream: channelConfig("caddy") }));
  assert.throws(() => validateExternalGatewayConfiguration({ enabled: true, downstream: channelConfig("caddy") }));
  assert.throws(() => validateExternalGatewayConfiguration(configuration(channelConfig("direct", {
    endpointRefs: ["direct.one", "direct.two"]
  }))));
  assert.throws(() => validateExternalGatewayConfiguration({ ...configuration(), selection: "external" }));
  const admitted = validateExternalGatewayConfiguration(configuration(channelConfig("direct"), channelConfig("direct")));
  assert.equal(admitted.downstream.endpointRefs.length, 1);
  assert.equal(Object.hasOwn(admitted.downstream, "timeoutMs"), false);
  const explicitBudget = validateExternalGatewayConfiguration(configuration(
    channelConfig("direct", { timeoutMs: 1_000 }),
    channelConfig("direct")
  ));
  assert.equal(explicitBudget.downstream.timeoutMs, 1_000);
  assert.equal(Object.hasOwn(explicitBudget.upstream, "timeoutMs"), false);
  assert.throws(() => validateExternalGatewayConfiguration(configuration(
    channelConfig("direct", { timeoutMs: 120_001 }), channelConfig("direct")
  )));
  assert.ok(Object.isFrozen(admitted));
  assert.ok(Object.isFrozen(admitted.downstream.endpointRefs));
});

test("explicit channel timeout reports promptly but retains its active slot until transport settlement", async () => {
  let releaseFirst;
  let calls = 0;
  const runtime = await runtimeWith(({ signal }) => {
    calls += 1;
    if (calls === 1) return new Promise((resolve) => { releaseFirst = resolve; });
    return Promise.resolve({ status: "admitted", normalizedOutcomeRef: "outcome.second" });
  }, configuration(
    channelConfig("caddy", { maxConcurrency: 1, maxQueueDepth: 1 }),
    channelConfig("nginx")
  ));
  const channel = runtime.contributions.gatewayChannels.channels[0];
  const first = channel.execute(downstream("gateway_transit", "timed-active", { deadlineMs: 25 }));
  await new Promise((resolve) => setImmediate(resolve));
  const second = channel.execute(downstream("gateway_transit", "after-timeout", { deadlineMs: 1_000 }));

  assert.equal((await first).status, "timeout");
  assert.equal(calls, 1);
  assert.deepEqual(runtime.snapshot()[0], {
    direction: "downstream", active: 1, queued: 1, endpointCount: 2, accepting: true
  });

  releaseFirst({ status: "admitted", normalizedOutcomeRef: "outcome.late" });
  assert.equal((await second).status, "admitted");
  assert.equal(calls, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.snapshot()[0], {
    direction: "downstream", active: 0, queued: 0, endpointCount: 2, accepting: true
  });
  await runtime.close();
});

test("close cancels active work but waits for an abort-ignoring transport to settle", async () => {
  let releaseTransport;
  let activeSignal;
  let calls = 0;
  const runtime = await runtimeWith(({ signal }) => {
    calls += 1;
    activeSignal = signal;
    return new Promise((resolve) => { releaseTransport = resolve; });
  }, configuration(
    channelConfig("caddy", { maxConcurrency: 1, maxQueueDepth: 1 }),
    channelConfig("nginx")
  ));
  const channel = runtime.contributions.gatewayChannels.channels[0];
  const active = channel.execute(downstream("gateway_transit", "close-active", { deadlineMs: 5_000 }));
  const queued = channel.execute(downstream("gateway_transit", "close-queued", { deadlineMs: 5_000 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  const firstClose = runtime.close();
  const concurrentClose = runtime.close();
  assert.strictEqual(firstClose, concurrentClose);
  assert.equal(activeSignal.aborted, true);
  assert.equal((await active).status, "cancelled");
  assert.equal((await queued).status, "cancelled");
  await Promise.resolve();
  assert.deepEqual(runtime.snapshot()[0], {
    direction: "downstream", active: 1, queued: 0, endpointCount: 2, accepting: false
  });
  assert.equal(calls, 1);

  releaseTransport({ status: "admitted", normalizedOutcomeRef: "outcome.completed_after_close" });
  assert.deepEqual(await firstClose, { ok: true, alreadyClosed: false });
  assert.deepEqual(runtime.snapshot()[0], {
    direction: "downstream", active: 0, queued: 0, endpointCount: 2, accepting: false
  });
  assert.deepEqual(await runtime.close(), { ok: true, alreadyClosed: true });
  assert.equal(calls, 1);
});

test("enabled runtime contributes frozen downstream and upstream channels for both traffic models", async () => {
  const seen = [];
  const runtime = await runtimeWith(async (request) => {
    seen.push(request);
    return Object.freeze({
      status: "admitted",
      normalizedOutcomeRef: "outcome.same",
      errorRef: null,
      generationRef: "generation.external"
    });
  });
  const contribution = runtime.contributions.gatewayChannels;
  assert.equal(contribution.kind, "gatewayChannels");
  assert.equal(contribution.channels.length, 2);
  assert.equal(runtime.activation.trafficChanged, false);
  assert.deepEqual(contribution.channels.map((channel) => channel.direction), ["downstream", "upstream"]);
  for (const channel of contribution.channels) {
    assert.deepEqual(channel.trafficModels, ["workspace_application", "gateway_transit"]);
    assert.equal(channel.capabilities.loadDistribution, "bounded");
    assert.equal(channel.capabilities.streaming, true);
    assert.equal(channel.capabilities.backpressure, true);
    assert.ok(Object.isFrozen(channel));
  }
  for (const trafficModel of ["workspace_application", "gateway_transit"]) {
    const down = await contribution.channels[0].execute(downstream(trafficModel, trafficModel));
    const up = await contribution.channels[1].execute(upstream(trafficModel, trafficModel));
    assert.equal(down.normalizedOutcomeRef, "outcome.same");
    assert.equal(up.normalizedOutcomeRef, "outcome.same");
    assert.equal(down.trafficModel, trafficModel);
    assert.equal(up.trafficModel, trafficModel);
    assert.ok(Object.isFrozen(down));
    assert.ok(Object.isFrozen(up));
  }
  assert.equal(seen.length, 4);
  assert.ok(seen.every((request) => Object.isFrozen(request) && Object.isFrozen(request.envelope)));
  assert.ok(seen.filter((request) => request.attachment.adapter === "caddy")
    .every((request) => request.attachment.instanceOwnership === "operator_existing"));
  assert.deepEqual(
    seen.filter((request) => request.attachment.adapter === "caddy")
      .map((request) => request.attachment.endpointRef),
    ["caddy.primary", "caddy.secondary"]
  );
  assert.ok(seen.every((request) => request.attachment.configurationAuthority === "none" &&
    request.attachment.lifecycleAuthority === "none" && request.attachment.implicitFallback === false));
});

test("channels reject mutable and application-stage envelopes before transport", async () => {
  let calls = 0;
  const runtime = await runtimeWith(async () => {
    calls += 1;
    return { status: "admitted", normalizedOutcomeRef: "unexpected" };
  });
  const [downstreamChannel] = runtime.contributions.gatewayChannels.channels;
  const mutable = structuredClone(downstream("gateway_transit", "mutable"));
  const valid = downstream("gateway_transit", "fractional-deadline");
  const fractionalDeadline = Object.freeze({
    ...valid,
    refs: Object.freeze({ ...valid.refs, deadlineMs: 1.5 })
  });
  const workspaceEnvelope = createWorkspaceApplicationEnvelope({
    trafficModel: "workspace_application",
    operationId: "operation.workspace",
    subjectRef: "subject.workspace",
    workingSetId: "working-set.workspace",
    resourceRefs: [],
    cacheScope: "private"
  });
  assert.equal(downstreamChannel.accepts(mutable), false);
  assert.equal(downstreamChannel.accepts(fractionalDeadline), false);
  assert.equal(downstreamChannel.accepts(workspaceEnvelope), false);
  assert.equal((await downstreamChannel.execute(mutable)).errorRef, "external_gateway_envelope_rejected");
  assert.equal((await downstreamChannel.execute(fractionalDeadline)).errorRef, "external_gateway_envelope_rejected");
  assert.equal((await downstreamChannel.execute(workspaceEnvelope)).errorRef, "external_gateway_envelope_rejected");
  assert.equal(calls, 0);
});

test("bounded concurrency queues one call and sheds overload without invoking transport", async () => {
  const releases = [];
  let calls = 0;
  const runtime = await runtimeWith(() => {
    calls += 1;
    return new Promise((resolve) => releases.push(resolve));
  }, configuration(channelConfig("caddy", { maxConcurrency: 1, maxQueueDepth: 1 }), channelConfig("nginx")));
  const channel = runtime.contributions.gatewayChannels.channels[0];
  const first = channel.execute(downstream("gateway_transit", "first"));
  const second = channel.execute(downstream("gateway_transit", "second"));
  const third = await channel.execute(downstream("gateway_transit", "third"));
  assert.equal(third.status, "shed");
  assert.equal(third.errorRef, "external_gateway_overloaded");
  assert.equal(calls, 1);
  releases.shift()({ status: "admitted", normalizedOutcomeRef: "outcome.first" });
  assert.equal((await first).status, "admitted");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  releases.shift()({ status: "admitted", normalizedOutcomeRef: "outcome.second" });
  assert.equal((await second).status, "admitted");
});

test("rate, queued deadline, cancellation, circuit, and health state fail closed with stable outcomes", async () => {
  const rateRuntime = await runtimeWith(async () => ({ status: "admitted", normalizedOutcomeRef: "ok" }),
    configuration(channelConfig("caddy", { maxRatePerSecond: 1 }), channelConfig("nginx")));
  const rateChannel = rateRuntime.contributions.gatewayChannels.channels[0];
  assert.equal((await rateChannel.execute(downstream("gateway_transit", "rate-one"))).status, "admitted");
  assert.equal((await rateChannel.execute(downstream("gateway_transit", "rate-two"))).errorRef,
    "external_gateway_rate_limited");

  let releaseFirst;
  let callCount = 0;
  const deadlineRuntime = await runtimeWith(() => {
    callCount += 1;
    return new Promise((resolve) => { releaseFirst = resolve; });
  }, configuration(channelConfig("caddy", { maxConcurrency: 1, maxQueueDepth: 1 }), channelConfig("nginx")));
  const deadlineChannel = deadlineRuntime.contributions.gatewayChannels.channels[0];
  const active = deadlineChannel.execute(downstream("gateway_transit", "active"));
  await new Promise((resolve) => setImmediate(resolve));
  const timed = await deadlineChannel.execute(downstream("gateway_transit", "queued", { deadlineMs: 20 }));
  assert.equal(timed.status, "timeout");
  assert.equal(timed.errorRef, "external_gateway_timeout");
  assert.equal(callCount, 1);
  releaseFirst({ status: "admitted", normalizedOutcomeRef: "outcome.active" });
  assert.equal((await active).status, "admitted");

  let releaseUncancellable;
  let secondStarted;
  const secondStartedPromise = new Promise((resolve) => { secondStarted = resolve; });
  let uncancellableCalls = 0;
  const slotRuntime = await runtimeWith(({ signal }) => {
    uncancellableCalls += 1;
    if (uncancellableCalls === 1) {
      return new Promise((resolve) => { releaseUncancellable = resolve; });
    }
    secondStarted();
    return Promise.resolve({ status: "admitted", normalizedOutcomeRef: "outcome.second" });
  }, configuration(channelConfig("caddy", { maxConcurrency: 1, maxQueueDepth: 1 }), channelConfig("nginx")));
  const slotChannel = slotRuntime.contributions.gatewayChannels.channels[0];
  const cancellationController = new AbortController();
  const cancelledTransport = slotChannel.execute(downstream("gateway_transit", "uncancellable"), {
    signal: cancellationController.signal
  });
  await new Promise((resolve) => setImmediate(resolve));
  const queuedTransport = slotChannel.execute(downstream("gateway_transit", "after-cancel"));
  cancellationController.abort();
  const cancellationOutcome = await cancelledTransport;
  assert.equal(cancellationOutcome.status, "cancelled");
  assert.equal(uncancellableCalls, 1);
  assert.deepEqual(slotRuntime.snapshot()[0], {
    direction: "downstream", active: 1, queued: 1, endpointCount: 2, accepting: true
  });
  releaseUncancellable({ status: "admitted", normalizedOutcomeRef: "outcome.late" });
  await secondStartedPromise;
  assert.equal((await queuedTransport).status, "admitted");
  assert.equal(uncancellableCalls, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(slotRuntime.snapshot()[0], {
    direction: "downstream", active: 0, queued: 0, endpointCount: 2, accepting: true
  });

  const cancellationRuntime = await runtimeWith(({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  }));
  const controller = new AbortController();
  const cancellation = cancellationRuntime.contributions.gatewayChannels.channels[0]
    .execute(downstream("gateway_transit", "cancel"), { signal: controller.signal });
  controller.abort();
  const cancelled = await cancellation;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.errorRef, "external_gateway_cancelled");

  let circuitCalls = 0;
  const circuitRuntime = await runtimeWith(async () => {
    circuitCalls += 1;
    return { status: "failed", errorRef: "backend_unavailable" };
  }, configuration(channelConfig("caddy", {
    endpointRefs: ["caddy.only"], circuitFailureThreshold: 1, circuitResetMs: 1_000
  }), channelConfig("nginx")));
  const circuitChannel = circuitRuntime.contributions.gatewayChannels.channels[0];
  assert.equal((await circuitChannel.execute(downstream("gateway_transit", "circuit-one"))).status, "failed");
  assert.equal((await circuitChannel.execute(downstream("gateway_transit", "circuit-two"))).errorRef,
    "external_gateway_circuit_open");
  assert.equal(circuitCalls, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(circuitRuntime.snapshot()[0], {
    direction: "downstream", active: 0, queued: 0, endpointCount: 1, accepting: true
  });
});

test("direct performs one explicit attempt and never silently reroutes", async () => {
  const attachments = [];
  const runtime = await runtimeWith(async ({ attachment }) => {
    attachments.push(attachment);
    throw new Error("unavailable");
  }, configuration(channelConfig("direct"), channelConfig("direct")));
  const outcome = await runtime.contributions.gatewayChannels.channels[0]
    .execute(downstream("workspace_application", "direct"));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.errorRef, "external_gateway_transport_failed");
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].adapter, "direct");
  assert.equal(attachments[0].instanceOwnership, "operator_endpoint");
  assert.equal(attachments[0].implicitFallback, false);
});
