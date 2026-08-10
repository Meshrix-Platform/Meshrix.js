#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";

import { repoRoot, sanitizeError } from "./lib/repository.mjs";

const serviceRoot = path.join(repoRoot, "services", "file-parser", "format-convert");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: serviceRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${args.join(" ")} failed: ${sanitizeError(stderr || stdout)}`)));
  });
}

async function main() {
  const format = await run("gofmt", ["-l", "cmd", "internal"]);
  if (format.stdout.trim()) throw new Error(`gofmt reported unformatted files: ${format.stdout.trim()}`);
  await run("go", ["test", "./..."]);
  await run("go", ["vet", "./..."]);
  process.stdout.write(`${JSON.stringify({ ok: true, service: "file-parser/format-convert", route: "POST /v1/convert", transport: "multipart" })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${sanitizeError(error)}\n`);
  process.exitCode = 1;
});
