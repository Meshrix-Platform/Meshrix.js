import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { workspaceIntegerLimit } from "./agent-workspace-limits.ts";

export const AGENT_WORKSPACE_PROTOCOL_VERSION = "v0.0.1:workspace:agent-workspace-1";
export const AGENT_WORKSPACE_CONTEXT_BUNDLE_VERSION = "v0.0.1:workspace:context-bundle-1";
export const AGENT_SESSION_THREAD_VERSION = "v0.0.1:agent:session-thread-1";
export const CONTEXT_BUNDLE_COMPRESSED_MAX_BYTES = workspaceIntegerLimit(
  "MESHRIX_AGENT_WORKSPACE_CONTEXT_BUNDLE_COMPRESSED_MAX_BYTES",
  { defaultValue: 2 * 1024 * 1024, minimum: 1024, maximum: 64 * 1024 * 1024 }
);
export const CONTEXT_BUNDLE_UNCOMPRESSED_MAX_BYTES = workspaceIntegerLimit(
  "MESHRIX_AGENT_WORKSPACE_CONTEXT_BUNDLE_UNCOMPRESSED_MAX_BYTES",
  {
    defaultValue: 16 * 1024 * 1024,
    minimum: CONTEXT_BUNDLE_COMPRESSED_MAX_BYTES,
    maximum: 256 * 1024 * 1024
  }
);
export const WORKSPACE_FILE_MAX_BYTES = workspaceIntegerLimit(
  "MESHRIX_AGENT_WORKSPACE_FILE_MAX_BYTES",
  { defaultValue: 8 * 1024 * 1024, minimum: 1024, maximum: 64 * 1024 * 1024 }
);
export const DANGEROUS_WORKSPACE_EXTENSIONS = new Set<string>([
  ".app",
  ".bat",
  ".bash",
  ".bin",
  ".cmd",
  ".com",
  ".command",
  ".csh",
  ".dll",
  ".dmg",
  ".exe",
  ".fish",
  ".jar",
  ".js",
  ".jse",
  ".ksh",
  ".lua",
  ".ts",
  ".msi",
  ".pkg",
  ".pl",
  ".ps1",
  ".py",
  ".rb",
  ".run",
  ".scr",
  ".sh",
  ".so",
  ".vbe",
  ".vbs",
  ".wsf",
  ".zsh"
]);
export const ARCHIVE_WORKSPACE_EXTENSIONS: string[] = [
  ".7z",
  ".gz",
  ".rar",
  ".tar",
  ".tar.gz",
  ".tgz",
  ".xz",
  ".zip"
];

export const ACCEPTED_SUBMISSION_TYPES = new Set<string>([
  "evidenceCard",
  "evidenceRef",
  "claim",
  "artifact",
  "issue",
  "decisionProposal",
  "taskState",
  "contextSummary",
  "canonicalChange",
  "entityMerge",
  "relationChange",
  "taxonomyChange"
]);

export const REVIEW_ONLY_TYPES = new Set<string>([
  "canonicalChange",
  "entityMerge",
  "relationChange",
  "taxonomyChange"
]);

export function nowIso(): string {
  return new Date().toISOString();
}

