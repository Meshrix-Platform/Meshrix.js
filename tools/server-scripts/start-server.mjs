#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";

import { ServerConfig } from "#lico/server-config";
import { DEFAULT_SERVER_PORT } from "../../packages/foundation/src/config/server-env.mjs";
import {
  resolveDeploymentProfileId,
  ENABLED_PLUGINS_CONFIG_PATH,
  resolveEnabledPluginSelection,
  resolvePluginArtifactTrustedPublicKeys,
  resolvePluginConfigurations
} from "./lib/runtime-plugin-selection.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");
const defaultDistPath = path.join(projectRoot, "build", "dist");
const READY_FILE_KIND = "private-ready-state";
const operatorConsole = Object.freeze({
  error: console.error.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console)
});

let serverHandle = null;
let readyFilePath = "";
let shuttingDown = false;

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const separatorIndex = arg.indexOf("=");
    if (separatorIndex > 2) {
      parsed[arg.slice(2, separatorIndex)] = arg.slice(separatorIndex + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

function normalizePort(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`无效端口号：${value}`);
  }

  return parsed;
}

function enabledFlag(value) {
  return value === true || ["1", "true", "yes"].includes(String(value || "").trim().toLowerCase());
}

function readRuntimeConfig(configPath = "") {
  const resolvedPath = String(configPath || "").trim();
  if (!resolvedPath) {
    return { filePath: "", dir: process.cwd(), config: {} };
  }
  const absolutePath = path.resolve(resolvedPath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  const config = JSON.parse(raw);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`运行时配置必须是 JSON 对象：${absolutePath}`);
  }
  return {
    filePath: absolutePath,
    dir: path.dirname(absolutePath),
    config
  };
}

function nestedValue(source, keyPath) {
  return String(keyPath || "")
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }
      return current[key];
    }, source);
}

