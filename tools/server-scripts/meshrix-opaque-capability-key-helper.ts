#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { ServerConfig } from "#meshrix/server-config";
import {
  OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION
} from "../../packages/foundation/src/security/authorization/opaque-capability-key.ts";

const DEFAULT_ALIAS: any = "meshrix-opaque-capability-key";

function nowIso() : any {
  return new Date().toISOString();
}

function text(value?: any) : any {
  return String(value || "").trim();
}

function safeAlias(value: any = DEFAULT_ALIAS) : any {
  return text(value || DEFAULT_ALIAS).replace(/[^a-zA-Z0-9._:-]/g, "_") || DEFAULT_ALIAS;
}

function resolveDataDir(dataDir: any = "") : any {
  return path.resolve(text(dataDir) || ServerConfig.getDataDir());
}

function lookupKeyPath({ dataDir = "", alias = DEFAULT_ALIAS }: Record<string, any> = {}) : any {
  return path.join(resolveDataDir(dataDir), "security", "capability-key-lookup", `${safeAlias(alias)}.json`);
}

async function readStdinJson() : Promise<any> {
  let raw: any = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString();
  }
  return raw.trim() ? JSON.parse(raw) : {};
}

function run(command?: any, args: any = [], { input = "" }: Record<string, any> = {}) : any {
  return new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout: any = "";
    let stderr: any = "";
    child.stdout.on("data", (chunk?: any) : any => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk?: any) : any => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code?: any) : any => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${command} failed with exit code ${code}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

function emptyRecord({ alias = DEFAULT_ALIAS, provider = "local-file" }: Record<string, any> = {}) : any {
  return {
    protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
    alias: safeAlias(alias),
    provider,
    generation: 1,
    runtimeLookupKeyBase64: crypto.randomBytes(32).toString("base64"),
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

function publicRecord(record?: any) : any {
  return {
    protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
    alias: record.alias,
    provider: record.provider,
    generation: record.generation,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

async function ensurePrivateDir(dir?: any) : Promise<any> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() : any => {});
}

async function readLocalRecord(input?: any) : Promise<any> {
  const filePath: any = lookupKeyPath(input);
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return emptyRecord({ alias: input.alias, provider: "local-file" });
    }
    throw error;
  }
}

async function writeLocalRecord(input?: any, record?: any) : Promise<any> {
  const filePath: any = lookupKeyPath(input);
  await ensurePrivateDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() : any => {});
}

function keychainService(alias: any = DEFAULT_ALIAS) : any {
  return `com.meshrix.capability-key-lookup.${safeAlias(alias)}`;
}

async function readMacosRecord(input?: any) : Promise<any> {
  if (process.platform !== "darwin") {
    throw new Error("macos-keychain capability key lookup backend is only available on macOS.");
  }
  try {
    const raw: any = await run("security", [
      "find-generic-password",
      "-w",
      "-a",
      "meshrix",
      "-s",
      keychainService(input.alias)
    ]);
    return JSON.parse(raw.trim());
  } catch (error: any) {
    if (/could not be found|The specified item could not be found/i.test(error.message)) {
      return emptyRecord({ alias: input.alias, provider: "macos-keychain" });
    }
    throw error;
  }
}

async function writeMacosRecord(input?: any, record?: any) : Promise<any> {
  if (process.platform !== "darwin") {
    throw new Error("macos-keychain capability key lookup backend is only available on macOS.");
  }
  await run("security", [
    "add-generic-password",
    "-U",
    "-a",
    "meshrix",
    "-s",
    keychainService(input.alias),
    "-w",
    JSON.stringify(record)
  ]);
}

async function readRecord(input?: any) : Promise<any> {
  if (input.backend === "macos-keychain") return readMacosRecord(input);
  if (input.backend === "local-file") return readLocalRecord(input);
  throw new Error(`Unsupported capability key lookup helper backend: ${input.backend}`);
}

async function writeRecord(input?: any, record?: any) : Promise<any> {
  if (input.backend === "macos-keychain") return writeMacosRecord(input, record);
  if (input.backend === "local-file") return writeLocalRecord(input, record);
  throw new Error(`Unsupported capability key lookup helper backend: ${input.backend}`);
}

async function handle(input?: any) : Promise<any> {
  if (input.protocolVersion !== OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION) {
    throw new Error("Unsupported capability key lookup helper protocol version.");
  }
  const action: any = text(input.action);
  let record: any = await readRecord(input);
  record.alias = safeAlias(input.alias);
  record.provider = input.backend;

  if (action === "loadRuntimeLookupKey") {
    await writeRecord(input, record);
    return {
      protocolVersion: OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
      provider: record.provider,
      alias: record.alias,
      generation: record.generation,
      runtimeLookupKeyBase64: record.runtimeLookupKeyBase64
    };
  }
  if (action === "rotateRuntimeLookupKey") {
    throw new Error("Runtime lookup key rotation is not supported by the command helper; rotate opaque capability keys instead.");
  }
  if (action === "describe") {
    await writeRecord(input, record);
    return publicRecord(record);
  }
  throw new Error(`Unsupported capability key lookup helper action: ${action}`);
}

try {
  const input: any = await readStdinJson();
  const output: any = await handle(input);
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error: any) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
