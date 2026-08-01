#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

function fail(code?: any) : any {
  const error: Error & Record<string, any> = new Error(code);
  error.code = code;
  throw error;
}

function required(name?: any) : any {
  const value: any = String(process.env[name] || "").trim();
  if (!value) fail(`real_machine_workflow_input_missing:${name}`);
  return value;
}

function safeArtifactName(name?: any) : any {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(required(name));
}

function safeRelativePath(name?: any) : any {
  const value: any = required(name);
  const normalized: any = path.posix.normalize(value.replaceAll("\\", "/"));
  return (
    normalized !== "." &&
    !path.posix.isAbsolute(normalized) &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !normalized.includes("/../") &&
    normalized.length <= 512
  );
}

function httpsUrl(name?: any) : any {
  let url: any;
  try {
    url = new URL(required(name));
  } catch {
    fail(`real_machine_workflow_url_invalid:${name}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    fail(`real_machine_workflow_url_invalid:${name}`);
  }
}

const target: any = required("MESHRIX_REAL_MACHINE_TARGET");
const portable: any = target === "native-macos-arm64" || target === "native-windows-x64";
const dockerTarget: any = [
  "native-linux-x64",
  "native-linux-arm64",
  "public-cloud-single-node",
  "clean-host-recovery",
].includes(target);
if (!portable && !dockerTarget) fail("real_machine_workflow_target_invalid");

if (portable) {
  if (!safeArtifactName("MESHRIX_CANDIDATE_ARTIFACT_NAME")) {
    fail("real_machine_workflow_candidate_artifact_name_invalid");
  }
  if (!safeRelativePath("MESHRIX_CANDIDATE_ARTIFACT_FILENAME")) {
    fail("real_machine_workflow_candidate_artifact_path_invalid");
  }
  const portableSubdirectory: any = String(
    process.env.MESHRIX_PORTABLE_INPUT_SUBDIRECTORY || "",
  ).trim();
  const normalizedSubdirectory: any = path.posix.normalize(
    portableSubdirectory.replaceAll("\\", "/"),
  );
  if (
    !portableSubdirectory ||
    path.posix.isAbsolute(normalizedSubdirectory) ||
    normalizedSubdirectory === ".." ||
    normalizedSubdirectory.startsWith("../") ||
    normalizedSubdirectory.includes("/../") ||
    normalizedSubdirectory.length > 512
  ) {
    fail("real_machine_workflow_portable_input_path_invalid");
  }
}
if (dockerTarget) {
  httpsUrl("MESHRIX_PUBLIC_BASE_URL");
  required("MESHRIX_TRUSTED_PROXIES");
}
if (target === "public-cloud-single-node") {
  for (const name of [
    "MESHRIX_PUBLIC_AGENT_MCP_URL",
    "MESHRIX_PUBLIC_UPSTREAM_HTTP_URL",
    "MESHRIX_PUBLIC_UPSTREAM_MCP_URL",
    "MESHRIX_PUBLIC_FAULT_URL",
  ]) {
    httpsUrl(name);
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(required("MESHRIX_EXPECTED_CERT_SHA256"))) {
    fail("real_machine_workflow_certificate_digest_invalid");
  }
  const capacity: any = Number(required("MESHRIX_CAPACITY_REQUESTS"));
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1000) {
    fail("real_machine_workflow_capacity_invalid");
  }
}
if (target === "clean-host-recovery") {
  if (!/^[1-9][0-9]*$/u.test(required("MESHRIX_BACKUP_RUN_ID"))) {
    fail("real_machine_workflow_backup_run_id_invalid");
  }
  if (!safeArtifactName("MESHRIX_BACKUP_ARTIFACT_NAME")) {
    fail("real_machine_workflow_backup_artifact_name_invalid");
  }
}

process.stdout.write(`${JSON.stringify({ ok: true, target })}\n`);
