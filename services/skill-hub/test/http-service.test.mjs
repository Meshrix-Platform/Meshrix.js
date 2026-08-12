import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSkillHubHttpHandler } from "../internal/http-service.mjs";

const authToken = "synthetic-skill-hub-service-test-token-00000000";

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
      await new Promise((resolve) => server.close(resolve));
      await handler.close();
    }
  });
}

test("independent Skill Hub service persists its authoritative registry across restart", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-service-test-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const metadata = {
    actorId: "service-test-contributor",
    actorKind: "test",
    tenantRef: "service-test-tenant",
    authorized: true,
    current: true
  };
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
    __meshrix: metadata
  });
  assert.equal(submitted.statusCode, 201);
  await first.close();

  const second = await start(dataRoot);
  t.after(() => second.close());
  const stats = await second.invoke("skill_hub.stats", { __meshrix: metadata });
  assert.equal(stats.statusCode, 200);
  assert.equal(stats.body.skillCount, 1);
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
  const response = await fetch(`${service.baseUrl}/v1/operations/skill_hub.submit`, {
    method: "POST",
    headers: { "authorization": `Bearer ${authToken}`, "content-type": "application/json" },
    body: JSON.stringify({ oversized: "x".repeat(2 * 1024 * 1024 + 1) })
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { ok: false, error: { code: "request_too_large" } });
});
