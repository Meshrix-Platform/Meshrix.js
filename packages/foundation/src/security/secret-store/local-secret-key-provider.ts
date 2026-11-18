import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ServerConfig } from "#meshrix/server-config";

export const LOCAL_SECRET_KEY_PROVIDER_VERSION =
  "v0.0.1:security:local-secret-key-provider-1";
export const LOCAL_SECRET_MASTER_KEY_FILE_ENV =
  "MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE";

const MASTER_KEY_BYTES = 32;
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/u;

export interface LocalSecretKeyFact {
  readonly protocolVersion: string;
  readonly custody: string;
  readonly keyId: string;
  readonly key: Buffer;
}

export interface LocalSecretKeyProvider {
  readonly protocolVersion: string;
  readonly custody: string;
  loadKey(): Promise<LocalSecretKeyFact>;
  close(): void;
  describe(): Readonly<{
    protocolVersion: string;
    custody: string;
    configured: boolean;
  }>;
}

interface KeyProviderOptions {
  dataDir?: string;
  keyFile?: string;
  keyProvider?: LocalSecretKeyProvider | null;
}

const defaultProviders = new Map<string, LocalSecretKeyProvider>();

function text(value?: unknown): string {
  return String(value ?? "").trim();
}

function keyProviderError(code = "local_secret_key_unavailable", message = "Meshrix.js local secret key is unavailable."): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function resolvedDataDir(dataDir = ""): string {
  return path.resolve(text(dataDir) || ServerConfig.getDataDir());
}

