#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath: any = path.join(repoRoot, "build", "reports", "console-component-reuse.json");
const tierAllowlistPath: any = path.join(repoRoot, "tools", "server-scripts", "console-component-reuse-tier-bootstrap-allowlist.json");
const destructiveAllowlistPath: any = path.join(repoRoot, "tools", "server-scripts", "console-component-reuse-destructive-coverage-bootstrap-allowlist.json");
const scanRoot: any = "apps/console";
const componentsRoot: any = "apps/console/components";
const emptyStateComponent: any = "apps/console/components/ConsoleEmptyState.vue";
const commonModulePath: any = "apps/console/components/common.ts";
const featureRegistryPath: any = "apps/console/components/feature-registry.ts";
const destructiveRegistryPath: any = "apps/console/composables/console-destructive-operation-registry.ts";
// Test seam for the destructive-coverage family: while REQ-010's registry is a scaffold, an
// override path lets the coverage evaluation be exercised without touching the owned module.
const destructiveRegistryOverride: any = process.env.CONSOLE_COMPONENT_REUSE_DESTRUCTIVE_REGISTRY_PATH || "";

// Family 2 legacy set: files whose hand-rolled empty blocks predate this gate. Converting them
// was landed item 1.4's job and is a declared non-goal of this plan, so this is a permanent
// grandfather list (NOT a ratchet) — the gate only prevents NEW hand-rolled blocks.
const legacyEmptyBlockFiles: readonly any[] = Object.freeze([
  "apps/console/components/admin/agent-config/AgentModelLibraryPanel.vue",
  "apps/console/components/admin/authorization-governance/AuthorizationGovernancePanel.vue",
  "apps/console/components/admin/maintenance-agent/MaintenanceAgentPolicyPanel.vue",
  "apps/console/components/admin/operation-permission/ToolGrantCreateCard.vue",
  "apps/console/components/AgentModelOptionBar.vue",
  "apps/console/components/approval/ApprovalFlowCardList.vue",
  "apps/console/components/dashboard/DashboardPluginCard.vue",
  "apps/console/components/MultiChoiceCardGroup.vue",
  "apps/console/components/shell/ConsoleCommandPalette.vue",
  "apps/console/components/shell/side-nav/ConsoleSideNavDirectory.vue",
  "apps/console/components/UploadFileListCard.vue",
  "apps/console/views/admin/ApiKeyDistributionView.vue",
  "apps/console/views/admin/context-management/ContextBuildRecordCard.vue",
  "apps/console/views/admin/organization-governance/OrganizationAdministratorRoles.vue",
  "apps/console/views/admin/tools/ToolCatalogSearch.vue",
  "apps/console/views/admin/UpstreamGatewayView.vue",
  "apps/console/views/admin/VersionAssemblyView.vue",
  "apps/console/views/DashboardView.vue"
]);

const nativeDialogPattern: any = /(?:^|[^\w$.])(?:window\.)?(?:alert|confirm)\s*\(/u;
const emptyClassPattern: any = /(?<![\w:-])class\s*=\s*("|')[^"']*\bempty\b[^"']*\1/gu;
const openTagPattern: any = /<([A-Za-z][\w.-]*)[^<>]*$/u;
const registryEntryBlockPattern: any = /\{[^{}]*\bfile:\s*"([^"]+)"[^{}]*\}/gu;
const tierFieldPattern: any = /\btier\s*:/u;
const featurePathPattern: any = /["'`]((?:apps\/console\/)?components\/[^"'`]+\.vue)["'`]/gu;
const destructiveIdPattern: any = /\bid:\s*"([^"]+)"/gu;
const confirmCallPattern: any = /\b(?:requestDestructiveConfirm|requestConsoleConfirm|confirmConsoleAction)\s*\(/u;
const destructiveCallSitePattern: any = /\brequestDestructiveConfirm\s*\(\s*["'`]([^"'`]+)["'`]/gu;

async function walk(relativeDir?: any, extensions?: any) : Promise<any> {
  const absoluteDir: any = path.join(repoRoot, relativeDir);
  const entries: any = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() : any => []);
  const files: any[] = [];
  for (const entry of entries) {
    const relativePath: any = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await walk(relativePath, extensions));
    } else if (extensions.test(entry.name)) {
      files.push(relativePath);
    }
  }
  return files;
}

function lineNumber(source: any = "", index: any = 0) : any {
  return source.slice(0, index).split(/\r?\n/u).length;
}

async function readOptional(relativePath?: any) : Promise<any> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8").catch(() : any => null);
}

async function readAllowlist(absolutePath?: any, key?: any) : Promise<any> {
  const raw: any = await fs.readFile(absolutePath, "utf8").catch(() : any => null);
  if (raw === null) {
    return [];
  }
  return JSON.parse(raw)[key] || [];
}

