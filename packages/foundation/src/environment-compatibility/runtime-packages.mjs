import path from "node:path";
import {
  commandPath,
  commandVersion,
  hostPlatformKey,
  pathExists
} from "./host-runtime.mjs";

function text(value) {
  return String(value ?? "").trim();
}

export function gatewayCaddyArch({ arch = process.arch } = {}) {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "amd64";
  return arch;
}

export function sourcePlatformKeys({ platform = process.platform, arch = process.arch } = {}) {
  return [
    hostPlatformKey({ platform, arch }),
    `${platform}-${gatewayCaddyArch({ arch })}`,
    platform,
    "default"
  ];
}

export function defaultPythonPackageFileName({
  platform = process.platform,
  version
} = {}) {
  const pythonVersion = text(version);
  if (platform === "darwin") return `python-${pythonVersion}-macos11.pkg`;
  if (platform === "win32") return `python-${pythonVersion}-amd64.exe`;
  return `python-${pythonVersion}.tgz`;
}

export function defaultPythonPackageUrl({
  platform = process.platform,
  version
} = {}) {
  const pythonVersion = text(version);
  if (platform === "darwin") {
    return `https://www.python.org/ftp/python/${pythonVersion}/python-${pythonVersion}-macos11.pkg`;
  }
  if (platform === "win32") {
    return `https://www.python.org/ftp/python/${pythonVersion}/python-${pythonVersion}-amd64.exe`;
  }
  return `https://www.python.org/ftp/python/${pythonVersion}/Python-${pythonVersion}.tgz`;
}

export function defaultJreSourceEntry({
  platform = process.platform,
  arch = process.arch
} = {}) {
  const platformKey = hostPlatformKey({ platform, arch });
  if (platformKey === "linux-x64") {
    return {
      fileName: "OpenJDK21U-jre_x64_linux_hotspot_21.0.10_7.tar.gz",
      url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.10%2B7/OpenJDK21U-jre_x64_linux_hotspot_21.0.10_7.tar.gz"
    };
  }
  if (platformKey === "linux-arm64") {
    return {
      fileName: "OpenJDK21U-jre_aarch64_linux_hotspot_21.0.10_7.tar.gz",
      url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.10%2B7/OpenJDK21U-jre_aarch64_linux_hotspot_21.0.10_7.tar.gz"
    };
  }
  if (platformKey === "darwin-arm64") {
    return {
      fileName: "OpenJDK21U-jre_aarch64_mac_hotspot_21.0.10_7.tar.gz",
      url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.10%2B7/OpenJDK21U-jre_aarch64_mac_hotspot_21.0.10_7.tar.gz"
    };
  }
  if (platformKey === "darwin-x64") {
    return {
      fileName: "OpenJDK21U-jre_x64_mac_hotspot_21.0.10_7.tar.gz",
      url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.10%2B7/OpenJDK21U-jre_x64_mac_hotspot_21.0.10_7.tar.gz"
    };
  }
  if (platformKey === "win32-x64") {
    return {
      fileName: "OpenJDK21U-jre_x64_windows_hotspot_21.0.10_7.zip",
      url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.10%2B7/OpenJDK21U-jre_x64_windows_hotspot_21.0.10_7.zip"
    };
  }
  if (platformKey === "win32-arm64") {
    return {
      fileName: "jre-win32-arm64.zip",
      url: "",
      unsupportedReason: "Windows ARM64 JRE auto-download is not bundled yet. Install Java 21+ locally or set LICO_JRE_DOWNLOAD_URL and LICO_JRE_DOWNLOAD_FILE to a trusted Windows ARM64 JRE zip."
    };
  }
  return {
    fileName: `jre-${platformKey}.tar.gz`,
    url: ""
  };
}

export function defaultCaddyPackageUrl({
  platform = process.platform,
  arch = process.arch
} = {}) {
  const osName = platform === "win32" ? "windows" : platform;
  return `https://caddyserver.com/api/download?os=${encodeURIComponent(osName)}&arch=${encodeURIComponent(gatewayCaddyArch({ arch }))}`;
}

export function defaultCaddyPackageFileName({
  platform = process.platform,
  arch = process.arch
} = {}) {
  const extension = platform === "win32" ? "zip" : "tar.gz";
  return `caddy-${platform}-${arch}.${extension}`;
}

export function dockerDefaultInstallerUrl({
  platform = process.platform,
  arch = process.arch
} = {}) {
  if (platform !== "darwin") {
    return "";
  }
  const dockerArch = arch === "arm64" ? "arm64" : "amd64";
  return `https://desktop.docker.com/mac/main/${dockerArch}/Docker.dmg`;
}

export function detectDockerHostSync({
  platform = process.platform,
  arch = process.arch,
  platformKey = hostPlatformKey({ platform, arch }),
  runtimeCacheRoot = "",
  installerFileName = "",
  commandPathFn = commandPath,
  pathExistsFn = pathExists,
  commandVersionFn = commandVersion
} = {}) {
  const dockerPath = commandPathFn("docker");
  const appPath = platform === "darwin" ? "/Applications/Docker.app" : "";
  const resolvedInstallerFileName = installerFileName || `Docker-${platformKey}.dmg`;
  const installerPath = runtimeCacheRoot ? path.join(runtimeCacheRoot, "docker", resolvedInstallerFileName) : "";
  const appPresent = appPath ? pathExistsFn(appPath) : false;
  return {
    id: "docker",
    ready: Boolean(dockerPath),
    present: Boolean(dockerPath) || appPresent,
    cached: installerPath ? pathExistsFn(installerPath) : false,
    dockerPath,
    appPath,
    appPresent,
    installerPath,
    version: dockerPath ? commandVersionFn("docker", ["--version"]) : ""
  };
}

export function optionalModuleRuntimeRoot(repoRoot = "", moduleId = "") {
  return path.join(repoRoot, "packages", "capabilities", "runtime-modules", text(moduleId));
}
