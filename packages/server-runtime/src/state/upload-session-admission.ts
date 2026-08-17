import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";

export const UPLOAD_SESSION_MAX_FILE_COUNT = 256;
export const UPLOAD_SESSION_MAX_FILE_BYTES = 512 * 1024 * 1024;
export const UPLOAD_SESSION_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const UPLOAD_SESSION_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
export const UPLOAD_SESSION_MAX_SOURCE_METADATA_BYTES = 64 * 1024;
export const UPLOAD_SESSION_MAX_ACTIVE_PER_OWNER_SCOPE = 8;
export const UPLOAD_SESSION_MAX_RETAINED = 4_096;
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
export const UPLOAD_SESSION_EXPIRY_CLEANUP_BATCH = 32;

const DATABASE_FILE_NAME = "admission.sqlite";
type AdmissionStatus = "uploading" | "complete";
interface UploadDeclaration { fileCount: number; totalBytes: number }
interface UploadFileDeclaration { byteSize?: unknown; sourceMetadata?: unknown }
interface AdmissionRow {
  sessionId: string; ownerScopeKey: string; status: AdmissionStatus;
  declaredBytes: number; fileCount: number; expiresAtMs: number;
}
interface CountRow { count: number }
interface ExpiredRow { sessionId: string }
export interface ReserveUploadSessionAdmissionInput {
  userDataPath: string; sessionId: string; ownerScopeKey: string; status: AdmissionStatus;
  fileCount: number; totalBytes: number; nowMs?: number;
}

export function uploadAdmissionError(code: string, statusCode: number, message: string): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}

export function validateUploadSessionDeclaration(files: unknown): UploadDeclaration {
  if (!Array.isArray(files)) throw uploadAdmissionError("upload_file_list_invalid", 400, "上传文件列表无效。");
  if (files.length > UPLOAD_SESSION_MAX_FILE_COUNT) {
    throw uploadAdmissionError("upload_file_count_exceeded", 413, "上传文件数量超过服务端安全上限。");
  }

  let totalBytes = 0;
  for (const [index, value] of files.entries()) {
    const file = value !== null && typeof value === "object" ? value as UploadFileDeclaration : {};
    const byteSize = Number(file.byteSize || 0);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw uploadAdmissionError("upload_file_size_invalid", 400, "上传文件大小无效。");
    }
    if (byteSize > UPLOAD_SESSION_MAX_FILE_BYTES) {
      throw uploadAdmissionError("upload_file_bytes_exceeded", 413, `files[${index}].byteSize 超过服务端安全上限。`);
    }
    totalBytes += byteSize;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > UPLOAD_SESSION_MAX_TOTAL_BYTES) {
      throw uploadAdmissionError("upload_session_bytes_exceeded", 413, "上传会话总字节数超过服务端安全上限。");
    }
    if (file.sourceMetadata !== undefined) {
      let encoded: string | undefined;
      try { encoded = JSON.stringify(file.sourceMetadata); } catch {
        throw uploadAdmissionError("upload_source_metadata_invalid", 400, `files[${index}].sourceMetadata 无法序列化。`);
      }
      if (Buffer.byteLength(encoded || "", "utf8") > UPLOAD_SESSION_MAX_SOURCE_METADATA_BYTES) {
        throw uploadAdmissionError("upload_source_metadata_bytes_exceeded", 413, `files[${index}].sourceMetadata 超过服务端安全上限。`);
      }
    }
  }
  return { fileCount: files.length, totalBytes };
}

function openAdmissionDatabase(userDataPath: string): Database.Database {
  const databasePath = path.join(userDataPath, "upload-sessions", DATABASE_FILE_NAME);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(databasePath), 0o700);
  const database = openSqliteDatabase(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("busy_timeout = 5000");
  fs.chmodSync(databasePath, 0o600);
  database.exec(`
    CREATE TABLE IF NOT EXISTS upload_session_admission (
      session_id TEXT PRIMARY KEY,
      owner_scope_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('uploading', 'complete')),
      declared_bytes INTEGER NOT NULL CHECK (declared_bytes >= 0),
      file_count INTEGER NOT NULL CHECK (file_count >= 0),
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_upload_session_admission_owner_active
      ON upload_session_admission(owner_scope_key, status, expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_upload_session_admission_expiry
      ON upload_session_admission(expires_at_ms, session_id);
  `);
  for (const suffix of ["-wal", "-shm"]) {
    const auxiliaryPath = `${databasePath}${suffix}`;
    if (fs.existsSync(auxiliaryPath)) fs.chmodSync(auxiliaryPath, 0o600);
  }
  return database;
}

function withImmediateTransaction<Result>(database: Database.Database, operation: () => Result): Result {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    try { database.exec("ROLLBACK"); } catch { /* Preserve the admission failure. */ }
    throw error;
  }
}

