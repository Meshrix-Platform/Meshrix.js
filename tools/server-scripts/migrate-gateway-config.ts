import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { readFile, rename, open, unlink, lstat, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

export const GATEWAY_MIGRATION_SCHEMA = "v0.0.1:meshrix:gateway-migration-1" as const;

type JsonRecord = Record<string, unknown>;

export interface GatewayMigrationReport {
  readonly schemaVersion: typeof GATEWAY_MIGRATION_SCHEMA;
  readonly sourceRevision: string;
  readonly targetSchemaVersion: string;
  readonly changed: readonly string[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly serviceCount: number;
  readonly applied: boolean;
}

export interface GatewayMigrationOptions {
  readonly expectedRevision?: string;
  readonly targetSchemaVersion?: string;
}

export interface GatewayMigrationApplyOptions extends GatewayMigrationOptions {
  readonly backupPath?: string;
  /** Focused fault injection on the original atomic writer; never supplied by the CLI. */
  readonly atomicIO?: { readonly rename?: typeof rename; readonly write?: (handle: FileHandle, bytes: Uint8Array) => Promise<void> };
}

interface BackupProvenance {
  readonly schemaVersion: "meshrix.gateway-migration-backup/v1";
  readonly sourceRevision: string;
  readonly targetRevision: string;
  readonly objectRevision: string;
}

function isRecord(value: unknown): value is JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sourceRevision(source: JsonRecord, bytes: Uint8Array): string {
  return `sha256:${digestBytes(bytes)}`;
}

function migrateService(value: unknown, index: number, changed: string[], warnings: string[], errors: string[]): JsonRecord {
  if (!isRecord(value)) {
    errors.push(`services[${index}] must be an object`);
    return {};
  }
  const service = clone(value);
  if (service.serviceId === undefined && typeof service.serviceKey === "string") {
    service.serviceId = service.serviceKey;
    delete service.serviceKey;
    changed.push(`services[${index}].serviceKey->serviceId`);
  }
  if (service.baseUrl === undefined && typeof service.endpoint === "string") {
    service.baseUrl = service.endpoint;
    delete service.endpoint;
    changed.push(`services[${index}].endpoint->baseUrl`);
  }
  if (service.method === undefined && typeof service.rpcMethod === "string") {
    service.method = service.rpcMethod;
    delete service.rpcMethod;
    changed.push(`services[${index}].rpcMethod->method`);
  }
  if (service.method === undefined) warnings.push(`services[${index}].method requires operator confirmation; no method was inferred`);
  if (service.transport === "stdio") {
    if (typeof service.command !== "string" || !service.command.trim()) errors.push(`services[${index}].command is required for stdio`);
  } else if (typeof service.baseUrl !== "string" || !service.baseUrl.trim()) errors.push(`services[${index}].baseUrl is required`);
  if (typeof service.method === "string" && !/^[A-Za-z][A-Za-z0-9-]*$/u.test(service.method.trim())) errors.push(`services[${index}].method is invalid`);
  return service;
}

function migrateDocument(source: JsonRecord, sourceRevisionValue: string, options: GatewayMigrationOptions): { document: JsonRecord; report: GatewayMigrationReport } {
  const changed: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const targetSchemaVersion = options.targetSchemaVersion ?? "v0.0.1:meshrix:gateway-config-1";
  const document = clone(source);
  if (!Array.isArray(document.services) && !isRecord(document.service)) errors.push("services or service must be present in a supported gateway configuration");
  const services = Array.isArray(document.services) ? document.services : isRecord(document.service) ? [document.service] : [];
  if (!Array.isArray(document.services) && services.length > 0) {
    document.services = services;
    delete document.service;
    changed.push("service->services");
  }
  document.services = services.map((service, index) => migrateService(service, index, changed, warnings, errors));
  if (document.schemaVersion !== targetSchemaVersion) {
    document.schemaVersion = targetSchemaVersion;
    changed.push("schemaVersion");
  }
  if (options.expectedRevision && options.expectedRevision !== sourceRevisionValue) errors.push("expectedRevision does not match the source revision");
  return {
    document,
    report: Object.freeze({
      schemaVersion: GATEWAY_MIGRATION_SCHEMA,
      sourceRevision: sourceRevisionValue,
      targetSchemaVersion,
      changed: Object.freeze(changed),
      warnings: Object.freeze(warnings),
      errors: Object.freeze(errors),
      serviceCount: services.length,
      applied: false
    })
  };
}

async function readDocument(inputPath: string): Promise<{ source: JsonRecord; bytes: Uint8Array; revision: string }> {
  const sourceFile = await lstat(inputPath);
  if (!sourceFile.isFile() || sourceFile.isSymbolicLink()) throw Object.assign(new Error("Gateway source must be a regular file."), { code: "gateway_migration_source_invalid" });
  const bytes = await readFile(inputPath);
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new Error("Gateway configuration is not valid JSON."); }
  if (!isRecord(parsed)) throw new Error("Gateway configuration root must be an object.");
  return { source: parsed, bytes, revision: sourceRevision(parsed, bytes) };
}

export async function previewGatewayMigration(inputPath: string, options: GatewayMigrationOptions = {}): Promise<GatewayMigrationReport> {
  const { source, revision } = await readDocument(inputPath);
  const { report } = migrateDocument(source, revision, options);
  return Object.freeze({ ...report, sourceRevision: revision });
}

async function atomicWrite(path: string, bytes: Uint8Array, io: GatewayMigrationApplyOptions["atomicIO"] = {}): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      if (io?.write) await io.write(handle, bytes);
      else await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await (io?.rename ?? rename)(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function backupPaths(backupPath: string, revision: string) {
  return { object: `${backupPath}.${revision.replace(":", "-")}`, receipt: `${backupPath}.receipt.json` };
}

async function existing(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function readPrivateBackup(path: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.size > 16 * 1024 * 1024) {
    throw Object.assign(new Error("Existing gateway backup is not a private regular file."), { code: "gateway_migration_backup_invalid" });
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== metadata.dev || actual.ino !== metadata.ino) throw Object.assign(new Error("Gateway backup changed while reading."), { code: "gateway_migration_backup_invalid" });
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function writeImmutable(path: string, bytes: Uint8Array): Promise<void> {
  let handle: FileHandle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previous = await readPrivateBackup(path);
    if (digestBytes(previous) !== digestBytes(bytes) || !Buffer.from(previous).equals(Buffer.from(bytes))) throw Object.assign(new Error("Existing gateway backup bytes do not match the immutable candidate."), { code: "gateway_migration_backup_conflict" });
    return;
  }
  try { await handle.writeFile(bytes); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(path).catch(() => {}); throw error; }
  await handle.close();
}

async function verifiedBackup(backupPath: string, sourceRevisionValue: string, targetRevision?: string, sourceBytes?: Uint8Array): Promise<Buffer> {
  const aliasExists = await existing(backupPath);
  const objectPath = backupPaths(backupPath, sourceRevisionValue).object;
  const receiptPath = backupPaths(backupPath, sourceRevisionValue).receipt;
  if (!aliasExists && !sourceBytes) throw Object.assign(new Error("Gateway backup is missing."), { code: "gateway_migration_backup_invalid" });
  if (sourceBytes && !aliasExists) {
    if (!targetRevision) throw Object.assign(new Error("Gateway migration target revision is missing."), { code: "gateway_migration_backup_invalid" });
    // Create the content-addressed object and receipt before the first alias.
    await writeImmutable(objectPath, sourceBytes);
    const provenance: BackupProvenance = { schemaVersion: "meshrix.gateway-migration-backup/v1", sourceRevision: sourceRevisionValue, targetRevision, objectRevision: sourceRevisionValue };
    await writeImmutable(receiptPath, Buffer.from(`${JSON.stringify(provenance)}\n`, "utf8"));
    await writeImmutable(backupPath, sourceBytes);
  }
  const alias = await readPrivateBackup(backupPath);
  const actualRevision = `sha256:${digestBytes(alias)}`;
  if (actualRevision !== sourceRevisionValue || sourceBytes && !Buffer.from(alias).equals(Buffer.from(sourceBytes))) throw Object.assign(new Error("Gateway earliest backup does not match this migration source."), { code: "gateway_migration_backup_conflict" });
  const object = await readPrivateBackup(objectPath);
  if (!object.equals(alias)) throw Object.assign(new Error("Content-addressed gateway backup was changed."), { code: "gateway_migration_backup_conflict" });
  const rawReceipt = await readPrivateBackup(receiptPath);
  let receipt: unknown;
  try { receipt = JSON.parse(rawReceipt.toString("utf8")); } catch { /* invalid provenance is rejected below */ }
  if (!isRecord(receipt) || receipt.schemaVersion !== "meshrix.gateway-migration-backup/v1" || receipt.sourceRevision !== sourceRevisionValue ||
      receipt.objectRevision !== actualRevision || typeof receipt.targetRevision !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(receipt.targetRevision) ||
      targetRevision !== undefined && receipt.targetRevision !== targetRevision) throw Object.assign(new Error("Gateway backup provenance is invalid."), { code: "gateway_migration_backup_invalid" });
  const parsed: unknown = JSON.parse(alias.toString("utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.services) && !isRecord(parsed.service)) throw Object.assign(new Error("Gateway backup source shape is invalid."), { code: "gateway_migration_backup_invalid" });
  return alias;
}

export async function applyGatewayMigration(inputPath: string, options: GatewayMigrationApplyOptions = {}): Promise<GatewayMigrationReport> {
  if (!options.expectedRevision) throw Object.assign(new Error("Apply requires a preview source digest."), { code: "gateway_migration_preview_required" });
  return withMigrationLock(inputPath, async () => {
    const { source, bytes, revision } = await readDocument(inputPath);
    const { document, report } = migrateDocument(source, revision, options);
    if (report.errors.length > 0) throw Object.assign(new Error("Gateway configuration migration was not applied."), { code: "gateway_migration_rejected", report });
    if (report.changed.length === 0) return Object.freeze({ ...report, applied: false });
    const backupPath = options.backupPath ?? `${inputPath}.backup`;
    if (resolve(backupPath) === resolve(inputPath)) throw Object.assign(new Error("Backup must not replace its source."), { code: "gateway_migration_backup_invalid" });
    const targetBytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await verifiedBackup(backupPath, revision, `sha256:${digestBytes(targetBytes)}`, bytes);
    // The lock fences other migrators; verify the exact input again to detect outside writers.
    if (digestBytes(await readFile(inputPath)) !== digestBytes(bytes)) throw Object.assign(new Error("Gateway configuration changed during migration."), { code: "gateway_migration_conflict" });
    await atomicWrite(inputPath, targetBytes, options.atomicIO);
    return Object.freeze({ ...report, applied: true });
  });
}

async function withMigrationLock<T>(inputPath: string, task: () => Promise<T>): Promise<T> {
  const lockPath = `${inputPath}.migration.lock`;
  let handle;
  try { handle = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error("A gateway migration is in progress."), { code: "gateway_migration_locked" });
    throw error;
  }
  try { return await task(); }
  finally { await handle.close(); await unlink(lockPath); }
}

export async function restoreGatewayMigration(inputPath: string, options: { readonly expectedRevision: string; readonly backupRevision: string; readonly backupPath?: string; readonly atomicIO?: GatewayMigrationApplyOptions["atomicIO"] }): Promise<GatewayMigrationReport> {
  return withMigrationLock(inputPath, async () => {
    if (resolve(options.backupPath ?? `${inputPath}.backup`) === resolve(inputPath)) throw Object.assign(new Error("Backup must not replace its source."), { code: "gateway_migration_backup_invalid" });
    const current = await readDocument(inputPath);
    if (current.revision !== options.expectedRevision) throw Object.assign(new Error("Gateway restore source digest mismatch."), { code: "gateway_migration_conflict" });
    const backupPath = options.backupPath ?? `${inputPath}.backup`;
    const backup = await verifiedBackup(backupPath, options.backupRevision, current.revision === options.backupRevision ? undefined : current.revision);
    if (current.revision === options.backupRevision) return Object.freeze({ ...(await previewGatewayMigration(inputPath)), applied: false });
    if (digestBytes(await readFile(inputPath)) !== digestBytes(current.bytes)) throw Object.assign(new Error("Gateway configuration changed during restore."), { code: "gateway_migration_conflict" });
    await atomicWrite(inputPath, backup, options.atomicIO);
    return Object.freeze({ ...(await previewGatewayMigration(inputPath)), applied: true });
  });
}

function cliArgs(argv: readonly string[]): { command: "preview" | "apply" | "restore"; input?: string; expectedRevision?: string; backupRevision?: string; backup?: string } {
  const [command = "preview", ...rest] = argv;
  let input: string | undefined;
  let expectedRevision: string | undefined;
  let backup: string | undefined;
  let backupRevision: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item === "--input") input = rest[++index];
    else if (item === "--expected-revision") expectedRevision = rest[++index];
    else if (item === "--backup") backup = rest[++index];
    else if (item === "--backup-revision") backupRevision = rest[++index];
  }
  if (command !== "preview" && command !== "apply" && command !== "restore") throw new Error("Usage: migrate-gateway-config.ts preview|apply|restore --input CONFIG.json --expected-revision SHA256 [--backup-revision SHA256] [--backup BACKUP.json]");
  return { command, input, expectedRevision, backupRevision, backup };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = cliArgs(process.argv.slice(2));
  if (!args.input) throw new Error("--input is required");
  const operation = args.command === "preview"
    ? previewGatewayMigration(args.input, { expectedRevision: args.expectedRevision })
    : args.command === "restore"
      ? args.expectedRevision && args.backupRevision ? restoreGatewayMigration(args.input, { expectedRevision: args.expectedRevision, backupRevision: args.backupRevision, backupPath: args.backup }) : Promise.reject(new Error("Restore needs expected and backup revisions."))
      : applyGatewayMigration(args.input, { expectedRevision: args.expectedRevision, backupPath: args.backup });
  operation.then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
