#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

import { repoRoot, sanitizeError, walkFiles } from "./lib/repository.mjs";

function check(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--check", filePath], { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(sanitizeError(stderr || "syntax check failed"))));
  });
}

async function main() {
  const files = await walkFiles(repoRoot, {
    excludeDirectory: (relative) => [".git", "build", "docs/plan", "node_modules", ".local"].some(
      (prefix) => relative === prefix || relative.startsWith(`${prefix}/`)
    ),
    include: (relative) => relative.endsWith(".mjs") &&
      !relative.startsWith("docs/plan/") && !relative.startsWith("build/") && !relative.startsWith("node_modules/")
  });
  for (const file of files) await check(file.absolute);
  console.log(JSON.stringify({ ok: true, checkedFiles: files.length }));
}

main().catch((error) => {
  console.error(sanitizeError(error));
  process.exitCode = 1;
});
