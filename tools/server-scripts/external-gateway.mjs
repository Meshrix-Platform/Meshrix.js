#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  commandPath,
  downloadRetryAttempts,
  fileSize,
  nativeHostPackageInstallPlans,
  normalizeSha256,
  outputMentionsRangeUnsupported,
  retryDelayMs as downloadRetryDelayMs,
  verifyFileSha256
} from "../../packages/foundation/src/environment-compatibility/index.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const DEFAULT_GATEWAY_ADAPTER = "caddy";
const DEFAULT_GATEWAY_BASE_URL = "http://127.0.0.1:7330";
const DEFAULT_DIRECT_BASE_URL = "http://127.0.0.1:7228";
let externalGatewayModulePromise = null;

function defaultGatewayRuntimeCacheRoot(env = process.env) {
  const explicit = String(env.MESHRIX_GATEWAY_RUNTIME_CACHE_DIR || "").trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const xdgCacheHome = String(env.XDG_CACHE_HOME || "").trim();
  const cacheHome = xdgCacheHome ? path.resolve(xdgCacheHome) : path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "meshrix", "external-gateway");
}

function loadExternalGateway() {
  if (!externalGatewayModulePromise) {
    externalGatewayModulePromise = import("../../packages/agents/src/agent-gateway/external-gateway/index.mjs");
  }
  return externalGatewayModulePromise;
}

function parseArgs(argv = []) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const keyValue = item.slice(2);
    const equalIndex = keyValue.indexOf("=");
    const key = equalIndex >= 0 ? keyValue.slice(0, equalIndex) : keyValue;
    const inlineValue = equalIndex >= 0 ? keyValue.slice(equalIndex + 1) : null;
    const next = argv[index + 1];
    if (inlineValue !== null) {
      args[key] = inlineValue;
    } else if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function printUsageAndExit(code = 0) {
  console.log(`Meshrix Agent Traffic Gateway

Usage:
  node tools/server-scripts/external-gateway.mjs list
  node tools/server-scripts/external-gateway.mjs plan [--gateway caddy|nginx]
  node tools/server-scripts/external-gateway.mjs render --gateway caddy|nginx
  node tools/server-scripts/external-gateway.mjs write --gateway caddy|nginx|all [--output DIR]
  node tools/server-scripts/external-gateway.mjs switch --gateway caddy|nginx|direct
  node tools/server-scripts/external-gateway.mjs runtime-plan --gateway caddy|nginx
  node tools/server-scripts/external-gateway.mjs runtime-pull --gateway caddy|nginx [--runtime-url URL --runtime-sha256 SHA256|--runtime-binary PATH]
  node tools/server-scripts/external-gateway.mjs verify --gateway caddy|nginx

Options:
  --gateway             Gateway adapter. Default: ${DEFAULT_GATEWAY_ADAPTER}
  --direct-base-url     Direct Meshrix endpoint kept as required fallback. Default: ${DEFAULT_DIRECT_BASE_URL}
  --public-base-url     Gateway public endpoint. Default: ${DEFAULT_GATEWAY_BASE_URL}
  --upstream            Upstream Meshrix endpoints, comma-separated. Default: direct-base-url
  --listen-host         Gateway listen host. Default: public-base-url host
  --listen-port         Gateway listen port. Default: public-base-url port
  --server-name         Nginx server_name / Caddy host label. Default: public-base-url host
  --max-body-size       Upload/request limit passed to gateway config. Default: 512m
  --stream-timeout      SSE/MCP/upload read timeout. Default: 3600s
  --runtime-cache-dir   Local runtime cache root. Default: ${defaultGatewayRuntimeCacheRoot()}
  --runtime-binary      Existing gateway binary to copy into the local cache
  --runtime-url         Runtime artifact URL to pull into the local cache
  --runtime-sha256      Required SHA-256 for --runtime-url artifacts
  --allow-unsafe-runtime-download
                       Development-only override for runtime URL downloads without SHA-256
  --output              Output directory. Default: runtime-cache-dir/configs
  --json                Print JSON for list/plan/verify
  --help                Show this message
`);
  process.exit(code);
}

