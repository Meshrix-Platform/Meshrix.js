import fsp from "node:fs/promises";
import path from "node:path";
import { getDefaultServerUrl } from "../../../../packages/foundation/src/config/server-env.mjs";

export const DEFAULT_SERVER_URL = process.env.MESHRIX_SERVER_URL || getDefaultServerUrl();

const SENSITIVE_ARG_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token"
]);

export function normalizeBaseUrl(value) {
  return String(value || DEFAULT_SERVER_URL).replace(/\/+$/, "");
}

export function normalizeApiPath(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new Error("--path is required");
  }
  return raw.startsWith("/") ? raw : `/${raw}`;
}

export function parseJsonText(raw, label = "JSON") {
  try {
    return JSON.parse(String(raw || "{}"));
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function readJsonInput(value, label = "JSON") {
  if (value === undefined || value === null || value === true || value === "") {
    return {};
  }

  const text = String(value);
  if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
    return parseJsonText(text, label);
  }

  try {
    return parseJsonText(await fsp.readFile(path.resolve(text), "utf8"), text);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return parseJsonText(text, label);
    }
    throw error;
  }
}

export async function readBody(args) {
  if (args["body-file"]) {
    return readJsonInput(String(args["body-file"]), "--body-file");
  }
  if (args.body !== undefined) {
    return readJsonInput(args.body, "--body");
  }
  return {};
}

export function coerceCliBodyValue(value, type) {
  if (type === "number") {
    return Number(value || 0);
  }
  if (type === "boolean") {
    return value === true || value === "1" || value === "true" || value === "yes";
  }
  if (type === "json") {
    return typeof value === "string" ? parseJsonText(value, "--parameters") : value;
  }
  if (type === "string-list") {
    if (Array.isArray(value)) {
      return value.map((item) => String(item || "").trim()).filter(Boolean);
    }
    return String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return value;
}

export function findCliArgValue(args, aliases = []) {
  for (const alias of aliases) {
    const value = args[alias];
    if (Array.isArray(value)) {
      const last = value[value.length - 1];
      if (last !== undefined && last !== null && last !== true && last !== "") {
        return last;
      }
      continue;
    }
    if (value !== undefined && value !== null && value !== true && value !== "") {
      return value;
    }
  }
  return undefined;
}

export function buildBodyFromCliParams(operation, args) {
  const bodyParams = operation.cli?.bodyParams || [];
  if (bodyParams.length === 0) {
    return null;
  }
  const body = {};
  for (const param of bodyParams) {
    const aliases = [param.name, ...(param.aliases || [])];
    const value = findCliArgValue(args, aliases);
    if ((value === undefined || value === null || value === "") && param.required) {
      throw new Error(`--${aliases[1] || param.name} is required`);
    }
    if (value !== undefined && value !== null && value !== "") {
      body[param.name] = coerceCliBodyValue(value, param.type || "string");
    }
  }
  return Object.keys(body).length > 0 ? body : null;
}

export function applyCommonSafetyFlags(args, body) {
  if (!hasConfirmArg(args)) {
    return body;
  }
  if (body === undefined || body === null) {
    return { confirm: true };
  }
  if (Buffer.isBuffer(body) || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  return {
    ...body,
    confirm: body.confirm === undefined ? true : body.confirm
  };
}

export function hasConfirmArg(args) {
  return ["true", "1", "yes"].includes(String(args.confirm || "").trim().toLowerCase());
}

export function applyCommonSafetyHeaders(args, headers = {}) {
  if (!hasConfirmArg(args)) {
    return headers;
  }
  return {
    ...headers,
    "x-meshrix-safety-confirm": headers["x-meshrix-safety-confirm"] || "true"
  };
}

export async function readRpcParams(args) {
  if (args["params-file"]) {
    return readJsonInput(String(args["params-file"]), "--params-file");
  }
  if (args.params !== undefined) {
    return readJsonInput(args.params, "--params");
  }
  return {};
}

export function readHeaders(args) {
  const headers = {
    "x-meshrix-client-kind": "meshrix-client",
    "x-meshrix-client-id": process.env.MESHRIX_CLIENT_ID || "meshrix-cli",
    ...envAuthHeaders()
  };
  for (const [index, entry] of (args.header || []).entries()) {
    const text = String(entry);
    const separatorIndex = text.indexOf(":");
    if (separatorIndex <= 0) {
      throw new Error(`第 ${index + 1} 个 --header 必须使用 "Name: value" 格式`);
    }
    const name = text.slice(0, separatorIndex).trim();
    if (SENSITIVE_ARG_HEADER_NAMES.has(name.toLowerCase())) {
      throw new Error(`禁止通过命令行参数传入敏感请求头 ${name}；请使用 Meshrix 密钥入口或受控环境变量`);
    }
    headers[name] = text.slice(separatorIndex + 1).trim();
  }
  return headers;
}

export function envAuthHeaders() {
  const headers = {};
  if (process.env.MESHRIX_CONSOLE_COOKIE) {
    headers.Cookie = process.env.MESHRIX_CONSOLE_COOKIE;
  }
  if (process.env.MESHRIX_CONSOLE_CSRF) {
    headers["x-meshrix-csrf"] = process.env.MESHRIX_CONSOLE_CSRF;
  }
  if (["1", "true", "yes"].includes(String(process.env.MESHRIX_SAFETY_CONFIRM || "").toLowerCase())) {
    headers["x-meshrix-safety-confirm"] = "true";
  }
  return headers;
}

export async function readHttpPayload(args, method) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const headers = readHeaders(args);
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD") {
    return {
      body: undefined,
      headers
    };
  }

  if (args["raw-file"]) {
    headers["content-type"] = headers["content-type"] || args["content-type"] || "application/octet-stream";
    return {
      body: await fsp.readFile(path.resolve(String(args["raw-file"]))),
      headers
    };
  }

  return {
    body: await readBody(args),
    headers
  };
}

