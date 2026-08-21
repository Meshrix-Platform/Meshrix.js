#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHistogram, performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import {
  HISTOGRAM_BUCKETS_MS,
  MAX_AGGREGATE_BYTES,
  MAX_RESPONSE_BYTES,
  RELEASE_DEPLOYMENT_AGGREGATE_SCHEMA,
  RELEASE_DEPLOYMENT_SCENARIOS,
  SCENARIO_BUDGETS,
  validateDriverAggregate,
  validateScenarioBudgets,
} from "./lib/release-deployment/contract.ts";

const MAX_CREDENTIAL_BYTES = 8 * 1024;
const OPENAI_MODELS = Object.freeze({
  success: "fixture-openai",
  concurrency: "fixture-openai-concurrent",
  cancellation: "fixture-openai-cancel",
  "provider-fault": "fixture-openai-fault",
});
const ANTHROPIC_MODELS = Object.freeze({
  success: "fixture-anthropic",
  concurrency: "fixture-anthropic-concurrent",
});

function fail(code: string, detail = code): never {
  throw Object.assign(new Error(detail), { code });
}

export function parseLoopbackOrigin(value: any): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    fail("release_driver_origin_invalid");
  }
  const loopback = parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" || parsed.hostname === "::1";
  if (parsed.protocol !== "http:" || !loopback || !parsed.port ||
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")) {
    fail("release_driver_origin_invalid");
  }
  return parsed.origin;
}

function validateCredential(value: any): string {
  const credential = String(value || "");
  const bytes = Buffer.byteLength(credential);
  if (bytes < 16 || bytes > MAX_CREDENTIAL_BYTES || /[\r\n\0]/u.test(credential)) {
    fail("release_driver_credential_invalid");
  }
  return credential;
}

async function boundedResponse(response: Response): Promise<{ bytes: number; overflow: boolean; value: any }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: 0, overflow: false, value: null };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { bytes, overflow: true, value: null };
    }
    chunks.push(next.value);
  }
  if (bytes === 0) return { bytes, overflow: false, value: null };
  try {
    return { bytes, overflow: false, value: JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) };
  } catch {
    return { bytes, overflow: false, value: null };
  }
}

async function probeRuntime(origin: string): Promise<void> {
  for (const route of ["/", "/api/healthz"]) {
    const response = await fetch(`${origin}${route}`, { signal: AbortSignal.timeout(10_000) });
    const body = await boundedResponse(response);
    if (!response.ok || body.overflow) fail("release_driver_runtime_probe_failed");
  }
}

function protocolFor(scenario: string, sequence: number): "openai" | "anthropic" {
  if (scenario === "cancellation" || scenario === "provider-fault") return "openai";
  return sequence % 2 === 0 ? "anthropic" : "openai";
}

function callArguments(protocol: "openai" | "anthropic", scenario: string, sequence: number): any {
  const message = `bounded deterministic release smoke ${sequence}`;
  if (protocol === "anthropic") {
    return {
      model: ANTHROPIC_MODELS[scenario as keyof typeof ANTHROPIC_MODELS],
      max_tokens: 16,
      messages: [{ role: "user", content: message }],
      stream: false,
    };
  }
  return {
    model: OPENAI_MODELS[scenario as keyof typeof OPENAI_MODELS],
    max_tokens: 16,
    messages: [{ role: "user", content: message }],
    stream: false,
  };
}

function isRecord(value: any): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function projectedToolPayload(payload: any, sequence: number): any {
  if (!isRecord(payload) || payload.jsonrpc !== "2.0" || payload.id !== sequence ||
    !isRecord(payload.result) || !isRecord(payload.result.structuredContent) ||
    !isRecord(payload.result.structuredContent.payload)) {
    return null;
  }
  return payload.result.structuredContent.payload;
}

