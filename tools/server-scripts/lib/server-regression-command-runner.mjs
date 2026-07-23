import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function commandDisplay(entry) {
  if (entry.script) {
    return `npm run ${entry.script}`;
  }
  if (entry.file) {
    return `node ${[entry.file, ...(entry.args || [])].join(" ")}`.trim();
  }
  return [entry.command, ...(entry.args || [])].filter(Boolean).join(" ");
}

export function npmScript(id, script) {
  return Object.freeze({
    id,
    kind: "npm-script",
    script,
    displayCommand: `npm run ${script}`
  });
}

export function nodeScript(id, file, args = []) {
  return Object.freeze({
    id,
    kind: "node-script",
    file,
    args: Object.freeze([...args]),
    displayCommand: `node ${[file, ...args].join(" ")}`.trim()
  });
}

function spawnForEntry(entry) {
  if (entry.kind === "npm-script") {
    return {
      command: npmCommand,
      args: ["run", entry.script]
    };
  }
  if (entry.kind === "node-script") {
    return {
      command: process.execPath,
      args: [entry.file, ...(entry.args || [])]
    };
  }
  return {
    command: entry.command,
    args: entry.args || []
  };
}

function resultForEntry(entry, overrides = {}) {
  return {
    id: entry.id,
    kind: entry.kind || "command",
    script: entry.script || undefined,
    file: entry.file || undefined,
    displayCommand: entry.displayCommand || commandDisplay(entry),
    ...overrides
  };
}

async function runCommand(entry) {
  const startedAt = Date.now();
  const childCommand = spawnForEntry(entry);
  return new Promise((resolve) => {
    const child = spawn(childCommand.command, childCommand.args, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    });
    child.on("close", (code) => {
      resolve(resultForEntry(entry, {
        status: code === 0 ? "passed" : "failed",
        exitCode: code ?? 1,
        elapsedMs: Date.now() - startedAt
      }));
    });
    child.on("error", () => {
      resolve(resultForEntry(entry, {
        status: "failed",
        exitCode: 1,
        elapsedMs: Date.now() - startedAt
      }));
    });
  });
}

async function writeReport(reportPath, report) {
  const absoluteReportPath = path.join(repoRoot, reportPath);
  await fs.mkdir(path.dirname(absoluteReportPath), { recursive: true });
  const temp = `${absoluteReportPath}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.rename(temp, absoluteReportPath);
}

export async function runRegressionCommandGroup({
  argv = process.argv.slice(2),
  commands,
  excludedCommands = [],
  exclusionReason = "",
  extraReportFields = {},
  groupId,
  reportPath,
  schemaVersion = "licomesh.server-regression-command-group.report.v1",
  verifier
}) {
  if (argv.includes("--list")) {
    for (const entry of commands) {
      console.log(`${entry.id}: ${entry.displayCommand || commandDisplay(entry)}`);
    }
    return 0;
  }

  const startedAt = new Date().toISOString();
  const results = [];
  console.log(`[${groupId}] starting verification`);
  for (const entry of commands) {
    console.log(`[${groupId}] RUN ${entry.id} (${entry.displayCommand || commandDisplay(entry)})`);
    const result = await runCommand(entry);
    results.push(result);
    console.log(`[${groupId}] ${result.status.toUpperCase()} ${entry.id} (${result.elapsedMs}ms)`);
  }

  const failed = results.filter((result) => result.status !== "passed");
  const report = {
    schemaVersion,
    verifier,
    groupId,
    startedAt,
    finishedAt: new Date().toISOString(),
    commandCount: results.length,
    failedCommandCount: failed.length,
    verificationPassed: failed.length === 0,
    excludedCommands: [...excludedCommands],
    exclusionReason,
    ...extraReportFields,
    results
  };
  await writeReport(reportPath, report);
  console.log(`[${groupId}] report=${reportPath}`);

  if (failed.length > 0) {
    for (const result of failed) {
      console.error(`[${groupId}] failed: ${result.id} ${result.displayCommand} exitCode=${result.exitCode}`);
    }
    return 1;
  }

  console.log(`[${groupId}] ok`);
  return 0;
}
