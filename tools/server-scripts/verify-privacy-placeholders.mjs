#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const selfPath = path.relative(root, new URL(import.meta.url).pathname);

const scanRoots = ["apps", "packages", "crates", "content", "fixtures", "docs", "tests"];
const ignoredDirectories = new Set([
  ".git",
  ".meshrix-server-data",
  "node_modules",
  "build",
  "dist",
  "coverage",
  ".cache"
]);
const textExtensions = new Set([
  ".css",
  ".eml",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".yaml",
  ".yml"
]);

const bannedPatterns = [
  {
    label: "real financial institution placeholder",
    pattern: /HSBC|汇丰|招商银行|信用卡电子账单|\bMonzo\b/i
  },
  {
    label: "personal billing placeholder",
    pattern: /最近的账单|查找最近账单|帮我找最近的账单|最近有哪些账单|3 月账单|三月账单|HSBC 账单|invoice-march/i
  }
];

async function* walk(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute);
    if (relative === selfPath) {
      continue;
    }
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }
      yield* walk(absolute);
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(path.extname(entry.name))) {
      continue;
    }
    yield absolute;
  }
}

function findViolations(filePath, text) {
  const lines = text.split(/\r?\n/);
  const violations = [];
  lines.forEach((line, index) => {
    for (const banned of bannedPatterns) {
      if (banned.pattern.test(line)) {
        violations.push({
          filePath,
          line: index + 1,
          label: banned.label,
          text: line.trim()
        });
      }
    }
  });
  return violations;
}

const allViolations = [];
for (const scanRoot of scanRoots) {
  for await (const filePath of walk(path.join(root, scanRoot))) {
    const text = await fs.readFile(filePath, "utf8");
    allViolations.push(...findViolations(filePath, text));
  }
}

if (allViolations.length > 0) {
  console.error("privacy placeholder verification failed");
  for (const violation of allViolations.slice(0, 50)) {
    console.error(
      `${path.relative(root, violation.filePath)}:${violation.line} ${violation.label}: ${violation.text}`
    );
  }
  if (allViolations.length > 50) {
    console.error(`... ${allViolations.length - 50} more violations`);
  }
  process.exit(1);
}

console.log("privacy placeholder verification passed");
