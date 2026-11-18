#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { npmCliArgs, resolveNpmCliInvocation } from "./lib/npm-cli-invocation.ts";
import { loadReleaseDefinition } from "./lib/release-metadata.ts";

const execFileAsync: any = promisify(execFile);
const MAX_COMMAND_OUTPUT_BYTES: any = 16 * 1024 * 1024;
const OFFICIAL_NPM_REGISTRY: any = "https://registry.npmjs.org";
const INTEGRITY_PATTERN: any = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const VERSION_PATTERN: any = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

export class ReleaseNpmCliInstallError extends Error {
  code: any;
  name: any;
  constructor(code?: any, message?: any) {
    super(message);
    this.name = "ReleaseNpmCliInstallError";
    this.code = code;
  }
}

function installError(code?: any, message?: any) : any {
  return new ReleaseNpmCliInstallError(code, message);
}

/**
 * The OIDC-enabled publish job must not execute whatever the registry happens
 * to serve at install time: the release definition pins the npm CLI tarball's
 * SHA-512, and this installer fails closed on any byte that does not match.
 */
export async function installReleaseNpmCli({
  rootDir = process.cwd(),
  fetchImpl = fetch,
  execFileImpl = execFileAsync,
  tmpdir = os.tmpdir()
}: Record<string, any> = {}) : Promise<any> {
  const definition: any = await loadReleaseDefinition(rootDir);
  const version: any = String(definition?.github?.npmCliVersion || "");
  const integrity: any = String(definition?.github?.npmCliIntegrity || "");
  if (!VERSION_PATTERN.test(version)) {
    throw installError(
      "release_npm_cli_version_invalid",
      "The release workflow requires an exact npm CLI version."
    );
  }
  if (!INTEGRITY_PATTERN.test(integrity)) {
    throw installError(
      "release_npm_cli_integrity_missing",
      "The release definition must pin the npm CLI tarball SHA-512."
    );
  }
  const tarballUrl: any = `${OFFICIAL_NPM_REGISTRY}/npm/-/npm-${version}.tgz`;
  const response: any = await fetchImpl(tarballUrl);
  if (!response?.ok) {
    throw installError(
      "release_npm_cli_download_failed",
      `The pinned npm CLI tarball could not be fetched (HTTP ${response?.status ?? "unavailable"}).`
    );
  }
  const bytes: any = Buffer.from(await response.arrayBuffer());
  const actual: any = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (actual !== integrity) {
    throw installError(
      "release_npm_cli_integrity_mismatch",
      "The fetched npm CLI tarball does not match the release definition's pinned SHA-512."
    );
  }
  const tarballPath: any = path.join(
    tmpdir,
    `meshrix-npm-cli-${version}-${randomBytes(6).toString("hex")}.tgz`
  );
  await fs.writeFile(tarballPath, bytes, { mode: 0o600 });
  try {
    const npmCli: any = resolveNpmCliInvocation();
    await execFileImpl(
      npmCli.command,
      npmCliArgs(npmCli, ["install", "--global", tarballPath]),
      { maxBuffer: MAX_COMMAND_OUTPUT_BYTES }
    );
  } catch (error: any) {
    throw installError(
      "release_npm_cli_install_failed",
      `The pinned npm CLI install failed: ${error?.message || error}`
    );
  } finally {
    await fs.rm(tarballPath, { force: true }).catch(() => {});
  }
  return Object.freeze({ ok: true, version, integrity });
}

const isMain: any = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  installReleaseNpmCli()
    .then((result?: any) : any => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error?: any) : any => {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        code: error?.code || "release_npm_cli_install_failed"
      })}\n`);
      process.exitCode = 1;
    });
}