function normalizeComponentPath(value: any = "") : any {
  return value.startsWith("apps/console/") ? value : `apps/console/${value}`;
}

function countByKind(findings: any = []) : any {
  const counts: Record<string, any> = {};
  for (const finding of findings) {
    counts[finding.code] = (counts[finding.code] || 0) + 1;
  }
  return counts;
}

await fs.mkdir(path.dirname(reportPath), { recursive: true });
const codeFiles: any = (await walk(scanRoot, /\.(vue|ts)$/u)).sort();
const vueFiles: any = codeFiles.filter((file: any) : any => file.endsWith(".vue"));
const componentFiles: any = (await walk(componentsRoot, /\.vue$/u)).sort();
const sources: any = new Map<any, any>();
for (const file of codeFiles) {
  sources.set(file, await fs.readFile(path.join(repoRoot, file), "utf8"));
}

const findings: any[] = [];

// Family 1 — no native alert()/confirm() dialogs (confirm rule: common.ts ConsoleConfirmDialog
// entry). Starts clean by inspection; it has NO allowlist — any call is blocking. Comment lines
// are skipped so prose examples cannot trip the statement-position call shape.
for (const file of codeFiles) {
  const lines: any = sources.get(file).split(/\r?\n/u);
  lines.forEach((line?: any, index?: any) : any => {
    const trimmed: any = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      return;
    }
    if (nativeDialogPattern.test(line)) {
      findings.push({
        severity: "error",
        code: "native-dialog-call",
        file,
        line: index + 1,
        message: "Native alert()/confirm() dialogs are forbidden; route confirmations through requestConsoleConfirm/confirmConsoleAction (ConsoleConfirmDialog usage rule)."
      });
    }
  });
}

// Family 2 — no NEW hand-rolled class="*empty*" blocks; use ConsoleEmptyState. Matches inside
// ConsoleEmptyState.vue itself and inside <ConsoleEmptyState ...> tags are exempt; the legacy
// grandfather files above are suppressed, everything else is blocking.
const legacyEmptySet: any = new Set<any>(legacyEmptyBlockFiles);
for (const file of vueFiles) {
  if (file === emptyStateComponent) {
    continue;
  }
  const source: any = sources.get(file);
  for (const match of source.matchAll(emptyClassPattern)) {
    const lookback: any = source.slice(Math.max(0, (match.index || 0) - 400), match.index || 0);
    const openTag: any = lookback.match(openTagPattern);
    if (openTag && openTag[1] === "ConsoleEmptyState") {
      continue;
    }
    findings.push({
      severity: "error",
      code: "hand-rolled-empty-block",
      file,
      line: lineNumber(source, match.index || 0),
      message: "Hand-rolled empty-state blocks are forbidden for new UI; render ConsoleEmptyState (with its #action slot) instead of a class=\"*empty*\" block."
    });
  }
}

// Family 3 — every components/**.vue file has a declared tier. Declaration sources (owned by
// N19, read-only here): common.ts Tier-2 registry entries once they carry a `tier` field, and
// feature-registry.ts Tier-3 records (component path literals). Absent data == all pending.
const declaredComponents: any = new Set<any>();
const commonSource: any = await readOptional(commonModulePath);
let commonDeclaredCount: any = 0;
if (commonSource !== null) {
  for (const match of commonSource.matchAll(registryEntryBlockPattern)) {
    if (!tierFieldPattern.test(match[0])) {
      continue;
    }
    const declared: any = normalizeComponentPath(match[1]);
    if (declared.endsWith(".vue")) {
      declaredComponents.add(declared);
      commonDeclaredCount += 1;
    }
  }
}
const featureRegistrySource: any = await readOptional(featureRegistryPath);
let featureDeclaredCount: any = 0;
if (featureRegistrySource !== null) {
  for (const match of featureRegistrySource.matchAll(featurePathPattern)) {
    declaredComponents.add(normalizeComponentPath(match[1]));
    featureDeclaredCount += 1;
  }
}
const undeclaredComponents: any = componentFiles.filter((file: any) : any => !declaredComponents.has(file));
for (const file of undeclaredComponents) {
  findings.push({
    severity: "error",
    code: "undeclared-component-tier",
    file,
    line: 0,
    message: "Every console component needs a declared tier (Tier 2 in common.ts, Tier 3 with owning feature in feature-registry.ts); pending declarations are tracked by the tier bootstrap allowlist until N19 lands them."
  });
}

