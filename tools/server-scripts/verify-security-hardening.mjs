#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const checks = [
  {
    label: "local stdio lockdown",
    args: ["tools/server-scripts/verify-security-local-stdio-lockdown.mjs"]
  },
  {
    label: "process identity",
    args: ["tools/server-scripts/verify-process-identity.mjs"]
  },
  {
    label: "MCP client identity proof",
    args: ["tools/server-scripts/verify-mcp-client-identity-proof.mjs"]
  },
  {
    label: "security alert lifecycle",
    args: ["tools/server-scripts/verify-security-alert-lifecycle.mjs"]
  }
];

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: "inherit",
      windowsHide: true
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${args.join(" ")} exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

for (const check of checks) {
  console.log(`\n[security-hardening] ${check.label}`);
  await runNode(check.args);
}

console.log("\nsecurity hardening verification passed");