function isExpectedSuccess(status: number, payload: any, sequence: number, protocol: string): boolean {
  const projected = projectedToolPayload(payload, sequence);
  const provider = projected?.response?.json;
  return status >= 200 && status < 300 && projected?.ok === true &&
    Number(projected?.upstream?.status) >= 200 && Number(projected?.upstream?.status) < 300 &&
    isRecord(provider) && (
      protocol === "openai"
        ? provider.object === "chat.completion" && provider.model === "fixture-openai"
        : provider.type === "message" && provider.model === "fixture-anthropic"
    );
}

function isExpectedProviderFault(status: number, payload: any, sequence: number): boolean {
  const projected = projectedToolPayload(payload, sequence);
  return status >= 200 && status < 300 && projected?.ok === false &&
    projected?.upstream?.status === 503 &&
    projected?.response?.json?.error?.code === "provider_unavailable";
}

async function requestOnce({
  origin,
  credential,
  scenario,
  sequence,
  timeoutMs,
  cancelAfterMs,
  openAiTool,
  anthropicTool,
}: Record<string, any>): Promise<any> {
  const protocol = protocolFor(scenario, sequence);
  const controller = new AbortController();
  let abortKind = "";
  const timeout = setTimeout(() => {
    abortKind = "timeout";
    controller.abort();
  }, timeoutMs);
  const cancellation = cancelAfterMs > 0
    ? setTimeout(() => {
        abortKind = "cancelled";
        controller.abort();
      }, cancelAfterMs)
    : null;
  try {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "X-Meshrix.js-Api-Key": credential,
        "X-Meshrix.js-MCP-Target": "codex",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: sequence,
        method: "tools/call",
        params: {
          name: protocol === "openai" ? openAiTool : anthropicTool,
          arguments: callArguments(protocol, scenario, sequence),
        },
      }),
      signal: controller.signal,
    });
    const body = await boundedResponse(response);
    if (body.overflow) return { bytes: body.bytes, outcome: "overflow", protocol };
    if (scenario === "provider-fault") {
      return {
        bytes: body.bytes,
        outcome: isExpectedProviderFault(response.status, body.value, sequence)
          ? "expectedFault"
          : "unexpectedFailure",
        protocol,
      };
    }
    if (isExpectedSuccess(response.status, body.value, sequence, protocol)) {
      return { bytes: body.bytes, outcome: "successful", protocol };
    }
    return { bytes: body.bytes, outcome: "unexpectedFailure", protocol };
  } catch {
    return {
      bytes: 0,
      outcome: abortKind ? "timeoutOrCancellation" : "unexpectedFailure",
      protocol,
    };
  } finally {
    clearTimeout(timeout);
    if (cancellation) clearTimeout(cancellation);
  }
}

function emptyScenario(expectedRequests: number): any {
  return {
    anthropic: 0,
    bucketCounts: HISTOGRAM_BUCKETS_MS.map(() => 0),
    completed: 0,
    discardedBytes: 0,
    expectedFault: 0,
    expectedRequests,
    issued: 0,
    latency: { maxMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 },
    openAi: 0,
    overflow: 0,
    successful: 0,
    timeoutOrCancellation: 0,
    unexpectedFailure: 0,
  };
}

async function driveScenario({
  origin,
  credential,
  scenario,
  budget,
  openAiTool,
  anthropicTool,
}: Record<string, any>): Promise<any> {
  const aggregate = emptyScenario(budget.requests);
  const histogram = createHistogram({ lowest: 1, highest: 60_000_000, figures: 3 });
  let nextSequence = 1;
  const worker = async (): Promise<void> => {
    while (true) {
      const sequence = nextSequence;
      nextSequence += 1;
      if (sequence > budget.requests) return;
      aggregate.issued += 1;
      const started = performance.now();
      const result = await requestOnce({
        origin,
        credential,
        scenario,
        sequence,
        timeoutMs: budget.timeoutMs,
        cancelAfterMs: budget.cancelAfterMs || 0,
        openAiTool,
        anthropicTool,
      });
      const elapsedMs = Math.max(0.001, performance.now() - started);
      histogram.record(Math.max(1, Math.min(60_000_000, Math.round(elapsedMs * 1000))));
      for (let index = 0; index < HISTOGRAM_BUCKETS_MS.length; index += 1) {
        if (elapsedMs <= HISTOGRAM_BUCKETS_MS[index]) aggregate.bucketCounts[index] += 1;
      }
      aggregate.completed += 1;
      aggregate.discardedBytes += result.bytes;
      aggregate[result.protocol === "openai" ? "openAi" : "anthropic"] += 1;
      aggregate[result.outcome] += 1;
    }
  };
  await Promise.all(Array.from({ length: budget.concurrency }, () => worker()));
  const milliseconds = (value: number): number => Number((value / 1000).toFixed(3));
  aggregate.latency = {
    maxMs: milliseconds(histogram.max),
    p50Ms: milliseconds(histogram.percentile(50)),
    p95Ms: milliseconds(histogram.percentile(95)),
    p99Ms: milliseconds(histogram.percentile(99)),
  };
  return aggregate;
}