function firstDefined(values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function configValue(config, keys = []) {
  return firstDefined(keys.map((key) => nestedValue(config, key)));
}

function optionValue({ args, argKeys = [], config, configKeys = [], env, fallback = "" }) {
  const value = firstDefined([
    ...argKeys.map((key) => args[key]),
    configValue(config, configKeys),
    env ? process.env[env] : undefined
  ]);
  return value === undefined ? fallback : value;
}

function optionFlag({ args, argKeys = [], config, configKeys = [], env, fallback = false }) {
  const value = firstDefined([
    ...argKeys.map((key) => args[key]),
    configValue(config, configKeys),
    env ? process.env[env] : undefined
  ]);
  return value === undefined ? fallback : enabledFlag(value);
}

function optionPath({ args, argKeys = [], config, configKeys = [], configDir, env, fallback = "" }) {
  const argValue = firstDefined(argKeys.map((key) => args[key]));
  if (argValue) {
    return path.resolve(String(argValue));
  }
  const configured = configValue(config, configKeys);
  if (configured) {
    return path.resolve(configDir, String(configured));
  }
  const envValue = env ? process.env[env] : "";
  if (envValue) {
    return path.resolve(String(envValue));
  }
  return fallback ? path.resolve(String(fallback)) : "";
}

function safeReasonCode(error, fallback = "server_runtime_failed") {
  const value = String(error?.reasonCode || error?.code || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value) ? value : fallback;
}

function safeStatusValue(value, fallback = "unknown") {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(text) ? text : fallback;
}

function removeReadyFile({ strict = false } = {}) {
  if (!readyFilePath) {
    return;
  }
  try {
    fs.rmSync(readyFilePath, { force: true });
  } catch (error) {
    if (strict) {
      throw error;
    }
  }
}

function writePrivateReadyFile(payload) {
  if (!readyFilePath) {
    return;
  }
  const directory = path.dirname(readyFilePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(readyFilePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(payload)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, readyFilePath);
    fs.chmodSync(readyFilePath, 0o600);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

async function startWithPrivateConsole(options) {
  const original = {
    error: console.error,
    log: console.log,
    warn: console.warn
  };
  console.error = () => {};
  console.log = () => {};
  console.warn = () => {};
  try {
    return await startHttpServer(options);
  } finally {
    console.error = original.error;
    console.log = original.log;
    console.warn = original.warn;
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  operatorConsole.log("Server shutdown: started");
  let exitCode = code;
  try {
    if (serverHandle) {
      await serverHandle.close();
    }
    operatorConsole.log("Server shutdown: complete");
  } catch (error) {
    exitCode = 1;
    operatorConsole.error(`Server shutdown: failed; reasonCode=${safeReasonCode(error, "shutdown_failed")}`);
  } finally {
    removeReadyFile();
  }
  process.exit(exitCode);
}

function reportFatalFailure(kind, error) {
  operatorConsole.error(`Server failure: ${kind}; reasonCode=${safeReasonCode(error)}`);
  void shutdown(1);
}

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

process.on("uncaughtException", (error) => {
  reportFatalFailure("uncaught_exception", error);
});

process.on("unhandledRejection", (reason) => {
  reportFatalFailure("unhandled_rejection", reason);
});

function printUsageAndExit(code = 0) {
  console.log(`LicoMesh Server

Usage:
  node tools/server-scripts/start-server.mjs [--runtime-config /path/to/runtime-instance.json] [--host 0.0.0.0] [--port ${DEFAULT_SERVER_PORT}] [--data-dir /path/to/data] [--with-ui] [--profile minimal|default] [--edition core|standard|integrations]

Options:
  --runtime-config          显式运行时实例配置 JSON；client-local supervisor 路径必须传入
  --require-runtime-config  未传 --runtime-config 时直接失败
  --expected-runtime-kind   校验 runtime-config.runtimeKind，例如 client-local
  --host                    监听地址，默认读取 LICO_SERVER_HOST，否则使用 127.0.0.1
  --allow-public-console    允许监听非回环地址；等价于 LICO_ALLOW_PUBLIC_CONSOLE=1
  --port                    监听端口，默认读取 LICO_SERVER_PORT，否则使用 ${DEFAULT_SERVER_PORT}
  --strict-port             端口被占用时直接失败，不自动尝试后续端口
  --ready-file              将私有启动状态原子写入显式文件（0600）；默认不创建
  --data-dir                数据目录，默认读取 LICO_SERVER_DATA_DIR，否则读取 ~/.licomesh-server.json，最后使用 ~/licomesh-data
  --with-ui                 同时提供 build/dist 前端页面；build/dist 不存在时会报错
  --profile                 运行档位：default|minimal，默认 default
  --edition                 功能 edition：core|standard|integrations
  --feature-profile         自定义功能 profile JSON 路径
  ${ENABLED_PLUGINS_CONFIG_PATH}  仅在 runtime-config JSON 中使用的插件 ID 数组；缺省或空数组均不加载插件
  --server-id               服务实例 ID
  --server-label            服务实例标签
  --bootstrap-url           客户端引导地址
  --advertised-base-url     当前实例对外地址
  --active-service-url      当前活跃能力服务地址
  --forward-to-url          旧服务切换时的转发目标
  --discovery-mode          active|forward，默认 active
  --config-version          发现配置版本号
  --refresh-interval-seconds 服务发现刷新间隔
  --check-in-interval-seconds 客户端回报间隔
  --offline-after-seconds   客户端离线判定秒数
  --help                    显示帮助
`);
  process.exit(code);
}

const args = parseArgs(process.argv.slice(2));

readyFilePath = String(args["ready-file"] || process.env.LICO_SERVER_READY_FILE || "").trim();
if (readyFilePath) {
  readyFilePath = path.resolve(readyFilePath);
  removeReadyFile({ strict: true });
}

if (args.help) {
  printUsageAndExit(0);
}

const runtimeConfigPath = String(args["runtime-config"] || args.runtimeConfig || process.env.LICO_RUNTIME_CONFIG || "").trim();
if ((args["require-runtime-config"] === true || enabledFlag(process.env.LICO_REQUIRE_RUNTIME_CONFIG)) && !runtimeConfigPath) {
  throw new Error("必须显式传入 --runtime-config。");
}
const runtimeConfig = readRuntimeConfig(runtimeConfigPath);
const runtimeConfigObject = runtimeConfig.config;
const expectedRuntimeKind = String(args["expected-runtime-kind"] || process.env.LICO_EXPECTED_RUNTIME_KIND || "").trim();
const runtimeKind = String(configValue(runtimeConfigObject, ["runtimeKind", "runtime.kind", "kind"]) || "").trim();
if (expectedRuntimeKind && runtimeKind !== expectedRuntimeKind) {
  throw new Error(`运行时配置类型不匹配：期望 ${expectedRuntimeKind}，实际 ${runtimeKind || "<missing>"}`);
}

const host = String(optionValue({
  args,
  argKeys: ["host"],
  config: runtimeConfigObject,
  configKeys: ["host", "server.host"],
  env: "LICO_SERVER_HOST",
  fallback: "127.0.0.1"
})).trim();
const port = normalizePort(optionValue({
  args,
  argKeys: ["port"],
  config: runtimeConfigObject,
  configKeys: ["port", "server.port"],
  env: "LICO_SERVER_PORT",
  fallback: DEFAULT_SERVER_PORT
}), DEFAULT_SERVER_PORT);
if (port === 0 && !readyFilePath) {
  const error = new Error("A private ready file is required when requesting a dynamic port.");
  error.reasonCode = "ready_file_required_for_dynamic_port";
  throw error;
}
const strictPort = optionFlag({
  args,
  argKeys: ["strict-port", "strictPort"],
  config: runtimeConfigObject,
  configKeys: ["strictPort", "strict-port", "server.strictPort", "runtime.strictPort"],
  env: "LICO_SERVER_STRICT_PORT",
  fallback: false
});
const userDataPath = optionPath({
  args,
  argKeys: ["data-dir", "dataDir"],
  config: runtimeConfigObject,
  configKeys: ["dataDir", "data-dir", "server.dataDir", "server.data-dir"],
  configDir: runtimeConfig.dir,
  env: "LICO_SERVER_DATA_DIR",
  fallback: ServerConfig.getDataDir()
});
const withUi = optionFlag({
  args,
  argKeys: ["with-ui", "withUi"],
  config: runtimeConfigObject,
  configKeys: ["withUi", "with-ui", "server.withUi", "server.with-ui"],
  env: "LICO_SERVER_WITH_UI",
  fallback: false
});
const runtimeOptions = {
  profile: String(optionValue({
    args,
    argKeys: ["profile"],
    config: runtimeConfigObject,
    configKeys: ["profile", "runtime.profile"],
    env: "LICO_SERVER_PROFILE",
    fallback: "default"
  })).trim(),
  edition: String(optionValue({
    args,
    argKeys: ["edition"],
    config: runtimeConfigObject,
    configKeys: ["edition", "runtime.edition"],
    env: "LICO_EDITION",
    fallback: ""
  })).trim(),
  featureProfile: optionPath({
    args,
    argKeys: ["feature-profile", "featureProfile"],
    config: runtimeConfigObject,
    configKeys: ["featureProfile", "feature-profile", "runtime.featureProfile", "runtime.feature-profile"],
    configDir: runtimeConfig.dir,
    env: "LICO_FEATURE_PROFILE",
    fallback: ""
  }),
  allowPublicConsole: optionFlag({
    args,
    argKeys: ["allow-public-console", "allowPublicConsole"],
    config: runtimeConfigObject,
    configKeys: ["allowPublicConsole", "allow-public-console", "runtime.allowPublicConsole", "runtime.allow-public-console"],
    env: "LICO_ALLOW_PUBLIC_CONSOLE",
    fallback: false
  }),
  enabledPlugins: resolveEnabledPluginSelection(runtimeConfigObject),
  pluginArtifactTrustedPublicKeys: resolvePluginArtifactTrustedPublicKeys(runtimeConfigObject),
  pluginConfigurations: resolvePluginConfigurations(runtimeConfigObject),
  deploymentProfileId: resolveDeploymentProfileId(runtimeConfigObject),
  cwd: projectRoot,
  mountModules: {}
};
const discoveryOptions = {
  serverId: String(optionValue({ args, argKeys: ["server-id", "serverId"], config: runtimeConfigObject, configKeys: ["discovery.serverId"], env: "LICO_SERVER_ID", fallback: "" })).trim(),
  serverLabel: String(optionValue({ args, argKeys: ["server-label", "serverLabel"], config: runtimeConfigObject, configKeys: ["discovery.serverLabel"], env: "LICO_SERVER_LABEL", fallback: "" })).trim(),
  bootstrapBaseUrl: String(optionValue({ args, argKeys: ["bootstrap-url", "bootstrapUrl"], config: runtimeConfigObject, configKeys: ["discovery.bootstrapBaseUrl", "discovery.bootstrapUrl"], env: "LICO_BOOTSTRAP_URL", fallback: "" })).trim(),
  advertisedBaseUrl: String(optionValue({ args, argKeys: ["advertised-base-url", "advertisedBaseUrl"], config: runtimeConfigObject, configKeys: ["discovery.advertisedBaseUrl"], env: "LICO_ADVERTISED_BASE_URL", fallback: "" })).trim(),
  activeServiceUrl: String(optionValue({ args, argKeys: ["active-service-url", "activeServiceUrl"], config: runtimeConfigObject, configKeys: ["discovery.activeServiceUrl"], env: "LICO_ACTIVE_SERVICE_URL", fallback: "" })).trim(),
  forwardBaseUrl: String(optionValue({ args, argKeys: ["forward-to-url", "forwardBaseUrl"], config: runtimeConfigObject, configKeys: ["discovery.forwardBaseUrl"], env: "LICO_FORWARD_TO_URL", fallback: "" })).trim(),
  mode: String(optionValue({ args, argKeys: ["discovery-mode", "discoveryMode"], config: runtimeConfigObject, configKeys: ["discovery.mode"], env: "LICO_DISCOVERY_MODE", fallback: "" })).trim(),
  configVersion: String(optionValue({ args, argKeys: ["config-version", "configVersion"], config: runtimeConfigObject, configKeys: ["discovery.configVersion"], env: "LICO_DISCOVERY_CONFIG_VERSION", fallback: "" })).trim(),
  refreshIntervalSeconds: optionValue({ args, argKeys: ["refresh-interval-seconds", "refreshIntervalSeconds"], config: runtimeConfigObject, configKeys: ["discovery.refreshIntervalSeconds"], env: "LICO_DISCOVERY_REFRESH_INTERVAL_SECONDS", fallback: "" }),
  checkInIntervalSeconds: optionValue({ args, argKeys: ["check-in-interval-seconds", "checkInIntervalSeconds"], config: runtimeConfigObject, configKeys: ["discovery.checkInIntervalSeconds"], env: "LICO_DISCOVERY_CHECK_IN_INTERVAL_SECONDS", fallback: "" }),
  offlineAfterSeconds: optionValue({ args, argKeys: ["offline-after-seconds", "offlineAfterSeconds"], config: runtimeConfigObject, configKeys: ["discovery.offlineAfterSeconds"], env: "LICO_DISCOVERY_OFFLINE_AFTER_SECONDS", fallback: "" })
};
const distPath = withUi ? defaultDistPath : "";

if (withUi && !fs.existsSync(defaultDistPath)) {
  throw new Error("build/dist 不存在。请先执行 npm run build，或不要传 --with-ui。");
}

let currentPort = port;
const maxPort = port + 10;

while (true) {
  try {
    serverHandle = await startWithPrivateConsole({
      userDataPath,
      distPath,
      runtimeOptions,
      discoveryOptions,
      host,
      port: currentPort
    });
    break;
  } catch (err) {
    if (!strictPort && err.code === 'EADDRINUSE' && currentPort < maxPort) {
      operatorConsole.warn("Server port unavailable; retrying with the next candidate.");
      currentPort++;
    } else {
      throw err;
    }
  }
}

writePrivateReadyFile({
  kind: READY_FILE_KIND,
  status: "ready",
  host: serverHandle.host,
  port: serverHandle.port,
  profile: runtimeOptions.profile,
  uiMode: withUi ? "enabled" : "api-only",
  discoveryMode: serverHandle.discovery.mode
});

operatorConsole.log("Server status: started");
operatorConsole.log(`UI mode: ${withUi ? "enabled" : "api-only"}`);
operatorConsole.log(`Runtime profile: ${safeStatusValue(runtimeOptions.profile)}`);
operatorConsole.log(`Discovery mode: ${safeStatusValue(serverHandle.discovery.mode, "unconfigured")}`);