export function listExpiredUploadSessionAdmissions(userDataPath: string, nowMs = Date.now(), limit = UPLOAD_SESSION_EXPIRY_CLEANUP_BATCH): string[] {
  const database = openAdmissionDatabase(userDataPath);
  try {
    return database.prepare<[number, number], ExpiredRow>(`
      SELECT session_id AS sessionId FROM upload_session_admission
      WHERE expires_at_ms <= ? ORDER BY expires_at_ms ASC, session_id ASC LIMIT ?
    `).all(nowMs, Math.max(0, Math.min(UPLOAD_SESSION_EXPIRY_CLEANUP_BATCH, Number(limit) || 0))).map((row) => row.sessionId);
  } finally { database.close(); }
}

export function reserveUploadSessionAdmission(input: ReserveUploadSessionAdmissionInput): AdmissionRow & { existing: boolean; expiredSessionIds: string[] } {
  const { userDataPath, sessionId, ownerScopeKey, status, fileCount, totalBytes, nowMs = Date.now() } = input;
  const database = openAdmissionDatabase(userDataPath);
  try {
    return withImmediateTransaction(database, () => {
      const existing = database.prepare<[string], AdmissionRow>(`
        SELECT session_id AS sessionId, owner_scope_key AS ownerScopeKey, status,
          declared_bytes AS declaredBytes, file_count AS fileCount, expires_at_ms AS expiresAtMs
        FROM upload_session_admission WHERE session_id = ?
      `).get(sessionId);
      if (existing) {
        if (existing.ownerScopeKey !== ownerScopeKey || existing.declaredBytes !== totalBytes || existing.fileCount !== fileCount) {
          throw uploadAdmissionError("upload_session_declaration_conflict", 409, "上传会话声明与已预留记录不一致。");
        }
        return { existing: true, expiredSessionIds: [], ...existing };
      }
      const retainedCount = database.prepare<[], CountRow>("SELECT COUNT(*) AS count FROM upload_session_admission").get()?.count || 0;
      if (retainedCount >= UPLOAD_SESSION_MAX_RETAINED) {
        throw uploadAdmissionError("upload_retained_capacity_exceeded", 429, "上传会话保留容量暂时已满。");
      }
      if (status === "uploading") {
        const activeCount = database.prepare<[string, number], CountRow>(`
          SELECT COUNT(*) AS count FROM upload_session_admission
          WHERE owner_scope_key = ? AND status = 'uploading' AND expires_at_ms > ?
        `).get(ownerScopeKey, nowMs)?.count || 0;
        if (activeCount >= UPLOAD_SESSION_MAX_ACTIVE_PER_OWNER_SCOPE) {
          throw uploadAdmissionError("upload_owner_active_capacity_exceeded", 429, "当前主体的活动上传会话已达到服务端安全上限。");
        }
      }
      const expiresAtMs = nowMs + UPLOAD_SESSION_TTL_MS;
      database.prepare<[string, string, AdmissionStatus, number, number, number, number]>(`
        INSERT INTO upload_session_admission (
          session_id, owner_scope_key, status, declared_bytes, file_count, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, ownerScopeKey, status, totalBytes, fileCount, nowMs, expiresAtMs);
      return { existing: false, expiredSessionIds: [], sessionId, ownerScopeKey, status, declaredBytes: totalBytes, fileCount, expiresAtMs };
    });
  } finally { database.close(); }
}

export function readUploadSessionAdmission(userDataPath: string, sessionId: string, nowMs = Date.now()): Pick<AdmissionRow, "status" | "expiresAtMs"> | null {
  const database = openAdmissionDatabase(userDataPath);
  try {
    const row = database.prepare<[string], Pick<AdmissionRow, "status" | "expiresAtMs">>(`
      SELECT status, expires_at_ms AS expiresAtMs FROM upload_session_admission WHERE session_id = ?
    `).get(sessionId);
    return row && row.expiresAtMs > nowMs ? row : null;
  } finally { database.close(); }
}

export function updateUploadSessionAdmissionStatus(userDataPath: string, sessionId: string, status: AdmissionStatus): void {
  const database = openAdmissionDatabase(userDataPath);
  try { database.prepare<[AdmissionStatus, string]>("UPDATE upload_session_admission SET status = ? WHERE session_id = ?").run(status, sessionId); }
  finally { database.close(); }
}

export function deleteUploadSessionAdmission(userDataPath: string, sessionId: string): void {
  const database = openAdmissionDatabase(userDataPath);
  try { database.prepare<[string]>("DELETE FROM upload_session_admission WHERE session_id = ?").run(sessionId); }
  finally { database.close(); }
}
