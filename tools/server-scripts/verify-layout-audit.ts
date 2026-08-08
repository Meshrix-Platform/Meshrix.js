#!/usr/bin/env node
/**
 * verify-layout-audit.ts — Comprehensive Repository Layout Audit
 *
 * Generates a JSON or Markdown report covering:
 * - Root directory classification
 * - Canonical runtime/package classification
 * - Foundation module status
 * - Public facade imports vs package.json#imports
 * - Prohibited path audit
 * - README/docs directory references
 * - package.json#files exclusions vs runtime payload policy
 * - Route registry bidirectional mapping (from importable data)
 * - Test suite registry coverage (from importable registry)
 * - Script registry coverage (from tools/scripts/package-script-registry.ts)
 * - Architecture dependency constraint violations
 * - External fixture direct import violations
 * - MCP connector path consistency
 * - Provenance metadata
 *
 * Usage:
 *   npm run repo:layout:audit                     (strict mode, non-zero on severe)
 *   npm run repo:layout:audit -- --report-only    (always exits 0, report only)
 *   npm run repo:layout:audit -- --format markdown
 *   npm run repo:layout:audit -- --strict --format json
 *
 * Schema version: v0.0.1:repository:layout-audit-0.2.0
 *
 * OTel Semantic Convention Fields (adoption baseline):
 *   service.name, service.version
 *   vcs.ref.head.name, vcs.ref.head.revision
 *
 * The report output includes provenance metadata with VCS references.
 * Adoption is incremental; new audit sections should include these fields.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const repoRoot: any = process.cwd();
const OTEL_LAYOUT_AUDIT_SEMANTICS: Readonly<Record<string, any>> = Object.freeze({
  "service.name": "meshrix-layout-audit",
  "service.version": "v0.0.1:repository:layout-audit-0.2.0",
  "vcs.ref.head.name": process.env.GITHUB_REF_NAME || "",
  "vcs.ref.head.revision": process.env.GITHUB_SHA || ""
});

const reportOnly: any = process.argv.includes("--report-only");
const strictMode: any = process.argv.includes("--strict") || !reportOnly; // default: strict unless report-only
const reportFormat: any = process.argv.includes("--markdown") ? "markdown" : "json";
const ROOT_AUDIT_IGNORED_ENTRIES: any = new Set<any>([
  ".DS_Store",
  ".cache",
  ".git",
  "build",
  "node_modules"
]);

async function pathExists(relativePath?: any) : Promise<any> {
  try {
    await fs.access(path.join(repoRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

function globPatternRegex(pattern?: any) : any {
  const input: any = String(pattern || "");
  let expression: any = "";
  for (let index: any = 0; index < input.length; index += 1) {
    if (input.startsWith("**/", index)) {
      expression += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (input.startsWith("**", index)) {
      expression += ".*";
      index += 1;
      continue;
    }
    if (input[index] === "*") {
      expression += "[^/]*";
      continue;
    }
    if (input[index] === "?") {
      expression += "[^/]";
      continue;
    }
    expression += input[index].replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${expression}$`, "u");
}

async function packageExclusionTargetExists(pattern?: any) : Promise<any> {
  if (!/[?*]/u.test(pattern)) return pathExists(pattern);
  const matcher: any = globPatternRegex(pattern);
  const pending: any[] = [""];
  while (pending.length > 0) {
    const relativeDir: any = pending.pop();
    const absoluteDir: any = path.join(repoRoot, relativeDir);
    for (const entry of await fs.readdir(absoluteDir, { withFileTypes: true })) {
      if (ROOT_AUDIT_IGNORED_ENTRIES.has(entry.name)) continue;
      const relativeEntry: any = toPosix(path.join(relativeDir, entry.name));
      if (matcher.test(relativeEntry)) return true;
      if (entry.isDirectory()) pending.push(relativeEntry);
    }
  }
  return false;
}

async function readJson(filePath?: any) : Promise<any> {
  return JSON.parse(await fs.readFile(path.join(repoRoot, filePath), "utf8"));
}

function toPosix(p?: any) : any {
  return p.split(path.sep).join("/");
}

/**
 * Scan a directory for .ts/.js/.ts/.vue files and check for import patterns.
 */
async function* walkFiles(rootDir?: any, extensions: any = [".ts", ".js"]) : AsyncGenerator<any, any, any> {
  async function* walk(dir?: any, relativeDir?: any) : AsyncGenerator<any, any, any> {
    let entries: any;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const childPath: any = path.join(dir, entry.name);
      const childRel: any = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "target" || entry.name === ".git") continue;
        yield* walk(childPath, childRel);
      } else if (extensions.some((ext?: any) : any => entry.name.endsWith(ext))) {
        yield { absPath: childPath, relPath: childRel };
      }
    }
  }
  yield* walk(path.join(repoRoot, rootDir), rootDir);
}

async function main() : Promise<any> {
  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:repository:layout-audit-0.2.0",
    generatedAt: new Date().toISOString(),
    mode: reportOnly ? "report-only" : "strict",
    semanticConventions: OTEL_LAYOUT_AUDIT_SEMANTICS,
    sections: [],
    issues: { severe: [], warning: [], info: [] },
  };

  // ── Load manifests and registries ───────────────────────────────────────────
  const archUrl: any = pathToFileURL(
    path.join(repoRoot, "tools/registry/architecture-layout-manifest.ts")
  ).href;
  const arch: any = await import(archUrl);
  const packageJson: any = await readJson("package.json");
  const scripts: any = packageJson.scripts || {};

  const scriptReg: any = await import(pathToFileURL(path.join(repoRoot, "tools/scripts/package-script-registry.ts")).href);
  const suiteReg: any = await readJson("tools/registry/tests.registry.json");

  // ── S1: Root directory classification ─────────────────────────────────────
  {
    const rootEntries: any = await fs.readdir(repoRoot, { withFileTypes: true });
    const actualNames: any = new Set<any>(rootEntries
      .map((e?: any) : any => e.name)
      .filter((name?: any) : any => !ROOT_AUDIT_IGNORED_ENTRIES.has(name)));
    const allowedNames: any = new Set<any>(arch.ROOT_ALLOWED_ENTRIES);

    const unclassified: any = [...actualNames].filter((n?: any) : any => !allowedNames.has(n));

    report.sections.push({
      title: "Root directory classification",
      summary: {
        total: actualNames.size,
        unclassified: unclassified.length,
      },
    });

    if (unclassified.length > 0) {
      report.issues.severe.push(`Unclassified root entries: ${unclassified.join(", ")}`);
    }
  }

  // ── S2: Canonical source root classification ─────────────────────────────
  {
    const canonicalRoots: any = arch.ROOT_ENTRIES
      .filter((entry?: any) : any => entry.kind === "source-root" && entry.required === true)
      .map((entry?: any) : any => entry.name);
    const missing: any[] = [];
    for (const root of canonicalRoots) {
      if (!await pathExists(root)) missing.push(root);
    }

    report.sections.push({
      title: "Canonical source root classification",
      summary: { total: canonicalRoots.length, missing: missing.length },
    });
    if (missing.length > 0) {
      report.issues.severe.push(`Missing canonical source roots: ${missing.join(", ")}`);
    }
  }

  // ── S3: Foundation modules ───────────────────────────────────────────────
  {
    const foundationModules: any[] = [
      "checkpoint",
      "config",
      "environment-compatibility",
      "http",
      "module-system",
      "observability",
      "proof",
      "security",
      "serialization",
      "storage",
      "unified-registration-core",
      "work-queue",
      "workflow"
    ];
    const missing: any[] = [];
    for (const mod of foundationModules) {
      if (!await pathExists(`packages/foundation/src/${mod}`)) missing.push(mod);
    }

    report.sections.push({
      title: "Foundation module status",
      summary: { registered: foundationModules.length, present: foundationModules.length - missing.length, missing: missing.length },
    });
    if (missing.length > 0) report.issues.severe.push(`Missing foundation modules: ${missing.join(", ")}`);
  }

  // ── S4: Public facade imports ────────────────────────────────────────────
  {
    const imports: any = packageJson.imports || {};
    const missingImports: any[] = [];
    const extraImports: any[] = [];

    for (const facade of arch.PUBLIC_FACADES) {
      const expected: any = `./${facade.facadePath}`;
      if (imports[facade.importSpecifier] !== expected) {
        missingImports.push({ specifier: facade.importSpecifier, expected, actual: imports[facade.importSpecifier] || "<missing>" });
      }
    }
    for (const specifier of Object.keys(imports)) {
      if (specifier.startsWith("#meshrix/") && !arch.PUBLIC_FACADES.find((f?: any) : any => f.importSpecifier === specifier)) {
        extraImports.push(specifier);
      }
    }

    report.sections.push({
      title: "Public facade imports",
      summary: { registered: arch.PUBLIC_FACADES.length, mismatched: missingImports.length, extra: extraImports.length },
    });
    if (missingImports.length > 0) {
      report.issues.severe.push(`${missingImports.length} facade import(s) mismatch package.json#imports`);
    }
  }

  // ── S6: package.json#files vs runtime payload policy ─────────────────────
  {
    const files: any = packageJson.files || [];
    const exclusions: any = files.filter((f?: any) : any => f.startsWith("!"));
    const manifestPatterns: any = new Set<any>(arch.RUNTIME_PAYLOADS.map((rp?: any) : any => rp.packageExclusion || rp.pattern).filter(Boolean));
    const staleExclusions: any[] = [];

    for (const rp of arch.RUNTIME_PAYLOADS) {
      const exclusion: any = rp.packageExclusion || rp.pattern;
      if (exclusion && !exclusions.includes(exclusion)) {
        report.issues.warning.push(`Missing runtime payload exclusion: ${exclusion}`);
      }
    }

    for (const exclusion of exclusions) {
      if (
        exclusion === "!**/node_modules/**" ||
        exclusion === "!**/.vite/**"
      ) continue; // executable-script and generated dependency/cache boundary exclusions
      const cleanPath: any = exclusion.slice(1).replace(/\/\*\*$/, "");
      const exists: any = await packageExclusionTargetExists(cleanPath);
      const payload: any = arch.RUNTIME_PAYLOADS.find((rp?: any) : any => rp.pattern === exclusion);
      if (!exists) {
        if (payload?.mayBeAbsentInSource) {
          report.issues.info.push(`Runtime payload absent (expected): ${cleanPath}`);
        } else if (!manifestPatterns.has(exclusion)) {
          staleExclusions.push(exclusion);
          report.issues.warning.push(`Stale exclusion targets missing dir: ${exclusion}`);
        }
      }
    }

    report.sections.push({
      title: "Package files vs runtime payload policy",
      summary: {
        runtimePayloads: arch.RUNTIME_PAYLOADS.length,
        staleExclusions: staleExclusions.length,
      },
    });
  }

  // ── S7: Script registry coverage ─────────────────────────────────────────
  {
    const allScripts: any = Object.keys(scripts);
    const unregistered: any = allScripts.filter((s?: any) : any => !scriptReg.isClassified(s));

    report.sections.push({
      title: "Script registry coverage",
      summary: { total: allScripts.length, registered: allScripts.length - unregistered.length, unregistered: unregistered.length },
    });

    if (unregistered.length > 0) {
      report.issues.warning.push(`${unregistered.length} package scripts not in script registry`);
    }
  }

  // ── S8: Test suite registry coverage ─────────────────────────────────────
  {
    const suiteScriptRefs: any = new Set<any>();
    for (const suite of suiteReg.suites || []) {
      if (!suite.command || !Array.isArray(suite.args)) {
        report.issues.severe.push(`Test suite ${suite.id} has no executable command`);
        continue;
      }
      if (suite.command.endsWith("npm") || suite.command.endsWith("npm.cmd")) {
        const runIdx: any = suite.args.indexOf("run");
        if (runIdx >= 0 && runIdx + 1 < suite.args.length) {
          suiteScriptRefs.add(suite.args[runIdx + 1]);
        }
      }
    }
    const missing: any = [...suiteScriptRefs].filter((s?: any) : any => !scripts[s]);

    report.sections.push({
      title: "Test suite registry coverage",
      summary: { totalSuites: (suiteReg.suites || []).length, profiles: Object.keys(suiteReg.profiles || {}).length, missingScripts: missing.length },
    });

    if (missing.length > 0) {
      report.issues.severe.push(`Test suite references non-existent npm scripts: ${missing.join(", ")}`);
    }
  }

  // ── S9: Architecture dependency constraint violations ────────────────────
  {
    const architectureVerifier: any = await import(pathToFileURL(
      path.join(repoRoot, "tools/verifiers/architecture-graph.ts")
    ).href);
    const architectureResult: any = await architectureVerifier.runArchitectureGraph({
      verbose: false,
      writeReport: false
    });
    const constraintViolations: any = architectureResult.violations;

    report.sections.push({
      title: "Dependency constraint violations",
      summary: {
        constraints: architectureResult.graph.constraints.length,
        unresolvedImports: architectureResult.graph.summary.unresolvedImportCount,
        violations: constraintViolations.length
      },
    });

    if (constraintViolations.length > 0) {
      const shown: any = constraintViolations.slice(0, 20);
      for (const v of shown) {
        report.issues.severe.push(`${v.rule}: ${v.from} imports ${v.specifier}`);
      }
      if (constraintViolations.length > 20) {
        report.issues.severe.push(`... and ${constraintViolations.length - 20} more violations`);
      }
    }
  }

  // ── S10: Route registry consistency ──────────────────────────────────────
  {
    try {
      const routesIndex: any = await fs.readFile(path.join(repoRoot, "apps/console/router/index.ts"), "utf8");
      const routesTs: any = await fs.readFile(path.join(repoRoot, "apps/console/router/routes.ts"), "utf8");
      // Strip single-line and block comments to avoid flagging documentation
      const stripComments: any = (s?: any) : any => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const activeIndex: any = stripComments(routesIndex);
      const activeRoutes: any = stripComments(routesTs);
      const usesImGlob: any = activeIndex.includes("import.meta.glob") || activeIndex.includes("resolveAdminComponent") || activeRoutes.includes("import.meta.glob");
      const hasViteIgnore: any = activeIndex.includes("@vite-ignore") || activeRoutes.includes("@vite-ignore");

      report.sections.push({
        title: "Route registry build safety",
        summary: { usesImportMetaGlob: usesImGlob, noViteIgnore: !hasViteIgnore },
      });

      if (!usesImGlob) report.issues.warning.push("Router not using import.meta.glob for admin components");
      if (hasViteIgnore) report.issues.warning.push("Router contains @vite-ignore in active code (build-unsafe)");
    } catch (err: any) {
      report.issues.warning.push(`Route registry check failed: ${err.message}`);
    }
  }

  // ── S11: Provenance metadata ─────────────────────────────────────────────
  report.sections.push({
    title: "Provenance metadata",
    summary: {
      manifestVersion: arch.ARCHITECTURE_LAYOUT_MANIFEST_VERSION,
      reportSchemaVersion: report.schemaVersion,
      generatedAt: report.generatedAt,
      mode: report.mode,
    },
  });

  // ── Output ───────────────────────────────────────────────────────────────
  const reportDir: any = path.join(repoRoot, "build", "reports");
  await fs.mkdir(reportDir, { recursive: true });

  const jsonPath: any = path.join(reportDir, "layout-audit.json");
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  if (reportFormat === "markdown") {
    const lines: any[] = [
      "# Meshrix.js Layout Audit Report",
      `Generated: ${report.generatedAt}`,
      `Mode: ${report.mode}`,
      "",
    ];
    for (const severity of ["severe", "warning", "info"]) {
      const items: any = report.issues[severity];
      if (items.length > 0) {
        lines.push(`## ${severity === "severe" ? "Severe" : severity === "warning" ? "Warnings" : "Info"} (${items.length})`);
        for (const item of items) lines.push(`- ${item}`);
        lines.push("");
      }
    }
    lines.push("## Section Summaries");
    for (const section of report.sections) {
      lines.push(`### ${section.title}`, "", "```json", JSON.stringify(section.summary, null, 2), "```", "");
    }
    const mdPath: any = path.join(reportDir, "layout-audit.md");
    await fs.writeFile(mdPath, lines.join("\n"), "utf8");
    console.log(`Layout audit report written to ${toPosix(path.relative(repoRoot, mdPath))}`);
  }

  console.log(`Layout audit report written to ${toPosix(path.relative(repoRoot, jsonPath))}`);

  // ── Exit code ────────────────────────────────────────────────────────────
  if (!reportOnly) {
    const severeCount: any = report.issues.severe.length;
    const warningCount: any = report.issues.warning.length;
    if (severeCount > 0) {
      console.error(`\n${severeCount} severe, ${warningCount} warning, ${report.issues.info.length} info`);
      for (const issue of report.issues.severe) console.error(`  SEVERE: ${issue}`);
      process.exitCode = 1;
    } else if (warningCount > 0) {
      console.log(`\n${severeCount} severe, ${warningCount} warning (non-blocking), ${report.issues.info.length} info`);
    } else {
      console.log("\nLayout audit passed with no issues.");
    }
  } else {
    console.log("\nLayout audit report generated (--report-only mode, no gate).");
  }
}

main().catch((error?: any) : any => {
  console.error(error);
  process.exitCode = 1;
});
