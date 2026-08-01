#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RECEIPT_PATH: any = "tools/registry/lico-dev-upstream-workflow-receipt.json";
const TRUSTED_RECEIPT_DIGEST: any = "sha256:2551ef2c639e5bb9f92d5c06bacd8e55423cdc63a88d42e9e0e585bbc74c7896";
const SHA256: any = /^sha256:[a-f0-9]{64}$/u;
const GIT_SHA1: any = /^[a-f0-9]{40}$/u;
const DENIED_KEYS: any =
  /^(?:rawOutput|stdout|stderr|localPath|absolutePath|homePath|username|hostname|host|device|account|credential|token|secret|secretValue|ciphertext|runtimeData|logs?)$/iu;
const PRIVATE_VALUE: any =
  /(?:^|["'\s])(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]|\\\\|file:\/\/|ssh:\/\/|https?:\/\/|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)/iu;
const CONTROL_CHARACTER: any = /[\u0000-\u001f\u007f]/u;
const EXPECTED_SOURCE_ALLOWLIST: readonly any[] = Object.freeze([
  Object.freeze({ path: "config/repositories.json", role: "repository-routing" }),
  Object.freeze({ path: "lib/constants.ts", role: "workflow-planner" }),
  Object.freeze({ path: "lib/io.ts", role: "workflow-planner" }),
  Object.freeze({ path: "lib/privacy-classifier.ts", role: "workflow-planner" }),
  Object.freeze({ path: "lib/repositories.ts", role: "workflow-planner" }),
  Object.freeze({ path: "lib/workflow.ts", role: "workflow-planner" }),
  Object.freeze({ path: "tests/helpers.ts", role: "workflow-tests" }),
  Object.freeze({ path: "tests/workflow.test.ts", role: "workflow-tests" }),
  Object.freeze({ path: "workflows/catalog.json", role: "workflow-catalog" }),
  Object.freeze({ path: "skills/catalog.json", role: "skill-catalog" }),
  Object.freeze({
    path: "skills/lico-upstream-service-publishing/SKILL.md",
    role: "skill-contract"
  }),
  Object.freeze({
    path: "skills/lico-upstream-service-publishing/references/publishing-contract.md",
    role: "skill-contract"
  })
]);
const EXPECTED_ROUTES: Readonly<Record<string, any>> = Object.freeze({
  prepublication: Object.freeze({
    profile: "upstream-service-prepublication",
    taskOrder: Object.freeze([
      "meshrix.upstream-service-report-template",
      "meshrix.upstream-service-prepublication"
    ])
  }),
  full: Object.freeze({
    profile: "upstream-service-publishing",
    taskOrder: Object.freeze([
      "meshrix.typecheck",
      "meshrix.upstream-service-report-template",
      "meshrix.upstream-service-publishing",
      "meshrix.release-journey"
    ])
  })
});
const EXPECTED_EXTERNAL_TEST_COMMAND: Readonly<Record<string, any>> = Object.freeze({
  executable: "node",
  args: Object.freeze(["--test", "tests/workflow.test.ts"])
});

function canonicalJson(value?: any) : any {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key?: any) : any => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value?: any) : any {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function computeLicoDevUpstreamWorkflowReceiptDigest(receipt?: any) : any {
  const payload: any = structuredClone(receipt);
  delete payload.receiptDigest;
  return sha256(canonicalJson(payload));
}

function assertExactKeys(value?: any, expected?: any, label?: any) : any {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has missing or extra facts`);
}

function withoutDigest(value?: any, digestKey?: any) : any {
  const payload: any = structuredClone(value);
  delete payload[digestKey];
  return payload;
}

function assertPrivacySafe(value?: any, key: any = "receipt") : any {
  if (Array.isArray(value)) {
    value.forEach((entry?: any, index?: any) : any => assertPrivacySafe(entry, `${key}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of (Object.entries(value) as [string, any][])) {
      assert(!DENIED_KEYS.test(childKey), `${key}.${childKey} is privacy-unsafe`);
      assertPrivacySafe(child, `${key}.${childKey}`);
    }
    return;
  }
  if (typeof value === "string") {
    assert(!PRIVATE_VALUE.test(value), `${key} is privacy-unsafe`);
    assert(!CONTROL_CHARACTER.test(value), `${key} contains a control character`);
  }
}

