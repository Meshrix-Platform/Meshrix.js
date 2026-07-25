#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RECEIPT_PATH = "tools/registry/lico-dev-upstream-workflow-receipt.json";
const TRUSTED_RECEIPT_DIGEST = "sha256:3bb54c582e4209d4bf9804a7e697862a4f414fe8eb0b90efd72bc7262a435a69";
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA1 = /^[a-f0-9]{40}$/;
const DENIED_KEYS = /^(?:rawOutput|stdout|stderr|username|hostname|credential|token|secretValue|ciphertext)$/i;
const PRIVATE_VALUE = /(?:^|["'\s])(?:\/Users\/|\/home\/|[A-Za-z]:\\|file:\/\/|ssh:\/\/)/;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function computeLicoDevUpstreamWorkflowReceiptDigest(receipt) {
  const payload = structuredClone(receipt);
  delete payload.receiptDigest;
  return sha256(canonicalJson(payload));
}

function assertExactKeys(value, expected, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has missing or extra facts`);
}

function assertPrivacySafe(value, key = "receipt") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPrivacySafe(entry, `${key}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      assert(!DENIED_KEYS.test(childKey), `${key}.${childKey} is privacy-unsafe`);
      assertPrivacySafe(child, `${key}.${childKey}`);
    }
    return;
  }
  if (typeof value === "string") assert(!PRIVATE_VALUE.test(value), `${key} is privacy-unsafe`);
}

export function verifyLicoDevUpstreamWorkflowReceipt(receipt) {
  assertPrivacySafe(receipt);
  assertExactKeys(receipt, ["schemaVersion", "receiptId", "source", "workflow", "skillRouting", "externalTest", "privacy", "receiptDigest"], "receipt");
  assertExactKeys(receipt.source, ["repository", "revision", "revisionAlgorithm", "allowlist", "treeDigest", "treeDigestAlgorithm"], "source");
  assertExactKeys(receipt.workflow, ["id", "owner", "command", "cwd", "report", "inputSelectors", "changedRouting"], "workflow");
  assertExactKeys(receipt.workflow.command, ["executable", "args"], "workflow.command");
  assertExactKeys(receipt.workflow.inputSelectors, ["count", "digest"], "workflow.inputSelectors");
  assertExactKeys(receipt.workflow.changedRouting, ["profile", "selectedWorkflowId", "coreOnly", "testedOwnedPathCount", "testedOwnedPathDigest"], "workflow.changedRouting");
  assertExactKeys(receipt.skillRouting, ["skill", "owner", "routeCount", "routeDigest", "selectorCount", "selectorDigest", "contractDigest"], "skillRouting");
  assertExactKeys(receipt.externalTest, ["command", "commandDigest", "revision", "passed", "exitCode", "factDigest"], "externalTest");
  assertExactKeys(receipt.externalTest.command, ["executable", "args"], "externalTest.command");
  assertExactKeys(receipt.privacy, ["rawOutputIncluded", "localInformationIncluded"], "privacy");

  assert.equal(receipt.schemaVersion, "v1:meshrix:lico-dev-upstream-workflow-receipt", "schema version is malformed");
  assert.equal(receipt.receiptId, "lico-dev:core.upstream-service-publishing", "receipt identity is substituted");
  assert.equal(receipt.source.repository, "lico-dev", "source repository is substituted");
  assert.match(receipt.source.revision, GIT_SHA1, "source revision is malformed");
  assert.equal(receipt.source.revisionAlgorithm, "git-sha1", "source revision algorithm is malformed");
  assert.equal(receipt.source.treeDigestAlgorithm, "sha256-canonical-json-v1", "tree digest algorithm is malformed");
  assert(Array.isArray(receipt.source.allowlist) && receipt.source.allowlist.length === 12, "source allowlist is incomplete");
  for (const [index, entry] of receipt.source.allowlist.entries()) {
    assertExactKeys(entry, ["path", "role", "digest"], `source.allowlist[${index}]`);
    assert(typeof entry.path === "string" && !path.isAbsolute(entry.path) && !entry.path.includes("..") && !entry.path.includes("\\"), `source.allowlist[${index}].path is malformed`);
    assert.match(entry.digest, SHA256, `source.allowlist[${index}].digest is malformed`);
  }
  assert.equal(new Set(receipt.source.allowlist.map((entry) => entry.path)).size, receipt.source.allowlist.length, "source allowlist contains duplicate paths");
  assert.equal(sha256(canonicalJson(receipt.source.allowlist)), receipt.source.treeDigest, "source tree digest is repaired or malformed");

  assert.equal(receipt.workflow.id, "core.upstream-service-publishing", "workflow identity is substituted");
  assert.deepEqual(receipt.workflow.command, { executable: "npm", args: ["run", "verify:upstream-service-publishing"] }, "workflow command is substituted");
  assert.equal(receipt.workflow.report, "build/reports/upstream-service-publishing.json", "workflow report is substituted");
  assert.equal(receipt.workflow.changedRouting.coreOnly, true, "changed routing is not Core-only");
  assert.equal(receipt.workflow.changedRouting.selectedWorkflowId, receipt.workflow.id, "changed routing selects another workflow");
  assert.equal(receipt.externalTest.revision, receipt.source.revision, "external test revision is stale");
  assert.deepEqual(receipt.externalTest.command, { executable: "node", args: ["--test", "tests/workflow.test.mjs"] }, "external test command is substituted");
  assert.equal(receipt.externalTest.passed, true, "external workflow test did not pass");
  assert.equal(receipt.externalTest.exitCode, 0, "external workflow test exit code is not successful");
  assert.equal(receipt.privacy.rawOutputIncluded, false, "receipt includes raw output");
  assert.equal(receipt.privacy.localInformationIncluded, false, "receipt includes local information");

  for (const digest of [
    receipt.source.treeDigest,
    receipt.workflow.inputSelectors.digest,
    receipt.workflow.changedRouting.testedOwnedPathDigest,
    receipt.skillRouting.routeDigest,
    receipt.skillRouting.selectorDigest,
    receipt.skillRouting.contractDigest,
    receipt.externalTest.commandDigest,
    receipt.externalTest.factDigest,
    receipt.receiptDigest
  ]) assert.match(digest, SHA256, "receipt contains a malformed digest");

  assert.equal(computeLicoDevUpstreamWorkflowReceiptDigest(receipt), receipt.receiptDigest, "receipt digest is malformed");
  assert.equal(receipt.receiptDigest, TRUSTED_RECEIPT_DIGEST, "receipt facts do not match the trusted immutable binding");

  return Object.freeze({
    ok: true,
    receiptId: receipt.receiptId,
    sourceRevision: receipt.source.revision,
    sourceTreeDigest: receipt.source.treeDigest,
    receiptDigest: receipt.receiptDigest,
    externalTestPassed: true,
    privacySafe: true
  });
}

export async function loadAndVerifyLicoDevUpstreamWorkflowReceipt({ repoRoot = REPO_ROOT } = {}) {
  const receipt = JSON.parse(await fs.readFile(path.join(repoRoot, RECEIPT_PATH), "utf8"));
  return verifyLicoDevUpstreamWorkflowReceipt(receipt);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  loadAndVerifyLicoDevUpstreamWorkflowReceipt().then((result) => {
    process.stdout.write(`[lico-dev-upstream-workflow-receipt] verified=${result.ok}\n`);
  }).catch(() => {
    process.stderr.write("[lico-dev-upstream-workflow-receipt] failed=receipt-invalid\n");
    process.exitCode = 1;
  });
}