function profileInputFromArgs(args = {}, gatewayOverride = "") {
  return {
    adapterId: gatewayOverride || args.gateway,
    directBaseUrl: args["direct-base-url"],
    publicBaseUrl: args["public-base-url"],
    upstream: args.upstream,
    maxBodySize: args["max-body-size"],
    streamTimeout: args["stream-timeout"],
    listen: {
      host: args["listen-host"],
      port: args["listen-port"],
      serverName: args["server-name"]
    }
  };
}

function defaultOutputRoot(args = {}) {
  return path.resolve(String(args.output || path.join(defaultRuntimeCacheRoot(args), "configs")));
}

function defaultRuntimeCacheRoot(args = {}) {
  return path.resolve(String(args["runtime-cache-dir"] || defaultGatewayRuntimeCacheRoot()));
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function writeGatewayArtifacts(args = {}, adapterId) {
  const { renderExternalGatewayConfig } = await loadExternalGateway();
  const rendered = renderExternalGatewayConfig(profileInputFromArgs(args, adapterId));
  const root = path.join(defaultOutputRoot(args), rendered.adapterId);
  await fs.mkdir(root, { recursive: true });
  const configPath = path.join(root, rendered.fileName);
  const profilePath = path.join(root, "gateway-profile.json");
  const routeManifestPath = path.join(root, "route-manifest.json");
  await fs.writeFile(configPath, rendered.config, "utf8");
  await fs.writeFile(profilePath, `${JSON.stringify(rendered.profile, null, 2)}\n`, "utf8");
  await fs.writeFile(routeManifestPath, `${JSON.stringify(rendered.routeManifest, null, 2)}\n`, "utf8");
  return {
    adapterId: rendered.adapterId,
    configPath,
    profilePath,
    routeManifestPath
  };
}

async function writeActiveGatewayPointer(args = {}, adapterId) {
  const { normalizeExternalGatewayProfile } = await loadExternalGateway();
  const root = defaultOutputRoot(args);
  await fs.mkdir(root, { recursive: true });
  const profile = normalizeExternalGatewayProfile(profileInputFromArgs(args, adapterId));
  const activePath = path.join(root, "active-gateway.json");
  await fs.writeFile(
    activePath,
    `${JSON.stringify(
      {
        schemaVersion: "v0.0.1:schema:definition-1",
        activeAdapterId: profile.gatewayMode.adapterId,
        publicBaseUrl: profile.gatewayMode.publicBaseUrl,
        directBaseUrl: profile.directMode.baseUrl,
        configDir: path.join(root, profile.gatewayMode.adapterId),
        directModeRequired: true,
        gatewayCanBeRemoved: true
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return activePath;
}

async function writeDirectGatewayPointer(args = {}) {
  const { normalizeExternalGatewayProfile } = await loadExternalGateway();
  const root = defaultOutputRoot(args);
  await fs.mkdir(root, { recursive: true });
  const profile = normalizeExternalGatewayProfile(profileInputFromArgs(args, DEFAULT_GATEWAY_ADAPTER));
  const activePath = path.join(root, "active-gateway.json");
  await fs.writeFile(
    activePath,
    `${JSON.stringify(
      {
        schemaVersion: "v0.0.1:schema:definition-1",
        activeAdapterId: "direct",
        publicBaseUrl: profile.directMode.baseUrl,
        directBaseUrl: profile.directMode.baseUrl,
        configDir: null,
        directModeRequired: true,
        gatewayCanBeRemoved: true
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return activePath;
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function commandExists(command) {
  return commandPath(command);
}

function nativeGatewayInstallPlans(adapterId) {
  const packageName = adapterId === "nginx" ? "nginx" : "caddy";
  return nativeHostPackageInstallPlans({
    packageName,
    platform: process.platform,
    commandPathFn: commandExists,
    wingetId: adapterId === "nginx" ? "Nginx.Nginx" : "CaddyServer.Caddy"
  });
}

async function runInstallCommand(command, args = []) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function tryNativeGatewayInstall(adapterId) {
  const plans = nativeGatewayInstallPlans(adapterId);
  const failures = [];
  for (const plan of plans) {
    try {
      const commands = plan.commands || [{ command: plan.command, args: plan.args || [] }];
      for (const entry of commands) {
        await runInstallCommand(entry.command, entry.args || []);
      }
      const executable = commandExists(adapterId === "nginx" ? "nginx" : "caddy");
      if (executable) {
        return { ok: true, sourceType: "native-package-manager", executable, plan };
      }
      failures.push({ plan: plan.label, error: "installed but executable was not detected on PATH" });
    } catch (error) {
      failures.push({ plan: plan.label, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: false, failures };
}

async function downloadTrustedFile(url, targetPath, { expectedSha256 = "", allowUnsafe = false } = {}) {
  const expected = normalizeSha256(expectedSha256);
  if (!expected && !allowUnsafe) {
    throw new Error("Gateway runtime URL downloads require --runtime-sha256. Development override: --allow-unsafe-runtime-download.");
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.download`;
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol === "file:") {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    await fs.copyFile(fileURLToPath(parsedUrl), tempPath);
    await fs.rename(tempPath, targetPath);
    if (expected) {
      const verification = await verifyFileSha256(targetPath, expected);
      if (!verification.ok) {
        await fs.rm(targetPath, { force: true }).catch(() => {});
        throw new Error(`Gateway runtime SHA-256 mismatch: expected ${expected}, actual ${verification.actual}`);
      }
    } else {
      console.warn("WARNING: gateway runtime copied from file URL without SHA-256 under explicit unsafe development override.");
    }
    return;
  }
  const maxAttempts = downloadRetryAttempts();
  let result = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const partialBytes = await fileSize(tempPath);
    console.log(
      partialBytes > 0
        ? `Auto-resuming gateway runtime download (${attempt}/${maxAttempts}, ${partialBytes} bytes): ${url}`
        : `Downloading gateway runtime (${attempt}/${maxAttempts}): ${url}`
    );
    const args = ["-L", "--fail", "--retry", "3", "--connect-timeout", "20"];
    if (partialBytes > 0) {
      args.push("-C", "-");
    }
    args.push("-o", tempPath, url);
    result = await runDownloadCommand("curl", args);
    if (result.status === 0) {
      break;
    }
    if (partialBytes > 0 && outputMentionsRangeUnsupported(result.output)) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      result = await runDownloadCommand("curl", ["-L", "--fail", "--retry", "3", "--connect-timeout", "20", "-o", tempPath, url]);
      if (result.status === 0) {
        break;
      }
    }
    if (attempt < maxAttempts) {
      const delayMs = downloadRetryDelayMs(attempt - 1);
      console.warn(`Gateway runtime download failed; auto-resuming in ${delayMs}ms with ${await fileSize(tempPath)} bytes preserved.`);
      await sleepMs(delayMs);
    }
  }
  if (!result || result.status !== 0) {
    throw new Error(`Gateway runtime download failed after ${maxAttempts} attempts: ${url}`);
  }
  await fs.rename(tempPath, targetPath);
  if (expected) {
    const verification = await verifyFileSha256(targetPath, expected);
    if (!verification.ok) {
      await fs.rm(targetPath, { force: true }).catch(() => {});
      throw new Error(`Gateway runtime SHA-256 mismatch: expected ${expected}, actual ${verification.actual}`);
    }
  } else {
    console.warn("WARNING: gateway runtime downloaded without SHA-256 under explicit unsafe development override.");
  }
}

async function runDownloadCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    let output = "";
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      output += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      resolve({ status: code ?? 0, output });
    });
  });
}

function sleepMs(delayMs = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
}

async function executableExists(targetPath) {
  try {
    await fs.access(targetPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function looksLikeArchive(filePath = "") {
  return /\.(zip|tar|tgz|tar\.gz|tar\.xz|txz)$/i.test(filePath);
}

async function findExecutable(root, executableName) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findExecutable(candidate, executableName);
      if (nested) return nested;
      continue;
    }
    if (entry.name === executableName && await executableExists(candidate)) {
      return candidate;
    }
  }
  return "";
}

async function extractRuntimeArtifact(artifactPath, targetRoot) {
  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.mkdir(targetRoot, { recursive: true });
  if (/\.zip$/i.test(artifactPath)) {
    await runInstallCommand(process.platform === "win32" ? "tar.exe" : "unzip", process.platform === "win32"
      ? ["-xf", artifactPath, "-C", targetRoot]
      : ["-q", artifactPath, "-d", targetRoot]);
    return;
  }
  if (/\.(tar\.gz|tgz)$/i.test(artifactPath)) {
    await runInstallCommand(process.platform === "win32" ? "tar.exe" : "tar", ["-xzf", artifactPath, "-C", targetRoot]);
    return;
  }
  if (/\.(tar\.xz|txz)$/i.test(artifactPath)) {
    await runInstallCommand(process.platform === "win32" ? "tar.exe" : "tar", ["-xJf", artifactPath, "-C", targetRoot]);
  }
}

async function installGatewayRuntime(args = {}) {
  const { resolveExternalGatewayRuntimePlan } = await loadExternalGateway();
  const plan = resolveExternalGatewayRuntimePlan({
    adapterId: args.gateway,
    cacheRoot: defaultRuntimeCacheRoot(args),
    runtimeBinary: args["runtime-binary"],
    runtimeUrl: args["runtime-url"],
    platform: args.platform
  });
  await fs.mkdir(plan.binDir, { recursive: true });

  let source = "";
  let sourceType = "";
  if (plan.configuredBinary) {
    source = plan.configuredBinary;
    sourceType = "configured-binary";
  } else if (await fileExists(plan.cachedExecutablePath)) {
    return {
      ...plan,
      sourceType: "local-cache",
      executablePath: plan.cachedExecutablePath,
      installed: false
    };
  } else {
    const systemBinary = commandExists(plan.executableName);
    if (systemBinary) {
      source = systemBinary;
      sourceType = "path";
    }
  }

  if (source) {
    await fs.copyFile(source, plan.cachedExecutablePath);
    await fs.chmod(plan.cachedExecutablePath, 0o755).catch(() => {});
    return {
      ...plan,
      sourceType,
      executablePath: plan.cachedExecutablePath,
      installed: true
    };
  }

  const nativeInstall = await tryNativeGatewayInstall(plan.adapterId);
  if (nativeInstall.ok) {
    await fs.copyFile(nativeInstall.executable, plan.cachedExecutablePath);
    await fs.chmod(plan.cachedExecutablePath, 0o755).catch(() => {});
    return {
      ...plan,
      sourceType: nativeInstall.sourceType,
      nativePlan: nativeInstall.plan?.label || "",
      executablePath: plan.cachedExecutablePath,
      installed: true
    };
  }

  if (plan.runtimeUrl) {
    const archivePath = path.join(plan.runtimeRoot, "downloads", path.basename(new URL(plan.runtimeUrl).pathname) || `${plan.adapterId}-runtime`);
    await downloadTrustedFile(plan.runtimeUrl, archivePath, {
      expectedSha256: args["runtime-sha256"] || process.env.MESHRIX_GATEWAY_RUNTIME_SHA256 || "",
      allowUnsafe: args["allow-unsafe-runtime-download"] === true ||
        process.env.MESHRIX_RUNTIME_ALLOW_UNSAFE_DOWNLOADS === "1"
    });
    await fs.chmod(archivePath, 0o755).catch(() => {});
    if (!looksLikeArchive(archivePath)) {
      await fs.copyFile(archivePath, plan.cachedExecutablePath);
      await fs.chmod(plan.cachedExecutablePath, 0o755).catch(() => {});
      return {
        ...plan,
        sourceType: "runtime-url-executable",
        artifactPath: archivePath,
        executablePath: plan.cachedExecutablePath,
        installed: true
      };
    }
    const extractedRoot = path.join(plan.runtimeRoot, "extracted");
    await extractRuntimeArtifact(archivePath, extractedRoot);
    const extractedExecutable = await findExecutable(extractedRoot, plan.executableName);
    if (extractedExecutable) {
      await fs.copyFile(extractedExecutable, plan.cachedExecutablePath);
      await fs.chmod(plan.cachedExecutablePath, 0o755).catch(() => {});
      return {
        ...plan,
        sourceType: "runtime-url-archive",
        artifactPath: archivePath,
        executablePath: plan.cachedExecutablePath,
        installed: true
      };
    }
    return {
      ...plan,
      sourceType: "runtime-url",
      artifactPath: archivePath,
      executablePath: "",
      installed: true,
      nativeInstallFailures: nativeInstall.failures || [],
      note: "Runtime artifact was cached but no executable was found. Use a platform package manager or pass --runtime-binary for executable installation."
    };
  }

  return {
    ...plan,
    sourceType: "missing",
    executablePath: "",
    installed: false,
    nativeInstallFailures: nativeInstall.failures || [],
    note: "No configured binary, cached runtime, PATH binary, or runtime URL was available."
  };
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "plan";

if (args.help || command === "help") {
  printUsageAndExit(0);
}

if (command === "list") {
  const { listExternalGatewayAdapters } = await loadExternalGateway();
  const adapters = listExternalGatewayAdapters();
  if (args.json) {
    printJson({ adapters });
  } else {
    for (const adapter of adapters) {
      console.log(`${adapter.adapterId}\t${adapter.fileName}`);
    }
  }
  process.exit(0);
}

if (command === "plan") {
  const { normalizeExternalGatewayProfile } = await loadExternalGateway();
  const profile = normalizeExternalGatewayProfile(profileInputFromArgs(args));
  printJson(profile);
  process.exit(0);
}

if (command === "runtime-plan") {
  const { resolveExternalGatewayRuntimePlan } = await loadExternalGateway();
  const plan = resolveExternalGatewayRuntimePlan({
    adapterId: args.gateway,
    cacheRoot: defaultRuntimeCacheRoot(args),
    runtimeBinary: args["runtime-binary"],
    runtimeUrl: args["runtime-url"],
    platform: args.platform
  });
  printJson({
    ...plan,
    cached: await fileExists(plan.cachedExecutablePath),
    pathBinary: commandExists(plan.executableName)
  });
  process.exit(0);
}

if (command === "runtime-pull") {
  const result = await installGatewayRuntime(args);
  printJson(result);
  process.exit(result.sourceType === "missing" ? 1 : 0);
}

if (command === "render") {
  const { renderExternalGatewayConfig } = await loadExternalGateway();
  const rendered = renderExternalGatewayConfig(profileInputFromArgs(args));
  if (args.json) {
    printJson(rendered);
  } else {
    process.stdout.write(rendered.config);
  }
  process.exit(0);
}

if (command === "verify") {
  const { validateExternalGatewayProfile } = await loadExternalGateway();
  const report = validateExternalGatewayProfile(profileInputFromArgs(args));
  if (args.json) {
    printJson(report);
  } else if (report.ok) {
    console.log(`[external-gateway] ${report.adapterId} ok (${report.routeCount} routes)`);
  } else {
    console.error(report.failures.join("\n"));
  }
  process.exit(report.ok ? 0 : 1);
}

if (command === "write" || command === "switch") {
  const requestedGateway = String(args.gateway || DEFAULT_GATEWAY_ADAPTER).trim().toLowerCase();
  if (command === "switch" && requestedGateway === "direct") {
    const activePath = await writeDirectGatewayPointer(args);
    const report = {
      outputRoot: defaultOutputRoot(args),
      activePath,
      written: []
    };
    if (args.json) {
      printJson(report);
    } else {
      console.log(`Switched active gateway pointer to direct mode: ${activePath}`);
    }
    process.exit(0);
  }
  const adapters =
    requestedGateway === "all"
      ? (await loadExternalGateway()).listExternalGatewayAdapters().map((adapter) => adapter.adapterId)
      : [requestedGateway];
  const written = [];
  for (const adapterId of adapters) {
    written.push(await writeGatewayArtifacts(args, adapterId));
  }
  const activeAdapterId = requestedGateway === "all" ? DEFAULT_GATEWAY_ADAPTER : requestedGateway;
  const activePath = await writeActiveGatewayPointer(args, activeAdapterId);
  const report = {
    outputRoot: defaultOutputRoot(args),
    activePath,
    written
  };
  if (args.json) {
    printJson(report);
  } else {
    console.log(`Wrote gateway ingress artifacts under ${report.outputRoot}`);
    console.log(`Active gateway pointer: ${activePath}`);
    for (const item of written) {
      console.log(`${item.adapterId}: ${path.relative(repoRoot, item.configPath)}`);
    }
  }
  process.exit(0);
}

console.error(`Unknown external-gateway command: ${command}`);
printUsageAndExit(1);
