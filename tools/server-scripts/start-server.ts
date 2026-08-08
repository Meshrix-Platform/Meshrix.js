#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startHttpServer } from "../../apps/server/runtime/http-server.ts";

import { ServerConfig } from "#meshrix/server-config";
import { DEFAULT_SERVER_PORT } from "../../packages/foundation/src/config/server-env.ts";
import {
  resolveDeploymentProfileId,
  ENABLED_PLUGINS_CONFIG_PATH,
  resolveEnabledPluginSelection,
  resolvePluginArtifactTrustedPublicKeys,
  resolvePluginConfigurations
} from "./lib/runtime-plugin-selection.ts";

const __filename: any = fileURLToPath(import.meta.url);
const __dirname: any = path.dirname(__filename);

function resolveProjectRoot(scriptDirectory: string): string {
  const candidates = [
    path.resolve(scriptDirectory, "../.."),
    path.resolve(scriptDirectory, "../../..")
  ];

  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8"));
      if (manifest?.name === "meshrix.js") {
        return candidate;
      }
    } catch {
      // Continue to the next bounded source/build layout candidate.
    }
  }

  throw new Error("无法定位 Meshrix.js 项目根目录。请从完整的软件包中启动服务。");
}

const projectRoot: any = resolveProjectRoot(__dirname);
const defaultDistPath: any = path.join(projectRoot, "build", "dist");
const READY_FILE_KIND: any = "private-ready-state";
const operatorConsole: Readonly<Record<string, any>> = Object.freeze({
  error: console.error.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console)
});

let serverHandle: any = null;
let readyFilePath: any = "";
let shuttingDown: any = false;

function parseArgs(argv?: any) : any {
  const parsed: Record<string, any> = {};

  for (let index: any = 0; index < argv.length; index += 1) {
    const arg: any = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const separatorIndex: any = arg.indexOf("=");
    if (separatorIndex > 2) {
      parsed[arg.slice(2, separatorIndex)] = arg.slice(separatorIndex + 1);
      continue;
    }

    const key: any = arg.slice(2);
    const next: any = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

function normalizePort(value?: any, fallback?: any) : any {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed: any = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`无效端口号：${value}`);
  }

  return parsed;
}

function enabledFlag(value?: any) : any {
  return value === true || ["1", "true", "yes"].includes(String(value || "").trim().toLowerCase());
}

function readRuntimeConfig(configPath: any = "") : any {
  const resolvedPath: any = String(configPath || "").trim();
  if (!resolvedPath) {
    return { filePath: "", dir: process.cwd(), config: {} };
  }
  const absolutePath: any = path.resolve(resolvedPath);
  const raw: any = fs.readFileSync(absolutePath, "utf8");
  const config: any = JSON.parse(raw);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`运行时配置必须是 JSON 对象：${absolutePath}`);
  }
  return {
    filePath: absolutePath,
    dir: path.dirname(absolutePath),
    config
  };
}

function nestedValue(source?: any, keyPath?: any) : any {
  return String(keyPath || "")
    .split(".")
    .filter(Boolean)
    .reduce((current?: any, key?: any) : any => {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }
      return current[key];
    }, source);
}

function firstDefined(values?: any) : any {
  return values.find((value?: any) : any => value !== undefined && value !== null && value !== "");
}

function configValue(config?: any, keys: any = []) : any {
  return firstDefined(keys.map((key?: any) : any => nestedValue(config, key)));
}

function optionValue({ args, argKeys = [], config, configKeys = [], env, fallback = "" }: Record<string, any>) : any {
  const value: any = firstDefined([
    ...argKeys.map((key?: any) : any => args[key]),
    configValue(config, configKeys),
    env ? process.env[env] : undefined
  ]);
  return value === undefined ? fallback : value;
}

function optionFlag({ args, argKeys = [], config, configKeys = [], env, fallback = false }: Record<string, any>) : any {
  const value: any = firstDefined([
    ...argKeys.map((key?: any) : any => args[key]),
    configValue(config, configKeys),
    env ? process.env[env] : undefined
  ]);
  return value === undefined ? fallback : enabledFlag(value);
}

