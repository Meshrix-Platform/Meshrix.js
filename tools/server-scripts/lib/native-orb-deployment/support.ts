import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateFileAtomic } from "../../../../packages/foundation/src/storage/private-file-atomic.ts";
import { readPrivateOwnerCredentialFile } from "../../console-auth.ts";
import { assertNoSensitiveReportLeak } from "../sensitive-report-scan.ts";
import { failNativeOrbDeployment } from "./contract.ts";

const REVISION_PATTERN: any = /^[0-9a-f]{40}$/u;

export function nativeOrbRepoRoot() : any {
  return path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
}

export function runOrb({
  machine,
  args = [],
  translatePaths = false,
  timeout = 60_000,
  allowFailure = false,
  input,
  code = "native_orb_command_failed",
}: Record<string, any> = {}) : any {
  const orbArgs: any[] = ["-m", machine];
  if (translatePaths === true) orbArgs.push("-p");
  orbArgs.push(...args.map(String));
  const result: any = spawnSync("orb", orbArgs, {
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (allowFailure !== true && result.status !== 0) {
    failNativeOrbDeployment(code, "Native OrbStack deployment command failed.");
  }
  return result;
}

export function orbText(machine?: any, args?: any, options?: any) : any {
  return String(runOrb({ machine, args, ...options }).stdout || "").trim();
}

export function gitHead(repoRoot?: any) : any {
  const result: any = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
  const revision: any = String(result.stdout || "").trim();
  if (result.status !== 0 || !REVISION_PATTERN.test(revision)) {
    failNativeOrbDeployment("native_orb_candidate_invalid", "Current candidate is unavailable.");
  }
  return revision;
}

export function resolveServiceNodeExecutable(execStart?: any) : any {
  const match: any = String(execStart || "").match(/(?:^|\{\s*)path=([^ ;]+)\s*;/u);
  const executable: any = String(match?.[1] || "");
  if (!path.posix.isAbsolute(executable) || path.posix.basename(executable) !== "node") {
    failNativeOrbDeployment("native_orb_service_node_invalid", "Native service must use an absolute Node.js executable.");
  }
  return executable;
}

export function assertInactiveReleaseMutation({
  activeWorkingDirectory,
  releaseDirectory,
  ready,
}: Record<string, any> = {}) : void {
  const candidateDirectory: any = String(releaseDirectory || "");
  if (ready !== true && candidateDirectory &&
      String(activeWorkingDirectory || "") === candidateDirectory) {
    failNativeOrbDeployment(
      "native_orb_active_release_mutation_forbidden",
      "Active native release markers are incomplete; the running release cannot be modified.",
    );
  }
}

export function assertRollbackServiceRestored({
  activeWorkingDirectory,
  expectedWorkingDirectory,
  serviceState,
}: Record<string, any> = {}) : void {
  if (String(activeWorkingDirectory || "") !== String(expectedWorkingDirectory || "") ||
      String(serviceState || "").trim() !== "active") {
    failNativeOrbDeployment(
      "native_orb_rollback_failed",
      "Previous native service activation was not restored.",
    );
  }
}

function fileSha256Sync(filePath?: unknown) : string {
  const descriptor: any = fs.openSync(String(filePath), "r");
  const hash: any = crypto.createHash("sha256");
  const chunk: any = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead: any = fs.readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    chunk.fill(0);
    fs.closeSync(descriptor);
  }
}

export function candidateArchive(repoRoot?: any, sourceRevision?: any, {
  cacheRoot = path.join(os.homedir(), ".cache", "meshrix-js", "native-orb-deploy"),
}: Record<string, any> = {}) : any {
  if (!REVISION_PATTERN.test(String(sourceRevision || ""))) {
    failNativeOrbDeployment("native_orb_candidate_invalid", "Candidate archive requires an exact commit.");
  }
  const archivePath: any = path.join(cacheRoot, `${sourceRevision}.tar`);
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(cacheRoot, 0o700);
  const temporary: any = path.join(
    cacheRoot,
    `.${sourceRevision}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  const result: any = spawnSync("git", [
    "archive",
    "--format=tar",
    "-o",
    temporary,
    sourceRevision,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    fs.rmSync(temporary, { force: true });
    failNativeOrbDeployment("native_orb_archive_failed", "Candidate archive failed.");
  }
  try {
    fs.chmodSync(temporary, 0o600);
    const existing: any = (() : any => {
      try { return fs.lstatSync(archivePath); } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    })();
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) {
        failNativeOrbDeployment("native_orb_archive_cache_unsafe", "Candidate archive cache is unsafe.");
      }
      if (fileSha256Sync(archivePath) === fileSha256Sync(temporary)) {
        fs.rmSync(temporary, { force: true });
        fs.chmodSync(archivePath, 0o600);
        return Object.freeze({ archivePath, resumed: true });
      }
    }
    fs.renameSync(temporary, archivePath);
    fs.chmodSync(archivePath, 0o600);
    return Object.freeze({ archivePath, resumed: false });
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeRemoteFile(machine?: any, filePath?: any, contents?: any) : any {
  const encoded: any = Buffer.from(String(contents), "utf8").toString("base64");
  runOrb({
    machine,
    args: [
      "sh",
      "-lc",
      "umask 077; printf %s \"$1\" | base64 -d > \"$2\"",
      "meshrix-write-file",
      encoded,
      filePath,
    ],
    timeout: 30_000,
    code: "native_orb_service_write_failed",
  });
}

export async function loadPrivateLoginInputBytes(inputPath?: any) : Promise<Buffer> {
  let credential: any;
  try {
    credential = await readPrivateOwnerCredentialFile(inputPath);
  } catch {
    failNativeOrbDeployment("native_orb_login_input_invalid", "Private login input is invalid.");
  }
  try {
    return Buffer.from(JSON.stringify(credential), "utf8");
  } finally {
    credential.username = "";
    credential.password = "";
  }
}

async function boundedResponseText(response?: Response, maximum = 64 * 1024) : Promise<string> {
  const reader: any = response?.body?.getReader();
  if (!reader) return "";
  const chunks: any[] = [];
  let total: any = 0;
  try {
    while (true) {
      const item: any = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximum) throw new Error("native_orb_probe_body_too_large");
      chunks.push(item.value);
    }
    return new TextDecoder().decode(Buffer.concat(
      chunks.map((item?: any) : any => Buffer.from(item)),
      total,
    ));
  } finally {
    await reader.cancel().catch(() : any => {});
  }
}

const emptyOriginProbe = () : any => Object.freeze({
  healthOk: false,
  consoleOk: false,
  authenticationOk: false,
  governedOperationOk: false,
  healthz: 0,
  console: 0,
});

export async function probeNativeOrbOrigin(publicOrigin?: any, credentialBytes?: Uint8Array) : Promise<any> {
  if (!(credentialBytes instanceof Uint8Array) || credentialBytes.byteLength === 0 || credentialBytes.byteLength > 8 * 1024) {
    failNativeOrbDeployment("native_orb_login_input_invalid", "Private login input is invalid.");
  }
  try {
    const health: any = await fetch(`${publicOrigin}/api/healthz`, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    await boundedResponseText(health);
    const root: any = await fetch(`${publicOrigin}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    const body: any = await boundedResponseText(root);
    let login: any;
    const requestBody: any = Buffer.from(credentialBytes);
    try {
      login = await fetch(`${publicOrigin}/api/auth/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: requestBody,
        signal: AbortSignal.timeout(5000),
      });
    } finally {
      requestBody.fill(0);
    }
    const loginText: any = await boundedResponseText(login);
    const loginPayload: any = loginText.trim() ? JSON.parse(loginText) : {};
    const setCookies: any[] = typeof login.headers.getSetCookie === "function"
      ? login.headers.getSetCookie()
      : [login.headers.get("set-cookie")].filter(Boolean);
    const cookie: any = String(setCookies[0] || "").split(";", 1)[0];
    const authenticationOk: any = login.ok === true && Boolean(cookie);
    let governedOperationOk: any = false;
    if (authenticationOk) {
      const governed: any = await fetch(`${publicOrigin}/api/console/state`, {
        method: "GET",
        redirect: "manual",
        headers: {
          cookie,
          ...(loginPayload?.csrfToken ? { "x-meshrix-csrf": String(loginPayload.csrfToken) } : {}),
        },
        signal: AbortSignal.timeout(5000),
      });
      await boundedResponseText(governed);
      governedOperationOk = governed.ok === true;
    }
    return Object.freeze({
      healthOk: health.ok === true,
      consoleOk: root.ok === true
        && /html/iu.test(String(root.headers.get("content-type") || ""))
        && /<!doctype html|<html/iu.test(body),
      healthz: Number(health.status),
      console: Number(root.status),
      authenticationOk,
      governedOperationOk,
    });
  } catch {
    return emptyOriginProbe();
  }
}

export async function probeOrigin(publicOrigin?: any, loginInput?: any) : Promise<any> {
  const credentialBytes: any = await loadPrivateLoginInputBytes(loginInput);
  try {
    return await probeNativeOrbOrigin(publicOrigin, credentialBytes);
  } finally {
    credentialBytes.fill(0);
  }
}

export async function rollbackNativeOrbActivation(context?: any) : Promise<any> {
  const machine: any = context?.parsed?.machine;
  if (!machine || !context?.dropInPath || !context?.unit) {
    failNativeOrbDeployment("native_orb_rollback_unavailable", "Native activation rollback state is unavailable.");
  }
  runOrb({
    machine,
    args: [
      "sh", "-lc",
      "if test \"$3\" = yes; then test -f \"$2\" && mv \"$2\" \"$1\"; else rm -f \"$1\" \"$2\"; fi",
      "meshrix-candidate-rollback",
      context.dropInPath,
      context.backupPath,
      context.previousDropInPresent ? "yes" : "no",
    ],
    timeout: 30_000,
    code: "native_orb_rollback_failed",
  });
  runOrb({ machine, args: ["systemctl", "--user", "daemon-reload"], code: "native_orb_rollback_failed" });
  runOrb({
    machine,
    args: ["systemctl", "--user", "restart", context.unit],
    timeout: 120_000,
    code: "native_orb_rollback_failed",
  });
  assertRollbackServiceRestored({
    activeWorkingDirectory: orbText(machine, [
      "systemctl", "--user", "show", context.unit, "-p", "WorkingDirectory", "--value",
    ], { timeout: 15_000, code: "native_orb_rollback_failed" }),
    expectedWorkingDirectory: context.currentWorkingDirectory,
    serviceState: orbText(machine, [
      "systemctl", "--user", "is-active", context.unit,
    ], { allowFailure: true, timeout: 15_000 }),
  });
  context.activationStarted = false;
}

export async function writeNativeOrbProductionUseReceipt(context?: any) : Promise<any> {
  const report: any = {
    schemaVersion: "v0.0.1:deployment:native-orb-production-use-report-1",
    verifier: "tools/server-scripts/native-orb-deploy.ts",
    generatedAt: new Date().toISOString(),
    sourceRevision: context.sourceRevision,
    candidateDigest: context.candidateDigest,
    existingServiceActiveBeforeUpgrade: context.existingServiceActiveBeforeUpgrade === true,
    healthOk: context.probe?.healthOk === true,
    consoleOk: context.probe?.consoleOk === true,
    authenticationOk: context.probe?.authenticationOk === true,
    governedOperationOk: context.probe?.governedOperationOk === true,
    candidateActive: context.probe?.candidateActive === true,
    serviceActive: context.probe?.serviceActive === true,
    rollbackAvailable: true,
  };
  report.releaseReady = [
    report.existingServiceActiveBeforeUpgrade,
    report.healthOk,
    report.consoleOk,
    report.authenticationOk,
    report.governedOperationOk,
    report.candidateActive,
    report.serviceActive,
  ].every(Boolean);
  if (!report.releaseReady) {
    failNativeOrbDeployment("native_orb_production_use_incomplete", "Native production-use evidence is incomplete.");
  }
  assertNoSensitiveReportLeak(report, "native Orb production-use report");
  const outputPath: any = path.join(context.repoRoot, "build", "reports", "native-orb-production-use.json");
  await writePrivateFileAtomic(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}
