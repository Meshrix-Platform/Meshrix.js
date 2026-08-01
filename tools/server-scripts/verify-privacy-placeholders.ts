#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root: any = process.cwd();
const selfPath: any = path.relative(root, new URL(import.meta.url).pathname);

const scanRoots: any[] = ["apps", "packages", "crates", "content", "fixtures", "docs", "tests"];
const ignoredDirectories: any = new Set<any>([
  ".git",
  ".meshrix-server-data",
  "node_modules",
  "build",
  "dist",
  "coverage",
  ".cache"
]);
const textExtensions: any = new Set<any>([
  ".css",
  ".eml",
  ".html",
  ".js",
  ".json",
  ".md",
  ".ts",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".yaml",
  ".yml"
]);

const bannedPatterns: any[] = [
  {
    label: "real financial institution placeholder",
    pattern: /HSBC|汇丰|招商银行|信用卡电子账单|\bMonzo\b/i
  },
  {
    label: "personal billing placeholder",
    pattern: /最近的账单|查找最近账单|帮我找最近的账单|最近有哪些账单|3 月账单|三月账单|HSBC 账单|invoice-march/i
  }
];

async function* walk(dir?: any) : AsyncGenerator<any, any, any> {
  let entries: any[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const absolute: any = path.join(dir, entry.name);
    const relative: any = path.relative(root, absolute);
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

function findViolations(filePath?: any, text?: any) : any {
  const lines: any = text.split(/\r?\n/);
  const violations: any[] = [];
  lines.forEach((line?: any, index?: any) : any => {
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

const allViolations: any[] = [];
for (const scanRoot of scanRoots) {
  for await (const filePath of walk(path.join(root, scanRoot))) {
    const text: any = await fs.readFile(filePath, "utf8");
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