// Family 4 — every destructive-operation registry entry routes through the confirm seam. The
// registry (owned by N10) is read-only here: entries are statically extracted `id` literals;
// adoption means a source file referencing the id AND calling
// requestDestructiveConfirm/requestConsoleConfirm/confirmConsoleAction. Absent registry ==
// coverage pending == vacuous pass tracked by the destructive-coverage bootstrap allowlist.
const destructiveRegistrySource: any = await readOptional(destructiveRegistryOverride || destructiveRegistryPath);
const registryIds: any = destructiveRegistrySource === null
  ? []
  : [...new Set<any>([...destructiveRegistrySource.matchAll(destructiveIdPattern)].map((match: any) : any => match[1]))];
const registryPresent: any = registryIds.length > 0;
const adoptionById: any = new Map<any, any>();
const unregisteredCallSites: any[] = [];
if (registryPresent) {
  for (const file of codeFiles) {
    if (file === destructiveRegistryPath) {
      continue;
    }
    const source: any = sources.get(file);
    if (confirmCallPattern.test(source)) {
      for (const id of registryIds) {
        if (!adoptionById.has(id) && (source.includes(`"${id}"`) || source.includes(`'${id}'`) || source.includes(`\`${id}\``))) {
          adoptionById.set(id, file);
        }
      }
    }
    for (const match of source.matchAll(destructiveCallSitePattern)) {
      if (!registryIds.includes(match[1])) {
        unregisteredCallSites.push({ file, line: lineNumber(source, match.index || 0), id: match[1] });
      }
    }
  }
}
const missingCoverageIds: any = registryIds.filter((id: any) : any => !adoptionById.has(id));
for (const id of missingCoverageIds) {
  findings.push({
    severity: "error",
    code: "destructive-confirm-coverage-missing",
    file: destructiveRegistryPath,
    line: 0,
    message: `Destructive operation "${id}" has no adoption site calling requestDestructiveConfirm/requestConsoleConfirm/confirmConsoleAction; pending adoptions are tracked by the destructive-coverage bootstrap allowlist.`
  });
}
for (const site of unregisteredCallSites) {
  findings.push({
    severity: "error",
    code: "unregistered-destructive-id",
    file: site.file,
    line: site.line,
    message: `requestDestructiveConfirm("${site.id}") references an id missing from the destructive-operation registry; register the operation instead of bypassing the registry.`
  });
}

// Bootstrap allowlists (frozen handoff 2, Architecture.md §3.2): absent file == empty; entries
// are ratchet-only — an entry that no longer matches a pending state FAILS the gate.
const tierBootstrap: any = await readAllowlist(tierAllowlistPath, "files");
const destructiveBootstrap: any = await readAllowlist(destructiveAllowlistPath, "ids");
const tierBootstrapSet: any = new Set<any>(tierBootstrap);
const destructiveBootstrapSet: any = new Set<any>(destructiveBootstrap);
const legacyEmptyViolatedFiles: any = new Set<any>(findings.filter((finding: any) : any => finding.code === "hand-rolled-empty-block").map((finding: any) : any => finding.file));

const blockingFindings: any[] = [];
const suppressedFindings: any[] = [];
for (const finding of findings) {
  if (finding.code === "undeclared-component-tier" && tierBootstrapSet.has(finding.file)) {
    suppressedFindings.push({ ...finding, pending: "tier-declaration" });
  } else if (finding.code === "destructive-confirm-coverage-missing") {
    const id: any = (finding.message.match(/"([^"]+)"/) || [])[1] || "";
    if (destructiveBootstrapSet.has(id)) {
      suppressedFindings.push({ ...finding, pending: "destructive-adoption" });
    } else {
      blockingFindings.push(finding);
    }
  } else if (finding.code === "hand-rolled-empty-block" && legacyEmptySet.has(finding.file)) {
    suppressedFindings.push({ ...finding, pending: "legacy-grandfather" });
  } else {
    blockingFindings.push(finding);
  }
}

const staleFindings: any[] = [];
for (const file of tierBootstrap) {
  if (!undeclaredComponents.includes(file)) {
    staleFindings.push({
      severity: "error",
      code: "stale-allowlist-entry",
      file,
      line: 0,
      message: "Tier bootstrap entry no longer matches an undeclared component (the tier was declared or the file is gone); remove the entry — only N19 may shrink, empty, and delete this allowlist."
    });
  }
}
for (const id of destructiveBootstrap) {
  const adopted: any = registryPresent && adoptionById.has(id);
  const dropped: any = registryPresent && !registryIds.includes(id);
  if (adopted || dropped) {
    staleFindings.push({
      severity: "error",
      code: "stale-allowlist-entry",
      file: destructiveRegistryPath,
      line: 0,
      message: `Destructive-coverage bootstrap entry "${id}" no longer marks a pending adoption (adopted or dropped from the registry); remove the entry — the Node removing the last one deletes this allowlist.`
    });
  }
}
blockingFindings.push(...staleFindings);
void legacyEmptyViolatedFiles;

