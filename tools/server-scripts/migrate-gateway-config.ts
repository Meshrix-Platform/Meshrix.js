import { createHash, randomUUID } from "node:crypto";
import { copyFile, readFile, rename, writeFile, open } from "node:fs/promises";

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
  return typeof source.revision === "string" && source.revision.trim() ? source.revision : `sha256:${digestBytes(bytes)}`;
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
  if (typeof service.baseUrl !== "string" || service.baseUrl.trim().length === 0) errors.push(`services[${index}].baseUrl is required`);
  if (typeof service.method === "string" && !/^[A-Za-z][A-Za-z0-9-]*$/u.test(service.method.trim())) errors.push(`services[${index}].method is invalid`);
  return service;
}

function migrateDocument(source: JsonRecord, sourceRevisionValue: string, options: GatewayMigrationOptions): { document: JsonRecord; report: GatewayMigrationReport } {
  const changed: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const targetSchemaVersion = options.targetSchemaVersion ?? "v0.0.1:meshrix:gateway-config-1";
  const document = clone(source);
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

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.write(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function applyGatewayMigration(inputPath: string, options: GatewayMigrationApplyOptions = {}): Promise<GatewayMigrationReport> {
  const { source, revision } = await readDocument(inputPath);
  const { document, report } = migrateDocument(source, revision, options);
  if (report.errors.length > 0) throw Object.assign(new Error("Gateway configuration migration was not applied."), { code: "gateway_migration_rejected", report });
  const backupPath = options.backupPath ?? `${inputPath}.backup`;
  await copyFile(inputPath, backupPath);
  await atomicWrite(inputPath, Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8"));
  return Object.freeze({ ...report, sourceRevision: revision, applied: true });
}

function cliArgs(argv: readonly string[]): { command: "preview" | "apply"; input?: string; expectedRevision?: string; backup?: string } {
  const [command = "preview", ...rest] = argv;
  let input: string | undefined;
  let expectedRevision: string | undefined;
  let backup: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item === "--input") input = rest[++index];
    else if (item === "--expected-revision") expectedRevision = rest[++index];
    else if (item === "--backup") backup = rest[++index];
  }
  if (command !== "preview" && command !== "apply") throw new Error("Usage: migrate-gateway-config.ts preview|apply --input CONFIG.json [--expected-revision REVISION] [--backup BACKUP.json]");
  return { command, input, expectedRevision, backup };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = cliArgs(process.argv.slice(2));
  if (!args.input) throw new Error("--input is required");
  const operation = args.command === "preview"
    ? previewGatewayMigration(args.input, { expectedRevision: args.expectedRevision })
    : applyGatewayMigration(args.input, { expectedRevision: args.expectedRevision, backupPath: args.backup });
  operation.then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
