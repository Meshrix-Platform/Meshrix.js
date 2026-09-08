import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { issueApiKey } from "../../skills/meshrix-js-api-key-issuance/scripts/issue-api-key.mjs";
import { configureOrganization } from "../../skills/meshrix-js-organization-governance/scripts/configure-organization.mjs";

const credential = "synthetic-test-credential";
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meshrix-skill-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = JSON.parse(await readFile(new URL("../../skills/meshrix-js-api-key-issuance/references/issuance-request.example.json", import.meta.url), "utf8"));
  request.workloadDisplayName = "synthetic-client";
  request.organizationNodeId = "selected-node";
  request.expiresAt = new Date(Date.now() + 3600000).toISOString();
  request.policy.capabilityIds = ["cap:synthetic:read"];
  request.policy.resources.workspaceIds = ["synthetic-workspace"];
  const requestFile = path.join(root, "request.json"), keyFile = path.join(root, "credential");
  const save = () => writeFile(requestFile, JSON.stringify(request));
  await save();
  return { request, keyFile, save, argv: ["--origin", "https://meshrix.invalid", "--username", "synthetic-actor", "--request", requestFile, "--key-file", keyFile, "--password-stdin"] };
}

function server({ configured = true, failure, unexpectedNode = false } = {}) {
  const calls = [];
  return { calls, readPassword: async () => "synthetic-password", fetchImpl: async (url, init) => {
    const route = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ route, body });
    assert.equal(init.redirect, "error");
    if (failure === route) throw new Error("synthetic-private-backend-detail");
    let payload;
    if (route.endsWith("/auth/login")) payload = { ok: true, csrfToken: "synthetic-csrf" };
    else if (route.endsWith("/organization-governance")) payload = { snapshot: { configured, revision: 7 } };
    else if (route.endsWith("/issuer-scopes")) payload = {
      eligibleNodes: [{ nodeId: "first-node" }, { nodeId: unexpectedNode ? "other-node" : "selected-node" }],
      serverAudience: "https://meshrix.invalid", catalogFingerprint: "synthetic-catalog",
    };
    else if (route.endsWith("/api-keys")) payload = { apiKey: credential, record: { policy: body.policy } };
    else if (route.endsWith("/import")) payload = { draft: { templateKey: body.templateKey, nodes: [] } };
    else if (route.endsWith("/preview")) payload = { ok: true };
    else if (route.endsWith("/publish")) payload = { ok: true, snapshot: { configured: true } };
    else throw new Error("unexpected mock request");
    return { ok: true, headers: new Headers({ "set-cookie": "synthetic-session=1; HttpOnly" }), json: async () => payload };
  } };
}

test("invalid arguments, risk, and resource mode cause no requests", async (t) => {
  const f = await fixture(t), remote = server();
  await assert.rejects(issueApiKey([...f.argv, "--unexpected"], remote), /invalid-arguments/);
  await assert.rejects(issueApiKey(f.argv.slice(0, -1), remote), /missing-arguments/);
  f.request.policy.maximumRisk = "misspelled";
  await f.save();
  await assert.rejects(issueApiKey(f.argv, remote), /invalid-issuance-request/);
  f.request.policy.maximumRisk = "low";
  delete f.request.policy.resources.mode;
  await f.save();
  await assert.rejects(issueApiKey(f.argv, remote), /invalid-issuance-request/);
  assert.deepEqual(remote.calls, []);
  await assert.rejects(access(f.keyFile));
});

test("selected node and policy are preserved; plaintext goes only to the private destination", async (t) => {
  const f = await fixture(t), remote = server();
  const result = await issueApiKey(f.argv, remote);
  assert.deepEqual(result, { ok: true, keyDelivered: true });
  assert.equal(await readFile(f.keyFile, "utf8"), credential + "\n");
  if (process.platform !== "win32") assert.equal((await stat(f.keyFile)).mode & 0o777, 0o600);
  const sent = remote.calls.find((call) => call.route.endsWith("/api-keys")).body;
  assert.equal(sent.organizationNodeId, "selected-node");
  assert.deepEqual(sent.policy, { ...f.request.policy,
    audience: { ...f.request.policy.audience, serverAudience: "https://meshrix.invalid" },
    catalogFingerprint: "synthetic-catalog",
  });
  assert.deepEqual(sent.policy.audience.targetIds, []);
  assert.equal(JSON.stringify(result).includes(credential), false);
});

test("existing credential destinations are preserved before any authentication", async (t) => {
  const f = await fixture(t), remote = server();
  await writeFile(f.keyFile, "existing-owner-content");
  await assert.rejects(issueApiKey(f.argv, remote), /key-destination-unavailable/);
  assert.equal(await readFile(f.keyFile, "utf8"), "existing-owner-content");
  assert.deepEqual(remote.calls, []);
});

