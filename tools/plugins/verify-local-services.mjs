#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";

import { repoRoot, sanitizeError } from "./lib/repository.mjs";

const formatConvertRoot = path.join(repoRoot, "services", "file-parser", "format-convert");
const skillHubRoot = path.join(repoRoot, "services", "skill-hub");

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${args.join(" ")} failed: ${sanitizeError(stderr || stdout)}`)));
  });
}

async function main() {
  const format = await run("gofmt", ["-l", "cmd", "internal"], formatConvertRoot);
  if (format.stdout.trim()) throw new Error(`gofmt reported unformatted files: ${format.stdout.trim()}`);
  await run("go", ["test", "./..."], formatConvertRoot);
  await run("go", ["vet", "./..."], formatConvertRoot);
  await run(process.execPath, ["--test", "test/http-service.test.mjs"], skillHubRoot);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    services: [
      { service: "file-parser/format-convert", route: "POST /v1/convert", transport: "multipart" },
      { service: "skill-hub", route: "POST /v1/operations/:operationId", transport: "json" }
    ]
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${sanitizeError(error)}\n`);
  process.exitCode = 1;
});
