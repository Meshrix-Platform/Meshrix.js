#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function parseArgs(argv?: any) : any {
  const options: Record<string, any> = {
    outputDir: ""
  };
  for (let index: any = 0; index < argv.length; index += 1) {
    const arg: any = argv[index];
    if (arg === "--output-dir") {
      options.outputDir = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`verify-runtime-recovery-export

Verify that runtime recovery exports do not copy secret material.

Usage:
  node tools/server-scripts/verify-runtime-recovery-export.ts [--output-dir PATH]
`);
      process.exit(0);
    }
  }
  return options;
}

async function writeFile(root?: any, relativePath?: any, content?: any) : Promise<any> {
  const filePath: any = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

async function exists(filePath?: any) : Promise<any> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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
  return files;
}

async function latestReport(outputDir?: any) : Promise<any> {
  const entries: any = await fs.readdir(outputDir, { withFileTypes: true });
  const runDirs: any = entries
    .filter((entry?: any) : any => entry.isDirectory())
    .map((entry?: any) : any => path.join(outputDir, entry.name))
    .sort();
  assert.ok(runDirs.length > 0, "recovery export verifier should create a run directory");
  const reportPath: any = path.join(runDirs.at(-1), "recovery-export-report.json");
  return {
    runDir: runDirs.at(-1),
    report: JSON.parse(await fs.readFile(reportPath, "utf8"))
  };
}

const options: any = parseArgs(process.argv.slice(2));
const tempRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-runtime-recovery-export-"));
const dataDir: any = path.join(tempRoot, "data");
const outputDir: any = options.outputDir ? path.resolve(options.outputDir) : path.join(tempRoot, "out");

const secretNeedles: any[] = [
  "FAKE_TOKEN_FOR_RECOVERY_EXPORT_TEST",
  "FAKE_SEALING_KEY_FOR_RECOVERY_EXPORT_TEST",
  "FAKE_CSRF_SECRET_FOR_RECOVERY_EXPORT_TEST",
  "FAKE_SENSITIVE_PROMPT_FOR_RECOVERY_EXPORT_TEST"
];

try {
  await writeFile(dataDir, "auth/console-auth.sqlite", "sqlite-placeholder\n");
  await writeFile(dataDir, "auth/csrf-hmac-secret.bin", secretNeedles[2]);
  await writeFile(dataDir, "security/authorization/grants.json", JSON.stringify({ grants: [] }, null, 2));
  await writeFile(dataDir, "security/capability-kernel/verify.sealing-key", secretNeedles[1]);
  await writeFile(dataDir, "security/capability-kernel/verify.sealed.json", JSON.stringify({ sealed: true }, null, 2));
  await writeFile(dataDir, "secrets/registry.json", JSON.stringify({ refs: { "secret://meshrix/test": { redacted: "***test" } } }, null, 2));
  await writeFile(dataDir, "secrets/values/fake.json", JSON.stringify({ payload: { ["token"]: secretNeedles[0] } }, null, 2));
  await writeFile(dataDir, "plugin-data/opaque-sensitive-payloads.json", JSON.stringify({ payloads: { pending: { prompt: secretNeedles[3] } } }, null, 2));

  const result: any = spawnSync(process.execPath, [
    "tools/server-scripts/export-runtime-recovery.ts",
    "--data-dir",
    dataDir,
    "--output-dir",
    outputDir,
    "--json"
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary: any = JSON.parse(result.stdout);
  assert.equal(summary.status, "ready");

  const { runDir, report } = await latestReport(outputDir);
  assert.equal(report.summary.sensitiveFileCount, 4);

  const skippedByPath: any = new Map<any, any>(report.recovery.skipped.map((entry?: any) : any => [entry.relativePath, entry]));
  for (const relativePath of [
    "auth/csrf-hmac-secret.bin",
    "security/capability-kernel/verify.sealing-key",
    "secrets/values/fake.json",
    "plugin-data/opaque-sensitive-payloads.json"
  ]) {
    assert.equal(skippedByPath.get(relativePath)?.reason, "sensitive-recovery-material", `${relativePath} must be skipped as sensitive material`);
  }

  assert.equal(await exists(path.join(runDir, "recovery-files", "auth", "console-auth.sqlite")), true);
  assert.equal(await exists(path.join(runDir, "recovery-files", "auth", "csrf-hmac-secret.bin")), false);
  assert.equal(await exists(path.join(runDir, "recovery-files", "security", "capability-kernel", "verify.sealing-key")), false);
  assert.equal(await exists(path.join(runDir, "recovery-files", "secrets", "values", "fake.json")), false);
  assert.equal(await exists(path.join(runDir, "recovery-files", "plugin-data", "opaque-sensitive-payloads.json")), false);

  const outputFiles: any = await collectFiles(outputDir);
  for (const filePath of outputFiles) {
    const content: any = await fs.readFile(filePath, "utf8").catch(() : any => "");
    for (const needle of secretNeedles) {
      assert.equal(content.includes(needle), false, `${filePath} must not contain copied secret material`);
    }
  }

  console.log("runtime recovery export verification passed");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() : any => {});
}
