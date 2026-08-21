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
  cleanupVerified = false,
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
  if (cleanupVerified !== true) fail("release_reducer_cleanup_unverified");
  const reasons = validateDriverAggregate(aggregate);
  if (reasons.length > 0) fail(reasons[0], reasons.join("; "));
  const receipt = createReleaseDeploymentReceipt({
    sourceRevision,
    candidateDigest,
    functionalReceiptDigest,
    scenarios: aggregate.scenarios,
    cleanupVerified: true,
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
    scenarios: Object.fromEntries(RELEASE_DEPLOYMENT_SCENARIOS.map((scenario) => [
      scenario,
      scenarioAggregate(scenario),
    ])),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--self-test") {
    const receipt = await reduceDeploymentEvidence({
      aggregate: selfTestAggregate(),
      sourceRevision: "a".repeat(40),
      candidateDigest: "b".repeat(64),
      functionalReceiptDigest: "c".repeat(64),
      cleanupVerified: true,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, receipt })}\n`);
    return;
  }
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--cleanup-verified") {
      options["cleanup-verified"] = true;
    } else if (name?.startsWith("--") && args[index + 1] && !args[index + 1].startsWith("--")) {
      options[name.slice(2)] = args[++index];
    } else {
      fail("release_reducer_argument_invalid");
    }
  }
  for (const key of ["input", "source-revision", "candidate-digest", "functional-receipt-digest", "output"]) {
    if (!options[key]) fail("release_reducer_argument_incomplete");
  }
  const receipt = await reduceDeploymentEvidence({
    aggregate: await readDriverAggregate(String(options.input)),
    sourceRevision: String(options["source-revision"]),
    candidateDigest: String(options["candidate-digest"]),
    functionalReceiptDigest: String(options["functional-receipt-digest"]),
    cleanupVerified: options["cleanup-verified"] === true,
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
