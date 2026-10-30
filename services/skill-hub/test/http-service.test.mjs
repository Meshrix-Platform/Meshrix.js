import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSkillHubApplication } from "../internal/application.mjs";
import { createSkillHubHttpHandler } from "../internal/http-service.mjs";
import { createServiceData } from "../internal/service-data.mjs";
import { createSkillHubEventJournal } from "../internal/service-events.mjs";
import { createStateMutationQueue } from "../internal/state-mutation-queue.mjs";
import { registryResource, unownedRegistryResource } from "../internal/registry-ownership.mjs";
import {
  legacyRegistryArchiveResource,
  registryDatabaseResource
} from "../internal/registry-persistence.mjs";
import { normalizeSkillHubContribution } from "../internal/skill-hub-contribution.mjs";
const canned1 = "synthetic-skill-hub-service-test-token-00000000";
const canned2 = "shared-package-scan";



const cannedMeta = 'json_import_complete';




const authToken = canned1;

test("Skill Hub handler requires an explicit authentication token before opening storage", async () => {
  await assert.rejects(createSkillHubHttpHandler(), /requires a bounded authentication token/u);
  await assert.rejects(createSkillHubHttpHandler({ authToken: { toString: () => "x".repeat(32) } }), /requires a bounded authentication token/u);
});

function meshrixContext(subject = "a", tenant = "b", phase = "execute") {
  return Object.freeze({
    schemaVersion: "v0.0.1:skill-hub:host-context-1",
    phase,
    principal: Object.freeze({
      subjectRef: `skill_hub_subject_${subject.repeat(64)}`,
      tenantRef: `skill_hub_tenant_${tenant.repeat(64)}`
    })
  });
}

