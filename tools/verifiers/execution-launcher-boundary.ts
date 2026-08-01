#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createSourceEvidenceContext } from "../server-scripts/lib/source-tree-digest.ts";

const REPORT_SCHEMA: any = "v0.0.1:execution-sandbox:launcher-boundary-report-1";
const REPORT_PATH: any = "build/reports/execution-launcher-boundary.json";
const VERIFIER: any = "tools/verifiers/execution-launcher-boundary.ts";
const DEFAULT_SOURCE_ROOTS: readonly any[] = Object.freeze([
  "apps",
  "packages",
  "plugins"
]);
const SOURCE_EXTENSIONS: any = new Set<any>([".js", ".ts", ".cjs", ".ts", ".tsx"]);
const EXCLUDED_DIRECTORIES: any = new Set<any>(["build", "coverage", "dist", "node_modules", "vendor"]);
const CHILD_PROCESS_SPECIFIERS: any = new Set<any>(["child_process", "node:child_process"]);
const EXECUTION_RUNTIME_SPECIFIERS: any = new Set<any>([
  ...CHILD_PROCESS_SPECIFIERS,
  "cluster", "node:cluster",
  "vm", "node:vm",
  "worker_threads", "node:worker_threads"
]);
const INTERNAL_EXECUTION_IMPORT: any = /(?:^|\/)execution-sandbox\/(?:broker|oci-backend|trusted-oci-provider-adapters)(?:\.ts)?$/u;

const LAUNCHER_CATALOG: any = new Map<any, any>([
  [
    "packages/foundation/src/module-system/isolated-plugin-process-host.ts",
    Object.freeze({
      approved: true,
      classification: "plugin_owned_isolated_process_host",
      authority: "core.plugin-runtime",
      reason: "loads one verified plugin artifact in a dedicated bounded IPC child process with no in-process fallback"
    })
  ],
  [
    "packages/server-runtime/src/execution-sandbox/oci-backend.ts",
    Object.freeze({
      approved: true,
      classification: "canonical_sandbox_backend",
      authority: "core.execution.sandbox",
      reason: "executes admitted workloads through the canonical sandbox backend"
    })
  ],
  [
    "packages/agents/src/agent-workspace/agent-workspace-materialization-file-worker.ts",
    Object.freeze({
      approved: true,
      classification: "workspace_materialization_file_worker",
      authority: "core.agent-workspace.materialization",
      reason: "runs the bounded no-shell file worker used by the governed workspace materialization port"
    })
  ],
  [
    "packages/server-runtime/src/execution-sandbox/trusted-oci-provider-adapters.ts",
    Object.freeze({
      approved: true,
      classification: "fixed_provider_probe",
      authority: "core.execution.sandbox",
      reason: "probes a closed set of trusted OCI provider commands"
    })
  ],
  [
    "packages/protocols/mcp/upstream-mcp-stdio-launcher.ts",
    Object.freeze({
      approved: true,
      classification: "protocol_owned_stdio_session_launcher",
      authority: "core.protocols.mcp.upstream-gateway",
      reason: "owns the bounded no-shell process boundary for configured upstream MCP stdio sessions"
    })
  ],
  [
    "packages/foundation/src/environment-compatibility/host-runtime.ts",
    Object.freeze({
      approved: true,
      classification: "fixed_host_compatibility_probe",
      authority: "core.environment.compatibility",
      reason: "executes bounded host capability and version probes outside workload admission"
    })
  ],
  [
    "packages/foundation/src/environment-compatibility/host-services.ts",
    Object.freeze({
      approved: true,
      classification: "fixed_host_service_control",
      authority: "core.environment.compatibility",
      reason: "controls a fixed operating-system service manager outside workload admission"
    })
  ],
  ...[
    "packages/foundation/src/security/authorization/capability-binding-guard-backends.ts",
    "packages/foundation/src/security/authorization/capability-security-helper-client.ts",
    "packages/foundation/src/security/authorization/opaque-capability-key-backends.ts",
    "packages/foundation/src/security/authorization/opaque-capability-key-provider.ts"
  ].map((sourcePath?: any) : any => [
    sourcePath,
    Object.freeze({
      approved: true,
      classification: "fixed_security_credential_helper",
      authority: "core.security.authorization",
      reason: "invokes bounded operating-system credential custody helpers outside workload admission"
    })
  ]),
  ...[
    "packages/foundation/src/storage/private-file-atomic.ts",
    "packages/foundation/src/storage/storage-lifecycle-lock.ts"
  ].map((sourcePath?: any) : any => [
    sourcePath,
    Object.freeze({
      approved: true,
      classification: "fixed_storage_os_helper",
      authority: "core.storage",
      reason: "invokes bounded operating-system file or process metadata helpers outside workload admission"
    })
  ]),
  ...[
    "packages/protocols/mcp/adapter/gateway-installer/lib/cli/constants.ts",
    "packages/protocols/mcp/adapter/gateway-installer/lib/cli/connector-process.ts",
    "packages/protocols/mcp/adapter/gateway-installer/lib/process-identity-store.ts"
  ].map((sourcePath?: any) : any => [
    sourcePath,
    Object.freeze({
      approved: true,
      classification: "explicit_client_install_control",
      authority: "core.protocols.mcp.client-installer",
      reason: "performs an explicit client installation or credential-custody control-plane action outside workload admission"
    })
  ])
]);

