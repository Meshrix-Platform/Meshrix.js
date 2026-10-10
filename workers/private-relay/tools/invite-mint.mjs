#!/usr/bin/env node
/**
 * Mint an invite ticket offline — the only way new devices get in.
 *
 * The invitation authority holds an Ed25519 *private* key (never on the
 * relay), runs this tool, and hands the printed code or join URL to the
 * invitee. The relay verifies with the public key alone —
 * `RELAY_INVITE_PUBLIC_KEY` is a var, not a secret — so minting stays a
 * purely offline authority and the public deployment carries no control
 * plane for this flow.
 *
 * Usage:
 *   node tools/invite-mint.mjs keygen [--out <path>]
 *     Generate an issuer keypair: writes the private key (PKCS8,
 *     base64url) to <path> with mode 0600, prints the public key to put
 *     in `RELAY_INVITE_PUBLIC_KEY` (vars or wrangler secret — it is
 *     public material either way).
 *
 *   node tools/invite-mint.mjs mint \
 *     --key-file <path> \
 *     --tenant <tenantId> --route <routeId> --role entry|endpoint \
 *     [--mode personal|enterprise] [--days 7] \
 *     [--base https://relay.meshrix.io]
 *     Mint one signed invite ticket + its join URL.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { importInviteSigningKey, issueInviteTicket } from "../src/invite.ts";

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function fail(msg) {
  console.error(`invite-mint: ${msg}`);
  process.exit(1);
}

const command = process.argv[2];

if (command === "keygen") {
  const out = arg("out") ?? "invite-private-key.pkcs8";
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  writeFileSync(out, `${b64u(pkcs8)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    privateKeyFile: out,
    publicKey: b64u(raw),
    note: "set RELAY_INVITE_PUBLIC_KEY to publicKey; the private key stays offline with the issuer",
  }, null, 2));
  process.exit(0);
}

if (command !== "mint") {
  fail("usage: invite-mint.mjs keygen [--out <path>] | mint --key-file <path> --tenant <id> --route <id> --role entry|endpoint [--mode personal|enterprise] [--days 7] [--base <url>]");
}

const keyFile = arg("key-file");
if (!keyFile) fail("--key-file <path> is required (see `invite-mint.mjs keygen`)");
const privateKey = await importInviteSigningKey(readFileSync(keyFile, "utf8").trim())
  .catch(() => fail(`--key-file ${keyFile} is not a valid Ed25519 PKCS8 key`));

const tenantId = arg("tenant");
const routeId = arg("route");
const role = arg("role");
const mode = arg("mode") ?? "personal";
const days = Number.parseFloat(arg("days") ?? "7");
const base = (arg("base") ?? "https://relay.meshrix.io").replace(/\/+$/, "");

if (!tenantId) fail("--tenant is required");
if (!routeId) fail("--route is required");
if (role !== "entry" && role !== "endpoint") fail("--role must be entry or endpoint");
if (mode !== "personal" && mode !== "enterprise") fail("--mode must be personal or enterprise");
if (!Number.isFinite(days) || days <= 0 || days > 30) fail("--days must be >0 and <=30");

const expiresAt = Date.now() + Math.round(days * 86_400_000);
const invite = await issueInviteTicket(privateKey, { tenantId, routeId, role, mode, expiresAt });

console.log(JSON.stringify({
  invite,
  joinUrl: `${base}/join#${encodeURIComponent(invite)}`,
  tenantId,
  routeId,
  role,
  mode,
  expiresAt: new Date(expiresAt).toISOString(),
}, null, 2));
