import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const STORE_SCHEMA = "v0.0.1:execution-sandbox:trusted-provider-receipts-1";
const STORE_DIRECTORY = "execution-sandbox";
const STORE_FILE = "trusted-provider-receipts.json";

type ProviderReceipt = Readonly<Record<string, unknown>>;
export type TrustedProviderReceipts = Readonly<Record<string, ProviderReceipt>>;

function errorCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code || "")
    : "";
}

function storePath(userDataPath?: unknown): string {
  const root = String(userDataPath || "").trim();
  if (!root) return "";
  return path.join(root, STORE_DIRECTORY, STORE_FILE);
}

function normalizedReceipts(value?: unknown): TrustedProviderReceipts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return Object.freeze({});
  const receipts = Object.entries(value)
    .filter((entry): entry is [string, Record<string, unknown>] => {
      const [providerId, receipt] = entry;
      return Boolean(providerId.trim()) &&
        receipt !== null &&
        typeof receipt === "object" &&
        !Array.isArray(receipt);
    })
    .map(([providerId, receipt]) => [providerId.trim(), Object.freeze({ ...receipt })] as const);
  return Object.freeze(Object.fromEntries(receipts));
}

function ownedByCurrentProcess(metadata: Pick<fs.Stats, "uid">): boolean {
  return typeof process.getuid !== "function" || metadata.uid === process.getuid();
}

export function loadTrustedSandboxProviderReceipts(
  { userDataPath }: { userDataPath?: string } = {}
): TrustedProviderReceipts {
  const target = storePath(userDataPath);
  if (!target) return Object.freeze({});
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return Object.freeze({});
    return Object.freeze({});
  }
  try {
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || !ownedByCurrentProcess(metadata) || (metadata.mode & 0o077) !== 0) {
      return Object.freeze({});
    }
    const document: unknown = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (
      document === null ||
      typeof document !== "object" ||
      !("schemaVersion" in document) ||
      document.schemaVersion !== STORE_SCHEMA
    ) return Object.freeze({});
    return normalizedReceipts("receipts" in document ? document.receipts : undefined);
  } catch {
    return Object.freeze({});
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function writeTrustedSandboxProviderReceipts(
  { userDataPath, receipts }: { userDataPath?: string; receipts?: unknown } = {}
): Promise<Readonly<{ receiptCount: number }>> {
  const target = storePath(userDataPath);
  if (!target) throw new TypeError("A runtime data path is required for provider receipts.");
  const directory = path.dirname(target);
  const normalized = normalizedReceipts(receipts);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await fsp.lstat(directory);
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    !ownedByCurrentProcess(directoryMetadata)
  ) {
    throw new Error("The provider receipt store directory is not private runtime state.");
  }
  await fsp.chmod(directory, 0o700);
  const temporary = path.join(directory, `.trusted-provider-receipts.${crypto.randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temporary, `${JSON.stringify({
      schemaVersion: STORE_SCHEMA,
      receipts: normalized
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fsp.rename(temporary, target);
    await fsp.chmod(target, 0o600);
  } catch (error: unknown) {
    await fsp.rm(temporary, { force: true }).catch((): void => {});
    throw error;
  }
  return Object.freeze({ receiptCount: Object.keys(normalized).length });
}

export { STORE_SCHEMA as TRUSTED_SANDBOX_PROVIDER_RECEIPT_STORE_SCHEMA };
