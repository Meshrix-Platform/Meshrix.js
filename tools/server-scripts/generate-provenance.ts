#!/usr/bin/env node
/**
 * generate-provenance.ts — SLSA-aligned Provenance Report Generator
 *
 * Produces build/reports/provenance.json with:
 * - Git SHA, branch, tags, dirty flag
 * - Node/npm/rust/cargo/flutter/docker toolchain versions
 * - Build commands executed (from env, --command flags, script-registry.json)
 * - Package artifact subjects with sha256 + size + kind
 * - Runtime, feature, and composition profiles
 * - Reports inventory
 *
 * Usage:
 *   node tools/server-scripts/generate-provenance.ts
 *   node tools/server-scripts/generate-provenance.ts --command "npm test"
 *   node tools/server-scripts/generate-provenance.ts --command "npm test" --command "npm run repo:layout:audit"
 *   node tools/server-scripts/generate-provenance.ts --output build/reports/my-provenance.json
 */

import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function exec(cmd?: any) : any {
  try {
    return execSync(cmd, { cwd: repoRoot, encoding: "utf8", timeout: 30000 }).trim();
  } catch {
    return null;
  }
}

async function fileSha256(filePath?: any) : Promise<any> {
  try {
    const { createHash } = await import("node:crypto");
    const data: any = await fs.readFile(filePath);
    const hash: any = createHash("sha256").update(data).digest("hex");
    const stat: any = await fs.stat(filePath);
    return { sha256: hash, size: stat.size };
  } catch {
    return null;
  }
}