async function start(dataRoot) {
  const handler = await createSkillHubHttpHandler({ dataRoot, authToken });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return Object.freeze({
    baseUrl,
    async invoke(operationId, input) {
      const response = await fetch(`${baseUrl}/v1/operations/${operationId}`, {
        method: "POST",
        headers: { "authorization": ("Bearer "+authToken), "content-type": "application/json",
          "x-meshrix-skill-hub-subject": input?.meshrixContext?.principal?.subjectRef || meshrixContext().principal.subjectRef },
        body: JSON.stringify(input)
      });
      assert.equal(response.status, 200);
      return response.json();
    },
    async close() {
      await handler.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test("independent Skill Hub service persists its authoritative registry across restart", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-service-test-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const context = meshrixContext();
  const first = await start(dataRoot);
  const health = await fetch(`${first.baseUrl}/healthz`).then((response) => response.json());
  assert.equal(health.ok, true);
  const submitted = await first.invoke("skill_hub.submit", {
    contributionId: "service-persisted-skill",
    workspaceId: "workspace-service-test",
    title: "Service persisted skill",
    license: "Apache-2.0",
    declaredPermissions: ["read"],
    skillManifestRef: "service-persisted-skill/SKILL.md",
    payloadRefs: ["service-persisted-skill/SKILL.md"],
    packageBundleBase64: Buffer.from("service-persisted-package").toString("base64"),
    meshrixContext: context
  });
  assert.equal(submitted.statusCode, 201);
  await first.close();

  const second = await start(dataRoot);
  t.after(() => second.close());
  const stats = await second.invoke("skill_hub.stats", { meshrixContext: context });
  assert.equal(stats.statusCode, 200);
  assert.equal(stats.body.skillCount, 1);
  assert.equal(stats.body.workspaceId, "");
});

test("registry reads and idempotent lifecycle calls do not write; download commits one audit and contribution update", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-registry-read-cost-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const data = createServiceData(dataRoot);
  const context = meshrixContext();
  const first = await createSkillHubApplication({ serviceData: data });
  const submitted = await first.invoke("skill_hub.submit", {
    contributionId: "download-cost-skill",
    workspaceId: "download-cost-workspace",
    title: "Download cost skill",
    license: "Apache-2.0",
    declaredPermissions: ["read"],
    skillManifestRef: "download-cost/SKILL.md",
    payloadRefs: ["download-cost/SKILL.md"],
    packageBundleBase64: Buffer.from("download-cost-package").toString("base64"),
    meshrixContext: context
  });
  assert.equal(submitted.statusCode, 201);
  await first.close();

  const databasePath = path.join(dataRoot, ...registryDatabaseResource(
    registryResource("default", context.principal.tenantRef)
  ).split("/"));
  const seedDatabase = new DatabaseSync(databasePath);
  try {
    const row = seedDatabase.prepare("SELECT body FROM contributions WHERE contribution_id = ?")
      .get("download-cost-skill");
    const contribution = JSON.parse(row.body);
    contribution.status = "published";
    seedDatabase.prepare("UPDATE contributions SET body = ? WHERE contribution_id = ?")
      .run(JSON.stringify(contribution), contribution.contributionId);
  } finally {
    seedDatabase.close();
  }

  const application = await createSkillHubApplication({ serviceData: data });
  const observer = new DatabaseSync(databasePath);
  t.after(async () => {
    observer.close();
    await application.close();
  });
  const versionBeforeReads = observer.prepare("PRAGMA data_version").get().data_version;
  assert.equal((await application.invoke("skill_hub.list", { meshrixContext: context })).statusCode, 200);
  const initialStats = await application.invoke("skill_hub.stats", { meshrixContext: context });
  assert.equal(initialStats.body.auditEventCount, 1);
  assert.equal(observer.prepare("PRAGMA data_version").get().data_version, versionBeforeReads);

  const noOpPublish = await application.invoke("skill_hub.publish", {
    skillId: "download-cost-skill",
    meshrixContext: context
  });
  assert.equal(noOpPublish.statusCode, 200);
  assert.equal(noOpPublish.body.lifecycleDecision.result, "ignored_idempotent_event");
  assert.equal(observer.prepare("PRAGMA data_version").get().data_version, versionBeforeReads);

  const downloaded = await application.invoke("skill_hub.download", {
    skillId: "download-cost-skill",
    workspaceId: "download-cost-workspace",
    meshrixContext: context
  });
  assert.equal(downloaded.statusCode, 200);
  assert.equal(downloaded.body.download.packageRef.integrityVerified, true);
  assert.equal(downloaded.body.downloadEvent.metrics.downloadCount, 1);
  assert.equal(downloaded.body.downloadEvent.audit.eventType, "contribution.downloaded");
  assert.equal(Object.hasOwn(downloaded.body.downloadEvent, "contribution"), false);
  assert.equal(observer.prepare("PRAGMA data_version").get().data_version, versionBeforeReads + 1,
    "one download records one durable SQLite transaction");
  const finalStats = await application.invoke("skill_hub.stats", { meshrixContext: context });
  assert.equal(finalStats.body.downloadCount, 1);
  assert.equal(finalStats.body.auditEventCount, 2);
});

test("failed registry transaction restores the affected contribution and audit history", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-registry-rollback-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const data = createServiceData(dataRoot);
  const context = meshrixContext();
  const first = await createSkillHubApplication({ serviceData: data });
  const submitted = await first.invoke("skill_hub.submit", {
    contributionId: "rollback-cost-skill",
    workspaceId: "rollback-cost-workspace",
    title: "Rollback cost skill",
    license: "Apache-2.0",
    declaredPermissions: ["read"],
    skillManifestRef: "rollback-cost/SKILL.md",
    payloadRefs: ["rollback-cost/SKILL.md"],
    packageBundleBase64: Buffer.from("rollback-cost-package").toString("base64"),
    meshrixContext: context
  });
  assert.equal(submitted.statusCode, 201);
  await first.close();

  const databasePath = path.join(dataRoot, ...registryDatabaseResource(
    registryResource("default", context.principal.tenantRef)
  ).split("/"));
  const inspector = new DatabaseSync(databasePath);
  const contributionBeforeFailure = JSON.parse(inspector.prepare(
    "SELECT body FROM contributions WHERE contribution_id = ?"
  ).get("rollback-cost-skill").body);
  const auditBeforeFailure = [...inspector.prepare("SELECT body FROM audit_events ORDER BY sequence").iterate()]
    .map((row) => JSON.parse(row.body));
  inspector.exec(`
    CREATE TRIGGER reject_registry_audit
    BEFORE INSERT ON audit_events
    BEGIN
      SELECT RAISE(ABORT, 'injected transaction failure');
    END;
  `);
  const failedApplication = await createSkillHubApplication({ serviceData: data });
  const versionBeforeFailure = inspector.prepare("PRAGMA data_version").get().data_version;
  const failed = await failedApplication.invoke("skill_hub.rollback.record", {
    skillId: "rollback-cost-skill",
    meshrixContext: context
  });
  assert.equal(failed.statusCode, 400);
  assert.equal(inspector.prepare("PRAGMA data_version").get().data_version, versionBeforeFailure,
    "aborted SQLite transaction is not visible as a commit");
  assert.deepEqual(JSON.parse(inspector.prepare(
    "SELECT body FROM contributions WHERE contribution_id = ?"
  ).get("rollback-cost-skill").body), contributionBeforeFailure);
  assert.deepEqual([...inspector.prepare("SELECT body FROM audit_events ORDER BY sequence").iterate()]
    .map((row) => JSON.parse(row.body)), auditBeforeFailure);
  const afterFailure = await failedApplication.invoke("skill_hub.stats", { meshrixContext: context });
  assert.equal(afterFailure.body.rollbackCount, 0);
  assert.equal(afterFailure.body.auditEventCount, 1);
  await failedApplication.close();

  inspector.exec("DROP TRIGGER reject_registry_audit;");
  const versionBeforeRetry = inspector.prepare("PRAGMA data_version").get().data_version;
  const retryApplication = await createSkillHubApplication({ serviceData: data });
  const retried = await retryApplication.invoke("skill_hub.rollback.record", {
    skillId: "rollback-cost-skill",
    meshrixContext: context
  });
  assert.equal(retried.statusCode, 201);
  assert.equal(inspector.prepare("PRAGMA data_version").get().data_version, versionBeforeRetry + 1);
  const afterRetry = await retryApplication.invoke("skill_hub.stats", { meshrixContext: context });
  assert.equal(afterRetry.body.rollbackCount, 1);
  assert.equal(afterRetry.body.auditEventCount, 2);
  await retryApplication.close();
  inspector.close();
});

test("failed duplicate submission preserves shared packages and prototype-named records across tenant recovery", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-shared-package-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const data = createServiceData(dataRoot);
  const bytes = Buffer.from("shared-package-fixture");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const input = {
    contributionId: "__proto__", workspaceId: "package-workspace", title: "Shared package",
    license: "Apache-2.0", declaredPermissions: ["read"], skillManifestRef: "shared/SKILL.md",
    payloadRefs: ["shared/SKILL.md"], packageBundleBase64: bytes.toString("base64")
  };
  const contexts = [meshrixContext(), meshrixContext("c", "d")];
  const first = await createSkillHubApplication({ serviceData: data });
  for (const context of contexts) {
    assert.equal((await first.invoke("skill_hub.submit", { ...input, meshrixContext: context })).statusCode, 201);
  }
  const duplicate = await first.invoke("skill_hub.submit", { ...input, meshrixContext: contexts[0] });
  assert.equal(duplicate.statusCode, 400);
  assert.deepEqual(await data.readFile(data.packageResource(digest), null), bytes);
  await first.close();
  const restored = await createSkillHubApplication({ serviceData: data });
  t.after(() => restored.close());
  for (const context of contexts) {
    const prepared = await restored.invoke("skill_hub.scan", {
      skillId: input.contributionId, workspaceId: input.workspaceId,
      idempotencyKey: canned2, deadlineAt: "2999-01-01T00:00:00.000Z",
      resources: { wallTimeMs: 1000, cpuMillis: 1000, memoryBytes: 1024, processes: 1,
        fileDescriptors: 8, diskBytes: 1024, inodes: 8, fileCount: 8, outputBytes: 1024,
        logBytes: 1024, networkBytes: 1024, toolCalls: 1 },
      outputs: { schema: "fixture-output-v1", maxFiles: 1, maxBytes: 1024, allowedTypes: ["application/json"] },
      capabilities: { filesystem: [], network: [], tools: [], secretRefs: [], clock: false,
        randomness: false, subprocesses: 0 },
      meshrixContext: { ...context, phase: "prepare" }
    });
    assert.equal(prepared.statusCode, 200);
    assert.equal(prepared.body.execution.packageBundleBase64, bytes.toString("base64"));
    const stats = await restored.invoke("skill_hub.stats", { meshrixContext: context });
    assert.equal(stats.body.skillCount, 1);
    assert.equal(stats.body.auditEventCount, 1, "failed submission cannot add committed audit evidence");
  }
});