const reportFindings: any = [
  ...blockingFindings,
  ...suppressedFindings.map((finding: any) : any => ({ ...finding, severity: "warning", suppressed: true }))
];
const familySummary: any = (code: any) : any => {
  const all: any = findings.filter((finding: any) : any => finding.code === code);
  return {
    findingCount: all.length,
    blockingCount: blockingFindings.filter((finding: any) : any => finding.code === code).length,
    suppressedCount: suppressedFindings.filter((finding: any) : any => finding.code === code).length
  };
};
const report: Record<string, any> = {
  schemaVersion: "v0.0.1:console:component-reuse-report-1",
  generatedAt: new Date().toISOString(),
  verifier: "tools/server-scripts/verify-console-component-reuse.ts",
  allowlists: [
    "tools/server-scripts/console-component-reuse-tier-bootstrap-allowlist.json",
    "tools/server-scripts/console-component-reuse-destructive-coverage-bootstrap-allowlist.json"
  ],
  summary: {
    releaseReady: blockingFindings.length === 0,
    reportLeakScan: true,
    scannedFileCount: codeFiles.length,
    componentFileCount: componentFiles.length,
    findingCount: findings.length,
    blockingFindingCount: blockingFindings.length,
    suppressedFindingCount: suppressedFindings.length,
    staleAllowlistEntryCount: staleFindings.length,
    findingCountByKind: countByKind(findings),
    families: {
      nativeDialogCalls: familySummary("native-dialog-call"),
      handRolledEmptyBlocks: { ...familySummary("hand-rolled-empty-block"), legacyFileCount: legacyEmptyBlockFiles.length },
      componentTierDeclarations: {
        ...familySummary("undeclared-component-tier"),
        declaredCount: declaredComponents.size,
        declarationSources: {
          commonTsTierEntries: commonDeclaredCount,
          featureRegistryPaths: featureDeclaredCount,
          featureRegistryPresent: featureRegistrySource !== null
        },
        bootstrapPendingCount: tierBootstrap.length
      },
      destructiveConfirmCoverage: {
        ...familySummary("destructive-confirm-coverage-missing"),
        registryPresent,
        registryEntryCount: registryIds.length,
        adoptedCount: adoptionById.size,
        unregisteredCallSiteCount: unregisteredCallSites.length,
        bootstrapPendingCount: destructiveBootstrap.length
      }
    }
  },
  scopeNotes: [
    "native-dialog-call requires the alert(/confirm( call shape at statement position and skips comment lines; the family starts clean and has NO allowlist — any match is blocking.",
    "hand-rolled-empty-block matches class=\"*empty*\" in templates, excluding ConsoleEmptyState.vue itself and <ConsoleEmptyState ...> tags. The legacy grandfather list is permanent (conversion of existing blocks is a declared non-goal); the gate prevents NEW blocks.",
    "undeclared-component-tier reads declaration modules owned by N19 as text: common.ts Tier-2 entries count once they carry a `tier` field; feature-registry.ts Tier-3 records count via component path literals. Absent data == all-pending == covered by the tier bootstrap allowlist (emptied and deleted only by N19).",
    "destructive-confirm-coverage reads the registry owned by N10 as statically analyzable id literals. Absent registry == coverage pending == vacuous pass tracked by the destructive-coverage bootstrap allowlist (shrunk by N10 and N13/N14; last-remover deletes). CONSOLE_COMPONENT_REUSE_DESTRUCTIVE_REGISTRY_PATH overrides the registry path for gate self-tests.",
    "Bootstrap allowlist lifecycle (frozen handoff 2): an absent allowlist file equals an empty allowlist; entries are ratchet-only; a stale entry fails the gate. No other Node may add entries — a Node that trips the gate fixes its own code."
  ],
  findings: reportFindings
};

assert.equal(JSON.stringify(report).includes(repoRoot), false, "console component-reuse report leaked repo path");
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (blockingFindings.length > 0) {
  const parts: any = [`Console component-reuse gate failed: ${blockingFindings.length} blocking findings`];
  for (const finding of blockingFindings.slice(0, 40)) {
    parts.push(`${finding.code}: ${finding.file}${finding.line ? `:${finding.line}` : ""}`);
  }
  if (blockingFindings.length > 40) {
    parts.push(`...and ${blockingFindings.length - 40} more (see build/reports/console-component-reuse.json)`);
  }
  throw new Error(parts.join("\n  "));
}
console.log(`[console-component-reuse] ok (scanned ${codeFiles.length} files, ${componentFiles.length} components, suppressed ${suppressedFindings.length} findings: ${tierBootstrap.length} tier-pending, ${destructiveBootstrap.length} destructive-pending)`);
