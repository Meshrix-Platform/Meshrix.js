#!/usr/bin/env node
/**
 * Generate a bounded local build-input report.
 *
 * This report is not a signed attestation and does not claim that external
 * build, test, registry, or deployment steps ran. Its inputs are the fixed
 * source files registered for `release:generate-provenance`.
 *
 * Usage:
 *   node tools/server-scripts/generate-provenance.ts
 *   node tools/server-scripts/generate-provenance.ts --output build/reports/local-build-inputs.json
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const maximumInputBytes = 16 * 1024 * 1024;
const fixedBuildInputs = [
  ["package.json", "package-manifest"],
  ["package-lock.json", "dependency-lock"],
  ["tools/server-scripts/generate-provenance.ts", "generator-source"],
  ["build/composition-presets.json", "composition-input"]
] as const;
const versionPattern = /^(?:v)?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;
const stableToolVersionPattern = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;

type BuildSubject = Readonly<{
  path: string;
  sha256: string;
  size: number;
  kind: string;
}>;

function runFixedCommand(command: string, args: readonly string[]): string | null {
  try {
    return execFileSync(command, [...args], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 4096,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      windowsHide: true
    }).trim();
  } catch {
    return null;
  }
}

function parsedVersion(output: string | null): string | null {
  if (!output || output.length > 64) return null;
  return stableToolVersionPattern.exec(output)?.[1] ?? null;
}

function parsedRevision(output: string | null): string | null {
  if (!output || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(output)) return null;
  return output.toLowerCase();
}

function publicPackageName(value: unknown): string | null {
  return typeof value === "string"
    && value.length <= 214
    && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu.test(value)
    ? value
    : null;
}

function publicPackageVersion(value: unknown): string | null {
  return typeof value === "string" && versionPattern.test(value)
    ? value.replace(/^v/u, "")
    : null;
}

function publicRepositoryCoordinate(value: unknown): string | null {
  const configuredUrl = typeof value === "string"
    ? value
    : value && typeof value === "object" && "url" in value
      ? (value as { url?: unknown }).url
      : null;
  if (typeof configuredUrl !== "string" || configuredUrl.length > 2048 || configuredUrl !== configuredUrl.trim()) {
    return null;
  }

  const urlText = configuredUrl.startsWith("git+https://")
    ? configuredUrl.slice("git+".length)
    : configuredUrl;
  try {
    const url = new URL(urlText);
    if (url.protocol !== "https:"
      || url.hostname.toLowerCase() !== "github.com"
      || url.port
      || url.username
      || url.password
      || url.search
      || url.hash) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) return null;
    const [owner, configuredRepository] = segments;
    const repository = configuredRepository.replace(/\.git$/iu, "");
    const coordinatePart = /^[A-Za-z0-9_.-]{1,100}$/u;
    if (!coordinatePart.test(owner) || !coordinatePart.test(repository) || owner === "." || owner === ".." || repository === "." || repository === "..") {
      return null;
    }
    return `https://github.com/${owner}/${repository}`;
  } catch {
    return null;
  }
}

async function packageIdentity(): Promise<Readonly<{ name: string | null; version: string | null; repository: string | null }>> {
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")) as Record<string, unknown>;
    return {
      name: publicPackageName(metadata.name),
      version: publicPackageVersion(metadata.version),
      repository: publicRepositoryCoordinate(metadata.repository)
    };
  } catch {
    return { name: null, version: null, repository: null };
  }
}

async function fileSubject(relativePath: string, kind: string): Promise<BuildSubject | null> {
  const absolutePath = path.join(repoRoot, relativePath);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const pathStat = await fs.lstat(absolutePath);
    if (!pathStat.isFile() || pathStat.size > maximumInputBytes) return null;
    handle = await fs.open(absolutePath, "r");
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size !== pathStat.size || fileStat.size > maximumInputBytes) return null;

    const bytes = Buffer.alloc(fileStat.size);
    const { bytesRead } = await handle.read(bytes, 0, fileStat.size, 0);
    if (bytesRead !== fileStat.size) return null;
    return {
      path: relativePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytesRead,
      kind
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function localReportFileCount(outputPath: string): Promise<number> {
  try {
    const reportDirectory = path.join(repoRoot, "build", "reports");
    const entries = await fs.readdir(reportDirectory, { withFileTypes: true });
    return entries.filter((entry) => {
      if (!entry.isFile() || !(entry.name.endsWith(".json") || entry.name.endsWith(".md"))) return false;
      return path.resolve(reportDirectory, entry.name) !== outputPath;
    }).length;
  } catch {
    return 0;
  }
}

function outputPathFromArgs(args: readonly string[]): string {
  let configuredOutput: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output") {
      configuredOutput = args[index + 1];
      if (!configuredOutput) throw new Error("invalid_arguments");
      index += 1;
    } else if (argument.startsWith("--output=")) {
      configuredOutput = argument.slice("--output=".length);
      if (!configuredOutput) throw new Error("invalid_arguments");
    } else {
      throw new Error("invalid_arguments");
    }
  }
  return configuredOutput ? path.resolve(repoRoot, configuredOutput) : path.join(repoRoot, "build", "reports", "provenance.json");
}

async function main(): Promise<void> {
  const outputPath = outputPathFromArgs(process.argv.slice(2));
  const subjects: BuildSubject[] = [];
  for (const [relativePath, kind] of fixedBuildInputs) {
    const subject = await fileSubject(relativePath, kind);
    if (subject) subjects.push(subject);
  }

  const identity = await packageIdentity();
  const revision = parsedRevision(runFixedCommand("git", ["rev-parse", "--verify", "HEAD^{commit}"]));
  const toolchain = {
    node: parsedVersion(runFixedCommand(process.execPath, ["--version"])),
    npm: parsedVersion(runFixedCommand("npm", ["--version"]))
  };
  const reportCount = await localReportFileCount(outputPath);

  const report = {
    schemaVersion: "v0.0.1:meshrix:build-input-report-1",
    reportKind: "unsigned-local-build-input-report",
    generatedAt: new Date().toISOString(),
    project: identity,
    revision,
    toolchain,
    observedBuildSteps: ["hash-registered-build-inputs", "count-local-report-files"],
    localReportFileCount: reportCount,
    subjects
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log("Unsigned local build-input report written.");
  console.log(`Package: ${identity.name ?? "unknown"}@${identity.version ?? "unknown"}`);
  console.log(`Revision: ${revision ?? "unknown"}`);
  console.log(`Toolchain: Node ${toolchain.node ?? "unknown"}; npm ${toolchain.npm ?? "unknown"}`);
  console.log(`Subjects: ${subjects.length}`);
  console.log(`Local report files: ${reportCount}`);
}

main().catch(() => {
  console.error("provenance_generation_failed");
  process.exitCode = 1;
});
