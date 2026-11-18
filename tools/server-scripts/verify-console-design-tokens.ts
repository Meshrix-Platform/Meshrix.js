#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath: any = path.join(repoRoot, "build", "reports", "console-design-tokens.json");
const allowlistPath: any = path.join(repoRoot, "tools", "server-scripts", "console-design-tokens-allowlist.json");
const scanRoot: any = "apps/console";
// Hex rule definition sites: raw hex is legitimate only where tokens are defined.
const hexDefinitionSites: readonly any[] = Object.freeze([
  "apps/console/styles/tokens.css",
  "apps/console/appearance-presets/",
  "apps/console/lib/appearance-preset-config.ts"
]);
const presetDirectory: any = path.join(repoRoot, "apps", "console", "appearance-presets");
const derivedTokenConfigPath: any = path.join(repoRoot, "apps", "console", "lib", "appearance-preset-config.ts");

const hexColorPattern: any = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/gu;
const pxDeclarationPattern: any = /\b((?:padding|margin|gap|font-size|border-radius)(?:-[a-z]+)*)\s*:\s*([^;}]+)/gu;
const pxValuePattern: any = /\b\d+(?:\.\d+)?px\b/u;
const tokenReferencePattern: any = /var\(\s*(--[\w-]+)/gu;
// Declarations: custom property at a statement position. The lookbehind keeps pseudo-selectors
// such as ".el-table--border::before" from masquerading as a "--border" declaration, and the
// lookahead rejects the first colon of "::before"-style pseudo syntax.
const tokenDeclarationPattern: any = /(?<![\w-])(--[\w-]+)\s*:(?!:)/gu;
const setPropertyPattern: any = /setProperty\(\s*["'`](--[\w-]+)["'`]/gu;
// Quoted keys in JS/TS style objects (":style" bindings, setProperty-style records) also define
// a custom property at runtime.
const quotedTokenKeyPattern: any = /["'`](--[\w-]+)["'`]\s*:/gu;
const inlineStylePattern: any = /(?<![:\w.-])style\s*=\s*["']/gu;
const derivedKeyPattern: any = /^\s*(?:"([\w-]+)"|([a-zA-Z][\w-]*))\s*:/gmu;

async function walk(relativeDir?: any) : Promise<any> {
  const absoluteDir: any = path.join(repoRoot, relativeDir);
  const entries: any = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() : any => []);
  const files: any[] = [];
  for (const entry of entries) {
    const relativePath: any = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await walk(relativePath));
    } else if (/\.(vue|ts|css)$/u.test(entry.name)) {
      files.push(relativePath);
    }
  }
  return files;
}

function lineNumber(source: any = "", index: any = 0) : any {
  return source.slice(0, index).split(/\r?\n/u).length;
}

function isHexDefinitionSite(file: any = "") : any {
  return hexDefinitionSites.some((site: any) : any =>
    site.endsWith("/") ? file.startsWith(site) : file === site
  );
}

async function collectPresetTokenNames(universe: any) : Promise<any> {
  const entries: any = await fs.readdir(presetDirectory, { withFileTypes: true }).catch(() : any => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const raw: any = await fs.readFile(path.join(presetDirectory, entry.name), "utf8");
    const preset: any = JSON.parse(raw);
    for (const key of Object.keys(preset.tokens || {})) {
      universe.add(`--${key}`);
    }
  }
}

async function collectDerivedTokenNames(universe: any) : Promise<any> {
  const source: any = await fs.readFile(derivedTokenConfigPath, "utf8").catch(() : any => "");
  const returnStart: any = source.indexOf("return {");
  const returnEnd: any = returnStart < 0 ? -1 : source.indexOf("\n  };", returnStart);
  if (returnStart < 0 || returnEnd < 0) {
    return;
  }
  const block: any = source.slice(returnStart, returnEnd);
  for (const match of block.matchAll(derivedKeyPattern)) {
    universe.add(`--${match[1] || match[2]}`);
  }
}

function countByKind(findings: any = []) : any {
  const counts: Record<string, any> = {};
  for (const finding of findings) {
    counts[finding.code] = (counts[finding.code] || 0) + 1;
  }
  return counts;
}

await fs.mkdir(path.dirname(reportPath), { recursive: true });
const files: any = (await walk(scanRoot)).sort();

const tokenUniverse: any = new Set<any>();
await collectPresetTokenNames(tokenUniverse);
await collectDerivedTokenNames(tokenUniverse);
const sources: any = new Map<any, any>();
for (const file of files) {
  const source: any = await fs.readFile(path.join(repoRoot, file), "utf8");
  sources.set(file, source);
  for (const match of source.matchAll(tokenDeclarationPattern)) {
    tokenUniverse.add(match[1]);
  }
  for (const match of source.matchAll(setPropertyPattern)) {
    tokenUniverse.add(match[1]);
  }
  for (const match of source.matchAll(quotedTokenKeyPattern)) {
    tokenUniverse.add(match[1]);
  }
}

const findings: any[] = [];
for (const file of files) {
  const source: any = sources.get(file);
  if (!isHexDefinitionSite(file)) {
    for (const match of source.matchAll(hexColorPattern)) {
      findings.push({
        severity: "error",
        code: "raw-hex-color",
        file,
        line: lineNumber(source, match.index || 0),
        message: "Raw hex colors belong in the token definition sites (styles/tokens.css, appearance-presets/, lib/appearance-preset-config.ts); consume a token instead."
      });
    }
  }
  for (const match of source.matchAll(pxDeclarationPattern)) {
    if (!pxValuePattern.test(match[2])) {
      continue;
    }
    findings.push({
      severity: "error",
      code: "raw-px-dimension",
      file,
      line: lineNumber(source, match.index || 0),
      message: `Raw px in "${match[1]}" bypasses the spacing/radius/type token scale; use the tokens defined in styles/tokens.css.`
    });
  }
  for (const match of source.matchAll(tokenReferencePattern)) {
    if (tokenUniverse.has(match[1])) {
      continue;
    }
    findings.push({
      severity: "error",
      code: "undefined-token",
      file,
      line: lineNumber(source, match.index || 0),
      message: `var(${match[1]}) references a token defined nowhere (tokens.css, appearance presets, derived preset tokens, or local declarations); dead references render broken fallbacks.`
    });
  }
  if (file.endsWith(".vue") || file.endsWith(".ts")) {
    for (const match of source.matchAll(inlineStylePattern)) {
      findings.push({
        severity: "error",
        code: "inline-style-attribute",
        file,
        line: lineNumber(source, match.index || 0),
        message: "Inline style= attributes bypass the token scale; move the declaration into a scoped style or shared stylesheet (dynamic :style bindings are exempt)."
      });
    }
  }
}

// Frozen allowlist semantics (Architecture.md §3.2): absent file == empty allowlist;
// a stale entry (no current violation in that file) fails the gate; only N21 shrinks it.
const allowlistRaw: any = await fs.readFile(allowlistPath, "utf8").catch(() : any => null);
const allowlist: any = allowlistRaw === null ? [] : (JSON.parse(allowlistRaw).files || []);
const allowlisted: any = new Set<any>(allowlist);
const blockingFindings: any = findings.filter((finding: any) : any => !allowlisted.has(finding.file));
const suppressedFindings: any = findings.filter((finding: any) : any => allowlisted.has(finding.file));
const violatedFiles: any = new Set<any>(findings.map((finding: any) : any => finding.file));
const staleAllowlistEntries: any = allowlist.filter((file: any) : any => !violatedFiles.has(file));
const staleFindings: any = staleAllowlistEntries.map((file: any) : any => ({
  severity: "error",
  code: "stale-allowlist-entry",
  file,
  line: 0,
  message: "Allowlist entry no longer matches any violation; the allowlist is ratchet-only, so the entry must be removed (only N21 may shrink, empty, and delete the allowlist)."
}));

const reportFindings: any = [
  ...blockingFindings,
  ...staleFindings,
  ...suppressedFindings.map((finding: any) : any => ({ ...finding, severity: "warning", suppressed: true }))
];
const report: Record<string, any> = {
  schemaVersion: "v0.0.1:console:design-tokens-report-1",
  generatedAt: new Date().toISOString(),
  verifier: "tools/server-scripts/verify-console-design-tokens.ts",
  allowlist: "tools/server-scripts/console-design-tokens-allowlist.json",
  summary: {
    releaseReady: blockingFindings.length === 0 && staleAllowlistEntries.length === 0,
    reportLeakScan: true,
    scannedFileCount: files.length,
    tokenUniverseSize: tokenUniverse.size,
    allowlistEntryCount: allowlist.length,
    staleAllowlistEntryCount: staleAllowlistEntries.length,
    findingCount: findings.length,
    blockingFindingCount: blockingFindings.length,
    suppressedFindingCount: suppressedFindings.length,
    suppressedFileCount: new Set<any>(suppressedFindings.map((finding: any) : any => finding.file)).size,
    findingCountByKind: countByKind(findings),
    blockingFindingCountByKind: countByKind(blockingFindings)
  },
  scopeNotes: [
    "raw-px-dimension covers padding, margin, gap, font-size, and border-radius declarations only; raw px in border and border-width declarations is intentionally out of scope until the border-width token category exists (design-token-gate.md §8).",
    "raw-hex-color excludes the token definition sites: apps/console/styles/tokens.css, apps/console/appearance-presets/, and apps/console/lib/appearance-preset-config.ts.",
    "undefined-token resolves var(--x) with any fallback argument stripped; --x is defined when declared in any scanned source, set via setProperty(), present as an appearance-preset token key, or derived in lib/appearance-preset-config.ts.",
    "inline-style-attribute matches style= in templates; dynamic :style bindings are exempt.",
    "Allowlist lifecycle (frozen handoff 2): an absent allowlist file equals an empty allowlist; entries are file-granular and ratchet-only; only N21 (token-gap-closure) may shrink, empty, and delete it."
  ],
  findings: reportFindings
};

assert.equal(JSON.stringify(report).includes(repoRoot), false, "console design-token report leaked repo path");
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (blockingFindings.length > 0 || staleAllowlistEntries.length > 0) {
  const blockingFiles: any = [...new Set<any>(blockingFindings.map((finding: any) : any => finding.file))].sort();
  const perFile: any = blockingFiles.map((file: any) : any => {
    const kinds: any = countByKind(blockingFindings.filter((finding: any) : any => finding.file === file));
    const detail: any = Object.entries(kinds).map(([kind, count]: any) : any => `${kind}×${count}`).join(", ");
    return `${file} (${detail})`;
  });
  const parts: any = [
    `Console design-token gate failed: ${blockingFindings.length} blocking findings in ${blockingFiles.length} files`,
    ...perFile
  ];
  if (staleAllowlistEntries.length > 0) {
    parts.push(`stale allowlist entries: ${staleAllowlistEntries.join(", ")}`);
  }
  throw new Error(parts.join("\n  "));
}
console.log(`[console-design-tokens] ok (scanned ${files.length} files, suppressed ${suppressedFindings.length} findings via ${allowlist.length} allowlist entries)`);
