#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  HISTOGRAM_BUCKETS_MS,
  MAX_AGGREGATE_BYTES,
  RELEASE_DEPLOYMENT_AGGREGATE_SCHEMA,
  RELEASE_DEPLOYMENT_SCENARIOS,
  SCENARIO_BUDGETS,
  createReleaseDeploymentReceipt,
  validateDriverAggregate,
} from "./lib/release-deployment/contract.ts";
import {
  assertReleaseDeploymentResourcesRemoved,
  readReleaseDeploymentCleanupState,
  requireCurrentReleaseDeploymentEnvironment,
} from "./lib/release-deployment/authority.ts";

function fail(code: string, detail = code): never {
  throw Object.assign(new Error(detail), { code });
}

export async function readDriverAggregate(inputPath: string): Promise<any> {
  const stat = await fs.lstat(inputPath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_AGGREGATE_BYTES) {
    fail("release_reducer_input_invalid");
  }
  let aggregate: any;
  try {
    aggregate = JSON.parse(await fs.readFile(inputPath, "utf8"));
  } catch {
    fail("release_reducer_input_invalid");
  }
  return aggregate;
}

async function writeJsonAtomic(outputPath: string, value: any): Promise<void> {
  const absolute = path.resolve(outputPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, absolute);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function reduceDeploymentEvidence({
  aggregate,
  sourceRevision = "",
  candidateDigest = "",
  functionalReceiptDigest = "",
  cleanupStatePath = "",
  outputPath = "",
}: Record<string, any> = {}): Promise<any> {
  if (!/^[a-f0-9]{40}$/u.test(String(sourceRevision || ""))) {
    fail("release_reducer_source_revision_invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(String(candidateDigest || ""))) {
    fail("release_reducer_candidate_digest_invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(String(functionalReceiptDigest || ""))) {
    fail("release_reducer_functional_digest_invalid");
  }
  const reasons = validateDriverAggregate(aggregate);
  if (reasons.length > 0) fail(reasons[0], reasons.join("; "));
  const cleanupState = await readReleaseDeploymentCleanupState(cleanupStatePath);
  if (cleanupState.sourceRevision !== sourceRevision || cleanupState.candidateDigest !== candidateDigest) {
    fail("release_reducer_cleanup_candidate_mismatch");
  }
  await assertReleaseDeploymentResourcesRemoved(cleanupState);
  const receipt = createReleaseDeploymentReceipt({
    sourceRevision,
    candidateDigest,
    functionalReceiptDigest,
    executionEnvironment: aggregate.executionEnvironment,
    scenarios: aggregate.scenarios,
  });
  if (outputPath) await writeJsonAtomic(outputPath, receipt);
  return receipt;
}

function selfTestAggregate(): any {
  const scenarioAggregate = (scenario: string): any => {
    const attempts = SCENARIO_BUDGETS[scenario].requests;
    return {
      anthropic: scenario === "success" || scenario === "concurrency" ? attempts / 2 : 0,
      bucketCounts: HISTOGRAM_BUCKETS_MS.map(() => attempts),
      completed: attempts,
      discardedBytes: attempts * 128,
      expectedFault: scenario === "provider-fault" ? attempts : 0,
      expectedRequests: attempts,
      issued: attempts,
      latency: { maxMs: 40, p50Ms: 20, p95Ms: 40, p99Ms: 40 },
      openAi: scenario === "success" || scenario === "concurrency" ? attempts / 2 : attempts,
      overflow: 0,
      successful: scenario === "success" || scenario === "concurrency" ? attempts : 0,
      timeoutOrCancellation: scenario === "cancellation" ? attempts : 0,
      unexpectedFailure: 0,
    };
  };
  return {
    schemaVersion: RELEASE_DEPLOYMENT_AGGREGATE_SCHEMA,
    externalBoundary: true,
    executionEnvironment: {
      architecture: "x64",
      nodeVersion: "24.16.0",
      platform: "linux",
      runner: "ubuntu-24.04",
      runnerEnvironment: "github-hosted",
    },
    scenarios: Object.fromEntries(RELEASE_DEPLOYMENT_SCENARIOS.map((scenario) => [
      scenario,
      scenarioAggregate(scenario),
    ])),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--self-test") {
    const aggregate = selfTestAggregate();
    const reasons = validateDriverAggregate(aggregate);
    if (reasons.length > 0) fail(reasons[0]);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schemaVersion: RELEASE_DEPLOYMENT_AGGREGATE_SCHEMA,
      scenarioCount: RELEASE_DEPLOYMENT_SCENARIOS.length,
      syntheticEvidence: true,
    })}\n`);
    return;
  }
  const optionNames = new Set([
    "input", "source-revision", "candidate-digest", "functional-receipt-digest", "cleanup-state", "output",
  ]);
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const key = name?.startsWith("--") ? name.slice(2) : "";
    const value = args[index + 1];
    if (!optionNames.has(key) || options[key] !== undefined || !value || value.startsWith("--")) {
      fail("release_reducer_argument_invalid");
    }
    options[key] = value;
    index += 1;
  }
  for (const key of [
    "input", "source-revision", "candidate-digest", "functional-receipt-digest", "cleanup-state", "output",
  ]) {
    if (!options[key]) fail("release_reducer_argument_incomplete");
  }
  const aggregate = await readDriverAggregate(String(options.input));
  await requireCurrentReleaseDeploymentEnvironment(aggregate.executionEnvironment);
  const receipt = await reduceDeploymentEvidence({
    aggregate,
    sourceRevision: String(options["source-revision"]),
    candidateDigest: String(options["candidate-digest"]),
    functionalReceiptDigest: String(options["functional-receipt-digest"]),
    cleanupStatePath: String(options["cleanup-state"]),
    outputPath: String(options.output),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, scenarioCount: Object.keys(receipt.scenarios).length })}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main().catch((error: any) => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "release_reducer_failed" })}\n`);
    process.exitCode = 1;
  });
}