function pathIsWithin(parent = "", child = ""): boolean {
  const relative = path.relative(parent, child);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function parseMasterKey(bytes: Buffer): Buffer {
  const encoded = bytes.toString("utf8").trim().toLowerCase();
  if (!HEX_KEY_PATTERN.test(encoded)) {
    throw keyProviderError(
      "local_secret_key_invalid",
      "Meshrix.js local secret master key is invalid.",
    );
  }
  return Buffer.from(encoded, "hex");
}

function keyFact(key: Buffer, custody: string): Readonly<LocalSecretKeyFact> {
  if (!Buffer.isBuffer(key) || key.length !== MASTER_KEY_BYTES) {
    throw keyProviderError(
      "local_secret_key_invalid",
      "Meshrix.js local secret master key is invalid.",
    );
  }
  return Object.freeze({
    protocolVersion: LOCAL_SECRET_KEY_PROVIDER_VERSION,
    custody,
    keyId: `sha256:${crypto.createHash("sha256").update(key).digest("hex")}`,
    key: Buffer.from(key),
  });
}

async function validateExternalKeyFile({ dataDir = "", keyFile = "" }: KeyProviderOptions): Promise<string> {
  const configuredPath = text(keyFile);
  if (!configuredPath || !path.isAbsolute(configuredPath)) {
    throw keyProviderError(
      "local_secret_key_unavailable",
      "Meshrix.js local secret master key file is not configured.",
    );
  }
  const [keyStat, keyRealPath, dataRealPath] = await Promise.all([
    fs.lstat(configuredPath).catch(() => null),
    fs.realpath(configuredPath).catch(() => ""),
    fs.realpath(resolvedDataDir(dataDir)).catch(() => resolvedDataDir(dataDir)),
  ]);
  if (
    !keyStat?.isFile() ||
    keyStat.isSymbolicLink() ||
    !keyRealPath ||
    keyStat.size > 256
  ) {
    throw keyProviderError(
      "local_secret_key_unavailable",
      "Meshrix.js local secret master key file is unavailable.",
    );
  }
  if (pathIsWithin(dataRealPath, keyRealPath)) {
    throw keyProviderError(
      "local_secret_key_custody_invalid",
      "Meshrix.js local secret master key must be kept outside governed data.",
    );
  }
  return keyRealPath;
}

export function createFileLocalSecretKeyProvider({
  dataDir = "",
  keyFile = process.env[LOCAL_SECRET_MASTER_KEY_FILE_ENV] || "",
}: KeyProviderOptions = {}): LocalSecretKeyProvider {
  let cachedKey: Buffer | null = null;
  let cachedKeyId = "";

  return Object.freeze({
    protocolVersion: LOCAL_SECRET_KEY_PROVIDER_VERSION,
    custody: "external-file",
    async loadKey(): Promise<LocalSecretKeyFact> {
      if (cachedKey) {
        return Object.freeze({
          protocolVersion: LOCAL_SECRET_KEY_PROVIDER_VERSION,
          custody: "external-file",
          keyId: cachedKeyId,
          key: Buffer.from(cachedKey),
        });
      }
      const keyPath = await validateExternalKeyFile({ dataDir, keyFile });
      let bytes: Buffer | undefined;
      let parsedKey: Buffer | undefined;
      try {
        bytes = await fs.readFile(keyPath);
        parsedKey = parseMasterKey(bytes);
        const fact = keyFact(parsedKey, "external-file");
        cachedKey = Buffer.from(fact.key);
        cachedKeyId = fact.keyId;
        fact.key.fill(0);
        return Object.freeze({
          protocolVersion: LOCAL_SECRET_KEY_PROVIDER_VERSION,
          custody: "external-file",
          keyId: cachedKeyId,
          key: Buffer.from(cachedKey),
        });
      } catch (error: unknown) {
        if ((error as { code?: string })?.code?.startsWith("local_secret_key_")) throw error;
        throw keyProviderError(
          "local_secret_key_unavailable",
          "Meshrix.js local secret master key file is unavailable.",
        );
      } finally {
        bytes?.fill(0);
        parsedKey?.fill(0);
      }
    },
    close(): void {
      cachedKey?.fill(0);
      cachedKey = null;
      cachedKeyId = "";
    },
    describe() {
      return Object.freeze({
        protocolVersion: LOCAL_SECRET_KEY_PROVIDER_VERSION,
        custody: "external-file",
        configured: Boolean(text(keyFile)),
      });
    },
  });
}

export function createMemoryLocalSecretKeyProvider({
  key = crypto.randomBytes(MASTER_KEY_BYTES),
}: { key?: Uint8Array } = {}): LocalSecretKeyProvider {
  const retained = Buffer.from(key);
  let closed = false;
  if (retained.length !== MASTER_KEY_BYTES) {
    retained.fill(0);
    throw keyProviderError(
      "local_secret_key_invalid",
      "Meshrix.js local secret master key is invalid.",
    );
  }
  const keyId = `sha256:${crypto.createHash("sha256").update(retained).digest("hex")}`;
  return Object.freeze({
    protocolVersion: LOCAL_SECRET_KEY_PROVIDER_VERSION,
    custody: "memory",
    async loadKey(): Promise<LocalSecretKeyFact> {
      if (closed) {
        throw keyProviderError(
          "local_secret_key_unavailable",
          "Meshrix.js local secret master key is unavailable.",
        );
      }
      return Object.freeze({
        protocolVersion: LOCAL_SECRET_KEY_PROVIDER_VERSION,
        custody: "memory",
        keyId,
        key: Buffer.from(retained),
      });
    },
    close(): void {
      closed = true;
      retained.fill(0);
    },
    describe() {
      return Object.freeze({
        protocolVersion: LOCAL_SECRET_KEY_PROVIDER_VERSION,
        custody: "memory",
        configured: true,
      });
    },
  });
}

export function resolveLocalSecretKeyProvider({ dataDir = "", keyProvider = null }: KeyProviderOptions = {}): LocalSecretKeyProvider {
  if (keyProvider) {
    if (typeof keyProvider.loadKey !== "function") {
      throw keyProviderError(
        "local_secret_key_provider_invalid",
        "Meshrix.js local secret key provider is invalid.",
      );
    }
    return keyProvider;
  }
  const keyFile = text(process.env[LOCAL_SECRET_MASTER_KEY_FILE_ENV]);
  const cacheKey = `${resolvedDataDir(dataDir)}\0${keyFile}`;
  let provider = defaultProviders.get(cacheKey);
  if (!provider) {
    provider = createFileLocalSecretKeyProvider({ dataDir, keyFile });
    defaultProviders.set(cacheKey, provider);
  }
  return provider;
}

export async function assertLocalSecretKeyReady({
  dataDir = "",
  keyProvider = null,
}: KeyProviderOptions = {}) {
  const provider = resolveLocalSecretKeyProvider({ dataDir, keyProvider });
  const fact = await provider.loadKey();
  try {
    if (
      !Buffer.isBuffer(fact?.key) ||
      fact.key.length !== MASTER_KEY_BYTES ||
      !/^sha256:[0-9a-f]{64}$/u.test(String(fact?.keyId || ""))
    ) {
      throw keyProviderError(
        "local_secret_key_invalid",
        "Meshrix.js local secret master key is invalid.",
      );
    }
    return Object.freeze({
      ready: true,
      protocolVersion: LOCAL_SECRET_KEY_PROVIDER_VERSION,
      custody: String(fact.custody || provider.custody || "external"),
    });
  } finally {
    fact?.key?.fill(0);
  }
}
