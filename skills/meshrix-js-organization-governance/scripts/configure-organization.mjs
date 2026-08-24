#!/usr/bin/env node
// Configure organization governance on a Meshrix.js instance using a
// built-in template: import -> preview -> publish.
//
// Usage:
//   node configure-organization.mjs \
//     --origin http://127.0.0.1:7228 \
//     --username owner --password '...' \
//     [--template enterprise-group]
import fs from "node:fs";

function args() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].startsWith("--")) {
      const key = a[i].slice(2);
      const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[camel] = a[i + 1];
    }
  }
  return out;
}

async function main() {
  const opt = args();
  const origin = String(opt.origin || "http://127.0.0.1:7228").replace(/\/$/, "");
  const username = opt.username || "owner";
  const password = opt.password || "";
  const templateKey = opt.template || "enterprise-group";
  if (!password) throw new Error("--password is required");

  const login = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const loginPayload = await login.json();
  if (!loginPayload.ok) throw new Error(`login failed: ${loginPayload.error || login.status}`);
  const csrf = loginPayload.csrfToken;
  const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
  const headers = {
    cookie,
    "content-type": "application/json",
    "x-meshrix-csrf": csrf,
    "x-meshrix-safety-confirm": "true",
  };

  const governance = await (await fetch(`${origin}/api/authorization/organization-governance`, { headers: { cookie } })).json();
  const snapshot = governance.snapshot || {};
  if (snapshot.configured === true) {
    console.log(JSON.stringify({ ok: true, alreadyConfigured: true, revision: snapshot.revision, templateKey: snapshot.templateKey }));
    return;
  }
  const expectedRevision = Number(snapshot.revision || 0);

  const imported = await (await fetch(`${origin}/api/authorization/organization-governance/import`, {
    method: "POST", headers, body: JSON.stringify({ templateKey }),
  })).json();
  const draft = imported.draft;
  if (!draft) throw new Error(`template import failed: ${imported.error || "no draft"}`);

  const preview = await (await fetch(`${origin}/api/authorization/organization-governance/preview`, {
    method: "POST", headers, body: JSON.stringify({ ...draft, expectedRevision }),
  })).json();
  if (!preview.ok) throw new Error(`preview failed: ${JSON.stringify(preview.error || preview)}`);

  const published = await (await fetch(`${origin}/api/authorization/organization-governance/publish`, {
    method: "POST", headers, body: JSON.stringify({ ...draft, expectedRevision }),
  })).json();
  if (!published.ok) throw new Error(`publish failed: ${JSON.stringify(published.error || published)}`);

  const next = published.snapshot || {};
  console.log(JSON.stringify({
    ok: true,
    configured: next.configured,
    revision: next.revision,
    templateKey: next.templateKey,
    nodeCount: (next.nodes || []).length,
  }));
}

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
