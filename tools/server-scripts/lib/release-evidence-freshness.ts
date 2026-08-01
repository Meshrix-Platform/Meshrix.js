import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

function asRecord(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseTimeMs(value?: any) : any {
  const ms: any = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

export function uniqueReportPaths(paths: any = []) : any {
  return [...new Set<any>((Array.isArray(paths) ? paths : [])
    .map((item?: any) : any => String(item || "").trim())
    .filter(Boolean))];
}

export async function removeReportPaths(repoRoot?: any, paths: any = []) : Promise<any> {
  for (const relativePath of uniqueReportPaths(paths)) {
    await fs.rm(path.join(repoRoot, relativePath), { force: true });
  }
}

export async function readJsonReportWithStats(repoRoot?: any, relativePath?: any) : Promise<any> {
  const absolutePath: any = path.join(repoRoot, relativePath);
  const [text, stats] = await Promise.all([
    fs.readFile(absolutePath, "utf8"),
    fs.stat(absolutePath)
  ]);
  return {
    report: JSON.parse(text),
    stats
  };
}

async function listJsonFiles(rootPath?: any, basePath?: any, output: any = []) : Promise<any> {
  let entries: any[] = [];
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return output;
    }
    throw error;
  }
  for (const entry of entries) {
    const absolutePath: any = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await listJsonFiles(absolutePath, basePath, output);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      output.push(path.relative(basePath, absolutePath).split(path.sep).join("/"));
    }
  }
  return output;
}

export async function snapshotJsonReportFiles(repoRoot?: any, {
  roots = ["build/reports"]
}: Record<string, any> = {}) : Promise<any> {
  const snapshot: Record<string, any> = {};
  for (const root of uniqueReportPaths(roots)) {
    const rootPath: any = path.join(repoRoot, root);
    const files: any = await listJsonFiles(rootPath, repoRoot);
    for (const relativePath of files) {
      const content: any = await fs.readFile(path.join(repoRoot, relativePath));
      snapshot[relativePath] = crypto.createHash("sha256").update(content).digest("hex");
    }
  }
  return snapshot;
}

export function createCurrentRunReportDriftAudit({
  beforeSnapshot = {},
  afterSnapshot = {},
  allowedReports = []
}: Record<string, any> = {}) : any {
  const allowed: any = new Set<any>(uniqueReportPaths(allowedReports));
  const currentRunOrphans: any = (Object.entries(afterSnapshot) as [string, any][])
    .filter(([relativePath, digest]: any[]) : any => !allowed.has(relativePath) && beforeSnapshot[relativePath] !== digest)
    .map(([relativePath]: any[]) : any => relativePath)
    .sort();
  return {
    mode: "content-hash-current-run-report-drift",
    allowedReportCount: allowed.size,
    beforeReportCount: Object.keys(beforeSnapshot).length,
    afterReportCount: Object.keys(afterSnapshot).length,
    currentRunOrphans,
    currentRunOrphanCount: currentRunOrphans.length,
    consistent: currentRunOrphans.length === 0
  };
}

/**
 * Create freshness evidence for a release report.
 *
 * Freshness is determined solely by embedded timestamps (generatedAt,
 * finishedAt, startedAt, checkedAt, timestamp, createdAt on the report root
 * and summary).  File-system mtime is recorded for diagnostics but is never
 * used as a silent fallback for the `fresh` decision.
 */
export function createReportFreshnessEvidence(relativePath?: any, report: Record<string, any> = {}, stats: Record<string, any> = {}, options: Record<string, any> = {}) : any {
  const notBeforeMs: any = Number(options.notBeforeMs || 0);
  const record: any = asRecord(report);
  const summary: any = asRecord(record.summary);
  const embeddedTimes: any = [
    record.generatedAt,
    record.finishedAt,
    record.startedAt,
    record.checkedAt,
    record.timestamp,
    record.createdAt,
    summary.generatedAt,
    summary.finishedAt,
    summary.startedAt,
    summary.checkedAt
  ]
    .map(parseTimeMs)
    .filter((value?: any) : any => value > 0);
  const embeddedFreshestMs: any = Math.max(0, ...embeddedTimes);
  const mtimeMs: any = Number(stats.mtimeMs || 0);
  const embeddedTimestampPresent: any = embeddedFreshestMs > 0;
  const fileMtimePresent: any = mtimeMs > 0;

  // Only embedded timestamps drive the freshness decision.
  // File mtime is never a silent substitute.
  let source: any;
  if (embeddedTimestampPresent) {
    source = "embedded-timestamp";
  } else if (fileMtimePresent) {
    source = "file-mtime-not-trusted";
  } else {
    source = "missing-timestamp";
  }

  // When embedded timestamps are missing the report cannot be fresh,
  // regardless of file-system mtime.
  const evidenceTimeMs: any = embeddedTimestampPresent ? embeddedFreshestMs : 0;
  const fresh: any = notBeforeMs > 0
    ? embeddedTimestampPresent && evidenceTimeMs >= notBeforeMs
    : embeddedTimestampPresent;

  return {
    report: relativePath,
    fresh,
    notBefore: notBeforeMs > 0 ? new Date(notBeforeMs).toISOString() : "",
    evidenceTime: evidenceTimeMs > 0 ? new Date(evidenceTimeMs).toISOString() : "",
    source,
    embeddedTimestampPresent,
    embeddedTimestampCount: embeddedTimes.length,
    fileMtimePresent,
    fileMtime: fileMtimePresent ? new Date(mtimeMs).toISOString() : ""
  };
}
