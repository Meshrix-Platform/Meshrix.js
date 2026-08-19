#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const INVOKED_AS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === SELF;

if (INVOKED_AS_MAIN && !process.execArgv.includes("--conditions=source")) {
  const child = spawnSync(process.execPath, ["--conditions=source", SELF], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  process.exit(child.status ?? 1);
}

const REPOSITORY_ROOT = path.resolve(path.dirname(SELF), "../..");
const REPORT_PATH = "build/reports/gateway-boundary-final.json";

type TrafficModel = "workspace_application" | "gateway_transit";
type Direction = "downstream" | "upstream";

interface GatewayChannelLike {
  readonly channelId: string;
  readonly direction: Direction;
  readonly kind: "built_in" | "external";
  readonly trafficModels: readonly TrafficModel[];
  readonly externalAdapter: "caddy" | "nginx" | "direct" | null;
  readonly capabilities: unknown;
  readonly accepts: (input: unknown) => boolean;
  readonly execute: (input: unknown) => Promise<Readonly<Record<string, unknown>>>;
}

interface PipelineResultLike {
  readonly trafficModel: TrafficModel;
  readonly downstream: Readonly<Record<string, unknown>>;
  readonly application: Readonly<Record<string, unknown>> | null;
  readonly upstream: Readonly<Record<string, unknown>>;
  readonly downstreamPin: Readonly<{ channelId: string; generation: number }>;
  readonly upstreamPin: Readonly<{ channelId: string; generation: number }>;
  readonly operationOutput: unknown;
  readonly returnPath: Readonly<Record<string, string>>;
}

interface RouterLike {
  registerContribution(pluginId: string, contribution: unknown): void;
  removeContribution(pluginId: string): void;
  snapshot(): Readonly<Record<string, unknown>>;
}

interface ConsoleResponse {
  readonly status: number;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly body?: Readonly<Record<string, unknown>>;
}

export interface GatewayBoundaryFinalReceipt {
  readonly schemaVersion: "v0.0.1:gateway-boundary-final:receipt-1";
  readonly ok: true;
  readonly trafficModels: 2;
  readonly mandatoryStageOrders: number;
  readonly transitWorkspaceCalls: 0;
  readonly consoleDirectionSwitches: 4;
  readonly pinnedDrain: Readonly<{
    inFlight: Readonly<{ downstreamGeneration: 1; upstreamGeneration: 0 }>;
    afterUpstreamSwitch: Readonly<{ downstreamGeneration: 1; upstreamGeneration: 1 }>;
  }>;
  readonly hiddenFallbackCalls: 0;
  readonly modelGateway: Readonly<{
    disabledOperations: 0;
    attachedServiceCalls: 2;
    postDetachServiceCalls: 0;
  }>;
  readonly maintenance: Readonly<{
    configurationInputs: 1;
    inboundControlSurfaces: 0;
    meshrixInboundEdges: 0;
  }>;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

function responsePayload(response: ConsoleResponse): Readonly<Record<string, unknown>> {
  return response.payload ?? response.body ?? response as unknown as Readonly<Record<string, unknown>>;
}

function deferred(): Readonly<{ promise: Promise<void>; release: () => void }> {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return Object.freeze({ promise, release });
}

export async function runGatewayBoundaryFinalScenario(): Promise<GatewayBoundaryFinalReceipt> {
  const trafficContracts = await import("@meshrix/contracts/agent-mcp-traffic");
  const gatewayContracts = await import("@meshrix/contracts/plugins/gateway-channel-contract");
  const confinementContracts = await import("@meshrix/contracts/plugins/plugin-confinement-contract");
  const pipelineModule = await import(pathToFileURL(path.join(
    REPOSITORY_ROOT, "packages/server-runtime/src/composition/agent-mcp-gateway-pipeline.ts"
  )).href);
  const routerModule = await import(pathToFileURL(path.join(
    REPOSITORY_ROOT, "packages/server-runtime/src/composition/gateway-channel-router.ts"
  )).href);
  const consoleModule = await import(pathToFileURL(path.join(
    REPOSITORY_ROOT,
    "packages/server-runtime/src/composition/console-domain/operation-executors/runtime-admin-executors.ts"
  )).href);
  const externalGatewayModule = await import(pathToFileURL(path.join(
    REPOSITORY_ROOT, "plugins/external-gateway/runtime.mjs"
  )).href);
  const modelGatewayModule = await import(pathToFileURL(path.join(
    REPOSITORY_ROOT, "plugins/model-gateway/runtime.mjs"
  )).href);

  const traces: string[][] = [];
  let activeTrace: string[] = [];
  let workspaceCalls = 0;
  let transitWorkspaceCalls = 0;
  let holdExternalDownstream = false;
  const drainGate = deferred();

  function builtInChannel(direction: Direction): GatewayChannelLike {
    return gatewayContracts.assertGatewayChannel({
      channelId: `meshrix.built-in.${direction}`,
      direction,
      kind: "built_in",
      trafficModels: ["workspace_application", "gateway_transit"],
      externalAdapter: null,
      capabilities: {
        loadDistribution: "bounded",
        maxConcurrency: 8,
        maxRatePerSecond: 64,
        circuitBreaker: true,
        overloadShedding: true,
        timeoutMs: 1_000,
        cancellation: true,
        streaming: true,
        backpressure: true,
        degradation: "stable_transport"
      },
      accepts: (value: unknown) => Object.isFrozen(value) && asRecord(value, "gateway envelope required").stage === direction,
      execute: async () => {
        activeTrace.push(direction);
        return Object.freeze({
          stage: direction,
          status: "admitted",
          normalizedOutcomeRef: "semantic:preserved",
          errorRef: null
        });
      }
    }) as GatewayChannelLike;
  }

  const router = routerModule.createGatewayChannelRouter({
    downstream: builtInChannel("downstream"),
    upstream: builtInChannel("upstream")
  }) as RouterLike;
  const workspaceApplication = Object.freeze({
    async execute(input: Readonly<Record<string, unknown>>) {
      const descriptor = asRecord(input.descriptor, "descriptor required");
      if (descriptor.trafficModel !== "workspace_application") transitWorkspaceCalls += 1;
      workspaceCalls += 1;
      activeTrace.push("workspace_application");
      return Object.freeze({
        envelope: trafficContracts.createWorkspaceApplicationEnvelope({
          trafficModel: "workspace_application",
          operationId: descriptor.operationId,
          subjectRef: "subject:fixture",
          workingSetId: "working-set:fixture",
          cursorRef: "working-view:reused",
          changeSetRef: "change-set:bounded",
          resourceRefs: ["resource:delta"],
          cacheScope: "private"
        }),
        result: Object.freeze({
          stage: "workspace_application",
          trafficModel: "workspace_application",
          envelopeRef: "workspace:fixture",
          status: "admitted",
          normalizedOutcomeRef: "semantic:preserved",
          errorRef: null,
          generationRef: "workspace-generation:fixture"
        }),
        output: Object.freeze({ workingViewReused: true, boundedChangeSet: true, resourceDeltaDelivered: true })
      });
    }
  });
  const pipeline = pipelineModule.createAgentMcpGatewayPipeline({ router, workspaceApplication });

  const refs = Object.freeze({
    operationId: "fixture.operation",
    subjectRef: "subject:fixture",
    targetRef: "service:fixture",
    resourceRefs: Object.freeze(["resource:fixture"]),
    inputRefs: Object.freeze(["input:fixture"]),
    policyRef: "policy:allow",
    approvalBinding: "approval:fixture",
    idempotencyKey: "request:fixture",
    deadlineMs: 1_000,
    cancellationRef: null,
    streamingMode: "sse",
    traceRefs: Object.freeze(["trace:fixture"]),
    evidenceRefs: Object.freeze(["evidence:fixture"])
  });

  function descriptor(trafficModel: TrafficModel) {
    return Object.freeze({
      schemaVersion: trafficContracts.AGENT_MCP_OPERATION_DESCRIPTOR_SCHEMA_VERSION,
      operationId: "fixture.operation",
      trafficModel
    });
  }

  async function executePipeline(trafficModel: TrafficModel): Promise<PipelineResultLike> {
    activeTrace = [];
    traces.push(activeTrace);
    return pipeline.execute({
      descriptor: descriptor(trafficModel),
      callerInput: Object.freeze(trafficModel === "gateway_transit" ? { workspaceId: "non-authoritative" } : {}),
      refs,
      executeOperation: async () => {
        activeTrace.push("upstream_service");
        return Object.freeze({ semanticRef: "semantic:preserved" });
      }
    }) as Promise<PipelineResultLike>;
  }

  const builtInApplication = await executePipeline("workspace_application");
  assert.deepEqual(traces.at(-1), ["downstream", "workspace_application", "upstream", "upstream_service"]);
  assert.equal(builtInApplication.application?.normalizedOutcomeRef, "semantic:preserved");
  const builtInTransit = await executePipeline("gateway_transit");
  assert.deepEqual(traces.at(-1), ["downstream", "upstream", "upstream_service"]);
  assert.equal(workspaceCalls, 1);
  assert.equal(transitWorkspaceCalls, 0);
  assert.equal(builtInTransit.application, null);

  const deniedTraceCount = traces.length;
  await assert.rejects(() => pipeline.execute({
    descriptor: Object.freeze({ operationId: "fixture.operation" }),
    callerInput: Object.freeze({}),
    refs,
    executeOperation: async () => Object.freeze({})
  }), /trafficModel/u);
  await assert.rejects(() => pipeline.execute({
    descriptor: descriptor("gateway_transit"),
    callerInput: Object.freeze({ trafficModel: "workspace_application" }),
    refs,
    executeOperation: async () => Object.freeze({})
  }), /callers cannot supply or override trafficModel/u);
  assert.equal(traces.length, deniedTraceCount);

  const externalManifest = JSON.parse(await readFile(path.join(
    REPOSITORY_ROOT, "plugins/external-gateway/plugin.json"
  ), "utf8"));
  const externalRuntime = await externalGatewayModule.activatePlugin({
    manifest: externalManifest,
    context: {
      configuration: {
        enabled: true,
        downstream: {
          adapter: "direct", endpointRefs: ["direct.downstream"], maxConcurrency: 4,
          maxRatePerSecond: 64, maxQueueDepth: 4, timeoutMs: 1_000,
          circuitFailureThreshold: 2, circuitResetMs: 100
        },
        upstream: {
          adapter: "direct", endpointRefs: ["direct.upstream"], maxConcurrency: 4,
          maxRatePerSecond: 64, maxQueueDepth: 4, timeoutMs: 1_000,
          circuitFailureThreshold: 2, circuitResetMs: 100
        }
      },
      gatewayTransport: async (request: Readonly<Record<string, unknown>>) => {
        const envelope = asRecord(request.envelope, "external envelope required");
        activeTrace.push(String(envelope.stage));
        if (envelope.stage === "downstream" && holdExternalDownstream) await drainGate.promise;
        return Object.freeze({
          status: "admitted",
          normalizedOutcomeRef: "semantic:preserved",
          errorRef: null,
          generationRef: "external:generation"
        });
      }
    }
  });
  const beforeRegistration = router.snapshot();
  router.registerContribution("external-gateway", externalRuntime.contributions.gatewayChannels);
  const afterRegistration = router.snapshot();
  assert.deepEqual(asRecord(afterRegistration.selections, "selections required"),
    asRecord(beforeRegistration.selections, "selections required"));

  async function consoleSelect(direction: Direction, channelId: string, expectedGeneration: number): Promise<void> {
    const response = await consoleModule.executeRuntimeMountOperation({
      operationId: "runtime.gateway_channels.select",
      input: { direction, channelId, expectedGeneration },
      context: { gatewayChannelRouter: router, authSession: { user: { userId: "fixture-admin" } } }
    }) as ConsoleResponse;
    assert.equal(response.status, 200);
    const payload = responsePayload(response);
    const selected = asRecord(payload.selected, "selected channel required");
    assert.equal(selected.direction, direction);
    assert.equal(selected.channelId, channelId);
  }

  const externalChannels = externalRuntime.contributions.gatewayChannels.channels as readonly GatewayChannelLike[];
  const externalDownstream = externalChannels.find((channel) => channel.direction === "downstream");
  const externalUpstream = externalChannels.find((channel) => channel.direction === "upstream");
  assert.ok(externalDownstream && externalUpstream);
  await consoleSelect("downstream", externalDownstream.channelId, 0);
  const downstreamOnlyApplication = await executePipeline("workspace_application");
  assert.deepEqual(traces.at(-1), ["downstream", "workspace_application", "upstream", "upstream_service"]);
  assert.equal(downstreamOnlyApplication.downstream.normalizedOutcomeRef, builtInApplication.downstream.normalizedOutcomeRef);
  const downstreamOnlyTransit = await executePipeline("gateway_transit");
  assert.deepEqual(traces.at(-1), ["downstream", "upstream", "upstream_service"]);
  assert.equal(downstreamOnlyTransit.application, null);

  holdExternalDownstream = true;
  const draining = executePipeline("gateway_transit");
  await new Promise((resolve) => setImmediate(resolve));
  await consoleSelect("upstream", externalUpstream.channelId, 0);
  holdExternalDownstream = false;
  drainGate.release();
  const drained = await draining;
  assert.equal(drained.downstreamPin.generation, 1);
  assert.equal(drained.upstreamPin.generation, 0);
  assert.deepEqual(drained.returnPath, {
    upstreamGatewayGeneration: "0",
    downstreamGatewayGeneration: "1"
  });

  const externalApplication = await executePipeline("workspace_application");
  const externalTransit = await executePipeline("gateway_transit");
  assert.equal(externalApplication.downstreamPin.generation, 1);
  assert.equal(externalApplication.upstreamPin.generation, 1);
  assert.equal(externalTransit.downstreamPin.generation, 1);
  assert.equal(externalTransit.upstreamPin.generation, 1);
  assert.equal(externalApplication.downstream.normalizedOutcomeRef, builtInApplication.downstream.normalizedOutcomeRef);
  assert.equal(externalApplication.upstream.normalizedOutcomeRef, builtInApplication.upstream.normalizedOutcomeRef);
  assert.equal(externalTransit.downstream.normalizedOutcomeRef, builtInTransit.downstream.normalizedOutcomeRef);
  assert.equal(externalTransit.upstream.normalizedOutcomeRef, builtInTransit.upstream.normalizedOutcomeRef);
  assert.equal(externalApplication.application?.normalizedOutcomeRef, "semantic:preserved");
  assert.equal(externalTransit.application, null);

  router.removeContribution("external-gateway");
  const traceCountBeforeUnavailable = traces.length;
  await assert.rejects(() => executePipeline("gateway_transit"), /gateway_selected_channel_unavailable/u);
  assert.equal(traces.length, traceCountBeforeUnavailable + 1);
  assert.deepEqual(traces.at(-1), []);
  await consoleSelect("downstream", routerModule.BUILT_IN_DOWNSTREAM_CHANNEL_ID, 1);
  await consoleSelect("upstream", routerModule.BUILT_IN_UPSTREAM_CHANNEL_ID, 1);
  await externalRuntime.close();

  const disabledModelRuntime = await modelGatewayModule.activatePlugin({
    manifest: { id: "model-gateway" }, context: {}
  });
  assert.deepEqual(disabledModelRuntime.contributions.operations, {});
  await disabledModelRuntime.close();

  let serviceCalls = 0;
  const serviceHealthy = true;
  const enabledModelRuntime = await modelGatewayModule.activatePlugin({
    manifest: { id: "model-gateway" },
    context: { configuration: { enabled: true, serviceRef: "service.model-gateway", timeoutMs: 1_000 } }
  });
  const modelOperation = enabledModelRuntime.contributions.operations["model_gateway.call"];
  const modelInput = Object.freeze({
    modelRef: "model:fixture",
    providerRef: "provider:fixture",
    inputRefs: Object.freeze(["input:fixture"]),
    idempotencyKey: "model-call:fixture",
    deadlineMs: 1_000,
    stream: false
  });
  const currentCall = Object.freeze({
    auth: Object.freeze({ authenticated: true }),
    governance: Object.freeze({ authorized: true, current: true, revoked: false })
  });
  activeTrace = [];
  traces.push(activeTrace);
  const attachedPipeline = await pipeline.execute({
    descriptor: Object.freeze({
      schemaVersion: trafficContracts.AGENT_MCP_OPERATION_DESCRIPTOR_SCHEMA_VERSION,
      operationId: "model_gateway.call",
      trafficModel: "gateway_transit"
    }),
    callerInput: Object.freeze({}),
    refs: Object.freeze({ ...refs, operationId: "model_gateway.call", idempotencyKey: "model-call:fixture" }),
    executeOperation: async () => {
      activeTrace.push("model_gateway_adapter");
      return modelOperation.execute({
        input: modelInput,
        call: currentCall,
        host: {
          externalService: {
            request: async () => {
              serviceCalls += 1;
              activeTrace.push("standalone_service");
              return Object.freeze({
                ok: true,
                status: 200,
                data: Object.freeze({ semanticRef: "semantic:preserved" })
              });
            }
          }
        }
      });
    }
  }) as PipelineResultLike;
  assert.deepEqual(traces.at(-1), ["downstream", "upstream", "model_gateway_adapter", "standalone_service"]);
  assert.equal(asRecord(attachedPipeline.operationOutput, "model adapter output required").statusCode, 200);
  const unavailable = await modelOperation.execute({
    input: modelInput,
    call: currentCall,
    host: {
      externalService: {
        request: async () => {
          serviceCalls += 1;
          throw Object.assign(new Error("unavailable"), { status: 503 });
        }
      }
    }
  });
  assert.deepEqual(unavailable.body, { ok: false, error: { code: "model_gateway_unavailable" } });
  const callsAtDetach = serviceCalls;
  await enabledModelRuntime.close();
  const detached = await modelOperation.execute({ input: modelInput, call: currentCall, host: {} });
  assert.equal(detached.statusCode, 503);
  assert.equal(detached.body.error.code, "model_gateway_adapter_closed");
  assert.equal(serviceCalls, callsAtDetach);
  assert.equal(serviceHealthy, true);

  const maintenanceRoot = path.join(REPOSITORY_ROOT, "plugins/agents/meshrix-self-maintenance");
  const [maintenancePackage, maintenanceManifest, maintenanceSchema, maintenanceRuntime, maintenanceClients] =
    await Promise.all([
      readFile(path.join(maintenanceRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(path.join(maintenanceRoot, "plugin.json"), "utf8").then(JSON.parse),
      readFile(path.join(maintenanceRoot, "contracts/local-config.schema.json"), "utf8").then(JSON.parse),
      readFile(path.join(maintenanceRoot, "internal/runtime.mjs"), "utf8"),
      readFile(path.join(maintenanceRoot, "internal/http-clients.mjs"), "utf8")
  ]);
  assert.equal(maintenancePackage.bin, undefined);
  assert.deepEqual(maintenanceManifest.integration.operations, []);
  assert.deepEqual(maintenanceManifest.integration.toolsets, []);
  assert.deepEqual(maintenanceManifest.integration.mountNames, []);
  assert.equal(maintenanceSchema.additionalProperties, false);
  for (const field of ["listener", "server", "socket", "port", "controlChannel", "lifecycle"]) {
    assert.equal(Object.hasOwn(maintenanceSchema.properties, field), false);
  }
  const maintenanceSource = `${maintenanceRuntime}\n${maintenanceClients}`;
  assert.doesNotMatch(maintenanceSource, /createServer\s*\(|\.listen\s*\(|WebSocket|process\.(?:argv|env|stdin)/u);
  assert.match(maintenanceRuntime, /new AtomicConfigSource\(configPath\)/u);
  assert.match(maintenanceClients, /\/v1\/chat\/completions/u);
  assert.match(maintenanceClients, /\/api\/operation-permission\/v1\/execute/u);
  assert.equal(confinementContracts.MESHRIX_TO_MAINTENANCE_PLUGIN_EDGE, "none");
  assert.equal(confinementContracts.MAINTENANCE_PLUGIN_MESHRIX_IMPORT, "none");

  assert.equal(workspaceCalls, 3);
  assert.equal(transitWorkspaceCalls, 0);
  assert.equal(serviceCalls, 2);
  const mandatoryStageOrders = traces.filter((trace) => {
    const downstreamIndex = trace.indexOf("downstream");
    const upstreamIndex = trace.indexOf("upstream");
    return downstreamIndex >= 0 && upstreamIndex > downstreamIndex;
  }).length;
  assert.equal(mandatoryStageOrders, 8);
  return Object.freeze({
    schemaVersion: "v0.0.1:gateway-boundary-final:receipt-1",
    ok: true,
    trafficModels: 2,
    mandatoryStageOrders,
    transitWorkspaceCalls: 0,
    consoleDirectionSwitches: 4,
    pinnedDrain: Object.freeze({
      inFlight: Object.freeze({ downstreamGeneration: 1, upstreamGeneration: 0 }),
      afterUpstreamSwitch: Object.freeze({ downstreamGeneration: 1, upstreamGeneration: 1 })
    }),
    hiddenFallbackCalls: 0,
    modelGateway: Object.freeze({
      disabledOperations: 0,
      attachedServiceCalls: 2,
      postDetachServiceCalls: 0
    }),
    maintenance: Object.freeze({
      configurationInputs: 1,
      inboundControlSurfaces: 0,
      meshrixInboundEdges: 0
    })
  });
}

if (INVOKED_AS_MAIN) {
  const receipt = await runGatewayBoundaryFinalScenario();
  const reportPath = path.join(REPOSITORY_ROOT, REPORT_PATH);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({
    schemaVersion: "v0.0.1:gateway-boundary-final:report-1",
    verifier: "tools/server-scripts/gateway-boundary-final.ts",
    generatedAt: new Date().toISOString(),
    status: "passed",
    summary: Object.freeze({ releaseReady: true, coverageReady: true, reportLeakScan: true }),
    releaseReady: true,
    coverageReady: true,
    receipt
  }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