export function verifyLicoDevUpstreamWorkflowReceipt(receipt?: any) : any {
  assertPrivacySafe(receipt);
  assertExactKeys(receipt, ["schemaVersion", "receiptId", "owner", "source", "routes", "externalTest", "privacy", "receiptDigest"], "receipt");
  assertExactKeys(receipt.source, ["repository", "revision", "revisionAlgorithm", "allowlist", "treeDigest", "treeDigestAlgorithm"], "source");
  assertExactKeys(receipt.routes, ["digestAlgorithm", "prepublication", "full"], "routes");
  assertExactKeys(receipt.routes.prepublication, ["profile", "taskOrder", "taskOrderDigest"], "routes.prepublication");
  assertExactKeys(receipt.routes.full, ["profile", "taskOrder", "taskOrderDigest"], "routes.full");
  assertExactKeys(receipt.externalTest, ["command", "commandDigest", "revision", "sourceTreeDigest", "passed", "exitCode", "factDigest"], "externalTest");
  assertExactKeys(receipt.externalTest.command, ["executable", "args"], "externalTest.command");
  assertExactKeys(receipt.privacy, ["rawOutputIncluded", "localInformationIncluded"], "privacy");

  assert.equal(receipt.schemaVersion, "v1:meshrix:lico-dev-upstream-workflow-receipt", "schema version is malformed");
  assert.equal(receipt.receiptId, "meshrix:lico-dev-upstream-workflows", "receipt identity is substituted");
  assert.equal(receipt.owner, "meshrix", "receipt owner is substituted");
  assert.equal(receipt.source.repository, "lico-dev", "source repository is substituted");
  assert.match(receipt.source.revision, GIT_SHA1, "source revision is malformed");
  assert.equal(receipt.source.revisionAlgorithm, "git-sha1", "source revision algorithm is malformed");
  assert.equal(receipt.source.treeDigestAlgorithm, "sha256-canonical-json-v1", "tree digest algorithm is malformed");
  assert(
    Array.isArray(receipt.source.allowlist)
      && receipt.source.allowlist.length === EXPECTED_SOURCE_ALLOWLIST.length,
    "source allowlist is incomplete"
  );
  for (const [index, entry] of receipt.source.allowlist.entries()) {
    assertExactKeys(entry, ["path", "role", "digest"], `source.allowlist[${index}]`);
    assert.equal(entry.path, EXPECTED_SOURCE_ALLOWLIST[index].path, `source.allowlist[${index}].path is substituted`);
    assert.equal(entry.role, EXPECTED_SOURCE_ALLOWLIST[index].role, `source.allowlist[${index}].role is substituted`);
    assert(
      !path.isAbsolute(entry.path)
        && !entry.path.includes("..")
        && !entry.path.includes("\\"),
      `source.allowlist[${index}].path is malformed`
    );
    assert.match(entry.digest, SHA256, `source.allowlist[${index}].digest is malformed`);
  }
  assert.equal(new Set<any>(receipt.source.allowlist.map((entry?: any) : any => entry.path)).size, receipt.source.allowlist.length, "source allowlist contains duplicate paths");
  assert.equal(sha256(canonicalJson(receipt.source.allowlist)), receipt.source.treeDigest, "source tree digest is repaired or malformed");

  assert.equal(receipt.routes.digestAlgorithm, "sha256-canonical-json-v1", "route digest algorithm is malformed");
  for (const [name, expected] of (Object.entries(EXPECTED_ROUTES) as [string, any][])) {
    const route: any = receipt.routes[name];
    assert.equal(route.profile, expected.profile, `${name} profile is substituted`);
    assert.deepEqual(route.taskOrder, expected.taskOrder, `${name} task order is substituted`);
    assert.match(route.taskOrderDigest, SHA256, `${name} task order digest is malformed`);
    assert.equal(
      sha256(canonicalJson(withoutDigest(route, "taskOrderDigest"))),
      route.taskOrderDigest,
      `${name} task order digest is repaired or malformed`
    );
  }

  assert.equal(receipt.externalTest.revision, receipt.source.revision, "external test revision is stale");
  assert.equal(receipt.externalTest.sourceTreeDigest, receipt.source.treeDigest, "external test source tree is stale");
  assert.deepEqual(receipt.externalTest.command, EXPECTED_EXTERNAL_TEST_COMMAND, "external test command is substituted");
  assert.match(receipt.externalTest.commandDigest, SHA256, "external test command digest is malformed");
  assert.equal(
    sha256(canonicalJson(receipt.externalTest.command)),
    receipt.externalTest.commandDigest,
    "external test command digest is repaired or malformed"
  );
  assert.equal(receipt.externalTest.passed, true, "external workflow test did not pass");
  assert.equal(receipt.externalTest.exitCode, 0, "external workflow test exit code is not successful");
  assert.match(receipt.externalTest.factDigest, SHA256, "external test fact digest is malformed");
  assert.equal(
    sha256(canonicalJson(withoutDigest(receipt.externalTest, "factDigest"))),
    receipt.externalTest.factDigest,
    "external test fact digest is repaired or malformed"
  );
  assert.equal(receipt.privacy.rawOutputIncluded, false, "receipt includes raw output");
  assert.equal(receipt.privacy.localInformationIncluded, false, "receipt includes local information");

  for (const digest of [
    receipt.source.treeDigest,
    receipt.routes.prepublication.taskOrderDigest,
    receipt.routes.full.taskOrderDigest,
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

export async function loadAndVerifyLicoDevUpstreamWorkflowReceipt({ repoRoot = REPO_ROOT }: Record<string, any> = {}) : Promise<any> {
  const receipt: any = JSON.parse(await fs.readFile(path.join(repoRoot, RECEIPT_PATH), "utf8"));
  return verifyLicoDevUpstreamWorkflowReceipt(receipt);
}

const invokedDirectly: any = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  loadAndVerifyLicoDevUpstreamWorkflowReceipt().then((result?: any) : any => {
    process.stdout.write(`[lico-dev-upstream-workflow-receipt] verified=${result.ok}\n`);
  }).catch(() : any => {
    process.stderr.write("[lico-dev-upstream-workflow-receipt] failed=receipt-invalid\n");
    process.exitCode = 1;
  });
}
