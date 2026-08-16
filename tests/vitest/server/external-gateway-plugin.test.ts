import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createDownstreamGatewayEnvelope,
  createWorkspaceApplicationEnvelope
} from "@meshrix/contracts/agent-mcp-traffic";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const pluginRoot = path.join(root, "plugins", "external-gateway");

async function runtime() {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8"));
  const module = await import(pathToFileURL(path.join(pluginRoot, "runtime.mjs")).href);
  return { manifest, module };
}

function channel(adapter: "caddy" | "nginx" | "direct") {
  return {
    adapter,
    endpointRefs: [`${adapter}.existing`],
    maxConcurrency: 1,
    maxRatePerSecond: 10,
    maxQueueDepth: 1,
    timeoutMs: 50,
    circuitFailureThreshold: 1,
    circuitResetMs: 100
  };
}

function downstream(trafficModel: "workspace_application" | "gateway_transit") {
  return createDownstreamGatewayEnvelope({
    operationId: `operation.${trafficModel}`,
    subjectRef: "subject.ref",
    targetRef: "target.ref",
    resourceRefs: [],
    inputRefs: [],
    policyRef: "policy.ref",
    approvalBinding: "approval.ref",
    idempotencyKey: `idempotency.${trafficModel}`,
    deadlineMs: 100,
    cancellationRef: null,
    streamingMode: "sse",
    traceRefs: [],
    evidenceRefs: [],
    trafficModel
  });
}

describe("External Gateway Runtime Plugin", () => {
  it("is default-disabled and activation changes availability without selecting traffic", async () => {
    const { manifest, module } = await runtime();
    expect(manifest.defaultEnabled).toBe(false);
    const disabled = await module.activatePlugin({ manifest, context: { configuration: {} } });
    expect(disabled.activation).toEqual({ trafficChanged: false, availableChoices: [] });
    expect(disabled).not.toHaveProperty("selectedChannel");
    expect(disabled).not.toHaveProperty("redirect");
  });

  it("provides immutable semantic-preserving channels and rejects the application envelope", async () => {
    const { manifest, module } = await runtime();
    let calls = 0;
    const enabled = await module.activatePlugin({
      manifest,
      context: {
        configuration: { enabled: true, downstream: channel("caddy"), upstream: channel("nginx") },
        gatewayTransport: async () => {
          calls += 1;
          return { status: "admitted", normalizedOutcomeRef: "normalized.same", generationRef: "generation.one" };
        }
      }
    });
    const channels = enabled.contributions.gatewayChannels.channels;
    expect(channels).toHaveLength(2);
    for (const trafficModel of ["workspace_application", "gateway_transit"] as const) {
      const envelope = downstream(trafficModel);
      const outcome = await channels[0].execute(envelope);
      expect(outcome).toMatchObject({
        stage: "downstream", trafficModel, status: "admitted", normalizedOutcomeRef: "normalized.same"
      });
      expect(Object.isFrozen(outcome)).toBe(true);
      expect(Object.isFrozen(envelope)).toBe(true);
    }
    const applicationEnvelope = createWorkspaceApplicationEnvelope({
      trafficModel: "workspace_application",
      operationId: "operation.application",
      subjectRef: "subject.ref",
      workingSetId: "working-set.ref",
      resourceRefs: [],
      cacheScope: "private"
    });
    expect((await channels[0].execute(applicationEnvelope)).errorRef).toBe("external_gateway_envelope_rejected");
    expect(calls).toBe(2);
  });

  it("contains no authority or lifecycle integration imports", async () => {
    async function files(directory: string): Promise<string[]> {
      const entries = await readdir(directory, { withFileTypes: true });
      return (await Promise.all(entries.map((entry) => {
        const target = path.join(directory, entry.name);
        return entry.isDirectory() ? files(target) : Promise.resolve([target]);
      }))).flat();
    }
    const sources = (await files(pluginRoot)).filter((file) => file.endsWith(".mjs"));
    const content = (await Promise.all(sources.map((file) => readFile(file, "utf8")))).join("\n");
    expect(content).not.toMatch(/packages\/(?:agents|capabilities|server-runtime|protocols)/u);
    expect(content).not.toMatch(/(?:start|reload|stop)(?:Caddy|Nginx)/u);
    expect(content).not.toMatch(/(?:select|switch)Channel/u);
  });
});