function normalizePath(value?: any) : any {
  return String(value || "").split(path.sep).join("/");
}

async function loadTypeScript() : Promise<any> {
  try {
    return await import("typescript");
  } catch (error: any) {
    throw new Error("execution_launcher_boundary_typescript_unavailable", { cause: error });
  }
}

function childProcessSpecifier(node?: any, ts?: any) : any {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
      ? node.moduleSpecifier.text
      : "";
  }
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return "";
  const [argument] = node.arguments;
  if (!ts.isStringLiteralLike(argument)) return "";
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return argument.text;
  return ts.isIdentifier(node.expression) && node.expression.text === "require"
    ? argument.text
    : "";
}

function importedBindings(node?: any, ts?: any) : any {
  if (ts.isImportDeclaration(node)) {
    const clause: any = node.importClause;
    if (!clause) return ["side-effect"];
    const bindings: any[] = [];
    if (clause.name) bindings.push("default");
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) bindings.push("*");
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          bindings.push((element.propertyName || element.name).text);
        }
      }
    }
    return bindings;
  }
  if (ts.isExportDeclaration(node)) return ["re-export"];
  return ["dynamic"];
}

export async function extractChildProcessImports(source?: any, fileName: any = "source.ts") : Promise<any> {
  const ts: any = await loadTypeScript();
  const extension: any = path.extname(fileName).toLowerCase();
  const scriptKind: any = extension === ".tsx"
    ? ts.ScriptKind.TSX
    : extension === ".ts"
      ? ts.ScriptKind.TS
      : extension === ".jsx"
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  const sourceFile: any = ts.createSourceFile(
    fileName,
    String(source || ""),
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error(`execution_launcher_boundary_parse_failed:${normalizePath(fileName)}`);
  }
  const imports: any[] = [];
  function visit(node?: any) : any {
    const specifier: any = childProcessSpecifier(node, ts);
    if (EXECUTION_RUNTIME_SPECIFIERS.has(specifier)) {
      imports.push(Object.freeze({
        specifier,
        bindings: Object.freeze(importedBindings(node, ts).sort())
      }));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return Object.freeze(imports);
}

export async function extractExecutionBoundarySyntax(source?: any, fileName: any = "source.ts") : Promise<any> {
  const ts: any = await loadTypeScript();
  const extension: any = path.extname(fileName).toLowerCase();
  const scriptKind: any = extension === ".tsx"
    ? ts.ScriptKind.TSX
    : extension === ".ts"
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  const sourceFile: any = ts.createSourceFile(fileName, String(source || ""), ts.ScriptTarget.Latest, true, scriptKind);
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error(`execution_launcher_boundary_parse_failed:${normalizePath(fileName)}`);
  }
  const internalImports: any[] = [];
  const unsafeCalls: any[] = [];
  function visit(node?: any) : any {
    const specifier: any = childProcessSpecifier(node, ts);
    if (specifier && INTERNAL_EXECUTION_IMPORT.test(specifier.replace(/\\/gu, "/"))) {
      internalImports.push(specifier);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        ["eval", "Function"].includes(node.expression.text)) {
      unsafeCalls.push(node.expression.text);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      unsafeCalls.push("new Function");
    }
    if (ts.isPropertyAssignment(node) &&
        ((ts.isIdentifier(node.name) && node.name.text === "shell") ||
         (ts.isStringLiteralLike(node.name) && node.name.text === "shell")) &&
        node.initializer.kind === ts.SyntaxKind.TrueKeyword) {
      unsafeCalls.push("shell:true");
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return Object.freeze({
    internalImports: Object.freeze([...new Set<any>(internalImports)].sort()),
    unsafeCalls: Object.freeze([...new Set<any>(unsafeCalls)].sort())
  });
}

export function classifyLauncherImport(relativePath?: any, imports?: any) : any {
  const normalizedPath: any = normalizePath(relativePath);
  if (!Array.isArray(imports) || imports.length === 0) return null;
  const catalogEntry: any = LAUNCHER_CATALOG.get(normalizedPath);
  if (!catalogEntry) {
    return Object.freeze({
      path: normalizedPath,
      approved: false,
      classification: "unclassified_direct_process_launcher",
      authority: "core.execution.sandbox",
      reason: "direct process launch site is not registered at the canonical boundary",
      imports: Object.freeze(imports)
    });
  }
  return Object.freeze({
    path: normalizedPath,
    ...catalogEntry,
    imports: Object.freeze(imports)
  });
}

async function listSourceFiles(directory?: any) : Promise<any> {
  let entries: any;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files: any[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        files.push(...await listSourceFiles(path.join(directory, entry.name)));
      }
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

export async function runExecutionLauncherBoundary({
  rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url))),
  sourceRoots = DEFAULT_SOURCE_ROOTS,
  writeReport = false,
  reportPath = REPORT_PATH
}: Record<string, any> = {}) : Promise<any> {
  const absoluteRoot: any = path.resolve(rootDir);
  const files: any[] = [];
  for (const sourceRoot of sourceRoots) {
    files.push(...await listSourceFiles(path.resolve(absoluteRoot, sourceRoot)));
  }
  files.sort((left?: any, right?: any) : any => left.localeCompare(right));

  const launchers: any[] = [];
  const boundaryViolations: any[] = [];
  for (const file of files) {
    const relativePath: any = normalizePath(path.relative(absoluteRoot, file));
    const source: any = await fs.readFile(file, "utf8");
    const imports: any = await extractChildProcessImports(source, relativePath);
    const finding: any = classifyLauncherImport(relativePath, imports);
    if (finding) launchers.push(finding);
    const syntax: any = await extractExecutionBoundarySyntax(source, relativePath);
    const internalImportAllowed: any = relativePath.startsWith("packages/server-runtime/src/execution-sandbox/") ||
      relativePath === "packages/server-runtime/src/composition/execution-sandbox-provider.ts" ||
      relativePath.includes("/verifiers/");
    if (syntax.internalImports.length > 0 && !internalImportAllowed) {
      boundaryViolations.push(Object.freeze({
        path: relativePath,
        approved: false,
        classification: "direct_internal_sandbox_import",
        imports: syntax.internalImports
      }));
    }
    if (syntax.unsafeCalls.length > 0) {
      boundaryViolations.push(Object.freeze({
        path: relativePath,
        approved: false,
        classification: "unsafe_dynamic_execution_syntax",
        calls: syntax.unsafeCalls
      }));
    }
  }
  launchers.sort((left?: any, right?: any) : any => left.path.localeCompare(right.path));
  const violations: any = [...launchers.filter((entry?: any) : any => entry.approved !== true), ...boundaryViolations]
    .sort((left?: any, right?: any) : any => left.path.localeCompare(right.path));
  const approved: any = launchers.filter((entry?: any) : any => entry.approved === true);
  const report: Readonly<Record<string, any>> = Object.freeze({
    schemaVersion: REPORT_SCHEMA,
    verifier: VERIFIER,
    generatedAt: new Date().toISOString(),
    sourceContext: createSourceEvidenceContext(absoluteRoot, {
      verifier: VERIFIER,
      commandId: "controlled-execution-sandbox"
    }),
    sourceRoots: Object.freeze([...sourceRoots]),
    summary: Object.freeze({
      scannedFileCount: files.length,
      launcherCount: launchers.length,
      approvedLauncherCount: approved.length,
      violationCount: violations.length,
      reportLeakScan: true
    }),
    launchers: Object.freeze(launchers),
    violations: Object.freeze(violations),
    boundaryClosed: violations.length === 0
  });
  if (writeReport) {
    const absoluteReportPath: any = path.resolve(reportPath);
    await fs.mkdir(path.dirname(absoluteReportPath), { recursive: true });
    await fs.writeFile(absoluteReportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  return report;
}

function isMain() : any {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const report: any = await runExecutionLauncherBoundary({ writeReport: true });
  console.log(`[execution-launcher-boundary] launchers=${report.summary.launcherCount} violations=${report.summary.violationCount}`);
  if (!report.boundaryClosed) process.exitCode = 1;
}
