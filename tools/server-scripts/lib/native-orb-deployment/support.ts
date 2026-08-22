import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  code = "native_orb_command_failed",
}: Record<string, any> = {}) : any {
  const orbArgs: any[] = ["-m", machine];
  if (translatePaths === true) orbArgs.push("-p");
  orbArgs.push(...args.map(String));
  const result: any = spawnSync("orb", orbArgs, {
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
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

export function candidateArchive(repoRoot?: any, sourceRevision?: any) : any {
  const cacheRoot: any = path.join(os.homedir(), ".cache", "meshrix-js", "native-orb-deploy");
  const archivePath: any = path.join(cacheRoot, `${sourceRevision}.tar`);
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  if (fs.existsSync(archivePath)) return Object.freeze({ archivePath, resumed: true });
  const temporary: any = `${archivePath}.${process.pid}.tmp`;
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
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, archivePath);
  return Object.freeze({ archivePath, resumed: false });
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

export async function probeOrigin(publicOrigin?: any) : Promise<any> {
  try {
    const health: any = await fetch(`${publicOrigin}/api/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    const root: any = await fetch(`${publicOrigin}/`, {
      signal: AbortSignal.timeout(5000),
    });
    const body: any = await root.text();
    return Object.freeze({
      healthOk: health.ok === true,
      consoleOk: root.ok === true
        && /html/iu.test(String(root.headers.get("content-type") || ""))
        && /<!doctype html|<html/iu.test(body),
      healthz: Number(health.status),
      console: Number(root.status),
    });
  } catch {
    return Object.freeze({ healthOk: false, consoleOk: false, healthz: 0, console: 0 });
  }
}
