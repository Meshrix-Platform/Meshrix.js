#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LocalizedFailure {
  assertion: string;
  file: string;
  command: string;
  line: number;
}

const COMMAND_LABEL = "npm run verify";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function trimLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function fileCandidate(value: string, root: string = repoRoot): string {
  const trimmed = trimLine(value);
  const match = trimmed.match(/(?:at\s+)?([^\s(]+\.(?:tsx?|mts|cts|jsx?|mjs|cjs|vue|json))(?::(\d+))?(?::\d+)?/u);
  if (!match) return "";
  let candidate = match[1].replace(/^file:\/\//u, "");
  candidate = candidate.replace(`${root.replaceAll("\\", "/")}/`, "");
  candidate = candidate.replace(`${root}/`, "");
  if (candidate.startsWith("node:") || candidate.includes("node_modules")) return "";
  return candidate;
}

function assertionFromLine(value: string): string {
  const trimmed = trimLine(value);
  const oxlint = trimmed.match(/.*\b(no-explicit-any)\b[^:]*:?\s*(.*)$/u);
  if (oxlint) return `${oxlint[1]}: ${oxlint[2] || ""}`.slice(0, 200);
  const tsc = trimmed.match(/(error TS\d+):\s*(.+)$/u);
  if (tsc) return `${tsc[1]}: ${tsc[2]}`.slice(0, 200);
  const generic = trimmed.match(
    /(?:AssertionError|Error|TypeError|ReferenceError|warning)\s*:?\s*(.+)$/u
  );
  if (generic) return generic[1].slice(0, 200);
  return trimmed.slice(0, 200);
}

export function parseFailureLog(logText: string, command: string = COMMAND_LABEL): LocalizedFailure[] {
  const failures: LocalizedFailure[] = [];
  const lines = String(logText || "").split(/\r?\n/u);
  let pendingFile = "";
  let pendingLine = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const file = fileCandidate(line);
    if (file) {
      pendingFile = file;
      const lineMatch = line.match(/:(\d+)/u);
      pendingLine = Number(lineMatch?.[1] || 0);
    }
    const isFailureHeading =
      line.startsWith("FAIL ") ||
      /\berror TS\d+/u.test(line) ||
      /\bno-explicit-any\b/u.test(line) ||
      line.startsWith("Error:") ||
      line.startsWith("AssertionError") ||
      line.startsWith("TypeError") ||
      line.startsWith("ReferenceError") ||
      line.includes("oxlint");
    if (!isFailureHeading) continue;
    const next: LocalizedFailure = {
      assertion: assertionFromLine(line),
      file: pendingFile || "",
      command,
      line: pendingLine
    };
    const previous = failures[failures.length - 1];
    if (previous && previous.file === next.file &&
        (previous.assertion === previous.file || previous.assertion === "" ||
         previous.assertion.startsWith("FAIL "))) {
      failures[failures.length - 1] = next;
    } else {
      failures.push(next);
    }
  }
  return failures;
}

export function formatLocalizedFailures(failures: LocalizedFailure[]): string {
  if (failures.length === 0) return "no-failure-facts-found";
  return failures
    .map((failure) => [
      `assertion: ${failure.assertion}`,
      `file: ${failure.file || "<unknown>"}`,
      `command: ${failure.command}`
    ].join("\n"))
    .join("\n\n");
}

async function readLogInput(argument: string | undefined): Promise<string> {
  if (argument) return fs.readFile(path.resolve(argument), "utf8");
  return new Promise<string>((resolve) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
    });
    process.stdin.on("end", () => resolve(buffer));
    process.stdin.on("error", () => resolve(""));
  });
}

interface CliArguments {
  command: string;
  logPath?: string;
  selfTest: boolean;
  help: boolean;
}

function parseArguments(argv: string[]): CliArguments {
  let command = COMMAND_LABEL;
  let logPath: string | undefined;
  let selfTest = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--command") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--command requires a value");
      command = value;
      index += 1;
    } else if (argument === "--self-test") {
      selfTest = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument.startsWith("--") || logPath) {
      throw new Error(`unsupported argument: ${argument}`);
    } else {
      logPath = argument;
    }
  }
  return { command, logPath, selfTest, help };
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const arguments_ = parseArguments(argv);
  if (arguments_.help) {
    process.stdout.write(
      "localize-verify-failure: reads a verification log from a file argument or stdin; --command records the exact failed command.\n"
    );
    return;
  }
  if (arguments_.selfTest) {
    const fixture = [
      "FAIL tests/vitest/server/example.test.ts",
      "AssertionError: expected 1 to equal 2",
      "at /repo/tests/vitest/server/example.test.ts:12:3"
    ].join("\n");
    const parsed = parseFailureLog(fixture, "npm run vitest");
    if (parsed.length !== 1 || !parsed[0].assertion.includes("expected 1 to equal 2")) {
      throw new Error("localize-verify-failure self-test failed");
    }
    process.stdout.write("localize-verify-failure: self-test ok\n");
    return;
  }
  const logText = await readLogInput(arguments_.logPath);
  const failures = parseFailureLog(logText, arguments_.command);
  if (failures.length > 0) {
    process.stderr.write(`${formatLocalizedFailures(failures)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${formatLocalizedFailures(failures)}\n`);
}

const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error: unknown) => {
    process.stderr.write(`[localize-verify-failure] ${String((error as Error)?.message || error)}\n`);
    process.exitCode = 1;
  });
}
