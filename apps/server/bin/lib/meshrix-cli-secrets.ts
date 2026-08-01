import fsp from "node:fs/promises";
import path from "node:path";
import {
  initializeLocalSecret,
  listLocalSecretEntries,
  LOCAL_SECRET_STORE_VERSION,
  revokeLocalSecret,
  rotateLocalSecret
} from "../../../../packages/foundation/src/security/secrets/local-secret-store.ts";
import {
  parseJsonText,
  trimOneTrailingNewline,
  writeResponse
} from "./meshrix-cli-common.ts";

const MAX_TARGET_FILE_BYTES: any = 64 * 1024;
const MAX_STDIN_SECRET_BYTES: any = 1024 * 1024;
const PAYLOAD_KEY_PATTERN: any = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const COMMON_FLAGS: any = new Set<any>(["data-dir", "output", "pretty"]);
const COMMAND_FLAGS: Readonly<Record<string, any>> = Object.freeze({
  init: new Set<any>([
    ...COMMON_FLAGS,
    "target-file",
    "json-stdin",
    "token-stdin",
    "api-key-stdin",
    "http-password-stdin",
    "from-env",
    "payload-key"
  ]),
  rotate: new Set<any>([
    ...COMMON_FLAGS,
    "target-file",
    "expected-revision",
    "json-stdin",
    "token-stdin",
    "api-key-stdin",
    "http-password-stdin",
    "from-env",
    "payload-key"
  ]),
  revoke: new Set<any>([...COMMON_FLAGS, "secret-ref", "expected-revision"]),
  list: COMMON_FLAGS,
  status: COMMON_FLAGS
});
const PARSER_COLLECTION_KEYS: any = new Set<any>(["_", "file", "header", "path", "input"]);

function requireFlag(args?: any, key?: any) : any {
  const value: any = args[key];
  if (value === undefined || value === null || value === true || String(value).trim() === "") {
    throw new Error(`--${key} is required.`);
  }
  return String(value).trim();
}

function assertAllowedFlags(args?: any, action?: any) : any {
  const allowed: any = COMMAND_FLAGS[action];
  for (const [key, value] of (Object.entries(args) as [string, any][])) {
    if (key === "_") continue;
    if (PARSER_COLLECTION_KEYS.has(key) && Array.isArray(value) && value.length === 0) continue;
    if (allowed.has(key)) continue;
    if (value === undefined || value === null || value === false) continue;
    throw new Error(`--${key} is not supported for meshrix secret ${action}.`);
  }
}

async function readTargetFile(args?: any) : Promise<any> {
  const filePath: any = path.resolve(requireFlag(args, "target-file"));
  let stat: any;
  try {
    stat = await fsp.stat(filePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw new Error("--target-file does not exist.");
    }
    throw new Error("Unable to inspect --target-file.");
  }
  if (!stat.isFile()) {
    throw new Error("--target-file must reference a regular file.");
  }
  if (stat.size > MAX_TARGET_FILE_BYTES) {
    throw new Error(`--target-file exceeds the ${MAX_TARGET_FILE_BYTES} byte limit.`);
  }
  let targetText: any;
  try {
    targetText = await fsp.readFile(filePath, "utf8");
  } catch {
    throw new Error("Unable to read --target-file.");
  }
  if (Buffer.byteLength(targetText, "utf8") > MAX_TARGET_FILE_BYTES) {
    throw new Error(`--target-file exceeds the ${MAX_TARGET_FILE_BYTES} byte limit.`);
  }
  const target: any = parseJsonText(targetText, "--target-file");
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("--target-file must contain one JSON object.");
  }
  return target;
}

async function readSecretStdin() : Promise<any> {
  const chunks: any[] = [];
  let totalBytes: any = 0;
  for await (const chunk of process.stdin) {
    const buffer: any = Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_STDIN_SECRET_BYTES) {
      throw new Error(`Secret input exceeds the ${MAX_STDIN_SECRET_BYTES} byte limit.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readSecretPayload(args?: any) : Promise<any> {
  const sources: any = [
    ["json-stdin", "json"],
    ["token-stdin", "token"],
    ["api-key-stdin", "apiKey"],
    ["http-password-stdin", "httpPassword"],
    ["from-env", "environment"]
  ].filter(([flag]: any[]) : any => args[flag] !== undefined && args[flag] !== false);
  if (sources.length !== 1) {
    throw new Error("Exactly one secret source is required: --json-stdin, --token-stdin, --api-key-stdin, --http-password-stdin, or --from-env with --payload-key.");
  }

  const [source, payloadKey] = sources[0];
  if (source === "from-env") {
    const envName: any = requireFlag(args, "from-env");
    const explicitPayloadKey: any = requireFlag(args, "payload-key");
    if (!PAYLOAD_KEY_PATTERN.test(explicitPayloadKey)) {
      throw new Error("--payload-key is invalid.");
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, envName) || !process.env[envName]) {
      throw new Error(`The requested environment variable is not configured: ${envName}.`);
    }
    return { [explicitPayloadKey]: process.env[envName] };
  }
  if (args["payload-key"] !== undefined) {
    throw new Error("--payload-key is only valid with --from-env.");
  }

  const raw: any = await readSecretStdin();
  if (source === "json-stdin") {
    const payload: any = parseJsonText(raw, "--json-stdin");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("--json-stdin must contain one JSON object.");
    }
    return payload;
  }
  const value: any = trimOneTrailingNewline(raw);
  if (!value) {
    throw new Error(`--${source} cannot be empty.`);
  }
  return { [payloadKey]: value };
}

function commandAction(args?: any) : any {
  if (String(args._[0] || "") !== "secret") return "";
  if (args._.length !== 2) {
    throw new Error("Use the canonical form: meshrix secret init|rotate|revoke|list|status.");
  }
  const action: any = String(args._[1] || "");
  if (!Object.prototype.hasOwnProperty.call(COMMAND_FLAGS, action)) {
    throw new Error(`Unsupported meshrix secret action: ${action || "<missing>"}.`);
  }
  return action;
}

export async function runSecretCommand(args?: any) : Promise<any> {
  const action: any = commandAction(args);
  if (!action) return false;
  assertAllowedFlags(args, action);

  if (action === "list" || action === "status") {
    const entries: any = await listLocalSecretEntries({ dataDir: args["data-dir"] });
    const result: any = action === "list"
      ? { ok: true, protocolVersion: LOCAL_SECRET_STORE_VERSION, count: entries.length, entries }
      : {
          ok: true,
          protocolVersion: LOCAL_SECRET_STORE_VERSION,
          count: entries.length,
          activeCount: entries.filter((entry?: any) : any => entry.status === "active").length,
          revokedCount: entries.filter((entry?: any) : any => entry.status === "revoked").length
        };
    await writeResponse({ args, result });
    return true;
  }

  let result: any;
  if (action === "revoke") {
    result = await revokeLocalSecret({
      dataDir: args["data-dir"],
      secretRef: requireFlag(args, "secret-ref"),
      expectedRevision: requireFlag(args, "expected-revision")
    });
  } else {
    const input: Record<string, any> = {
      dataDir: args["data-dir"],
      target: await readTargetFile(args),
      payload: await readSecretPayload(args)
    };
    result = action === "init"
        ? await initializeLocalSecret(input)
        : await rotateLocalSecret({
            ...input,
            expectedRevision: requireFlag(args, "expected-revision")
          });
  }
  await writeResponse({ args, result });
  return true;
}