test("failed lifecycle commit retains the committed manifest; later workspace adoptions survive restart", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-manifest-transaction-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const data = createServiceData(dataRoot);
  const context = meshrixContext();
  let application = await createSkillHubApplication({ serviceData: data });
  t.after(() => application.close());
  const skillId = "manifest-transaction-skill";
  assert.equal((await application.invoke("skill_hub.submit", {
    contributionId: skillId, workspaceId: "manifest-source", title: "Manifest transaction",
    license: "Apache-2.0", declaredPermissions: ["read"], skillManifestRef: "manifest/SKILL.md",
    payloadRefs: ["manifest/SKILL.md"], packageBundleBase64: Buffer.from("manifest-package").toString("base64"),
    meshrixContext: context
  })).statusCode, 201);
  await application.close();
  const databasePath = path.join(dataRoot, ...registryDatabaseResource(
    registryResource("default", context.principal.tenantRef)
  ).split("/"));
  const inspector = new DatabaseSync(databasePath);
  t.after(() => inspector.close());
  const readContribution = () => JSON.parse(inspector.prepare(
    "SELECT body FROM contributions WHERE contribution_id = ?"
  ).get(skillId).body);
  const reviewed = readContribution();
  reviewed.status = "reviewed";
  inspector.prepare("UPDATE contributions SET body = ? WHERE contribution_id = ?")
    .run(JSON.stringify(reviewed), skillId);
  application = await createSkillHubApplication({ serviceData: data });
  assert.equal((await application.invoke("skill_hub.publish", { skillId, meshrixContext: context })).statusCode, 200);
  const published = readContribution();
  const publishedBytes = await data.readFile(published.currentAssetRef.assetPath);
  assert.match(published.currentAssetRef.assetPath, /asset\.[a-f0-9]{32}\.json$/u);
  inspector.exec(`CREATE TRIGGER reject_lifecycle_audit BEFORE INSERT ON audit_events
    BEGIN SELECT RAISE(ABORT, 'injected lifecycle commit failure'); END;`);
  const rejected = await application.invoke("skill_hub.revoke", { skillId, meshrixContext: context });
  assert.equal(rejected.statusCode, 400);
  assert.deepEqual(readContribution(), published);
  assert.equal(await data.readFile(published.currentAssetRef.assetPath), publishedBytes);
  await application.close();
  inspector.exec("DROP TRIGGER reject_lifecycle_audit;");
  application = await createSkillHubApplication({ serviceData: data });
  const downloaded = await application.invoke("skill_hub.download", {
    skillId, workspaceId: "manifest-source", meshrixContext: context
  });
  assert.equal(downloaded.statusCode, 200);
  assert.equal(downloaded.body.download.packageRef.integrityVerified, true);
  for (const targetWorkspaceId of ["adoption-one", "adoption-two"]) {
    const adopted = await application.invoke("skill_hub.install", { skillId, targetWorkspaceId, meshrixContext: context });
    assert.equal(adopted.statusCode, 200, adopted.body?.error?.code || "");
    assert.equal(adopted.body.adoption.targetWorkspaceId, targetWorkspaceId);
  }
  await application.close();
  application = await createSkillHubApplication({ serviceData: data });
  const restored = await application.invoke("skill_hub.get", { skillId, meshrixContext: context });
  assert.equal(restored.statusCode, 200);
  assert.deepEqual(readContribution().adoptions.map((item) => item.targetWorkspaceId), ["adoption-one", "adoption-two"]);
  const stats = await application.invoke("skill_hub.stats", { meshrixContext: context });
  assert.equal(stats.body.uniqueWorkspaceAdoptions, 2);
  assert.equal(await data.readFile(published.currentAssetRef.assetPath), publishedBytes,
    "successful later revisions also retain the previously committed manifest");
});

test("event journal reports a failed write without exposing it or poisoning later publication", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-event-recovery-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const data = createServiceData(dataRoot);
  await data.initialize();
  let failNext = true;
  const injectedFailure = new Error("synthetic event storage failure");
  const journal = await createSkillHubEventJournal({ serviceData: {
    ...data,
    async writeFile(...args) {
      if (failNext) { failNext = false; throw injectedFailure; }
      return data.writeFile(...args);
    }
  } });
  const frames = [];
  journal.subscribe({ request: {}, response: { write(frame) { frames.push(frame); return true; }, end() {} } });
  await assert.rejects(journal.publish("skill_hub.submit"), (error) => error === injectedFailure);
  assert.deepEqual(frames, []);
  await assert.rejects(data.readFile("SkillHub/events.json"), { code: "SERVICE_DATA_NOT_FOUND" });
  journal.subscribe({ request: {}, response: { write(frame) { frames.push(frame); return true; }, end() {} } });
  const committed = await journal.publish("skill_hub.publish");
  assert.equal(committed.eventId, 1);
  assert.equal(frames.length, 1);
  assert.match(frames[0], /skill_hub\.publish/u);
  assert.doesNotMatch(frames[0], /skill_hub\.submit/u);
  await journal.close();
  const restored = await createSkillHubEventJournal({ serviceData: data });
  t.after(() => restored.close());
  const replayed = [];
  restored.subscribe({ request: {}, response: { write(frame) { replayed.push(frame); return true; }, end() {} } });
  assert.deepEqual(replayed, frames);
  assert.equal((await restored.publish("skill_hub.install")).eventId, 2);
});

test("HTTP preserves committed success when catalog publication fails and resumes notifications without replay", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-http-event-failure-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const warnings = [];
  t.mock.method(console, "warn", (category) => warnings.push(category));
  const service = await start(dataRoot);
  t.after(() => service.close());
  const subscription = await fetch(`${service.baseUrl}/v1/events`, {
    headers: { authorization: ("Bearer "+authToken) }
  });
  const reader = subscription.body.getReader();
  const blockedJournal = path.join(dataRoot, "SkillHub", "events.json");
  await mkdir(blockedJournal, { recursive: true });
  const context = meshrixContext();
  const skillId = "committed-before-hint";
  const committed = await service.invoke("skill_hub.submit", {
    contributionId: skillId, workspaceId: "commit-workspace", title: "Committed before hint",
    license: "Apache-2.0", declaredPermissions: ["read"], skillManifestRef: "committed/SKILL.md",
    payloadRefs: ["committed/SKILL.md"], packageBundleBase64: Buffer.from("committed-package").toString("base64"),
    meshrixContext: context
  });
  assert.equal(committed.statusCode, 201, "durable success gives the caller no reason to retry the mutation");
  assert.deepEqual(warnings, ["skill_hub_event_publish_failed"]);
  assert.equal((await reader.read()).done, true, "failed hints force subscribers to reconnect and refresh");
  const afterCommit = await service.invoke("skill_hub.stats", { meshrixContext: context });
  assert.equal(afterCommit.body.skillCount, 1);
  assert.equal(afterCommit.body.auditEventCount, 1);
  await rm(blockedJournal, { recursive: true });
  const resumed = await fetch(`${service.baseUrl}/v1/events`, {
    headers: { authorization: ("Bearer "+authToken) }
  });
  const resumedReader = resumed.body.getReader();
  const next = await service.invoke("skill_hub.rollback.record", { skillId, meshrixContext: context });
  assert.equal(next.statusCode, 201);
  const frame = await resumedReader.read();
  assert.equal(frame.done, false);
  assert.match(Buffer.from(frame.value).toString(), /skill_hub\.rollback\.record/u);
  await resumedReader.cancel();
  const afterRecovery = await service.invoke("skill_hub.stats", { meshrixContext: context });
  assert.equal(afterRecovery.body.auditEventCount, 2);
  assert.equal(afterRecovery.body.rollbackCount, 1);
});