function optionPath({ args, argKeys = [], config, configKeys = [], configDir, env, fallback = "" }: Record<string, any>) : any {
  const argValue: any = firstDefined(argKeys.map((key?: any) : any => args[key]));
  if (argValue) {
    return path.resolve(String(argValue));
  }
  const configured: any = configValue(config, configKeys);
  if (configured) {
    return path.resolve(configDir, String(configured));
  }
  const envValue: any = env ? process.env[env] : "";
  if (envValue) {
    return path.resolve(String(envValue));
  }
  return fallback ? path.resolve(String(fallback)) : "";
}

function safeReasonCode(error?: any, fallback: any = "server_runtime_failed") : any {
  const value: any = String(error?.reasonCode || error?.code || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value) ? value : fallback;
}

function safeStatusValue(value?: any, fallback: any = "unknown") : any {
  const text: any = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(text) ? text : fallback;
}

function removeReadyFile({ strict = false }: Record<string, any> = {}) : any {
  if (!readyFilePath) {
    return;
  }
  try {
    fs.rmSync(readyFilePath, { force: true });
  } catch (error: any) {
    if (strict) {
      throw error;
    }
  }
}

function writePrivateReadyFile(payload?: any) : any {
  if (!readyFilePath) {
    return;
  }
  const directory: any = path.dirname(readyFilePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath: any = path.join(
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

async function startWithPrivateConsole(options?: any) : Promise<any> {
  const original: Record<string, any> = {
    error: console.error,
    log: console.log,
    warn: console.warn
  };
  console.error = () : any => {};
  console.log = () : any => {};
  console.warn = () : any => {};
  try {
    return await startHttpServer(options);
  } finally {
    console.error = original.error;
    console.log = original.log;
    console.warn = original.warn;
  }
}

async function shutdown(code: any = 0) : Promise<any> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  operatorConsole.log("Server shutdown: started");
  let exitCode: any = code;
  try {
    if (serverHandle) {
      await serverHandle.close();
    }
    operatorConsole.log("Server shutdown: complete");
  } catch (error: any) {
    exitCode = 1;
    operatorConsole.error(`Server shutdown: failed; reasonCode=${safeReasonCode(error, "shutdown_failed")}`);
  } finally {
    removeReadyFile();
  }
  process.exit(exitCode);
}

function reportFatalFailure(kind?: any, error?: any) : any {
  operatorConsole.error(`Server failure: ${kind}; reasonCode=${safeReasonCode(error)}`);
  void shutdown(1);
}

process.on("SIGINT", () : any => {
  void shutdown(0);
});

process.on("SIGTERM", () : any => {
  void shutdown(0);
});

process.on("uncaughtException", (error?: any) : any => {
  reportFatalFailure("uncaught_exception", error);
});

process.on("unhandledRejection", (reason?: any) : any => {
  reportFatalFailure("unhandled_rejection", reason);
});

function printUsageAndExit(code: any = 0) : any {
  console.log(`Meshrix.js Server

Usage:
  node tools/server-scripts/start-server.ts [--runtime-config /path/to/runtime-instance.json] [--host 0.0.0.0] [--port ${DEFAULT_SERVER_PORT}] [--data-dir /path/to/data] [--with-ui] [--profile minimal|default] [--edition core|standard|integrations]

Options:
  --runtime-config          显式运行时实例配置 JSON；client-local supervisor 路径必须传入
  --require-runtime-config  未传 --runtime-config 时直接失败
  --expected-runtime-kind   校验 runtime-config.runtimeKind，例如 client-local
  --host                    监听地址，默认读取 MESHRIX_SERVER_HOST，否则使用 127.0.0.1
  --allow-public-console    允许监听非回环地址；等价于 MESHRIX_ALLOW_PUBLIC_CONSOLE=1
  --port                    监听端口，默认读取 MESHRIX_SERVER_PORT，否则使用 ${DEFAULT_SERVER_PORT}
  --strict-port             端口被占用时直接失败，不自动尝试后续端口
  --ready-file              将私有启动状态原子写入显式文件（0600）；默认不创建
  --data-dir                数据目录，默认读取 MESHRIX_SERVER_DATA_DIR，否则读取 ~/.meshrix-server.json，最后使用 ~/meshrix-data
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

const args: any = parseArgs(process.argv.slice(2));

readyFilePath = String(args["ready-file"] || process.env.MESHRIX_SERVER_READY_FILE || "").trim();
if (readyFilePath) {
  readyFilePath = path.resolve(readyFilePath);
  removeReadyFile({ strict: true });
}

if (args.help) {
  printUsageAndExit(0);
}

const runtimeConfigPath: any = String(args["runtime-config"] || args.runtimeConfig || process.env.MESHRIX_RUNTIME_CONFIG || "").trim();
if ((args["require-runtime-config"] === true || enabledFlag(process.env.MESHRIX_REQUIRE_RUNTIME_CONFIG)) && !runtimeConfigPath) {
  throw new Error("必须显式传入 --runtime-config。");
}
const runtimeConfig: any = readRuntimeConfig(runtimeConfigPath);
const runtimeConfigObject: any = runtimeConfig.config;
const expectedRuntimeKind: any = String(args["expected-runtime-kind"] || process.env.MESHRIX_EXPECTED_RUNTIME_KIND || "").trim();
const runtimeKind: any = String(configValue(runtimeConfigObject, ["runtimeKind", "runtime.kind", "kind"]) || "").trim();
if (expectedRuntimeKind && runtimeKind !== expectedRuntimeKind) {
  throw new Error(`运行时配置类型不匹配：期望 ${expectedRuntimeKind}，实际 ${runtimeKind || "<missing>"}`);
}

const host: any = String(optionValue({
  args,
  argKeys: ["host"],
  config: runtimeConfigObject,
  configKeys: ["host", "server.host"],
  env: "MESHRIX_SERVER_HOST",
  fallback: "127.0.0.1"
})).trim();
const port: any = normalizePort(optionValue({
  args,
  argKeys: ["port"],
  config: runtimeConfigObject,
  configKeys: ["port", "server.port"],
  env: "MESHRIX_SERVER_PORT",
  fallback: DEFAULT_SERVER_PORT
}), DEFAULT_SERVER_PORT);
if (port === 0 && !readyFilePath) {
  const error: Error & Record<string, any> = new Error("A private ready file is required when requesting a dynamic port.");
  error.reasonCode = "ready_file_required_for_dynamic_port";
  throw error;
}
const strictPort: any = optionFlag({
  args,
  argKeys: ["strict-port", "strictPort"],
  config: runtimeConfigObject,
  configKeys: ["strictPort", "strict-port", "server.strictPort", "runtime.strictPort"],
  env: "MESHRIX_SERVER_STRICT_PORT",
  fallback: false
});
const userDataPath: any = optionPath({
  args,
  argKeys: ["data-dir", "dataDir"],
  config: runtimeConfigObject,
  configKeys: ["dataDir", "data-dir", "server.dataDir", "server.data-dir"],
  configDir: runtimeConfig.dir,
  env: "MESHRIX_SERVER_DATA_DIR",
  fallback: ServerConfig.getDataDir()
});
const withUi: any = optionFlag({
  args,
  argKeys: ["with-ui", "withUi"],
  config: runtimeConfigObject,
  configKeys: ["withUi", "with-ui", "server.withUi", "server.with-ui"],
  env: "MESHRIX_SERVER_WITH_UI",
  fallback: false
});
const runtimeOptions: Record<string, any> = {
  profile: String(optionValue({
    args,
    argKeys: ["profile"],
    config: runtimeConfigObject,
    configKeys: ["profile", "runtime.profile"],
    env: "MESHRIX_SERVER_PROFILE",
    fallback: "default"
  })).trim(),
  edition: String(optionValue({
    args,
    argKeys: ["edition"],
    config: runtimeConfigObject,
    configKeys: ["edition", "runtime.edition"],
    env: "MESHRIX_EDITION",
    fallback: ""
  })).trim(),
  featureProfile: optionPath({
    args,
    argKeys: ["feature-profile", "featureProfile"],
    config: runtimeConfigObject,
    configKeys: ["featureProfile", "feature-profile", "runtime.featureProfile", "runtime.feature-profile"],
    configDir: runtimeConfig.dir,
    env: "MESHRIX_FEATURE_PROFILE",
    fallback: ""
  }),
  allowPublicConsole: optionFlag({
    args,
    argKeys: ["allow-public-console", "allowPublicConsole"],
    config: runtimeConfigObject,
    configKeys: ["allowPublicConsole", "allow-public-console", "runtime.allowPublicConsole", "runtime.allow-public-console"],
    env: "MESHRIX_ALLOW_PUBLIC_CONSOLE",
    fallback: false
  }),
  enabledPlugins: resolveEnabledPluginSelection(runtimeConfigObject),
  pluginArtifactTrustedPublicKeys: resolvePluginArtifactTrustedPublicKeys(runtimeConfigObject),
  pluginConfigurations: resolvePluginConfigurations(runtimeConfigObject),
  deploymentProfileId: resolveDeploymentProfileId(runtimeConfigObject),
  cwd: projectRoot,
  mountModules: {}
};
const discoveryOptions: Record<string, any> = {
  serverId: String(optionValue({ args, argKeys: ["server-id", "serverId"], config: runtimeConfigObject, configKeys: ["discovery.serverId"], env: "MESHRIX_SERVER_ID", fallback: "" })).trim(),
  serverLabel: String(optionValue({ args, argKeys: ["server-label", "serverLabel"], config: runtimeConfigObject, configKeys: ["discovery.serverLabel"], env: "MESHRIX_SERVER_LABEL", fallback: "" })).trim(),
  bootstrapBaseUrl: String(optionValue({ args, argKeys: ["bootstrap-url", "bootstrapUrl"], config: runtimeConfigObject, configKeys: ["discovery.bootstrapBaseUrl", "discovery.bootstrapUrl"], env: "MESHRIX_BOOTSTRAP_URL", fallback: "" })).trim(),
  advertisedBaseUrl: String(optionValue({ args, argKeys: ["advertised-base-url", "advertisedBaseUrl"], config: runtimeConfigObject, configKeys: ["discovery.advertisedBaseUrl"], env: "MESHRIX_ADVERTISED_BASE_URL", fallback: "" })).trim(),
  activeServiceUrl: String(optionValue({ args, argKeys: ["active-service-url", "activeServiceUrl"], config: runtimeConfigObject, configKeys: ["discovery.activeServiceUrl"], env: "MESHRIX_ACTIVE_SERVICE_URL", fallback: "" })).trim(),
  forwardBaseUrl: String(optionValue({ args, argKeys: ["forward-to-url", "forwardBaseUrl"], config: runtimeConfigObject, configKeys: ["discovery.forwardBaseUrl"], env: "MESHRIX_FORWARD_TO_URL", fallback: "" })).trim(),
  mode: String(optionValue({ args, argKeys: ["discovery-mode", "discoveryMode"], config: runtimeConfigObject, configKeys: ["discovery.mode"], env: "MESHRIX_DISCOVERY_MODE", fallback: "" })).trim(),
  configVersion: String(optionValue({ args, argKeys: ["config-version", "configVersion"], config: runtimeConfigObject, configKeys: ["discovery.configVersion"], env: "MESHRIX_DISCOVERY_CONFIG_VERSION", fallback: "" })).trim(),
  refreshIntervalSeconds: optionValue({ args, argKeys: ["refresh-interval-seconds", "refreshIntervalSeconds"], config: runtimeConfigObject, configKeys: ["discovery.refreshIntervalSeconds"], env: "MESHRIX_DISCOVERY_REFRESH_INTERVAL_SECONDS", fallback: "" }),
  checkInIntervalSeconds: optionValue({ args, argKeys: ["check-in-interval-seconds", "checkInIntervalSeconds"], config: runtimeConfigObject, configKeys: ["discovery.checkInIntervalSeconds"], env: "MESHRIX_DISCOVERY_CHECK_IN_INTERVAL_SECONDS", fallback: "" }),
  offlineAfterSeconds: optionValue({ args, argKeys: ["offline-after-seconds", "offlineAfterSeconds"], config: runtimeConfigObject, configKeys: ["discovery.offlineAfterSeconds"], env: "MESHRIX_DISCOVERY_OFFLINE_AFTER_SECONDS", fallback: "" })
};
const distPath: any = withUi ? defaultDistPath : "";

if (withUi && !fs.existsSync(defaultDistPath)) {
  throw new Error("build/dist 不存在。请先执行 npm run build，或不要传 --with-ui。");
}

let currentPort: any = port;
const maxPort: any = port + 10;

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
  } catch (err: any) {
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