async function main() : Promise<any> {
  // Parse --command flags (can appear multiple times)
  const commandFlags: any[] = [];
  const remainingArgs: any[] = [];
  for (let i: any = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--command" && i + 1 < process.argv.length) {
      commandFlags.push(process.argv[++i]);
    } else {
      remainingArgs.push(process.argv[i]);
    }
  }

  const outputArg: any = remainingArgs.find((a?: any) : any => a.startsWith("--output="));
  const outputPath: any = outputArg
    ? path.resolve(repoRoot, outputArg.slice("--output=".length))
    : path.join(repoRoot, "build", "reports", "provenance.json");

  // ── Git metadata ──────────────────────────────────────────────────────────
  const sha: any = exec("git rev-parse HEAD");
  const branch: any = exec("git rev-parse --abbrev-ref HEAD");
  const tagsRaw: any = exec("git tag --points-at HEAD");
  const remoteUrl: any = exec("git remote get-url origin");
  const dirty: any = exec("git status --porcelain") !== "" ? true : (exec("git status --porcelain") === "" ? false : null);

  // ── Toolchain versions ────────────────────────────────────────────────────
  const nodeVersion: any = process.version;
  const npmVersion: any = exec("npm --version");
  const rustVersion: any = exec("rustc --version");
  const cargoVersion: any = exec("cargo --version");
  const flutterVersion: any = exec("flutter --version 2>/dev/null | head -1");
  const dockerVersion: any = exec("docker --version 2>/dev/null");

  // ── Git dirty check ───────────────────────────────────────────────────────
  let gitDirty: any = false;
  try {
    const statusOutput: any = exec("git status --porcelain");
    gitDirty = statusOutput !== null && statusOutput.length > 0;
  } catch {
    gitDirty = null;
  }

  // ── Build commands executed ───────────────────────────────────────────────
  const commands: any[] = [];

  // From environment
  if (process.env.GITHUB_WORKFLOW) commands.push(`CI workflow: ${process.env.GITHUB_WORKFLOW}`);
  if (process.env.GITHUB_JOB) commands.push(`CI job: ${process.env.GITHUB_JOB}`);
  if (process.env.npm_lifecycle_event) commands.push(`npm: ${process.env.npm_lifecycle_event}`);

  // From --command flags
  for (const cmd of commandFlags) {
    commands.push(cmd);
  }

  // From script-registry.json if it exists
  try {
    const regPath: any = path.join(repoRoot, "build", "reports", "script-registry.json");
    const reg: any = JSON.parse(await fs.readFile(regPath, "utf8"));
    if (reg.entries) {
      commands.push(`Script registry: ${reg.entries.length} entries recorded`);
    }
  } catch { /* no script registry report yet */ }

  // ── Subjects (source inputs, reports, release artifacts) ──────────────────

  /** @type {Array<{path: string, sha256: string, size: number, kind: string}>} */
  const subjects: any[] = [];

  // Source inputs — key lock files and configs (NOT node_modules or runtime payloads)
  const sourceInputs: any[] = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vite.config.ts",
    "vitest.config.ts",
  ];
  for (const file of sourceInputs) {
    const hash: any = await fileSha256(path.join(repoRoot, file));
    if (hash) {
      subjects.push({ path: file, sha256: hash.sha256, size: hash.size, kind: "source-input" });
    }
  }

  // ── Reports inventory ─────────────────────────────────────────────────────
  /** @type {string[]} */
  const reportFiles: any[] = [];
  const reportDir: any = path.join(repoRoot, "build", "reports");
  try {
    const reportEntries: any = await fs.readdir(reportDir);
    for (const entry of reportEntries) {
      const entryPath: any = path.join(reportDir, entry);
      const stat: any = await fs.stat(entryPath);
      if (entry.endsWith(".json") || entry.endsWith(".md")) {
        const hash: any = await fileSha256(entryPath);
        const reportRelPath: any = `build/reports/${entry}`;
        reportFiles.push(reportRelPath);
        if (hash && stat.size < 1024 * 1024) { // Only hash reports < 1MB
          subjects.push({ path: reportRelPath, sha256: hash.sha256, size: hash.size, kind: "report" });
        }
      }
    }
  } catch { /* no reports yet */ }

  // ── Composition presets ───────────────────────────────────────────────────
  let compositionPresets: any = null;
  let compositionPreset: any = null;
  try {
    const presetsPath: any = path.join(repoRoot, "build", "composition-presets.json");
    compositionPresets = JSON.parse(await fs.readFile(presetsPath, "utf8"));
    compositionPreset = Object.keys(compositionPresets).join(",");
  } catch { /* no presets file */ }

  // ── Runtime kind from actual build inputs (not just directory existence) ──
  const runtimeKindParts: any[] = ["node"]; // Node is always present

  // Check if Docker was used (build was run)
  if (dockerVersion && commands.some((c?: any) : any => c.toLowerCase().includes("docker"))) {
    runtimeKindParts.push("docker");
  }

  // Check if network dependencies were actually involved (not just directory exists)
  const networkServiceReportExists: any = reportFiles.some((f?: any) : any => f.includes("external-dependency"));
  if (networkServiceReportExists) {
    runtimeKindParts.push("network-service");
  }

  const runtimeKind: any = runtimeKindParts.join("-");

  // ── Build the provenance document ─────────────────────────────────────────
  const provenance: Record<string, any> = {
    schemaVersion: "v0.0.1:meshrix:provenance-2",
    generatedAt: new Date().toISOString(),
    git: {
      sha,
      branch,
      tags: tagsRaw ? tagsRaw.split("\n").filter(Boolean) : [],
      remoteUrl,
      dirty: gitDirty,
    },
    toolchain: {
      node: nodeVersion,
      npm: npmVersion,
      rust: rustVersion,
      cargo: cargoVersion,
      flutter: flutterVersion,
      docker: dockerVersion,
    },
    commands,
    subjects,
    reports: reportFiles,
    compositionPreset,
    runtimeKind,
    composition: compositionPresets ? { presets: Object.keys(compositionPresets) } : null,
  };

  // ── Write output ──────────────────────────────────────────────────────────
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(provenance, null, 2), "utf8");

  console.log(`Provenance report written to ${outputPath}`);
  console.log(`  Git SHA: ${sha?.slice(0, 8) || "unknown"}`);
  console.log(`  Branch: ${branch || "unknown"}`);
  console.log(`  Dirty: ${gitDirty}`);
  console.log(`  Node: ${nodeVersion}`);
  console.log(`  Runtime kind: ${runtimeKind}`);
  console.log(`  Subjects: ${subjects.length} (${subjects.filter((s?: any) : any => s.kind === "source-input").length} source-input, ${subjects.filter((s?: any) : any => s.kind === "report").length} report)`);
  console.log(`  Commands: ${commands.length}`);
}

main().catch((error?: any) : any => {
  console.error(error);
  process.exitCode = 1;
});