export async function driveDeployment({
  originUrl,
  credential,
  openAiTool,
  anthropicTool,
  budgets = SCENARIO_BUDGETS,
  probe = true,
}: Record<string, any> = {}): Promise<any> {
  validateScenarioBudgets(budgets);
  const origin = parseLoopbackOrigin(originUrl);
  const privateCredential = validateCredential(credential);
  if (!/^[A-Za-z0-9_.-]{1,160}$/u.test(String(openAiTool || "")) ||
    !/^[A-Za-z0-9_.-]{1,160}$/u.test(String(anthropicTool || ""))) {
    fail("release_driver_tool_name_invalid");
  }
  if (probe) await probeRuntime(origin);
  const scenarios: Record<string, any> = {};
  for (const scenario of RELEASE_DEPLOYMENT_SCENARIOS) {
    scenarios[scenario] = await driveScenario({
      origin,
      credential: privateCredential,
      scenario,
      budget: budgets[scenario],
      openAiTool,
      anthropicTool,
    });
  }
  const aggregate = {
    schemaVersion: RELEASE_DEPLOYMENT_AGGREGATE_SCHEMA,
    externalBoundary: true,
    scenarios,
  };
  const reasons = validateDriverAggregate(aggregate);
  if (reasons.length > 0) fail(reasons[0], reasons.join("; "));
  return aggregate;
}

async function readCredentialFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_CREDENTIAL_BYTES) fail("release_driver_credential_invalid");
    chunks.push(chunk);
  }
  return validateCredential(Buffer.concat(chunks, bytes).toString("utf8").trimEnd());
}

async function writeAggregate(filePath: string, aggregate: any): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(aggregate)}\n`);
  if (bytes.byteLength > MAX_AGGREGATE_BYTES) fail("release_driver_aggregate_too_large");
  const absolute = path.resolve(filePath);
  const temporary = `${absolute}.tmp`;
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fs.writeFile(temporary, bytes, { mode: 0o600 });
    await fs.rename(temporary, absolute);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--self-test") {
    const budgets = validateScenarioBudgets();
    parseLoopbackOrigin("http://127.0.0.1:7228");
    process.stdout.write(`${JSON.stringify({ ok: true, ...budgets, fixedWorkerPool: true })}\n`);
    return;
  }
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value) fail("release_driver_argument_invalid");
    options[name.slice(2)] = value;
  }
  for (const key of ["origin", "openai-tool", "anthropic-tool", "output"]) {
    if (!options[key]) fail("release_driver_argument_incomplete");
  }
  const aggregate = await driveDeployment({
    originUrl: options.origin,
    credential: await readCredentialFromStdin(),
    openAiTool: options["openai-tool"],
    anthropicTool: options["anthropic-tool"],
  });
  await writeAggregate(options.output, aggregate);
  process.stdout.write(`${JSON.stringify({ ok: true, scenarioCount: RELEASE_DEPLOYMENT_SCENARIOS.length })}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main().catch((error: any) => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "release_driver_failed" })}\n`);
    process.exitCode = 1;
  });
}
