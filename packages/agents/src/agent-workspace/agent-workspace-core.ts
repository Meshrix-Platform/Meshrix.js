import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { workspaceIntegerLimit } from "./agent-workspace-limits.ts";

export const AGENT_WORKSPACE_PROTOCOL_VERSION: any = "v0.0.1:workspace:agent-workspace-1";
export const AGENT_WORKSPACE_CONTEXT_BUNDLE_VERSION: any = "v0.0.1:workspace:context-bundle-1";
export const AGENT_SESSION_THREAD_VERSION: any = "v0.0.1:agent:session-thread-1";
export const CONTEXT_BUNDLE_COMPRESSED_MAX_BYTES: any = workspaceIntegerLimit(
  "MESHRIX_AGENT_WORKSPACE_CONTEXT_BUNDLE_COMPRESSED_MAX_BYTES",
  { defaultValue: 2 * 1024 * 1024, minimum: 1024, maximum: 64 * 1024 * 1024 }
);
export const CONTEXT_BUNDLE_UNCOMPRESSED_MAX_BYTES: any = workspaceIntegerLimit(
  "MESHRIX_AGENT_WORKSPACE_CONTEXT_BUNDLE_UNCOMPRESSED_MAX_BYTES",
  {
    defaultValue: 16 * 1024 * 1024,
    minimum: CONTEXT_BUNDLE_COMPRESSED_MAX_BYTES,
    maximum: 256 * 1024 * 1024
  }
);
export const WORKSPACE_FILE_MAX_BYTES: any = workspaceIntegerLimit(
  "MESHRIX_AGENT_WORKSPACE_FILE_MAX_BYTES",
  { defaultValue: 8 * 1024 * 1024, minimum: 1024, maximum: 64 * 1024 * 1024 }
);
export const DANGEROUS_WORKSPACE_EXTENSIONS: any = new Set<any>([
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
export const ARCHIVE_WORKSPACE_EXTENSIONS: any[] = [
  ".7z",
  ".gz",
  ".rar",
  ".tar",
  ".tar.gz",
  ".tgz",
  ".xz",
  ".zip"
];

export const ACCEPTED_SUBMISSION_TYPES: any = new Set<any>([
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

export const REVIEW_ONLY_TYPES: any = new Set<any>([
  "canonicalChange",
  "entityMerge",
  "relationChange",
  "taxonomyChange"
]);

export function nowIso() : any {
  return new Date().toISOString();
}

export function asArray(value?: any) : any {
  return Array.isArray(value) ? value : [];
}

export function asObject(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

export function parseJson(value?: any, fallback: Record<string, any> = {}) : any {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value?: any, fallback: Record<string, any> = {}) : any {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function stableHash(...parts: any[]) : any {
  return crypto
    .createHash("sha256")
    .update(parts.map((part?: any) : any => String(part ?? "")).join("\n"))
    .digest("hex");
}


export function stableId(prefix: any, ...parts: any[]) : any {
  return `${prefix}_${stableHash(prefix, ...parts).slice(0, 24)}`;
}

export function normalizeWorkspaceRelativePath(value?: any, options: Record<string, any> = {}) : any {
  const raw: any = String(value || "").replace(/\\/g, "/").trim();
  if (!raw || raw === ".") {
    if (options.allowEmpty) {
      return "";
    }
    throw new Error("路径不能为空。");
  }
  if (raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error("路径必须是工作空间相对路径。");
  }
  const normalized: any = path.posix.normalize(raw);
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

export function workspaceFileExtension(relativePath: any = "") : any {
  const lower: any = String(relativePath || "").toLowerCase();
  const archiveExtension: any = ARCHIVE_WORKSPACE_EXTENSIONS.find((extension?: any) : any => lower.endsWith(extension));
  return archiveExtension || path.posix.extname(lower);
}

export function hasExecutableMagic(buffer: any = Buffer.alloc(0)) : any {
  if (buffer.length >= 4) {
    const head4: any = buffer.subarray(0, 4).toString("hex");
    if (["7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(head4)) {
      return true;
    }
  }
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return true;
  }
  return false;
}

export function hasArchiveMagic(buffer: any = Buffer.alloc(0)) : any {
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
}: Record<string, any> = {}) : any {
  const normalizedPath: any = normalizeWorkspaceRelativePath(relativePath, { allowEmpty: false });
  const extension: any = workspaceFileExtension(normalizedPath);
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

export function stripExecutableMode(absolutePath?: any) : any {
  try {
    const stat: any = fs.lstatSync(absolutePath);
    if (stat.isFile() && (stat.mode & 0o111)) {
      fs.chmodSync(absolutePath, stat.mode & 0o666);
    }
  } catch {
    // Permission normalization is best-effort after a successful guarded write.
  }
}

export function joinWorkspaceRelativePath(...parts: any[]) : any {
  return normalizeWorkspaceRelativePath(
    parts.map((part?: any) : any => String(part || "").replace(/\\/g, "/").trim()).filter(Boolean).join("/"),
    { allowEmpty: false }
  );
}

export function sha256Buffer(buffer?: any) : any {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function normalizeSha256(value: any = "") : any {
  return String(value || "").replace(/^sha256:/, "").trim();
}

export function splitPatchTextLines(text?: any) : any {
  const normalized: any = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const finalNewline: any = normalized.endsWith("\n");
  const body: any = finalNewline ? normalized.slice(0, -1) : normalized;
  return {
    lines: body ? body.split("\n") : [],
    finalNewline
  };
}

export function parseUnifiedPatch(patchText: any = "") : any {
  const hunks: any[] = [];
  let current: any = null;
  for (const line of String(patchText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    const header: any = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
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
    if (/^[ +\-]/.test(line)) {
      current.lines.push(line);
    }
  }
  if (hunks.length === 0) {
    throw new Error("patch 必须包含至少一个 unified diff hunk。");
  }
  return hunks;
}

export function assertPatchLineMatches(actual?: any, expected?: any, lineNumber?: any) : any {
  if (actual !== expected) {
    throw new Error(`patch hunk 与当前文件不匹配：第 ${lineNumber} 行。`);
  }
}

export function applyUnifiedPatchText(sourceText?: any, patchText?: any) : any {
  const source: any = splitPatchTextLines(sourceText);
  const output: any[] = [];
  let cursor: any = 0;
  for (const hunk of parseUnifiedPatch(patchText)) {
    const start: any = Math.max(0, hunk.oldStart - 1);
    if (start < cursor) {
      throw new Error("patch hunk 顺序重叠或倒退。");
    }
    output.push(...source.lines.slice(cursor, start));
    let oldCursor: any = start;
    for (const entry of hunk.lines) {
      const prefix: any = entry[0];
      const line: any = entry.slice(1);
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

export function applyReplacementHunks(sourceText?: any, hunks: any = []) : any {
  let nextText: any = String(sourceText || "");
  let appliedCount: any = 0;
  for (const hunk of hunks) {
    const oldText: any = String(hunk.oldText ?? hunk.search ?? hunk.before ?? "");
    const newText: any = String(hunk.newText ?? hunk.replace ?? hunk.after ?? "");
    if (!oldText) {
      throw new Error("replacement hunk 必须提供 oldText/search。");
    }
    if (!nextText.includes(oldText)) {
      throw new Error("replacement hunk 与当前文件不匹配。");
    }
    if (hunk.replaceAll === true) {
      const before: any = nextText;
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

export function optionalLimit(value?: any, max: any = 500) : any {
  if (value === undefined || value === null || value === false) {
    return null;
  }
  const numeric: any = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.max(1, Math.min(Math.floor(numeric), max));
}

export function normalizeText(value?: any) : any {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function boundedInteger(value?: any, fallback?: any, min: any = 0, max: any = 1000) : any {
  const numeric: any = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

export function truncateText(value?: any, maxChars: any = 800) : any {
  const text: any = normalizeText(value);
  const limit: any = boundedInteger(maxChars, 800, 0, 10000);
  if (limit <= 0 || text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 15))}...<truncated>`;
}

export function normalizeEvidenceRefs(value?: any, payload: Record<string, any> = {}) : any {
  const refs: any = [
    ...asArray(value),
    ...asArray(payload.evidenceRefs),
    payload.evidenceId,
    payload.sourceEvidenceId
  ]
    .map((item?: any) : any => {
      if (!item) {
        return "";
      }
      if (typeof item === "string") {
        return item.trim();
      }
      return String(item.evidenceId || item.id || item.ref || "").trim();
    })
    .filter(Boolean);
  return [...new Set<any>(refs)];
}

export { stableJson };
