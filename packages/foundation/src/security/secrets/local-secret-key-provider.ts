import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ServerConfig } from "#meshrix/server-config";

export const LOCAL_SECRET_KEY_PROVIDER_VERSION: any =
  "v0.0.1:security:local-secret-key-provider-1";
export const LOCAL_SECRET_MASTER_KEY_FILE_ENV: any =
  "MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE";

const MASTER_KEY_BYTES: any = 32;
const HEX_KEY_PATTERN: any = /^[0-9a-f]{64}$/u;
const defaultProviders: any = new Map<any, any>();

function text(value?: any) : any {
  return String(value ?? "").trim();
}

function keyProviderError(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  return error;
}

function resolvedDataDir(dataDir: any = "") : any {
  return path.resolve(text(dataDir) || ServerConfig.getDataDir());
}

function pathIsWithin(parent?: any, child?: any) : any {
  const relative: any = path.relative(parent, child);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function parseMasterKey(bytes?: any) : any {
  const encoded: any = bytes.toString("utf8").trim().toLowerCase();
  if (!HEX_KEY_PATTERN.test(encoded)) {
    throw keyProviderError(
      "local_secret_key_invalid",
      "Meshrix.js local secret master key is invalid.",
    );
  }
  return Buffer.from(encoded, "hex");
}

function keyFact(key?: any, custody?: any) : any {
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

async function validateExternalKeyFile({ dataDir, keyFile }: Record<string, any>) : Promise<any> {
  const configuredPath: any = text(keyFile);
  if (!configuredPath || !path.isAbsolute(configuredPath)) {
    throw keyProviderError(
      "local_secret_key_unavailable",
      "Meshrix.js local secret master key file is not configured.",
    );
  }
  const [keyStat, keyRealPath, dataRealPath] = await Promise.all([
    fs.lstat(configuredPath).catch(() : any => null),
    fs.realpath(configuredPath).catch(() : any => ""),
    fs.realpath(resolvedDataDir(dataDir)).catch(() : any => resolvedDataDir(dataDir)),
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
}: Record<string, any> = {}) : any {
  let cachedKey: any = null;
  let cachedKeyId: any = "";

  return Object.freeze({
    protocolVersion: LOCAL_SECRET_KEY_PROVIDER_VERSION,
    custody: "external-file",
    async loadKey() : Promise<any> {
      if (cachedKey) {
        return Object.freeze({
          protocolVersion: LOCAL_SECRET_KEY_PROVIDER_VERSION,
          custody: "external-file",
          keyId: cachedKeyId,
          key: Buffer.from(cachedKey),
        });
      }
      const keyPath: any = await validateExternalKeyFile({ dataDir, keyFile });
      let bytes: any;
      let parsedKey: any;
      try {
        bytes = await fs.readFile(keyPath);
        parsedKey = parseMasterKey(bytes);
        const fact: any = keyFact(parsedKey, "external-file");
        cachedKey = Buffer.from(fact.key);
        cachedKeyId = fact.keyId;
        fact.key.fill(0);
        return Object.freeze({
          protocolVersion: LOCAL_SECRET_KEY_PROVIDER_VERSION,
          custody: "external-file",
          keyId: cachedKeyId,
          key: Buffer.from(cachedKey),
        });
      } catch (error: any) {
        if (error?.code?.startsWith?.("local_secret_key_")) throw error;
        throw keyProviderError(
          "local_secret_key_unavailable",
          "Meshrix.js local secret master key file is unavailable.",
        );
      } finally {
        bytes?.fill(0);
        parsedKey?.fill(0);
      }
    },
    close() : any {
      cachedKey?.fill(0);
      cachedKey = null;
      cachedKeyId = "";
    },
    describe() : any {
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
}: Record<string, any> = {}) : any {
  const retained: any = Buffer.from(key);
  let closed: any = false;
  if (retained.length !== MASTER_KEY_BYTES) {
    retained.fill(0);
    throw keyProviderError(
      "local_secret_key_invalid",
      "Meshrix.js local secret master key is invalid.",
    );
  }
  const keyId: any = `sha256:${crypto.createHash("sha256").update(retained).digest("hex")}`;
  return Object.freeze({
    protocolVersion: LOCAL_SECRET_KEY_PROVIDER_VERSION,
    custody: "memory",
    async loadKey() : Promise<any> {
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
    close() : any {
      closed = true;
      retained.fill(0);
    },
    describe() : any {
      return Object.freeze({
        protocolVersion: LOCAL_SECRET_KEY_PROVIDER_VERSION,
        custody: "memory",
        configured: true,
      });
    },
  });
}

export function resolveLocalSecretKeyProvider({ dataDir = "", keyProvider = null }: Record<string, any> = {}) : any {
  if (keyProvider) {
    if (typeof keyProvider.loadKey !== "function") {
      throw keyProviderError(
        "local_secret_key_provider_invalid",
        "Meshrix.js local secret key provider is invalid.",
      );
    }
    return keyProvider;
  }
  const keyFile: any = text(process.env[LOCAL_SECRET_MASTER_KEY_FILE_ENV]);
  const cacheKey: any = `${resolvedDataDir(dataDir)}\0${keyFile}`;
  let provider: any = defaultProviders.get(cacheKey);
  if (!provider) {
    provider = createFileLocalSecretKeyProvider({ dataDir, keyFile });
    defaultProviders.set(cacheKey, provider);
  }
  return provider;
}

export async function assertLocalSecretKeyReady({
  dataDir = "",
  keyProvider = null,
}: Record<string, any> = {}) : Promise<any> {
  const provider: any = resolveLocalSecretKeyProvider({ dataDir, keyProvider });
  const fact: any = await provider.loadKey();
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
