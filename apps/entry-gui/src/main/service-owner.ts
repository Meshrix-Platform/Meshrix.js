import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDir, writePrivateFileAtomic } from "@meshrix/foundation/storage/private-file-atomic";

const OWNER_FILE = "entry-gui.service-owner.json";
const OWNER_SCHEMA = "entry-gui-service-owner-1";
const OWNER_LOCK_DB = "entry-gui.profile-owner.sqlite";

export interface EntryServiceOwnerRecord {
  readonly schemaVersion: typeof OWNER_SCHEMA;
  readonly pid: number;
  readonly ownerId: string;
  readonly port: number;
  readonly token: string;
}

export interface EntryServiceOwnerLease {
  readonly assertActive: () => void;
  readonly publish: (port: number, token: string) => Promise<void>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

/**
 * The Node writer itself owns a persistent SQLite writer transaction for
 * its full process lifetime. This keeps OS lock ownership aligned with the
 * process that writes profile state, including if the GUI parent disappears.
 * The JSON file is only the private MCP attachment descriptor, never a lock.
 */
export async function acquireEntryServiceOwner(dataDir: string): Promise<EntryServiceOwnerLease> {
  await ensurePrivateDir(dataDir);
  const ownerPath = join(dataDir, OWNER_FILE);
  const lockDb = new DatabaseSync(join(dataDir, OWNER_LOCK_DB));
  try {
    lockDb.exec("PRAGMA busy_timeout=0");
    // IMMEDIATE takes SQLite's single RESERVED writer lock up front. It
    // excludes every competing Node writer without a read→exclusive lock
    // upgrade race when two launchers hit a new profile simultaneously.
    lockDb.exec("BEGIN IMMEDIATE");
  } catch (error) {
    lockDb.close();
    const sqliteCode = (error as { errcode?: unknown }).errcode;
    if (sqliteCode === 5 || sqliteCode === 6) {
      throw Object.assign(new Error("Another Meshrix service already owns this profile."), { code: "entry_service_owner_active" });
    }
    throw Object.assign(new Error("The Meshrix profile ownership lock could not be acquired."), { code: "entry_service_owner_unavailable" });
  }
  const ownerId = randomUUID();
  const assertActive = () => {
    if (!lockDb.isOpen || !lockDb.isTransaction) {
      throw Object.assign(new Error("The Meshrix profile ownership lock is no longer held."), { code: "entry_service_owner_lost" });
    }
  };
  return Object.freeze({
    assertActive,
    async publish(port: number, token: string): Promise<void> {
      assertActive();
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || token.length < 32) {
        throw new Error("The Meshrix service owner descriptor is invalid.");
      }
      const record: EntryServiceOwnerRecord = { schemaVersion: OWNER_SCHEMA, pid: process.pid, ownerId, port, token };
      await writePrivateFileAtomic(ownerPath, `${JSON.stringify(record)}\n`);
    }
  });
}

/** Read the canonical owner descriptor for the local MCP attachment only. */
export async function readEntryServiceOwner(dataDir: string): Promise<EntryServiceOwnerRecord> {
  const path = join(dataDir, OWNER_FILE);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      throw Object.assign(new Error("The Meshrix desktop owner is not running. Reopen Meshrix before starting its MCP connection."), { code: "entry_service_owner_unavailable" });
    }
    throw Object.assign(new Error("The Meshrix service owner descriptor could not be read. Restart Meshrix to recreate it."), { code: "entry_service_owner_invalid" });
  }
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw Object.assign(new Error("The Meshrix service owner descriptor is not a private regular file. Restart Meshrix to recreate it."), { code: "entry_service_owner_invalid" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw Object.assign(new Error("The Meshrix service owner descriptor is invalid. Restart Meshrix to recreate it."), { code: "entry_service_owner_invalid" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("The Meshrix service owner descriptor is invalid. Restart Meshrix to recreate it."), { code: "entry_service_owner_invalid" });
  }
  const record = parsed as Partial<EntryServiceOwnerRecord>;
  if (record.schemaVersion !== OWNER_SCHEMA
    || !Number.isSafeInteger(record.pid) || Number(record.pid) < 1
    || !Number.isSafeInteger(record.port) || Number(record.port) < 1 || Number(record.port) > 65535
    || typeof record.ownerId !== "string" || !record.ownerId
    || typeof record.token !== "string" || record.token.length < 32) {
    throw Object.assign(new Error("The Meshrix service owner descriptor is invalid. Restart Meshrix to recreate it."), { code: "entry_service_owner_invalid" });
  }
  if (!await processIsAlive(Number(record.pid))) {
    throw Object.assign(new Error("The Meshrix desktop owner is not running. Reopen Meshrix before starting its MCP connection."), { code: "entry_service_owner_unavailable" });
  }
  return record as EntryServiceOwnerRecord;
}