test("the actual CLI consumes private standard input and emits only delivery status", async (t) => {
  const f = await fixture(t), preload = path.join(path.dirname(f.keyFile), "mock-http.mjs");
  await writeFile(preload, `import assert from "node:assert/strict";
globalThis.fetch = async (url, init) => {
  const route = new URL(url).pathname;
  const replies = {
    "/api/auth/login": { ok: true, csrfToken: "synthetic-csrf" },
    "/api/authorization/organization-governance": { snapshot: { configured: true } },
    "/api/operation-permission/v1/api-keys/issuer-scopes": { eligibleNodes: [{ nodeId: "selected-node" }], serverAudience: "https://meshrix.invalid", catalogFingerprint: "synthetic-catalog" },
    "/api/operation-permission/v1/api-keys": { apiKey: "synthetic-test-credential" }
  };
  assert.ok(Object.hasOwn(replies, route));
  if (route.endsWith("/auth/login")) assert.equal(JSON.parse(init.body).password, "synthetic-密码");
  return new Response(JSON.stringify(replies[route]), { headers: { "set-cookie": "synthetic-session=1; HttpOnly" } });
};\n`);
  const script = fileURLToPath(new URL("../../skills/meshrix-js-api-key-issuance/scripts/issue-api-key.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", preload, script, ...f.argv], { input: "synthetic-密码\n", encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, keyDelivered: true });
  assert.equal(result.stderr, "");
  assert.equal(await readFile(f.keyFile, "utf8"), credential + "\n");
});

test("unconfigured governance and an ineligible selected node never trigger alternate mutations", async (t) => {
  const f = await fixture(t);
  for (const options of [{ configured: false }, { unexpectedNode: true }]) {
    const remote = server(options);
    await assert.rejects(issueApiKey(f.argv, remote), /organization-unconfigured|requested-node-not-eligible/);
    assert.equal(remote.calls.some((call) => call.route.endsWith("/api-keys") || call.route.endsWith("/publish")), false);
    await assert.rejects(access(f.keyFile));
  }
});

test("uncertain issuance is not retried and private backend detail is not exposed", async (t) => {
  const f = await fixture(t), remote = server({ failure: "/api/operation-permission/v1/api-keys" });
  await assert.rejects(issueApiKey(f.argv, remote), (error) => {
    assert.match(error.message, /outcome-uncertain/);
    assert.equal(error.message.includes("synthetic-private-backend-detail"), false);
    return true;
  });
  assert.equal(remote.calls.filter((call) => call.route.endsWith("/api-keys")).length, 1);
  await assert.rejects(access(f.keyFile));
});

const organizationArgs = ["--origin", "https://meshrix.invalid", "--username", "synthetic-actor", "--template", "selected-template", "--password-stdin"];
test("organization helper preserves configured state and rejects password arguments", async () => {
  const remote = server();
  await assert.rejects(configureOrganization([...organizationArgs, "--password", "synthetic"], remote), /invalid-arguments/);
  assert.deepEqual(remote.calls, []);
  assert.deepEqual(await configureOrganization(organizationArgs, remote), { ok: true, alreadyConfigured: true });
  assert.equal(remote.calls.length, 2);
});

test("organization helper previews and publishes the selected template at one revision", async () => {
  const remote = server({ configured: false });
  assert.deepEqual(await configureOrganization(organizationArgs, remote), { ok: true, configured: true });
  assert.deepEqual(remote.calls.find((call) => call.route.endsWith("/import")).body, { templateKey: "selected-template" });
  const preview = remote.calls.find((call) => call.route.endsWith("/preview")).body;
  const published = remote.calls.find((call) => call.route.endsWith("/publish")).body;
  assert.equal(preview.expectedRevision, 7);
  assert.deepEqual(published, preview);
});

test("a failed organization preview never publishes or leaks backend detail", async () => {
  const remote = server({ configured: false, failure: "/api/authorization/organization-governance/preview" });
  await assert.rejects(configureOrganization(organizationArgs, remote), (error) => {
    assert.equal(error.message, "template-preview-failed");
    return true;
  });
  assert.equal(remote.calls.some((call) => call.route.endsWith("/publish")), false);
});

test("help for either operator helper does not read a password or authenticate", async () => {
  const noEffects = { fetchImpl: () => assert.fail("unexpected request"), readPassword: () => assert.fail("unexpected credential read") };
  assert.match(await issueApiKey(["--help"], noEffects), /^Usage:/);
  assert.match(await configureOrganization(["--help"], noEffects), /^Usage:/);
});
