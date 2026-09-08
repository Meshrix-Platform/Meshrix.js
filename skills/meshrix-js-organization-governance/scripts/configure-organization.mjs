#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const usage = "Usage: configure-organization.mjs --origin <server-origin> --username <actor> --template <approved-template> --password-stdin";
async function passwordFromStdin() {
  if (process.stdin.isTTY) throw new Error("password-stdin-required");
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value) > 8192) throw new Error("invalid-password-input");
  }
  return value.replace(/\r?\n$/, "");
}

export async function configureOrganization(argv, { fetchImpl = globalThis.fetch, readPassword = passwordFromStdin } = {}) {
  let options, origin;
  try {
    options = parseArgs({ args: argv, options: {
      origin: { type: "string" }, username: { type: "string" }, template: { type: "string" },
      "password-stdin": { type: "boolean" }, help: { type: "boolean" },
    } }).values;
  } catch { throw new Error("invalid-arguments; use --help"); }
  if (options.help) return usage;
  if (!["origin", "username", "template"].every((key) => options[key]?.trim()) || !options["password-stdin"]) throw new Error("missing-arguments; use --help");
  try {
    const url = new URL(options.origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    origin = url.origin;
  } catch { throw new Error("invalid-origin"); }
  let password;
  try { password = await readPassword(); }
  catch { throw new Error("invalid-password-input"); }
  if (typeof password !== "string" || !password || Buffer.byteLength(password) > 8192) throw new Error("invalid-password-input");

  async function jsonRequest(route, init, stage) {
    try {
      const response = await fetchImpl(origin + route, { ...init, redirect: "error" });
      if (!response.ok) throw new Error();
      const payload = await response.json();
      if (!payload || payload.ok === false) throw new Error();
      return { response, payload };
    } catch { throw new Error(stage + "-failed"); }
  }
  const { response, payload: login } = await jsonRequest("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: options.username, password }),
  }, "login");
  const cookie = String(response.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie || typeof login.csrfToken !== "string" || !login.csrfToken) throw new Error("login-session-unavailable");
  const headers = { cookie, "content-type": "application/json", "x-meshrix-csrf": login.csrfToken, "x-meshrix-safety-confirm": "true" };
  const { payload: governance } = await jsonRequest("/api/authorization/organization-governance", { headers: { cookie } }, "governance-check");
  const snapshot = governance.snapshot;
  if (!snapshot || typeof snapshot.configured !== "boolean" || !Number.isInteger(snapshot.revision) || snapshot.revision < 0) throw new Error("governance-snapshot-invalid");
  if (snapshot.configured) return { ok: true, alreadyConfigured: true };
  const { payload: imported } = await jsonRequest("/api/authorization/organization-governance/import", {
    method: "POST", headers, body: JSON.stringify({ templateKey: options.template }),
  }, "template-import");
  if (!imported.draft || typeof imported.draft !== "object" || Array.isArray(imported.draft)) throw new Error("template-draft-invalid");
  const body = JSON.stringify({ ...imported.draft, expectedRevision: snapshot.revision });
  const { payload: preview } = await jsonRequest("/api/authorization/organization-governance/preview", { method: "POST", headers, body }, "template-preview");
  if (preview.ok !== true) throw new Error("template-preview-failed");
  let published;
  try {
    ({ payload: published } = await jsonRequest("/api/authorization/organization-governance/publish", { method: "POST", headers, body }, "organization-publication"));
  } catch { throw new Error("organization-publication-outcome-uncertain; inspect governance before retrying"); }
  if (published.snapshot?.configured !== true) throw new Error("organization-publication-unconfirmed; inspect governance before retrying");
  return { ok: true, configured: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  configureOrganization(process.argv.slice(2)).then((result) => {
    console.log(typeof result === "string" ? result : JSON.stringify(result));
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
