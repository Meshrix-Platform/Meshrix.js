#!/usr/bin/env node

import process from "node:process";

function fail(code?: any) : any {
  const error: Error & Record<string, any> = new Error(code);
  error.code = code;
  throw error;
}

const runId: any = String(process.env.MESHRIX_FUNCTIONAL_RUN_ID || "").trim();
const sourceRevision: any = String(process.env.MESHRIX_SOURCE_REVISION || "").trim();
const repository: any = String(process.env.MESHRIX_REPOSITORY || "").trim();
const apiUrl: any = String(process.env.MESHRIX_GITHUB_API_URL || "").replace(/\/+$/u, "");
const token: any = String(process.env.GITHUB_TOKEN || "");

if (!/^[1-9][0-9]*$/u.test(runId)) fail("real_machine_functional_run_id_invalid");
if (!/^[a-f0-9]{40}$/u.test(sourceRevision)) fail("real_machine_source_revision_invalid");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
  fail("real_machine_repository_invalid");
}
if (!/^https:\/\/[^/]+/u.test(apiUrl) || !token) fail("real_machine_run_api_unavailable");

const response: any = await fetch(`${apiUrl}/repos/${repository}/actions/runs/${runId}`, {
  headers: {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  },
  redirect: "error",
});
if (!response.ok) fail("real_machine_functional_run_unavailable");
const bytes: any = Buffer.from(await response.arrayBuffer());
if (bytes.length > 1024 * 1024) fail("real_machine_functional_run_response_oversized");
let run: any;
try {
  run = JSON.parse(bytes.toString("utf8"));
} catch {
  fail("real_machine_functional_run_response_invalid");
}
if (
  String(run?.id) !== runId ||
  run?.path !== ".github/workflows/release.yml" ||
  run?.event !== "push" ||
  run?.head_sha !== sourceRevision ||
  run?.conclusion !== "success"
) {
  fail("real_machine_functional_run_binding_invalid");
}
process.stdout.write(`${JSON.stringify({ ok: true, sourceRevision })}\n`);
