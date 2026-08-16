#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.execArgv.includes("--conditions=source")) {
  const child = spawnSync(process.execPath, ["--conditions=source", fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  process.exit(child.status ?? 1);
}

const {
  createDownstreamGatewayEnvelope,
  createUpstreamGatewayEnvelope
} = await import("@meshrix/contracts/agent-mcp-traffic");

const root = process.cwd();
const pluginRoot = path.join(root, "plugins", "external-gateway");

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const resolved = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(resolved) : [resolved];
  }));
  return nested.flat();
}

const manifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8")) as Record<string, unknown>;
assert.equal(manifest.id, "external-gateway");
assert.equal(manifest.defaultEnabled, false);
assert.equal(manifest.contributionMode, "selected");
assert.deepEqual(manifest.dependencies, []);
assert.deepEqual(manifest.hostCapabilities, []);
assert.deepEqual(manifest.operations, []);
assert.deepEqual(manifest.routes, []);

const sourceFiles = (await listFiles(pluginRoot)).filter((file) => /\.(?:mjs|json)$/u.test(file));
const source = (await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")))).join("\n");
for (const forbiddenImport of [
  /from\s+["']@meshrix\/contracts["']/u,
  /from\s+["'][^"']*packages\/(?:agents|capabilities|server-runtime|protocols)[^"']*["']/u,
  /from\s+["'][^"']*(?:workspace|model-gateway|maintenance)[^"']*["']/u
]) assert.doesNotMatch(source, forbiddenImport);
for (const forbiddenAuthority of [
  "selectChannel", "switchChannel", "operationPermission", "credentialAuthority", "policyAuthority",
  "createWorkspace", "readWorkspace", "mutateWorkspace", "checkpointWorkspace", "startCaddy", "startNginx",
  "reloadCaddy", "reloadNginx"
]) assert.doesNotMatch(source, new RegExp(`\\b${forbiddenAuthority}\\b`, "u"));

const runtimeModule = await import(pathToFileURL(path.join(pluginRoot, "runtime.mjs")).href) as {
  activatePlugin(input: Record<string, unknown>): Promise<Record<string, unknown>>;
};

const disabled = await runtimeModule.activatePlugin({ manifest, context: { configuration: {} } });
assert.deepEqual(disabled.activation, { trafficChanged: false, availableChoices: [] });

const attachmentFacts: Array<Record<string, unknown>> = [];
const enabled = await runtimeModule.activatePlugin({
  manifest,
  context: {
    configuration: {
      enabled: true,
      downstream: {
        adapter: "caddy", endpointRefs: ["caddy.existing"], maxConcurrency: 2, maxRatePerSecond: 20,
        maxQueueDepth: 2, timeoutMs: 100, circuitFailureThreshold: 2, circuitResetMs: 100
      },
      upstream: {
        adapter: "direct", endpointRefs: ["direct.explicit"], maxConcurrency: 2, maxRatePerSecond: 20,
        maxQueueDepth: 2, timeoutMs: 100, circuitFailureThreshold: 2, circuitResetMs: 100
      }
    },
    gatewayTransport: async (request: Record<string, unknown>) => {
      attachmentFacts.push(request.attachment as Record<string, unknown>);
      return Object.freeze({
        status: "admitted",
        normalizedOutcomeRef: "normalized.same",
        errorRef: null,
        generationRef: "external.generation"
      });
    }
  }
});
assert.deepEqual(enabled.activation, {
  trafficChanged: false,
  availableChoices: ["external-gateway.caddy.downstream", "external-gateway.direct.upstream"]
});
const contribution = (enabled.contributions as Record<string, unknown>).gatewayChannels as {
  kind: string;
  channels: Array<{ direction: string; trafficModels: string[]; execute(input: unknown): Promise<Record<string, unknown>> }>;
};
assert.equal(contribution.kind, "gatewayChannels");
assert.deepEqual(contribution.channels.map((channel) => channel.direction), ["downstream", "upstream"]);
assert.ok(contribution.channels.every((channel) =>
  channel.trafficModels.includes("workspace_application") && channel.trafficModels.includes("gateway_transit")));

for (const trafficModel of ["workspace_application", "gateway_transit"] as const) {
  const base = {
    operationId: `operation.${trafficModel}`,
    subjectRef: "subject.ref",
    targetRef: "target.ref",
    resourceRefs: [],
    inputRefs: [],
    policyRef: "policy.ref",
    approvalBinding: "approval.ref",
    idempotencyKey: `idempotency.${trafficModel}`,
    deadlineMs: 500,
    cancellationRef: null,
    streamingMode: "sse",
    traceRefs: [],
    evidenceRefs: [],
    trafficModel
  };
  const downstream = createDownstreamGatewayEnvelope(base);
  const upstream = createUpstreamGatewayEnvelope({
    ...base,
    sourceDownstreamGeneration: "downstream.generation",
    sourceApplicationGeneration: trafficModel === "workspace_application" ? "application.generation" : null
  });
  const downResult = await contribution.channels[0].execute(downstream);
  const upResult = await contribution.channels[1].execute(upstream);
  assert.equal(downResult.normalizedOutcomeRef, "normalized.same");
  assert.equal(upResult.normalizedOutcomeRef, "normalized.same");
  assert.equal(downResult.trafficModel, trafficModel);
  assert.equal(upResult.trafficModel, trafficModel);
  assert.ok(Object.isFrozen(downResult));
  assert.ok(Object.isFrozen(upResult));
}
assert.equal(attachmentFacts.length, 4);
assert.ok(attachmentFacts.filter((attachment) => attachment.adapter === "caddy")
  .every((attachment) => attachment.instanceOwnership === "operator_existing"));
assert.ok(attachmentFacts.filter((attachment) => attachment.adapter === "direct")
  .every((attachment) => attachment.instanceOwnership === "operator_endpoint"));
assert.ok(attachmentFacts.every((attachment) => attachment.configurationAuthority === "none" &&
  attachment.lifecycleAuthority === "none" && attachment.implicitFallback === false));

process.stdout.write("external-gateway-plugin verification passed: directions=2 trafficModels=2 activationTrafficChanges=0\n");
