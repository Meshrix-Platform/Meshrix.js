import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSkillHubHttpHandler } from "../internal/http-service.mjs";

const authToken = "synthetic-skill-hub-service-test-token-00000000";

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
        headers: { "authorization": `Bearer ${authToken}`, "content-type": "application/json" },
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
  const missingContext = await service.invoke("skill_hub.list", {});
  assert.equal(missingContext.statusCode, 400);
  assert.equal(missingContext.body.error.code, "skill_hub_host_context_invalid");
  const response = await fetch(`${service.baseUrl}/v1/operations/skill_hub.submit`, {
    method: "POST",
    headers: { "authorization": `Bearer ${authToken}`, "content-type": "application/json" },
    body: JSON.stringify({ oversized: "x".repeat(2 * 1024 * 1024 + 1) })
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { ok: false, error: { code: "request_too_large" } });
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
  const response = await fetch(`${service.baseUrl}/v1/events?cursor=0`, {
    signal: controller.signal,
    headers: { authorization: `Bearer ${authToken}` }
  });
  assert.equal(response.status, 200);
  const { value } = await response.body.getReader().read();
  const frame = new TextDecoder().decode(value);
  assert.match(frame, /event: skill-hub\.catalog\.changed/u);
  assert.match(frame, /"eventId":1/u);
  assert.match(frame, /"operationId":"skill_hub\.submit"/u);
  assert.doesNotMatch(frame, /private-workspace|event-test-contributor|event-test-tenant/u);
});
