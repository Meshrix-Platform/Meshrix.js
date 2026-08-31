#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const TYPING_SUBSTRATE_OWNED_PATHS: readonly string[] = Object.freeze([
  ".oxlintrc.json",
  "tools/server-scripts/verify-no-explicit-any.ts",
  "packages/contracts/src/service-collaboration-contract.ts",
  "packages/contracts/src/service-collaboration-contract.d.ts",
  "packages/contracts/src/mcp-catalog-delivery.ts",
  "packages/contracts/src/mcp-catalog-delivery.d.ts",
  "packages/contracts/src/upstream-service-publishing.ts",
  "packages/contracts/src/upstream-service-publishing.d.ts",
  "packages/contracts/src/serialization",
  "packages/contracts/src/modules",
  "packages/contracts/src/fixtures",
  "packages/contracts/src/plugins/plugin-bundle-manifest.ts",
  "packages/contracts/src/plugins/plugin-package-receipt.ts",
  "packages/contracts/src/plugins/plugin-package-source.ts",
  "packages/contracts/src/plugins/plugin-package-state.ts",
  "packages/contracts/src/plugins/verified-plugin-package.ts",
  "packages/foundation/src/security/auth",
  "packages/foundation/src/security/secrets",
  "packages/foundation/src/security/risk-control",
  "packages/foundation/src/security/redaction",
  "packages/foundation/src/security/process-identity",
  "packages/foundation/src/security/artifact-signer-port.ts",
  "packages/foundation/src/security/client-strings.ts",
  "packages/foundation/src/security/closed-json-schema.ts",
  "packages/foundation/src/security/final-protected-sink-permit.ts",
  "packages/foundation/src/security/gateway-valkey-discipline.ts",
  "packages/foundation/src/security/gateway-valkey-provider.ts",
  "packages/foundation/src/security/governed-execution-permit-authority.ts",
  "packages/foundation/src/security/local-path-boundary.ts",
  "packages/foundation/src/security/operation-audit-common.ts",
  "packages/foundation/src/security/operation-audit-worker-store.ts",
  "packages/foundation/src/security/operation-audit-worker.ts",
  "packages/foundation/src/security/operation-audit.ts",
  "packages/foundation/src/security/outbound-egress-policy.ts",
  "packages/foundation/src/security/production-ingress-contract.ts",
  "packages/foundation/src/security/register.ts",
  "packages/foundation/src/security/security-alerts.ts",
  "packages/foundation/src/security/security-permissions-provider.ts",
  "packages/foundation/src/security/trusted-client-ip.ts",
  "packages/foundation/src/security/authorization/api-key-issuer-authority.ts",
  "packages/foundation/src/security/authorization/api-key-verifier-key-provider.ts",
  "packages/foundation/src/security/authorization/authorization-capabilities.ts",
  "packages/foundation/src/security/authorization/authorization-engine-common.ts",
  "packages/foundation/src/security/authorization/authorization-engine-support.ts",
  "packages/foundation/src/security/authorization/authorization-engine.ts",
  "packages/foundation/src/security/authorization/authorization-governance-store-support.ts",
  "packages/foundation/src/security/authorization/authorization-governance-store.ts",
  "packages/foundation/src/security/authorization/authorization-resource-context.ts",
  "packages/foundation/src/security/authorization/authorization-store-worker-owner.ts",
  "packages/foundation/src/security/authorization/authorization-store-worker.ts",
  "packages/foundation/src/security/authorization/authorization-store.ts",
  "packages/foundation/src/security/authorization/capability-binding-guard-backends.ts",
  "packages/foundation/src/security/authorization/capability-binding-guard-core.ts",
  "packages/foundation/src/security/authorization/capability-binding-guard.ts",
  "packages/foundation/src/security/authorization/capability-kernel-status.ts",
  "packages/foundation/src/security/authorization/capability-security-helper-client.ts",
  "packages/foundation/src/security/authorization/opaque-capability-key-backends.ts",
  "packages/foundation/src/security/authorization/opaque-capability-key-core.ts",
  "packages/foundation/src/security/authorization/opaque-capability-key-provider.ts",
  "packages/foundation/src/security/authorization/opaque-capability-key-store.ts",
  "packages/foundation/src/security/authorization/opaque-capability-key.ts",
  "packages/foundation/src/security/authorization/organization-model.ts",
  "packages/foundation/src/security/authorization/pdp",
  "packages/foundation/src/security/authorization/tag-store-provider-registry.ts",
  "packages/foundation/src/security/authorization/tag-store.port.ts",
  "packages/foundation/src/security/authorization/tag-tree.ts",
  "packages/foundation/src/security/authorization/universal-tag-policy.ts"
]);

export const NEW_TYPESCRIPT_SCOPE: readonly string[] = Object.freeze([
  "tools/server-scripts/verify-no-explicit-any.ts",
  "tools/server-scripts/localize-verify-failure.ts",
  "tests/vitest/server/acceptance-gate-provenance.test.ts",
  "tests/vitest/server/verify-failure-localization.test.ts",
  "tests/vitest/server/delivery-typing-substrate.test.ts"
]);