export async function requestRaw({
  serverUrl,
  method = "GET",
  apiPath,
  body,
  headers = {},
  binary = false,
  okStatuses = []
}) {
  const baseUrl = normalizeBaseUrl(serverUrl);
  const normalizedMethod = String(method || "GET").toUpperCase();
  const url = `${baseUrl}${normalizeApiPath(apiPath)}`;
  const requestHeaders = {
    accept: binary ? "*/*" : "application/json",
    ...envAuthHeaders(),
    ...headers
  };
  let requestBody;

  if (body !== undefined && normalizedMethod !== "GET" && normalizedMethod !== "HEAD") {
    if (Buffer.isBuffer(body)) {
      requestBody = body;
    } else {
      requestHeaders["content-type"] = requestHeaders["content-type"] || "application/json";
      requestBody = JSON.stringify(body);
    }
  }

  const response = await fetch(url, {
    method: normalizedMethod,
    headers: requestHeaders,
    body: requestBody
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok && !okStatuses.includes(response.status)) {
    const details = buffer.toString("utf8");
    throw new Error(`${normalizedMethod} ${url} failed: ${response.status} ${details}`);
  }

  return {
    response,
    buffer
  };
}

export async function requestJson(input) {
  const { buffer } = await requestRaw(input);
  const text = buffer.toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

export async function writeResponse({ args, result, rawBuffer = null, contentType = "" }) {
  if (args.output) {
    const outputPath = path.resolve(String(args.output));
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.writeFile(
      outputPath,
      rawBuffer || Buffer.from(JSON.stringify(result, null, 2), "utf8")
    );
    process.stderr.write(`output: ${outputPath}\n`);
    return;
  }

  if (rawBuffer && !/json/i.test(contentType)) {
    process.stdout.write(rawBuffer);
    return;
  }

  process.stdout.write(
    `${args.pretty === false ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`
  );
}

export function requireValue(args, key) {
  const value = Array.isArray(args[key]) ? args[key][args[key].length - 1] : args[key];
  if (!value || value === true) {
    throw new Error(`--${key} is required`);
  }
  return String(value);
}

export async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function trimOneTrailingNewline(value) {
  return String(value ?? "").replace(/\r?\n$/, "");
}

export function mergeIfPresent(target, key, value) {
  if (value !== undefined && value !== null && value !== true && value !== "") {
    target[key] = String(value);
  }
}
