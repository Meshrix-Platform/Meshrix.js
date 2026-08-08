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
} from "../../packages/foundation/src/environment-compatibility/index.ts";

const scriptDir: any = path.dirname(fileURLToPath(import.meta.url));
const repoRoot: any = path.resolve(scriptDir, "../..");
const DEFAULT_GATEWAY_ADAPTER: any = "caddy";
const DEFAULT_GATEWAY_BASE_URL: any = "http://127.0.0.1:7330";
const DEFAULT_DIRECT_BASE_URL: any = "http://127.0.0.1:7228";
let externalGatewayModulePromise: any = null;

function defaultGatewayRuntimeCacheRoot(env: any = process.env) : any {
  const explicit: any = String(env.MESHRIX_GATEWAY_RUNTIME_CACHE_DIR || "").trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const xdgCacheHome: any = String(env.XDG_CACHE_HOME || "").trim();
  const cacheHome: any = xdgCacheHome ? path.resolve(xdgCacheHome) : path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "meshrix", "external-gateway");
}

function loadExternalGateway() : any {
  if (!externalGatewayModulePromise) {
    externalGatewayModulePromise = import("../../packages/agents/src/agent-gateway/external-gateway/index.ts");
  }
  return externalGatewayModulePromise;
}

function parseArgs(argv: any = []) : any {
  const args: Record<string, any> = { _: [] };
  for (let index: any = 0; index < argv.length; index += 1) {
    const item: any = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const keyValue: any = item.slice(2);
    const equalIndex: any = keyValue.indexOf("=");
    const key: any = equalIndex >= 0 ? keyValue.slice(0, equalIndex) : keyValue;
    const inlineValue: any = equalIndex >= 0 ? keyValue.slice(equalIndex + 1) : null;
    const next: any = argv[index + 1];
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

function printUsageAndExit(code: any = 0) : any {
  console.log(`Meshrix.js Agent Traffic Gateway

Usage:
  node tools/server-scripts/external-gateway.ts list
  node tools/server-scripts/external-gateway.ts plan [--gateway caddy|nginx]
  node tools/server-scripts/external-gateway.ts render --gateway caddy|nginx
  node tools/server-scripts/external-gateway.ts write --gateway caddy|nginx|all [--output DIR]
  node tools/server-scripts/external-gateway.ts switch --gateway caddy|nginx|direct
  node tools/server-scripts/external-gateway.ts runtime-plan --gateway caddy|nginx
  node tools/server-scripts/external-gateway.ts runtime-pull --gateway caddy|nginx [--runtime-url URL --runtime-sha256 SHA256|--runtime-binary PATH]
  node tools/server-scripts/external-gateway.ts verify --gateway caddy|nginx

Options:
  --gateway             Gateway adapter. Default: ${DEFAULT_GATEWAY_ADAPTER}
  --direct-base-url     Direct Meshrix.js endpoint kept as required fallback. Default: ${DEFAULT_DIRECT_BASE_URL}
  --public-base-url     Gateway public endpoint. Default: ${DEFAULT_GATEWAY_BASE_URL}
  --upstream            Upstream Meshrix.js endpoints, comma-separated. Default: direct-base-url
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

function profileInputFromArgs(args: Record<string, any> = {}, gatewayOverride: any = "") : any {
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

function defaultOutputRoot(args: Record<string, any> = {}) : any {
  return path.resolve(String(args.output || path.join(defaultRuntimeCacheRoot(args), "configs")));
}

function defaultRuntimeCacheRoot(args: Record<string, any> = {}) : any {
  return path.resolve(String(args["runtime-cache-dir"] || defaultGatewayRuntimeCacheRoot()));
}

function printJson(value?: any) : any {
  console.log(JSON.stringify(value, null, 2));
}

async function writeGatewayArtifacts(args: Record<string, any> = {}, adapterId?: any) : Promise<any> {
  const { renderExternalGatewayConfig } = await loadExternalGateway();
  const rendered: any = renderExternalGatewayConfig(profileInputFromArgs(args, adapterId));
  const root: any = path.join(defaultOutputRoot(args), rendered.adapterId);
  await fs.mkdir(root, { recursive: true });
  const configPath: any = path.join(root, rendered.fileName);
  const profilePath: any = path.join(root, "gateway-profile.json");
  const routeManifestPath: any = path.join(root, "route-manifest.json");
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

async function writeActiveGatewayPointer(args: Record<string, any> = {}, adapterId?: any) : Promise<any> {
  const { normalizeExternalGatewayProfile } = await loadExternalGateway();
  const root: any = defaultOutputRoot(args);
  await fs.mkdir(root, { recursive: true });
  const profile: any = normalizeExternalGatewayProfile(profileInputFromArgs(args, adapterId));
  const activePath: any = path.join(root, "active-gateway.json");
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

async function writeDirectGatewayPointer(args: Record<string, any> = {}) : Promise<any> {
  const { normalizeExternalGatewayProfile } = await loadExternalGateway();
  const root: any = defaultOutputRoot(args);
  await fs.mkdir(root, { recursive: true });
  const profile: any = normalizeExternalGatewayProfile(profileInputFromArgs(args, DEFAULT_GATEWAY_ADAPTER));
  const activePath: any = path.join(root, "active-gateway.json");
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

async function fileExists(targetPath?: any) : Promise<any> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function commandExists(command?: any) : any {
  return commandPath(command);
}

function nativeGatewayInstallPlans(adapterId?: any) : any {
  const packageName: any = adapterId === "nginx" ? "nginx" : "caddy";
  return nativeHostPackageInstallPlans({
    packageName,
    platform: process.platform,
    commandPathFn: commandExists,
    wingetId: adapterId === "nginx" ? "Nginx.Nginx" : "CaddyServer.Caddy"
  });
}

async function runInstallCommand(command?: any, args: any = []) : Promise<any> {
  await new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code?: any) : any => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function tryNativeGatewayInstall(adapterId?: any) : Promise<any> {
  const plans: any = nativeGatewayInstallPlans(adapterId);
  const failures: any[] = [];
  for (const plan of plans) {
    try {
      const commands: any = plan.commands || [{ command: plan.command, args: plan.args || [] }];
      for (const entry of commands) {
        await runInstallCommand(entry.command, entry.args || []);
      }
      const executable: any = commandExists(adapterId === "nginx" ? "nginx" : "caddy");
      if (executable) {
        return { ok: true, sourceType: "native-package-manager", executable, plan };
      }
      failures.push({ plan: plan.label, error: "installed but executable was not detected on PATH" });
    } catch (error: any) {
      failures.push({ plan: plan.label, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: false, failures };
}

async function downloadTrustedFile(url?: any, targetPath?: any, { expectedSha256 = "", allowUnsafe = false }: Record<string, any> = {}) : Promise<any> {
  const expected: any = normalizeSha256(expectedSha256);
  if (!expected && !allowUnsafe) {
    throw new Error("Gateway runtime URL downloads require --runtime-sha256. Development override: --allow-unsafe-runtime-download.");
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath: any = `${targetPath}.download`;
  const parsedUrl: any = new URL(url);
  if (parsedUrl.protocol === "file:") {
    await fs.rm(tempPath, { force: true }).catch(() : any => {});
    await fs.copyFile(fileURLToPath(parsedUrl), tempPath);
    await fs.rename(tempPath, targetPath);
    if (expected) {
      const verification: any = await verifyFileSha256(targetPath, expected);
      if (!verification.ok) {
        await fs.rm(targetPath, { force: true }).catch(() : any => {});
        throw new Error(`Gateway runtime SHA-256 mismatch: expected ${expected}, actual ${verification.actual}`);
      }
    } else {
      console.warn("WARNING: gateway runtime copied from file URL without SHA-256 under explicit unsafe development override.");
    }
    return;
  }
  const maxAttempts: any = downloadRetryAttempts();
  let result: any = null;
  for (let attempt: any = 1; attempt <= maxAttempts; attempt += 1) {
    const partialBytes: any = await fileSize(tempPath);
    console.log(
      partialBytes > 0
        ? `Auto-resuming gateway runtime download (${attempt}/${maxAttempts}, ${partialBytes} bytes): ${url}`
        : `Downloading gateway runtime (${attempt}/${maxAttempts}): ${url}`
    );
    const args: any[] = ["-L", "--fail", "--retry", "3", "--connect-timeout", "20"];
    if (partialBytes > 0) {
      args.push("-C", "-");
    }
    args.push("-o", tempPath, url);
    result = await runDownloadCommand("curl", args);
    if (result.status === 0) {
      break;
    }
    if (partialBytes > 0 && outputMentionsRangeUnsupported(result.output)) {
      await fs.rm(tempPath, { force: true }).catch(() : any => {});
      result = await runDownloadCommand("curl", ["-L", "--fail", "--retry", "3", "--connect-timeout", "20", "-o", tempPath, url]);
      if (result.status === 0) {
        break;
      }
    }
    if (attempt < maxAttempts) {
      const delayMs: any = downloadRetryDelayMs(attempt - 1);
      console.warn(`Gateway runtime download failed; auto-resuming in ${delayMs}ms with ${await fileSize(tempPath)} bytes preserved.`);
      await sleepMs(delayMs);
    }
  }
  if (!result || result.status !== 0) {
    throw new Error(`Gateway runtime download failed after ${maxAttempts} attempts: ${url}`);
  }
  await fs.rename(tempPath, targetPath);
  if (expected) {
    const verification: any = await verifyFileSha256(targetPath, expected);
    if (!verification.ok) {
      await fs.rm(targetPath, { force: true }).catch(() : any => {});
      throw new Error(`Gateway runtime SHA-256 mismatch: expected ${expected}, actual ${verification.actual}`);
    }
  } else {
    console.warn("WARNING: gateway runtime downloaded without SHA-256 under explicit unsafe development override.");
  }
}

async function runDownloadCommand(command?: any, args: any = []) : Promise<any> {
  return new Promise((resolve?: any, reject?: any) : any => {
    let output: any = "";
    const child: any = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.once("error", reject);
    child.stdout.on("data", (chunk?: any) : any => {
      process.stdout.write(chunk);
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk?: any) : any => {
      process.stderr.write(chunk);
      output += chunk.toString("utf8");
    });
    child.once("exit", (code?: any) : any => {
      resolve({ status: code ?? 0, output });
    });
  });
}

function sleepMs(delayMs: any = 0) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, Math.max(0, delayMs)));
}

async function executableExists(targetPath?: any) : Promise<any> {
  try {
    await fs.access(targetPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function looksLikeArchive(filePath: any = "") : any {
  return /\.(zip|tar|tgz|tar\.gz|tar\.xz|txz)$/i.test(filePath);
}

async function findExecutable(root?: any, executableName?: any) : Promise<any> {
  const entries: any = await fs.readdir(root, { withFileTypes: true }).catch(() : any => []);
  for (const entry of entries) {
    const candidate: any = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested: any = await findExecutable(candidate, executableName);
      if (nested) return nested;
      continue;
    }
    if (entry.name === executableName && await executableExists(candidate)) {
      return candidate;
    }
  }
  return "";
}

async function extractRuntimeArtifact(artifactPath?: any, targetRoot?: any) : Promise<any> {
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

async function installGatewayRuntime(args: Record<string, any> = {}) : Promise<any> {
  const { resolveExternalGatewayRuntimePlan } = await loadExternalGateway();
  const plan: any = resolveExternalGatewayRuntimePlan({
    adapterId: args.gateway,
    cacheRoot: defaultRuntimeCacheRoot(args),
    runtimeBinary: args["runtime-binary"],
    runtimeUrl: args["runtime-url"],
    platform: args.platform
  });
  await fs.mkdir(plan.binDir, { recursive: true });

  let source: any = "";
  let sourceType: any = "";
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
    const systemBinary: any = commandExists(plan.executableName);
    if (systemBinary) {
      source = systemBinary;
      sourceType = "path";
    }
  }

  if (source) {
    await fs.copyFile(source, plan.cachedExecutablePath);
    await fs.chmod(plan.cachedExecutablePath, 0o755).catch(() : any => {});
    return {
      ...plan,
      sourceType,
      executablePath: plan.cachedExecutablePath,
      installed: true
    };
  }

  const nativeInstall: any = await tryNativeGatewayInstall(plan.adapterId);
  if (nativeInstall.ok) {
    await fs.copyFile(nativeInstall.executable, plan.cachedExecutablePath);
    await fs.chmod(plan.cachedExecutablePath, 0o755).catch(() : any => {});
    return {
      ...plan,
      sourceType: nativeInstall.sourceType,
      nativePlan: nativeInstall.plan?.label || "",
      executablePath: plan.cachedExecutablePath,
      installed: true
    };
  }

  if (plan.runtimeUrl) {
    const archivePath: any = path.join(plan.runtimeRoot, "downloads", path.basename(new URL(plan.runtimeUrl).pathname) || `${plan.adapterId}-runtime`);
    await downloadTrustedFile(plan.runtimeUrl, archivePath, {
      expectedSha256: args["runtime-sha256"] || process.env.MESHRIX_GATEWAY_RUNTIME_SHA256 || "",
      allowUnsafe: args["allow-unsafe-runtime-download"] === true ||
        process.env.MESHRIX_RUNTIME_ALLOW_UNSAFE_DOWNLOADS === "1"
    });
    await fs.chmod(archivePath, 0o755).catch(() : any => {});
    if (!looksLikeArchive(archivePath)) {
      await fs.copyFile(archivePath, plan.cachedExecutablePath);
      await fs.chmod(plan.cachedExecutablePath, 0o755).catch(() : any => {});
      return {
        ...plan,
        sourceType: "runtime-url-executable",
        artifactPath: archivePath,
        executablePath: plan.cachedExecutablePath,
        installed: true
      };
    }
    const extractedRoot: any = path.join(plan.runtimeRoot, "extracted");
    await extractRuntimeArtifact(archivePath, extractedRoot);
    const extractedExecutable: any = await findExecutable(extractedRoot, plan.executableName);
    if (extractedExecutable) {
      await fs.copyFile(extractedExecutable, plan.cachedExecutablePath);
      await fs.chmod(plan.cachedExecutablePath, 0o755).catch(() : any => {});
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

const args: any = parseArgs(process.argv.slice(2));
const command: any = args._[0] || "plan";

if (args.help || command === "help") {
  printUsageAndExit(0);
}

if (command === "list") {
  const { listExternalGatewayAdapters } = await loadExternalGateway();
  const adapters: any = listExternalGatewayAdapters();
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
  const profile: any = normalizeExternalGatewayProfile(profileInputFromArgs(args));
  printJson(profile);
  process.exit(0);
}

if (command === "runtime-plan") {
  const { resolveExternalGatewayRuntimePlan } = await loadExternalGateway();
  const plan: any = resolveExternalGatewayRuntimePlan({
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
  const result: any = await installGatewayRuntime(args);
  printJson(result);
  process.exit(result.sourceType === "missing" ? 1 : 0);
}

if (command === "render") {
  const { renderExternalGatewayConfig } = await loadExternalGateway();
  const rendered: any = renderExternalGatewayConfig(profileInputFromArgs(args));
  if (args.json) {
    printJson(rendered);
  } else {
    process.stdout.write(rendered.config);
  }
  process.exit(0);
}

if (command === "verify") {
  const { validateExternalGatewayProfile } = await loadExternalGateway();
  const report: any = validateExternalGatewayProfile(profileInputFromArgs(args));
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
  const requestedGateway: any = String(args.gateway || DEFAULT_GATEWAY_ADAPTER).trim().toLowerCase();
  if (command === "switch" && requestedGateway === "direct") {
    const activePath: any = await writeDirectGatewayPointer(args);
    const report: Record<string, any> = {
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
  const adapters: any =
    requestedGateway === "all"
      ? (await loadExternalGateway()).listExternalGatewayAdapters().map((adapter?: any) : any => adapter.adapterId)
      : [requestedGateway];
  const written: any[] = [];
  for (const adapterId of adapters) {
    written.push(await writeGatewayArtifacts(args, adapterId));
  }
  const activeAdapterId: any = requestedGateway === "all" ? DEFAULT_GATEWAY_ADAPTER : requestedGateway;
  const activePath: any = await writeActiveGatewayPointer(args, activeAdapterId);
  const report: Record<string, any> = {
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