test("service storage cleans failed replacement and uses durable rollback-journal commits", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-file-durability-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const data = createServiceData(dataRoot);
  await data.initialize();
  await mkdir(path.join(dataRoot, "occupied"));
  await assert.rejects(data.writeFile("occupied", "synthetic replacement"));
  assert.deepEqual(await readdir(dataRoot), ["occupied"], "failed rename removes only its temporary file");
  await data.writeFile("state/record.json", "retained record");
  const database = await data.openDatabase("state/registry.sqlite");
  assert.equal(database.prepare("PRAGMA synchronous").get().synchronous, 3);
  assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
  database.close();
  const reopened = createServiceData(dataRoot);
  assert.equal(await reopened.readFile("state/record.json"), "retained record");
});

test("independent Skill Hub service rejects oversized request bodies before domain materialization", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-service-boundary-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const service = await start(dataRoot);
  t.after(() => service.close());
  const unauthenticated = await fetch(`${service.baseUrl}/v1/operations/skill_hub.list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { ok: false, error: { code: "authentication_required" } });
  const missingContext = await fetch(`${service.baseUrl}/v1/operations/skill_hub.list`, {
    method: "POST", headers: { authorization: ("Bearer "+authToken),
      "x-meshrix-skill-hub-subject": meshrixContext().principal.subjectRef }, body: "{}"
  });
  assert.equal(missingContext.status, 400);
  assert.equal((await missingContext.json()).error.code, "skill_hub_host_context_invalid");
  const response = await fetch(`${service.baseUrl}/v1/operations/skill_hub.submit`, {
    method: "POST",
    headers: { "authorization": ("Bearer "+authToken), "content-type": "application/json",
      "x-meshrix-skill-hub-subject": meshrixContext().principal.subjectRef },
    body: JSON.stringify({ oversized: "x".repeat(2 * 1024 * 1024 + 1) })
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { ok: false, error: { code: "request_too_large" } });
});

test("independent Skill Hub service rejects duplicate authorization headers", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-service-auth-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const service = await start(dataRoot);
  t.after(() => service.close());
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(`${service.baseUrl}/v1/operations/skill_hub.list`, {
      method: "POST",
      headers: {
        authorization: [`Bearer ${authToken}`, `Bearer ${authToken}`],
        "content-type": "application/json"
      }
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end("{}");
  });
  assert.equal(status, 401);
});

test("Skill Hub requires the trusted subject carrier to match the body principal", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-subject-carrier-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const service = await start(dataRoot);
  t.after(() => service.close());
  const before = (await readdir(dataRoot, { recursive: true })).sort();
  const response = await fetch(`${service.baseUrl}/v1/operations/skill_hub.submit`, {
    method: "POST", headers: { authorization: ("Bearer "+authToken),
      "x-meshrix-skill-hub-subject": meshrixContext().principal.subjectRef },
    body: JSON.stringify({ meshrixContext: meshrixContext("c", "d"),
      workspaceId: "mismatched-workspace", contributionId: "mismatched-skill",
      packageBundleBase64: Buffer.from("must-not-be-stored").toString("base64") })
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "skill_hub_host_context_invalid");
  assert.deepEqual((await readdir(dataRoot, { recursive: true })).sort(), before,
    "mismatched carrier must not create registry or package state");
});

test("independent Skill Hub service rejects implicit workspace writes before storage", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-service-workspace-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const service = await start(dataRoot);
  t.after(() => service.close());
  const before = (await readdir(dataRoot, { recursive: true })).sort();
  const executeContext = meshrixContext("e", "f");
  const prepareContext = meshrixContext("e", "f", "prepare");
  const invalidRequests = [
    ["skill_hub.submit", {
      contributionId: "missing-workspace-skill",
      title: "Missing workspace skill",
      license: "Apache-2.0",
      declaredPermissions: ["read"],
      skillManifestRef: "missing-workspace-skill/SKILL.md",
      packageBundleBase64: Buffer.from("must-not-be-stored").toString("base64"),
      meshrixContext: executeContext
    }],
    ["skill_hub.scan", { skillId: "missing-workspace-skill", meshrixContext: prepareContext }],
    ["skill_hub.build", { skillId: "missing-workspace-skill", meshrixContext: prepareContext }],
    ["skill_hub.execute", { skillId: "missing-workspace-skill", meshrixContext: prepareContext }],
    ["skill_hub.download", { skillId: "missing-workspace-skill", meshrixContext: executeContext }],
    ["skill_hub.install", { skillId: "missing-workspace-skill", meshrixContext: executeContext }],
    ["skill_hub.usage.record", { skillId: "missing-workspace-skill", meshrixContext: executeContext }],
    ["skill_hub.permission.request", { skillId: "missing-workspace-skill", meshrixContext: executeContext }],
    ["skill_hub.permission.grant", { skillId: "missing-workspace-skill", meshrixContext: prepareContext }]
  ];
  for (const [operationId, input] of invalidRequests) {
    const denied = await service.invoke(operationId, input);
    assert.equal(denied.statusCode, 400);
    assert.equal(denied.body.error.code, "skill_hub_workspace_binding_invalid");
  }
  assert.deepEqual((await readdir(dataRoot, { recursive: true })).sort(), before);

  for (const operationId of ["skill_hub.search", "skill_hub.list", "skill_hub.stats", "skill_hub.leaderboard"]) {
    const globalRead = await service.invoke(operationId, { meshrixContext: executeContext });
    assert.equal(globalRead.statusCode, 200);
  }
  const detail = await service.invoke("skill_hub.get", {
    skillId: "missing-workspace-skill",
    meshrixContext: executeContext
  });
  assert.equal(detail.body.error.code, "contribution_not_found");
});

test("Skill Hub publishes a resumable redacted revision event after a successful mutation", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-service-events-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const service = await start(dataRoot);
  t.after(() => service.close());
  const submitted = await service.invoke("skill_hub.submit", {
    contributionId: "event-skill",
    workspaceId: "private-workspace-must-not-be-published",
    title: "Event skill",
    license: "Apache-2.0",
    declaredPermissions: ["read"],
    skillManifestRef: "event-skill/SKILL.md",
    payloadRefs: ["event-skill/SKILL.md"],
    packageBundleBase64: Buffer.from("event-package").toString("base64"),
    meshrixContext: meshrixContext("c", "d")
  });
  assert.equal(submitted.statusCode, 201);

  const controller = new AbortController();
  t.after(() => controller.abort());
  const recorded = await service.invoke("skill_hub.rollback.record", {
    skillId: "event-skill", meshrixContext: meshrixContext("c", "d")
  });
  assert.equal(recorded.statusCode, 201);
  const response = await fetch(`${service.baseUrl}/v1/events?cursor=1`, {
    signal: controller.signal,
    headers: { authorization: ("Bearer "+authToken) }
  });
  assert.equal(response.status, 200);
  const { value } = await response.body.getReader().read();
  const frame = new TextDecoder().decode(value);
  assert.match(frame, /event: skill-hub\.catalog\.changed/u);
  assert.match(frame, /"eventId":2/u);
  assert.doesNotMatch(frame, /"eventId":1/u);
  assert.match(frame, /"operationId":"skill_hub\.rollback\.record"/u);
  assert.doesNotMatch(frame, /private-workspace|event-test-contributor|event-test-tenant/u);
});

test("Skill Hub rejects invalid operations and partitions before registry initialization", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-service-reject-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const service = await start(dataRoot);
  t.after(() => service.close());
  const context = meshrixContext();
  const before = (await readdir(dataRoot, { recursive: true })).sort();
  const unknown = await service.invoke("skill_hub.nonexistent", { meshrixContext: context });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.error.code, "skill_hub_operation_not_found");
  for (const partition of ["../escape", "nested/partition", "back\\slash", "badcontrol", "x".repeat(300)]) {
    const denied = await service.invoke("skill_hub.list", {
      registryWorkspaceId: partition,
      meshrixContext: context
    });
    assert.equal(denied.statusCode, 400, `partition ${JSON.stringify(partition)} must be rejected`);
    assert.equal(denied.body.error.code, "skill_hub_workspace_binding_invalid");
  }
  assert.deepEqual(
    (await readdir(dataRoot, { recursive: true })).sort(),
    before,
    "rejected work must create zero registry sessions and zero persistent files"
  );
});

test("Skill Hub binds registry partitions to the authenticated tenant", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-service-tenant-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const service = await start(dataRoot);
  t.after(() => service.close());
  const submitted = await service.invoke("skill_hub.submit", {
    contributionId: "tenant-bound-skill",
    workspaceId: "ws-bound",
    title: "Tenant bound skill",
    license: "Apache-2.0",
    declaredPermissions: ["read"],
    skillManifestRef: "tenant-bound-skill/SKILL.md",
    payloadRefs: ["tenant-bound-skill/SKILL.md"],
    packageBundleBase64: Buffer.from("tenant-bound-package").toString("base64"),
    registryWorkspaceId: "shared-partition-name",
    meshrixContext: meshrixContext("a", "b")
  });
  assert.equal(submitted.statusCode, 201);
  const sameTenant = await service.invoke("skill_hub.stats", {
    registryWorkspaceId: "shared-partition-name",
    meshrixContext: meshrixContext("9", "b")
  });
  assert.equal(sameTenant.statusCode, 200);
  assert.equal(sameTenant.body.skillCount, 1, "a different subject in the same tenant shares the partition");
  const otherTenant = await service.invoke("skill_hub.stats", {
    registryWorkspaceId: "shared-partition-name",
    meshrixContext: meshrixContext("a", "c")
  });
  assert.equal(otherTenant.statusCode, 200);
  assert.equal(otherTenant.body.skillCount, 0, "another tenant must not reach this partition's registry");
});

test("Skill Hub registry session cache stays bounded while evicted partitions drain normally", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-service-cache-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const serviceData = createServiceData(dataRoot);
  const application = await createSkillHubApplication({ serviceData });
  t.after(() => application.close());
  const context = meshrixContext();
  for (let index = 0; index < 80; index += 1) {
    const submitted = await application.invoke("skill_hub.submit", {
      contributionId: `bounded-skill-${index}`,
      workspaceId: "ws-bounded",
      title: `Bounded skill ${index}`,
      license: "Apache-2.0",
      declaredPermissions: ["read"],
      skillManifestRef: `bounded-skill-${index}/SKILL.md`,
      payloadRefs: [`bounded-skill-${index}/SKILL.md`],
      packageBundleBase64: Buffer.from(`bounded-package-${index}`).toString("base64"),
      registryWorkspaceId: `bounded-partition-${index}`,
      meshrixContext: context
    });
    assert.equal(submitted.statusCode, 201, `partition ${index} must still be served while idle sessions evict`);
    assert.ok(application.sessionCount() <= 64, "live registry sessions stay bounded");
  }
  const reloaded = await application.invoke("skill_hub.stats", {
    registryWorkspaceId: "bounded-partition-0",
    meshrixContext: context
  });
  assert.equal(reloaded.statusCode, 200);
  assert.equal(reloaded.body.skillCount, 1, "an evicted partition reloads its persisted registry on demand");
});

test("state mutation queue shares pending capacity with active partitions and bounded bytes", async () => {
  let partitions = 0;
  const queue = createStateMutationQueue({
    maxPending: 4,
    maxPendingBytes: 1024,
    partitionCount: () => partitions
  });
  partitions = 3;
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const held = queue.run("held", () => blocker);
  assert.throws(() => queue.run("extra", () => {}), /capacity is exhausted/u);
  release();
  await held;
  partitions = 0;
  let releaseBytes;
  const byteBlocker = new Promise((resolve) => { releaseBytes = resolve; });
  const charged = queue.run("charged", () => byteBlocker, { bytes: 700 });
  assert.throws(() => queue.run("overflow", () => {}, { bytes: 400 }), /capacity is exhausted/u);
  releaseBytes();
  await charged;
  assert.equal(await queue.run("done", () => "ok"), "ok");
  await queue.close();
});

test("HTTP reserves aggregate and subject capacity before reading and drains admitted bodies on close", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-body-admission-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const handler = await createSkillHubHttpHandler({ dataRoot, authToken,
    admissionOptions: { maxPending: 2, maxPendingBytes: 4096, maxSubjectPending: 1, maxSubjectBytes: 2048 } });
  function request(context, wait = null) {
    const body = Buffer.from(JSON.stringify({ meshrixContext: context }));
    let readCount = 0;
    return {
      method: "POST", url: "/v1/operations/skill_hub.list",
      headers: { "content-length": String(body.length), "x-meshrix-skill-hub-subject": context.principal.subjectRef },
      headersDistinct: { authorization: [`Bearer ${authToken}`],
        "x-meshrix-skill-hub-subject": [context.principal.subjectRef] },
      reads: () => readCount,
      async *[Symbol.asyncIterator]() {
        readCount += 1;
        if (wait) await wait;
        yield body;
      }
    };
  }
  function response() {
    return { status: 0, body: null, writeHead(status) { this.status = status; },
      end(bytes) { this.body = JSON.parse(bytes.toString()); } };
  }
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const heldRequest = request(meshrixContext(), blocked);
  const heldResponse = response();
  const held = handler(heldRequest, heldResponse);
  const deniedRequest = request(meshrixContext());
  const denied = response();
  await handler(deniedRequest, denied);
  assert.equal(denied.status, 503);
  assert.equal(deniedRequest.reads(), 0, "saturated subject cannot cause body reads");
  const independent = response();
  await handler(request(meshrixContext("c", "d")), independent);
  assert.equal(independent.body.statusCode, 200, "another subject on the same transport retains capacity");
  const secondHeld = handler(request(meshrixContext("c", "d"), blocked), response());
  const globallyDeniedRequest = request(meshrixContext("e", "f"));
  const globallyDenied = response();
  await handler(globallyDeniedRequest, globallyDenied);
  assert.equal(globallyDenied.status, 503);
  assert.equal(globallyDeniedRequest.reads(), 0, "aggregate count rejects before reading another subject");
  let closed = false;
  const closing = handler.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await held;
  await secondHeld;
  await closing;
  assert.equal(heldResponse.body.statusCode, 200, "admitted viable body finishes before application close");

  const bytesHandler = await createSkillHubHttpHandler({ dataRoot, authToken,
    admissionOptions: { maxPending: 4,
      maxPendingBytes: Buffer.byteLength(JSON.stringify({ meshrixContext: meshrixContext() })),
      maxSubjectPending: 2, maxSubjectBytes: 2048 } });
  let releaseBytes;
  const byteWait = new Promise((resolve) => { releaseBytes = resolve; });
  const byteHeld = bytesHandler(request(meshrixContext(), byteWait), response());
  const byteDeniedRequest = request(meshrixContext("c", "d"));
  const byteDenied = response();
  await bytesHandler(byteDeniedRequest, byteDenied);
  assert.equal(byteDenied.status, 503);
  assert.equal(byteDeniedRequest.reads(), 0, "aggregate bytes rejects before consuming another body");
  releaseBytes();
  await byteHeld;
  const recovered = response();
  await bytesHandler(request(meshrixContext("c", "d")), recovered);
  assert.equal(recovered.body.statusCode, 200, "completion releases aggregate bytes for normal use");
  await bytesHandler.close();
});

test("historical registry requires trusted ownership and relocates without loss or tenant disclosure", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-owned-relocation-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const serviceData = createServiceData(dataRoot);
  const context = meshrixContext();
  const workspaceId = "historical-catalog";
  const tenantRef = context.principal.tenantRef;
  const current = registryResource(workspaceId, tenantRef);
  const historical = unownedRegistryResource(workspaceId);
  const historicalContribution = normalizeSkillHubContribution({
    contributionId: "historical-skill",
    workspaceId: "historical-workspace",
    title: "Historical skill",
    license: "Apache-2.0",
    declaredPermissions: ["read"],
    skillManifestRef: "historical/SKILL.md",
    payloadRefs: ["historical/SKILL.md"]
  });
  historicalContribution.status = "published";
  historicalContribution.statusHistory.push({ state: "published", event: "contribution.publish",
    at: "2025-01-02T00:00:00.000Z", actorId: "historical-reviewer", reason: "retained history" });
  historicalContribution.downloadEvents.push({ downloadEventId: "historical-download", contributionId: "historical-skill",
    actorId: "historical-downloader", workspaceId: "historical-workspace", createdAt: "2025-01-02T01:00:00.000Z" });
  historicalContribution.permissionRequests.push({ permissionRequestId: "historical-request", contributionId: "historical-skill",
    requesterId: "historical-requester", targetWorkspaceId: "historical-target", actions: ["read"],
    purpose: "historical purpose", status: "granted", createdAt: "2025-01-02T02:00:00.000Z",
    grantedAt: "2025-01-02T03:00:00.000Z" });
  historicalContribution.grants.push({ contributionGrantId: "historical-grant", contributionId: "historical-skill",
    granteeId: "historical-grantee", targetWorkspaceId: "historical-target", actions: ["read"],
    expiresAt: "", revocationPolicy: "revoke-on-policy-change", createdAt: "2025-01-02T03:00:00.000Z" });
  historicalContribution.auditIds.push("historical-audit-1", "historical-audit-2");
  const historicalAuditEvents = [
    { auditId: "historical-audit-1", eventType: "contribution.imported", workspaceId: "historical-workspace",
      payload: { contributionId: "historical-skill", retained: true }, createdAt: "2025-01-01T00:00:00.000Z" },
    { auditId: "historical-audit-2", eventType: "contribution.permission.granted", workspaceId: "historical-workspace",
      payload: { contributionId: "historical-skill", grantId: "historical-grant" }, createdAt: "2025-01-02T03:00:00.000Z" }
  ];
  await serviceData.writeFile(historical, JSON.stringify({
    schemaVersion: "v0.0.1:schema:definition-1",
    updatedAt: "2025-01-01T00:00:00.000Z",
    contributions: { "historical-skill": historicalContribution },
    auditEvents: historicalAuditEvents
  }, null, 2) + "\n");
  const original = await serviceData.readFile(historical, null);
  const unassigned = await createSkillHubApplication({ serviceData });
  for (const principal of [context, meshrixContext("c", "d")]) {
    const denied = await unassigned.invoke("skill_hub.stats", { registryWorkspaceId: workspaceId, meshrixContext: principal });
    assert.equal(denied.statusCode, 409);
    assert.equal(denied.body.error.code, "skill_hub_registry_ownership_required");
  }
  assert.deepEqual(await serviceData.readFile(historical, null), original);
  const unaffected = await unassigned.invoke("skill_hub.stats", {
    registryWorkspaceId: "unrelated-new-catalog", meshrixContext: meshrixContext("c", "d")
  });
  assert.equal(unaffected.statusCode, 200, "unknown historical ownership blocks only its catalog");
  await unassigned.close();
  const registryOwnership = [{ workspaceId, tenantRef }];
  const migrated = await createSkillHubApplication({ serviceData, registryOwnership });
  assert.deepEqual(await serviceData.readFile(current, null), original,
    "ownership relocation preserves all historical state byte for byte before import");
  await assert.rejects(serviceData.readFile(historical), { code: "SERVICE_DATA_NOT_FOUND" });
  const migratedStats = await migrated.invoke("skill_hub.stats", { registryWorkspaceId: workspaceId, meshrixContext: context });
  assert.equal(migratedStats.body.skillCount, 1);
  assert.equal(migratedStats.body.auditEventCount, historicalAuditEvents.length);
  assert.deepEqual(migratedStats.body.eventBreakdown, [
    { eventType: "contribution.imported", count: 1 },
    { eventType: "contribution.permission.granted", count: 1 }
  ]);
  await assert.rejects(serviceData.readFile(current), { code: "SERVICE_DATA_NOT_FOUND" });
  const archive = legacyRegistryArchiveResource(current);
  assert.deepEqual(await serviceData.readFile(archive, null), original,
    "the completed import preserves the original JSON bytes at an inactive archive path");
  const databasePath = path.join(dataRoot, ...registryDatabaseResource(current).split("/"));
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.deepEqual(JSON.parse(database.prepare(
      "SELECT body FROM contributions WHERE contribution_id = ?"
    ).get("historical-skill").body), historicalContribution);
    assert.deepEqual([...database.prepare("SELECT body FROM audit_events ORDER BY sequence").iterate()]
      .map((row) => JSON.parse(row.body)), historicalAuditEvents);
  } finally {
    database.close();
  }
  assert.equal((await migrated.invoke("skill_hub.stats", { registryWorkspaceId: workspaceId, meshrixContext: meshrixContext("c", "d") })).body.skillCount, 0);
  const addedAfterImport = await migrated.invoke("skill_hub.submit", {
    contributionId: "post-import-skill",
    workspaceId: "post-import-workspace",
    title: "Post import skill",
    license: "Apache-2.0",
    declaredPermissions: ["read"],
    skillManifestRef: "post-import/SKILL.md",
    payloadRefs: ["post-import/SKILL.md"],
    packageBundleBase64: Buffer.from("post-import-package").toString("base64"),
    registryWorkspaceId: workspaceId,
    meshrixContext: context
  });
  assert.equal(addedAfterImport.statusCode, 201);
  await migrated.close();

  // Recreate the pre-archive crash state while the database is newer than its
  // JSON source. Startup must honor the committed database marker and only
  // finish archival, never import the stale snapshot again.
  assert.equal(await serviceData.relocateFile(archive, current), true);
  const restarted = await createSkillHubApplication({ serviceData, registryOwnership });
  const restartedStats = await restarted.invoke("skill_hub.stats", { registryWorkspaceId: workspaceId, meshrixContext: context });
  assert.equal(restartedStats.body.skillCount, 2);
  assert.equal(restartedStats.body.auditEventCount, historicalAuditEvents.length + 1);
  await assert.rejects(serviceData.readFile(current), { code: "SERVICE_DATA_NOT_FOUND" });
  assert.deepEqual(await serviceData.readFile(archive, null), original,
    "restart completes the archive move without changing the historical bytes");
  await restarted.close();

  assert.equal(await serviceData.deleteFile(registryDatabaseResource(current)), true);
  const missingDatabase = await createSkillHubApplication({ serviceData, registryOwnership });
  const unavailable = await missingDatabase.invoke("skill_hub.stats", {
    registryWorkspaceId: workspaceId,
    meshrixContext: context
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.error.code, "skill_hub_registry_database_missing");
  await assert.rejects(serviceData.stat(registryDatabaseResource(current)), { code: "SERVICE_DATA_NOT_FOUND" },
    "an archived JSON snapshot must not recreate a missing active database");
  assert.deepEqual(await serviceData.readFile(archive, null), original,
    "the archived user data remains available for operator recovery");
  await missingDatabase.close();
});

test("failed legacy import leaves JSON untouched and retries as one complete transaction", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-import-rollback-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const data = createServiceData(dataRoot);
  const context = meshrixContext();
  const sourcePath = registryResource("import-retry-catalog", context.principal.tenantRef);
  const contribution = normalizeSkillHubContribution({
    contributionId: "import-retry-skill",
    workspaceId: "import-retry-workspace",
    title: "Import retry skill",
    license: "Apache-2.0",
    declaredPermissions: ["read"],
    skillManifestRef: "import-retry/SKILL.md",
    payloadRefs: ["import-retry/SKILL.md"]
  });
  contribution.downloadEvents.push({ downloadEventId: "import-retry-download", contributionId: contribution.contributionId,
    actorId: "historical-actor", workspaceId: contribution.workspaceId, createdAt: "2025-02-01T00:00:00.000Z" });
  const legacyAudit = [
    { auditId: "import-retry-audit-1", eventType: "contribution.submitted", workspaceId: contribution.workspaceId,
      payload: { contributionId: contribution.contributionId }, createdAt: "2025-02-01T00:00:00.000Z" },
    { auditId: "import-retry-audit-2", eventType: "contribution.downloaded", workspaceId: contribution.workspaceId,
      payload: { contributionId: contribution.contributionId, actorId: "historical-actor" }, createdAt: "2025-02-01T01:00:00.000Z" }
  ];
  const source = {
    schemaVersion: "v0.0.1:schema:definition-1",
    updatedAt: "2025-02-01T01:00:00.000Z",
    contributions: { [contribution.contributionId]: contribution },
    auditEvents: legacyAudit
  };
  await data.writeFile(sourcePath, JSON.stringify(source, null, 2) + "\n");
  const original = await data.readFile(sourcePath, null);
  const databasePath = registryDatabaseResource(sourcePath);
  const seeded = await data.openDatabase(databasePath);
  seeded.exec(`
    CREATE TABLE audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE TRIGGER reject_legacy_audit
    BEFORE INSERT ON audit_events
    BEGIN
      SELECT RAISE(ABORT, 'injected import failure');
    END;
  `);
  seeded.close();

  const application = await createSkillHubApplication({ serviceData: data });
  const failed = await application.invoke("skill_hub.stats", {
    registryWorkspaceId: "import-retry-catalog",
    meshrixContext: context
  });
  assert.equal(failed.statusCode, 400);
  assert.deepEqual(await data.readFile(sourcePath, null), original);
  const inspection = new DatabaseSync(path.join(dataRoot, ...databasePath.split("/")));
  assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM contributions").get().count, 0,
    "the contribution inserted before the injected error is rolled back");
  assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 0);
  assert.equal(inspection.prepare("SELECT value FROM registry_metadata WHERE key = ?").get(cannedMeta), undefined,
    "the incomplete import cannot be marked as the active registry");
  inspection.exec("DROP TRIGGER reject_legacy_audit;");

  const retried = await application.invoke("skill_hub.stats", {
    registryWorkspaceId: "import-retry-catalog",
    meshrixContext: context
  });
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.body.skillCount, 1);
  assert.equal(retried.body.downloadCount, 1);
  assert.equal(retried.body.auditEventCount, legacyAudit.length);
  await assert.rejects(data.readFile(sourcePath), { code: "SERVICE_DATA_NOT_FOUND" });
  assert.deepEqual(await data.readFile(legacyRegistryArchiveResource(sourcePath), null), original,
    "only a committed import moves the unchanged JSON bytes to the inactive archive");
  assert.deepEqual(JSON.parse(inspection.prepare(
    "SELECT body FROM contributions WHERE contribution_id = ?"
  ).get(contribution.contributionId).body), contribution);
  assert.deepEqual([...inspection.prepare("SELECT body FROM audit_events ORDER BY sequence").iterate()]
    .map((row) => JSON.parse(row.body)), legacyAudit);
  inspection.close();
  await application.close();
});

test("registry relocation never overwrites conflicting user state", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-relocation-conflict-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const data = createServiceData(dataRoot);
  await data.initialize();
  const workspaceId = "conflicting-catalog";
  const tenantRef = meshrixContext().principal.tenantRef;
  const source = unownedRegistryResource(workspaceId);
  const destination = registryResource(workspaceId, tenantRef);
  await data.writeFile(source, "historical-state");
  await data.writeFile(destination, "current-state");
  const application = await createSkillHubApplication({ serviceData: data, registryOwnership: [{ workspaceId, tenantRef }] });
  const conflict = await application.invoke("skill_hub.stats", { registryWorkspaceId: workspaceId, meshrixContext: meshrixContext() });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.error.code, "skill_hub_registry_ownership_conflict");
  const unrelated = await application.invoke("skill_hub.submit", {
    contributionId: "unrelated-skill", workspaceId: "unrelated-workspace", title: "Unrelated skill",
    license: "Apache-2.0", declaredPermissions: ["read"], skillManifestRef: "unrelated/SKILL.md",
    packageBundleBase64: Buffer.from("unrelated-package").toString("base64"),
    registryWorkspaceId: "unrelated-catalog", meshrixContext: meshrixContext("c", "d")
  });
  assert.equal(unrelated.statusCode, 201, "a historical conflict cannot stop another tenant's catalog");
  assert.equal((await application.invoke("skill_hub.stats", {
    registryWorkspaceId: "unrelated-catalog", meshrixContext: meshrixContext("c", "d")
  })).body.skillCount, 1);
  assert.equal(await data.readFile(source), "historical-state");
  assert.equal(await data.readFile(destination), "current-state");
  await application.close();
});

test("unassigned historical assets do not block an already tenant-owned catalog", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-existing-owner-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const data = createServiceData(dataRoot);
  await data.initialize();
  const context = meshrixContext();
  const workspaceId = "existing-owned-catalog";
  await data.writeFile(unownedRegistryResource(workspaceId), "unassigned-historical-bytes");
  await data.writeFile(registryResource(workspaceId, context.principal.tenantRef), JSON.stringify({ contributions: {}, auditEvents: [] }));
  const application = await createSkillHubApplication({ serviceData: data });
  const result = await application.invoke("skill_hub.stats", { registryWorkspaceId: workspaceId, meshrixContext: context });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.skillCount, 0);
  assert.equal(await data.readFile(unownedRegistryResource(workspaceId)), "unassigned-historical-bytes");
  await application.close();
});

test("asset manifests preserve tenant isolation and distinct contribution identities", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-asset-isolation-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const data = createServiceData(dataRoot);
  const application = await createSkillHubApplication({ serviceData: data });
  await data.writeFile("SkillHub/skills/collision/canonical/asset.json", "independent-historical-asset");
  async function submit(context, contributionId, title) {
    const result = await application.invoke("skill_hub.submit", {
      contributionId, workspaceId: "shared-workspace", title, license: "Apache-2.0",
      declaredPermissions: ["read"], skillManifestRef: "synthetic/SKILL.md", payloadRefs: ["synthetic/SKILL.md"],
      packageBundleBase64: Buffer.from(title).toString("base64"), meshrixContext: context
    });
    assert.equal(result.statusCode, 201);
    const databasePath = path.join(dataRoot, ...registryDatabaseResource(
      registryResource("default", context.principal.tenantRef)
    ).split("/"));
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare("SELECT body FROM contributions WHERE contribution_id = ?").get(contributionId);
      return JSON.parse(row.body).currentAssetRef.assetPath;
    } finally {
      database.close();
    }
  }
  const owner = meshrixContext();
  const first = await submit(owner, "collision!", "Original tenant asset");
  const original = await data.readFile(first);
  const other = await submit(meshrixContext("c", "d"), "collision!", "Another tenant asset");
  const distinct = await submit(owner, "collision?", "Distinct contribution asset");
  assert.notEqual(first, other);
  assert.notEqual(first, distinct);
  assert.equal(await data.readFile(first), original, "another tenant or similar name cannot overwrite the asset");
  assert.equal(await data.readFile("SkillHub/skills/collision/canonical/asset.json"), "independent-historical-asset");
  await application.close();
});