export const EXCLUDED_SUFFIXES: readonly string[] = Object.freeze([".d.ts"]);
export const EXCLUDED_PATH_MARKERS: readonly string[] = Object.freeze([
  "packages/contracts/src/generated/",
  "packages/foundation/src/security/authorization/generated-capabilities.ts"
]);

export interface ExplicitAnyFinding {
  file: string;
  line: number;
  column: number;
  text: string;
}

const EXPLICIT_ANY_PATTERNS: readonly RegExp[] = Object.freeze([
  /:\s*a[n]y\b/u,
  /\bas a[n]y\b/u,
  /<a[n]y>/u,
  /<a[n]y,/u,
  /\ba[n]y\[\]/u,
  /\b(?:Array|ReadonlyArray|Promise|Set|Map|WeakSet|WeakMap|Record|Readonly|Partial|Required|Awaited)<[^>]*\ba[n]y\b/u
]);

function stripStringsAndComments(line: string): string {
  let output = "";
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      output += " ";
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      output += " ";
      continue;
    }
    if (character === "/" && line[index + 1] === "/") {
      break;
    }
    output += character;
  }
  return output;
}

export function explicitAnyFindings(source: string, relativePath: string): ExplicitAnyFinding[] {
  const findings: ExplicitAnyFinding[] = [];
  const lines = String(source || "").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const text = stripStringsAndComments(lines[index]);
    for (const pattern of EXPLICIT_ANY_PATTERNS) {
      const match = pattern.exec(text);
      if (match) {
        findings.push({
          file: relativePath,
          line: index + 1,
          column: match.index + 1,
          text: text.trim().slice(0, 160)
        });
        break;
      }
    }
  }
  return findings;
}

export function isExcludedFile(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  if (EXCLUDED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;
  return EXCLUDED_PATH_MARKERS.some((marker) => normalized.startsWith(marker));
}

async function expandToFiles(root: string, relativePath: string): Promise<string[]> {
  const absolute = path.join(root, relativePath);
  const stats = await fs.stat(absolute);
  if (stats.isFile()) return [relativePath];
  if (!stats.isDirectory()) return [];
  const files: string[] = [];
  const pending: string[] = [relativePath];
  while (pending.length > 0) {
    const current = pending.pop() ?? "";
    const entries = await fs.readdir(path.join(root, current), { withFileTypes: true });
    for (const entry of entries) {
      const child = current ? `${current}/${entry.name}` : entry.name;
      const childAbsolute = path.join(root, child);
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (entry.isFile() && child.endsWith(".ts")) {
        files.push(child);
      } else if (entry.isSymbolicLink() && (await fs.stat(childAbsolute)).isFile() && child.endsWith(".ts")) {
        files.push(child);
      }
    }
  }
  return files.sort();
}

export async function scanNoExplicitAny({
  root = repoRoot,
  includePaths = [...TYPING_SUBSTRATE_OWNED_PATHS, ...NEW_TYPESCRIPT_SCOPE]
}: Record<string, unknown> = {}): Promise<{ findings: ExplicitAnyFinding[]; scannedFiles: string[] }> {
  const resolvedRoot = path.resolve(String(root || repoRoot));
  const scannedFiles = new Set<string>();
  const findings: ExplicitAnyFinding[] = [];
  for (const entry of includePaths as string[]) {
    if (entry.endsWith(".json") || entry.endsWith(".md") || isExcludedFile(entry)) continue;
    let files: string[];
    try {
      files = await expandToFiles(resolvedRoot, entry);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
    for (const file of files) {
      if (isExcludedFile(file)) continue;
      scannedFiles.add(file);
      const source = await fs.readFile(path.join(resolvedRoot, file), "utf8");
      findings.push(...explicitAnyFindings(source, file));
    }
  }
  return { findings, scannedFiles: [...scannedFiles].sort() };
}

async function assertOxlintConfig(root: string): Promise<void> {
  const config = JSON.parse(
    await fs.readFile(path.join(root, ".oxlintrc.json"), "utf8")
  ) as { rules?: Record<string, unknown> };
  const rule = config.rules?.["typescript/no-explicit-any"];
  if (rule !== "error" && !(Array.isArray(rule) && rule[0] === "error")) {
    throw new Error("verify-no-explicit-any: .oxlintrc.json must deny typescript/no-explicit-any");
  }
}

async function main(): Promise<void> {
  await assertOxlintConfig(repoRoot);
  const { findings, scannedFiles } = await scanNoExplicitAny({ root: repoRoot });
  if (findings.length > 0) {
    for (const finding of findings.slice(0, 40)) {
      process.stderr.write(
        `${finding.file}:${finding.line}:${finding.column}: explicit any: ${finding.text}\n`
      );
    }
    process.stderr.write(`verify-no-explicit-any: ${findings.length} explicit any finding(s)\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `verify-no-explicit-any: ok files=${scannedFiles.length} batch=${TYPING_SUBSTRATE_OWNED_PATHS.length}\n`
  );
}

const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error: unknown) => {
    process.stderr.write(`[verify-no-explicit-any] ${String((error as Error)?.message || error)}\n`);
    process.exitCode = 1;
  });
}