export function asArray<T = unknown>(value?: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export function asObject(value?: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function uniqueStrings(values: readonly unknown[] = []): string[] {
  return [...new Set<string>(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return value ? JSON.parse(String(value)) as T : fallback;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value?: unknown, fallback: unknown = {}): string {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function stableHash(...parts: unknown[]): string {
  return crypto
    .createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\n"))
    .digest("hex");
}


export function stableId(prefix: unknown, ...parts: unknown[]): string {
  return `${prefix}_${stableHash(prefix, ...parts).slice(0, 24)}`;
}

export function normalizeWorkspaceRelativePath(value?: unknown, options: { allowEmpty?: boolean } = {}): string {
  const raw = String(value || "").replace(/\\/g, "/").trim();
  if (!raw || raw === ".") {
    if (options.allowEmpty) {
      return "";
    }
    throw new Error("路径不能为空。");
  }
  if (raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error("路径必须是工作空间相对路径。");
  }
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === ".") {
    if (options.allowEmpty) {
      return "";
    }
    throw new Error("路径不能为空。");
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("路径不能跳出工作空间。");
  }
  return normalized.replace(/^\/+/, "");
}

export function workspaceFileExtension(relativePath: unknown = ""): string {
  const lower = String(relativePath || "").toLowerCase();
  const archiveExtension = ARCHIVE_WORKSPACE_EXTENSIONS.find((extension) => lower.endsWith(extension));
  return archiveExtension || path.posix.extname(lower);
}

export function hasExecutableMagic(buffer: Buffer = Buffer.alloc(0)): boolean {
  if (buffer.length >= 4) {
    const head4 = buffer.subarray(0, 4).toString("hex");
    if (["7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(head4)) {
      return true;
    }
  }
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return true;
  }
  return false;
}

export function hasArchiveMagic(buffer: Buffer = Buffer.alloc(0)): boolean {
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2])) {
    return true;
  }
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return true;
  }
  if (buffer.length >= 263 && buffer.subarray(257, 263).toString("ascii") === "ustar\0") {
    return true;
  }
  return false;
}

export function assertWorkspaceFileContentPolicy({
  relativePath,
  contentBuffer = Buffer.alloc(0),
  sizeBytes = contentBuffer.length
}: { relativePath?: unknown; contentBuffer?: Buffer; sizeBytes?: number } = {}): void {
  const normalizedPath = normalizeWorkspaceRelativePath(relativePath, { allowEmpty: false });
  const extension = workspaceFileExtension(normalizedPath);
  if (Number(sizeBytes || 0) > WORKSPACE_FILE_MAX_BYTES) {
    throw new Error("文件超过工作空间单文件大小限制。");
  }
  if (DANGEROUS_WORKSPACE_EXTENSIONS.has(extension)) {
    throw new Error("不允许写入可执行或脚本扩展名文件。");
  }
  if (ARCHIVE_WORKSPACE_EXTENSIONS.includes(extension)) {
    throw new Error("不允许通过工作空间文件接口写入归档文件。");
  }
  if (contentBuffer.length >= 2 && contentBuffer[0] === 0x23 && contentBuffer[1] === 0x21) {
    throw new Error("不允许写入 shebang 脚本内容。");
  }
  if (hasExecutableMagic(contentBuffer)) {
    throw new Error("不允许写入可执行文件内容。");
  }
  if (hasArchiveMagic(contentBuffer)) {
    throw new Error("不允许写入归档文件内容。");
  }
}

export function stripExecutableMode(absolutePath: fs.PathLike): void {
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isFile() && (stat.mode & 0o111)) {
      fs.chmodSync(absolutePath, stat.mode & 0o666);
    }
  } catch {
    // Permission normalization is best-effort after a successful guarded write.
  }
}

export function joinWorkspaceRelativePath(...parts: unknown[]): string {
  return normalizeWorkspaceRelativePath(
    parts.map((part) => String(part || "").replace(/\\/g, "/").trim()).filter(Boolean).join("/"),
    { allowEmpty: false }
  );
}

export function sha256Buffer(buffer: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function normalizeSha256(value: unknown = ""): string {
  return String(value || "").replace(/^sha256:/, "").trim();
}

export function splitPatchTextLines(text?: unknown): { lines: string[]; finalNewline: boolean } {
  const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  const body = finalNewline ? normalized.slice(0, -1) : normalized;
  return {
    lines: body ? body.split("\n") : [],
    finalNewline
  };
}

interface UnifiedPatchHunk { oldStart: number; lines: string[] }
interface ReplacementHunk { oldText?: unknown; search?: unknown; before?: unknown; newText?: unknown; replace?: unknown; after?: unknown; replaceAll?: boolean }

export function parseUnifiedPatch(patchText: unknown = ""): UnifiedPatchHunk[] {
  const hunks: UnifiedPatchHunk[] = [];
  let current: UnifiedPatchHunk | null = null;
  for (const line of String(patchText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        lines: []
      };
      hunks.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("\\ No newline")) {
      continue;
    }
    if (/^[- +]/.test(line)) {
      current.lines.push(line);
    }
  }
  if (hunks.length === 0) {
    throw new Error("patch 必须包含至少一个 unified diff hunk。");
  }
  return hunks;
}

