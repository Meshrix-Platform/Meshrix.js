#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function parseArgs(argv?: any) : any {
  const options: Record<string, any> = {
    dataDir: "",
    outputDir: "",
    json: false
  };
  for (let index: any = 0; index < argv.length; index += 1) {
    const arg: any = argv[index];
    if (arg === "--data-dir") {
      options.dataDir = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--output-dir") {
      options.outputDir = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`export-runtime-recovery

Create a secret-safe runtime recovery export.

Usage:
  node tools/server-scripts/export-runtime-recovery.ts --data-dir PATH --output-dir PATH [--json]
`);
      process.exit(0);
    }
  }
  return options;
}

function normalizeRelativePath(value?: any) : any {
  return String(value || "").split(path.sep).join("/");
}

function isSensitiveRuntimePath(relativePath?: any) : any {
  const value: any = normalizeRelativePath(relativePath).toLowerCase();
  return value.includes("csrf-hmac-secret") ||
    value.includes("sealing-key") ||
    value.startsWith("secrets/values/") ||
    value === "plugin-data/opaque-sensitive-payloads.json";
}

async function collectFiles(rootPath?: any) : Promise<any> {
  const files: any[] = [];
  async function visit(currentPath?: any) : Promise<any> {
    const entries: any = await fs.readdir(currentPath, { withFileTypes: true }).catch(() : any => []);
    for (const entry of entries) {
      const entryPath: any = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  await visit(rootPath);
  return files.sort((left?: any, right?: any) : any => left.localeCompare(right));
}

async function sha256File(filePath?: any) : Promise<any> {
  const content: any = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function runId(now: any = new Date()) : any {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function writeJson(filePath?: any, value?: any) : Promise<any> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeMarkdown(filePath?: any, report?: any) : Promise<any> {
  const lines: any[] = [
    "# Runtime Recovery Export Report",
    "",
    `- status: ${report.status}`,
    `- run: ${report.runId}`,
    `- scanned files: ${report.summary.scannedFileCount}`,
    `- copied recovery files: ${report.summary.copiedFileCount}`,
    `- sensitive files skipped: ${report.summary.sensitiveFileCount}`,
    "",
    "## Skipped Sensitive Files",
    "",
    ...report.recovery.skipped.map((entry?: any) : any => `- ${entry.relativePath}: ${entry.reason}`),
    ""
  ];
  await fs.writeFile(filePath, lines.join("\n"), "utf8");
}

async function main() : Promise<any> {
  const options: any = parseArgs(process.argv.slice(2));
  const dataDir: any = options.dataDir ? path.resolve(options.dataDir) : "";
  const outputDir: any = options.outputDir ? path.resolve(options.outputDir) : "";
  if (!dataDir || !outputDir) {
    throw new Error("--data-dir and --output-dir are required.");
  }
  const id: any = runId();
  const runDir: any = path.join(outputDir, id);
  const recoveryRoot: any = path.join(runDir, "recovery-files");
  const copied: any[] = [];
  const skipped: any[] = [];

  const files: any = await collectFiles(dataDir);
  for (const filePath of files) {
    const relativePath: any = normalizeRelativePath(path.relative(dataDir, filePath));
    if (isSensitiveRuntimePath(relativePath)) {
      skipped.push({
        relativePath,
        reason: "sensitive-recovery-material"
      });
      continue;
    }
    const targetPath: any = path.join(recoveryRoot, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(filePath, targetPath);
    const stat: any = await fs.stat(filePath);
    copied.push({
      relativePath,
      bytes: stat.size,
      sha256: await sha256File(filePath)
    });
  }

  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:platform:runtime-recovery-export-report-1",
    status: "ready",
    runId: id,
    generatedAt: new Date().toISOString(),
    host: os.platform(),
    summary: {
      scannedFileCount: files.length,
      copiedFileCount: copied.length,
      sensitiveFileCount: skipped.length
    },
    recovery: {
      copied,
      skipped
    }
  };
  await writeJson(path.join(runDir, "recovery-export-report.json"), report);
  await writeMarkdown(path.join(runDir, "recovery-export-report.md"), report);

  const summary: Record<string, any> = {
    status: report.status,
    scannedFileCount: report.summary.scannedFileCount,
    copiedFileCount: report.summary.copiedFileCount,
    sensitiveFileCount: report.summary.sensitiveFileCount
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    console.log("runtime recovery export ready");
  }
}

main().catch((error?: any) : any => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
