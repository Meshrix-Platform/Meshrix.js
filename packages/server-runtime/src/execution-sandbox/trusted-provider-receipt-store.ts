import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const STORE_SCHEMA: any = "v0.0.1:execution-sandbox:trusted-provider-receipts-1";
const STORE_DIRECTORY: any = "execution-sandbox";
const STORE_FILE: any = "trusted-provider-receipts.json";

function storePath(userDataPath?: any) : any {
  const root: any = String(userDataPath || "").trim();
  if (!root) return "";
  return path.join(root, STORE_DIRECTORY, STORE_FILE);
}

function normalizedReceipts(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return Object.freeze({});
  return Object.freeze(Object.fromEntries((Object.entries(value) as [string, any][])
    .filter(([providerId, receipt]: any[]) : any => providerId.trim() && receipt && typeof receipt === "object" && !Array.isArray(receipt))
    .map(([providerId, receipt]: any[]) : any => [providerId.trim(), Object.freeze({ ...receipt })])));
}

function ownedByCurrentProcess(metadata?: any) : any {
  return typeof process.getuid !== "function" || metadata.uid === process.getuid();
}

export function loadTrustedSandboxProviderReceipts({ userDataPath }: Record<string, any> = {}) : any {
  const target: any = storePath(userDataPath);
  if (!target) return Object.freeze({});
  let descriptor: any;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error: any) {
    if (error?.code === "ENOENT") return Object.freeze({});
    return Object.freeze({});
  }
  try {
    const metadata: any = fs.fstatSync(descriptor);
    if (!metadata.isFile() || !ownedByCurrentProcess(metadata) || (metadata.mode & 0o077) !== 0) {
      return Object.freeze({});
    }
    const document: any = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (document?.schemaVersion !== STORE_SCHEMA) return Object.freeze({});
    return normalizedReceipts(document.receipts);
  } catch {
    return Object.freeze({});
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function writeTrustedSandboxProviderReceipts({ userDataPath, receipts }: Record<string, any> = {}) : Promise<any> {
  const target: any = storePath(userDataPath);
  if (!target) throw new TypeError("A runtime data path is required for provider receipts.");
  const directory: any = path.dirname(target);
  const normalized: any = normalizedReceipts(receipts);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata: any = await fsp.lstat(directory);
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    !ownedByCurrentProcess(directoryMetadata)
  ) {
    throw new Error("The provider receipt store directory is not private runtime state.");
  }
  await fsp.chmod(directory, 0o700);
  const temporary: any = path.join(directory, `.trusted-provider-receipts.${crypto.randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temporary, `${JSON.stringify({
      schemaVersion: STORE_SCHEMA,
      receipts: normalized
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fsp.rename(temporary, target);
    await fsp.chmod(target, 0o600);
  } catch (error: any) {
    await fsp.rm(temporary, { force: true }).catch(() : any => {});
    throw error;
  }
  return Object.freeze({ receiptCount: Object.keys(normalized).length });
}

export { STORE_SCHEMA as TRUSTED_SANDBOX_PROVIDER_RECEIPT_STORE_SCHEMA };
