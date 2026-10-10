#!/usr/bin/env node
/**
 * Mint an invite ticket offline — the only way new devices get in.
 *
 * The operator holds the invite secret locally (never on the relay), runs
 * this tool, and hands the printed code or join URL to the invitee. No
 * admin API is involved: minting is pure HMAC signing, so the public
 * deployment carries no control plane for this flow.
 *
 * Usage:
 *   node tools/invite-mint.mjs \
 *     --tenant <tenantId> --route <routeId> --role entry|endpoint \
 *     [--mode personal|enterprise] [--days 7] \
 *     [--base https://relay.meshrix.io] \
 *     (--secret <value> | --secret-file <path> | --secret-env <NAME>)
 */

import { readFileSync } from "node:fs";
import { issueInviteTicket } from "../src/invite.ts";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function fail(msg) {
  console.error(`invite-mint: ${msg}`);
  process.exit(1);
}

const secret =
  arg("secret") ??
  (arg("secret-file") ? readFileSync(arg("secret-file"), "utf8").trim() : undefined) ??
  (arg("secret-env") ? process.env[arg("secret-env")] : undefined) ??
  process.env.RELAY_INVITE_SECRET;
if (!secret) fail("no invite secret — pass --secret, --secret-file, --secret-env or set RELAY_INVITE_SECRET");

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
const invite = await issueInviteTicket(secret, { tenantId, routeId, role, mode, expiresAt });

console.log(JSON.stringify({
  invite,
  joinUrl: `${base}/join#${encodeURIComponent(invite)}`,
  tenantId,
  routeId,
  role,
  mode,
  expiresAt: new Date(expiresAt).toISOString(),
}, null, 2));