export function assertPatchLineMatches(actual: unknown, expected: unknown, lineNumber: number): void {
  if (actual !== expected) {
    throw new Error(`patch hunk 与当前文件不匹配：第 ${lineNumber} 行。`);
  }
}

export function applyUnifiedPatchText(sourceText?: unknown, patchText?: unknown): string {
  const source = splitPatchTextLines(sourceText);
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of parseUnifiedPatch(patchText)) {
    const start = Math.max(0, hunk.oldStart - 1);
    if (start < cursor) {
      throw new Error("patch hunk 顺序重叠或倒退。");
    }
    output.push(...source.lines.slice(cursor, start));
    let oldCursor = start;
    for (const entry of hunk.lines) {
      const prefix = entry[0];
      const line = entry.slice(1);
      if (prefix === " ") {
        assertPatchLineMatches(source.lines[oldCursor], line, oldCursor + 1);
        output.push(line);
        oldCursor += 1;
      } else if (prefix === "-") {
        assertPatchLineMatches(source.lines[oldCursor], line, oldCursor + 1);
        oldCursor += 1;
      } else if (prefix === "+") {
        output.push(line);
      }
    }
    cursor = oldCursor;
  }
  output.push(...source.lines.slice(cursor));
  return `${output.join("\n")}${source.finalNewline ? "\n" : ""}`;
}

export function applyReplacementHunks(sourceText: unknown, hunks: readonly ReplacementHunk[] = []): string {
  let nextText = String(sourceText || "");
  let appliedCount = 0;
  for (const hunk of hunks) {
    const oldText = String(hunk.oldText ?? hunk.search ?? hunk.before ?? "");
    const newText = String(hunk.newText ?? hunk.replace ?? hunk.after ?? "");
    if (!oldText) {
      throw new Error("replacement hunk 必须提供 oldText/search。");
    }
    if (!nextText.includes(oldText)) {
      throw new Error("replacement hunk 与当前文件不匹配。");
    }
    if (hunk.replaceAll === true) {
      const before = nextText;
      nextText = nextText.split(oldText).join(newText);
      appliedCount += before === nextText ? 0 : 1;
    } else {
      nextText = nextText.replace(oldText, newText);
      appliedCount += 1;
    }
  }
  if (appliedCount === 0) {
    throw new Error("没有可应用的 replacement hunk。");
  }
  return nextText;
}

export function optionalLimit(value?: unknown, max = 500): number | null {
  if (value === undefined || value === null || value === false) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.max(1, Math.min(Math.floor(numeric), max));
}

export function normalizeText(value?: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function boundedInteger(value: unknown, fallback: number, min = 0, max = 1000): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

export function truncateText(value?: unknown, maxChars: unknown = 800): string {
  const text = normalizeText(value);
  const limit = boundedInteger(maxChars, 800, 0, 10000);
  if (limit <= 0 || text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 15))}...<truncated>`;
}

export function normalizeEvidenceRefs(value?: unknown, payload: Record<string, unknown> = {}): string[] {
  const refs = [
    ...asArray(value),
    ...asArray(payload.evidenceRefs),
    payload.evidenceId,
    payload.sourceEvidenceId
  ]
    .map((item) => {
      if (!item) {
        return "";
      }
      if (typeof item === "string") {
        return item.trim();
      }
      const record = asObject(item);
      return String(record.evidenceId || record.id || record.ref || "").trim();
    })
    .filter(Boolean);
  return [...new Set<string>(refs)];
}

export { stableJson };
