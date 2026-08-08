import fs from "node:fs/promises";
import path from "node:path";
import {
  MCP_INTERFACE_VERSION,
  MCP_SERVER_VERSION,
  MCP_STABLE_TOOL_NAME,
  MCP_TOOLSET_VERSION
} from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-constants.ts";
import {
  MCP_CLIENT_TARGETS,
  MCP_PRIORITY_INSTALL_TARGETS,
  mcpSupportedTargetDetails
} from "../../../packages/protocols/mcp/adapter/mcp-release-targets.ts";
import { PRIORITY_INSTALL_TARGET, projectRoot, sha256 } from "./mcp-release-common.ts";

function sharedHubContract() : any {
  return {
    clientPolicy: "discover-shared-hub-then-opt-in",
    defaultClientMutation: "none",
    directHttp: true
  };
}

function githubOwnerRepo(packageJson?: any) : any {
  const repositoryUrl: any = String(packageJson.repository?.url || "");
  const match: any = repositoryUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return match?.[1] || String(process.env.GITHUB_REPOSITORY || "internal/meshrix-js");
}

export function releaseGeneratedAtFromSourceDateEpoch(value?: any) : any {
  const normalized: any = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d{0,11})$/u.test(normalized)) {
    throw new Error("release_source_date_epoch_invalid");
  }
  const milliseconds: any = Number(normalized) * 1000;
  const date: any = new Date(milliseconds);
  if (!Number.isSafeInteger(milliseconds) || Number.isNaN(date.getTime())) {
    throw new Error("release_source_date_epoch_invalid");
  }
  return date.toISOString();
}

export async function createBootstrapInstaller({ outputDir, packageJson }: Record<string, any>) : Promise<any> {
  const scriptName: any = "meshrix-mcp-install.sh";
  const scriptPath: any = path.join(outputDir, scriptName);
  const uninstallScriptName: any = "meshrix-mcp-uninstall.sh";
  const uninstallScriptPath: any = path.join(outputDir, uninstallScriptName);
  const zhCnScriptName: any = "meshrix-mcp-install.zh-CN.sh";
  const zhCnScriptPath: any = path.join(outputDir, zhCnScriptName);
  const zhCnUninstallScriptName: any = "meshrix-mcp-uninstall.zh-CN.sh";
  const zhCnUninstallScriptPath: any = path.join(outputDir, zhCnUninstallScriptName);
  const repo: any = githubOwnerRepo(packageJson);
  const windowsScriptName: any = "meshrix-mcp-install.ps1";
  const windowsScriptPath: any = path.join(outputDir, windowsScriptName);
  const windowsUninstallScriptName: any = "meshrix-mcp-uninstall.ps1";
  const windowsUninstallScriptPath: any = path.join(outputDir, windowsUninstallScriptName);
  const nativeInstallerRoot: any = path.join(projectRoot, "packages/protocols/mcp/adapter/native-installer");
  await fs.copyFile(path.join(nativeInstallerRoot, scriptName), scriptPath);
  await fs.chmod(scriptPath, 0o755);
  await fs.copyFile(path.join(nativeInstallerRoot, uninstallScriptName), uninstallScriptPath);
  await fs.chmod(uninstallScriptPath, 0o755);
  await fs.copyFile(path.join(nativeInstallerRoot, scriptName), zhCnScriptPath);
  await fs.chmod(zhCnScriptPath, 0o755);
  await fs.copyFile(path.join(nativeInstallerRoot, uninstallScriptName), zhCnUninstallScriptPath);
  await fs.chmod(zhCnUninstallScriptPath, 0o755);
  await fs.copyFile(path.join(nativeInstallerRoot, windowsScriptName), windowsScriptPath);
  await fs.copyFile(path.join(nativeInstallerRoot, windowsUninstallScriptName), windowsUninstallScriptPath);
  const localScriptCommand: any = (filename?: any) : any => `/bin/sh -c 'exec /bin/sh ./${filename} "$@"'`;
  const oneLineCommand: any = localScriptCommand(scriptName);
  const oneLineCommandZhCN: any = localScriptCommand(zhCnScriptName);
  const oneLineUninstallCommand: any = localScriptCommand(uninstallScriptName);
  const oneLineUninstallCommandZhCN: any = localScriptCommand(zhCnUninstallScriptName);
  return {
    scriptName,
    scriptPath,
    sha256: await sha256(scriptPath),
    githubLatestUrl: `https://github.com/${repo}/releases/latest/download/${scriptName}`,
    oneLineCommand,
    oneLineClientInstallJsonCommand: `${oneLineCommand} -- --target <client> --json`,
    oneLineAutoInstallCommand: `${oneLineCommand} -- --target auto --json`,
    oneLinePriorityInstallCommand: `${oneLineCommand} -- --target ${PRIORITY_INSTALL_TARGET} --json`,
    uninstallScriptName,
    uninstallScriptPath,
    uninstallSha256: await sha256(uninstallScriptPath),
    githubLatestUninstallUrl: `https://github.com/${repo}/releases/latest/download/${uninstallScriptName}`,
    oneLineUninstallCommand,
    windowsScriptName,
    windowsScriptPath,
    windowsSha256: await sha256(windowsScriptPath),
    windowsGithubLatestUrl: `https://github.com/${repo}/releases/latest/download/${windowsScriptName}`,
    windowsUninstallScriptName,
    windowsUninstallScriptPath,
    windowsUninstallSha256: await sha256(windowsUninstallScriptPath),
    windowsGithubLatestUninstallUrl: `https://github.com/${repo}/releases/latest/download/${windowsUninstallScriptName}`,
    localized: {
      zhCN: {
        scriptName: zhCnScriptName,
        scriptPath: zhCnScriptPath,
        sha256: await sha256(zhCnScriptPath),
        githubLatestUrl: `https://github.com/${repo}/releases/latest/download/${zhCnScriptName}`,
        oneLineCommand: oneLineCommandZhCN,
        oneLineClientInstallJsonCommand: `${oneLineCommandZhCN} -- --target <client> --json`,
        oneLineAutoInstallCommand: `${oneLineCommandZhCN} -- --target auto --json`,
        oneLinePriorityInstallCommand: `${oneLineCommandZhCN} -- --target ${PRIORITY_INSTALL_TARGET} --json`,
        uninstallScriptName: zhCnUninstallScriptName,
        uninstallScriptPath: zhCnUninstallScriptPath,
        uninstallSha256: await sha256(zhCnUninstallScriptPath),
        githubLatestUninstallUrl: `https://github.com/${repo}/releases/latest/download/${zhCnUninstallScriptName}`,
        oneLineUninstallCommand: oneLineUninstallCommandZhCN
      }
    }
  };
}

export function releaseManifest({
  channel,
  packageJson,
  tarballName,
  tarballPath,
  checksum,
  sizeBytes,
  portables,
  bootstrap,
  generatedAt
}: Record<string, any>) : any {
  const minimumNodeVersion: any = String(packageJson?.engines?.node || "").trim();
  if (!minimumNodeVersion) {
    throw new Error("connector_node_engine_missing");
  }
  const portable: any = portables[0];
  const portableCommand: any = "meshrix-mcp";
  const hasFallbackZip: any = Boolean(portable.zipArchiveName);
  const fallbackDownload: any = hasFallbackZip ? portable.zipArchiveName : portable.archiveName;
  const fallbackSizeBytes: any = hasFallbackZip ? portable.zipSizeBytes : portable.sizeBytes;
  const normalizedGeneratedAt: any = String(generatedAt || "");
  const generatedDate: any = new Date(normalizedGeneratedAt);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(normalizedGeneratedAt)
    || Number.isNaN(generatedDate.getTime())
    || generatedDate.toISOString() !== normalizedGeneratedAt
  ) {
    throw new Error("release_generated_at_invalid");
  }
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    packageType: "v0.0.1:mcp:connector-release-1",
    generatedAt: normalizedGeneratedAt,
    channel,
    interfaceVersion: MCP_INTERFACE_VERSION,
    toolsetVersion: MCP_TOOLSET_VERSION,
    serverVersion: MCP_SERVER_VERSION,
    stableToolName: MCP_STABLE_TOOL_NAME,
    sharedHub: sharedHubContract(),
    connector: {
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      minimumNodeVersion,
      tarball: tarballName,
      sha256: checksum,
      sizeBytes,
      userDeviceInstaller: "platform-native-launcher"
    },
    portable: {
      strategy: "verified-portable-connector",
      requiresInstalledNode: false,
      preferredArchive: "versioned-portable-archive",
      currentPlatform: portable.platform,
      tarball: portable.archiveName,
      sha256: portable.sha256,
      sizeBytes: portable.sizeBytes,
      zipArchive: portable.zipArchiveName,
      zipSha256: portable.zipSha256,
      zipSizeBytes: portable.zipSizeBytes,
      executable: portable.executable,
      includesNodeRuntime: portable.includesNodeRuntime,
      bundledNodeVersion: portable.bundledNodeVersion,
      nodeRuntimeLockPath: portable.nodeRuntimeLockPath,
      releaseChecksumFile: "RELEASE_SHA256SUMS",
      releaseChecksumSigstoreBundleFile: "RELEASE_SHA256SUMS.sigstore.json",
      checksumAuthorityVerificationOrder: "sigstore-bundle-then-asset-digest",
      checksumVerificationRequired: true,
      zipInstallEntry: "install.command",
      zipUninstallEntry: "uninstall.command",
      installArchive: portable.archiveName,
      installArchiveSha256: portable.sha256,
      installArchiveSizeBytes: portable.sizeBytes,
      installArchiveType: portable.zipArchiveName ? "zip" : "tar",
      installCommand: bootstrap.oneLineCommand,
      clientInstallCommand: `${bootstrap.oneLineCommand} -- --target <client>`,
      clientInstallJsonCommand: bootstrap.oneLineClientInstallJsonCommand,
      autoInstallCommand: bootstrap.oneLineAutoInstallCommand,
      priorityInstallCommand: bootstrap.oneLinePriorityInstallCommand,
      priorityTargets: [...MCP_PRIORITY_INSTALL_TARGETS],
      supportedTargetDetails: mcpSupportedTargetDetails(),
      interactiveUninstallCommand: bootstrap.oneLineUninstallCommand,
      clientUninstallCommand: `${bootstrap.oneLineUninstallCommand} -- --target <client>`,
      doubleClickEntry: ""
    },
    install: {
      githubOneLineCommand: bootstrap.oneLineCommand,
      githubOneLineCommandZhCN: bootstrap.localized.zhCN.oneLineCommand,
      githubOneLineClientInstallJsonCommand: bootstrap.oneLineClientInstallJsonCommand,
      githubOneLineClientInstallJsonCommandZhCN: bootstrap.localized.zhCN.oneLineClientInstallJsonCommand,
      githubOneLineAutoInstallCommand: bootstrap.oneLineAutoInstallCommand,
      githubOneLineAutoInstallCommandZhCN: bootstrap.localized.zhCN.oneLineAutoInstallCommand,
      githubOneLinePriorityInstallCommand: bootstrap.oneLinePriorityInstallCommand,
      githubOneLinePriorityInstallCommandZhCN: bootstrap.localized.zhCN.oneLinePriorityInstallCommand,
      githubOneLineUninstallCommand: bootstrap.oneLineUninstallCommand,
      githubOneLineUninstallCommandZhCN: bootstrap.localized.zhCN.oneLineUninstallCommand,
      oneCommandInstall: bootstrap.oneLineCommand,
      oneCommandInstallZhCN: bootstrap.localized.zhCN.oneLineCommand,
      oneCommandClientInstallJson: bootstrap.oneLineClientInstallJsonCommand,
      oneCommandClientInstallJsonZhCN: bootstrap.localized.zhCN.oneLineClientInstallJsonCommand,
      oneCommandAutoInstall: bootstrap.oneLineAutoInstallCommand,
      oneCommandAutoInstallZhCN: bootstrap.localized.zhCN.oneLineAutoInstallCommand,
      oneCommandPriorityInstall: bootstrap.oneLinePriorityInstallCommand,
      oneCommandPriorityInstallZhCN: bootstrap.localized.zhCN.oneLinePriorityInstallCommand,
      oneCommandUninstall: bootstrap.oneLineUninstallCommand,
      oneCommandUninstallZhCN: bootstrap.localized.zhCN.oneLineUninstallCommand,
      registryCommand: bootstrap.oneLineCommand,
      tarballCommand: bootstrap.oneLineCommand,
      portableCommand: bootstrap.oneLineCommand,
      interactiveInstallCommand: bootstrap.oneLineCommand,
      autoInstallCommand: bootstrap.oneLineAutoInstallCommand,
      priorityInstallCommand: bootstrap.oneLinePriorityInstallCommand,
      priorityTargets: [...MCP_PRIORITY_INSTALL_TARGETS],
      clientInstallCommand: `${bootstrap.oneLineCommand} -- --target <client>`,
      clientInstallJsonCommand: bootstrap.oneLineClientInstallJsonCommand,
      interactiveUninstallCommand: bootstrap.oneLineUninstallCommand,
      uninstallCommand: `${bootstrap.oneLineUninstallCommand} -- --target <client>`,
      doctorCommand: `${bootstrap.oneLineCommand} -- doctor`,
      discoverCommand: `${bootstrap.oneLineCommand} -- discover-local --json`,
      scanCommand: `${bootstrap.oneLineCommand} -- scan --json`,
      windowsInstallScript: bootstrap.windowsScriptName,
      windowsUninstallScript: bootstrap.windowsUninstallScriptName,
      supportedTargets: MCP_CLIENT_TARGETS.map((target?: any) : any => target.target),
      supportedTargetDetails: mcpSupportedTargetDetails()
    },
    upgrade: {
      listChanged: true,
      notification: "notifications/tools/list_changed",
      reinstallCommand: bootstrap.oneLineCommand,
      reinstallCommandZhCN: bootstrap.localized.zhCN.oneLineCommand,
      clientReinstallJsonCommand: bootstrap.oneLineClientInstallJsonCommand,
      clientReinstallJsonCommandZhCN: bootstrap.localized.zhCN.oneLineClientInstallJsonCommand,
      agentReinstallCommand: bootstrap.oneLineAutoInstallCommand,
      agentReinstallCommandZhCN: bootstrap.localized.zhCN.oneLineAutoInstallCommand,
      priorityAgentReinstallCommand: bootstrap.oneLinePriorityInstallCommand,
      priorityAgentReinstallCommandZhCN: bootstrap.localized.zhCN.oneLinePriorityInstallCommand,
      oneCommandReinstall: bootstrap.oneLineCommand,
      oneCommandReinstallZhCN: bootstrap.localized.zhCN.oneLineCommand,
      oneCommandClientReinstallJson: bootstrap.oneLineClientInstallJsonCommand,
      oneCommandClientReinstallJsonZhCN: bootstrap.localized.zhCN.oneLineClientInstallJsonCommand,
      oneCommandAgentReinstall: bootstrap.oneLineAutoInstallCommand,
      oneCommandAgentReinstallZhCN: bootstrap.localized.zhCN.oneLineAutoInstallCommand,
      oneCommandPriorityAgentReinstall: bootstrap.oneLinePriorityInstallCommand,
      oneCommandPriorityAgentReinstallZhCN: bootstrap.localized.zhCN.oneLinePriorityInstallCommand,
      priorityTargets: [...MCP_PRIORITY_INSTALL_TARGETS]
    },
    bootstrap: {
      scriptName: bootstrap.scriptName,
      sha256: bootstrap.sha256,
      githubLatestUrl: bootstrap.githubLatestUrl,
      command: bootstrap.oneLineCommand,
      uninstallScriptName: bootstrap.uninstallScriptName,
      uninstallSha256: bootstrap.uninstallSha256,
      uninstallGithubLatestUrl: bootstrap.githubLatestUninstallUrl,
      uninstallCommand: bootstrap.oneLineUninstallCommand,
      localized: {
        zhCN: {
          scriptName: bootstrap.localized.zhCN.scriptName,
          sha256: bootstrap.localized.zhCN.sha256,
          githubLatestUrl: bootstrap.localized.zhCN.githubLatestUrl,
          command: bootstrap.localized.zhCN.oneLineCommand,
          uninstallScriptName: bootstrap.localized.zhCN.uninstallScriptName,
          uninstallSha256: bootstrap.localized.zhCN.uninstallSha256,
          uninstallGithubLatestUrl: bootstrap.localized.zhCN.githubLatestUninstallUrl,
          uninstallCommand: bootstrap.localized.zhCN.oneLineUninstallCommand
        }
      },
      windows: {
        scriptName: bootstrap.windowsScriptName,
        sha256: bootstrap.windowsSha256,
        githubLatestUrl: bootstrap.windowsGithubLatestUrl,
        uninstallScriptName: bootstrap.windowsUninstallScriptName,
        uninstallSha256: bootstrap.windowsUninstallSha256,
        uninstallGithubLatestUrl: bootstrap.windowsGithubLatestUninstallUrl
      },
      strategy: "verified-portable-connector",
      preferredDownload: portable.archiveName,
      fallbackDownload,
      sourceSizeBytes: sizeBytes,
      fallbackSizeBytes,
      installsTo: "agent-client native config",
      startsInteractiveInstaller: true,
      startsInteractiveUninstaller: true,
      supportsMultiSelect: true
    },
    publish: {
      releaseFiles: [
        tarballName,
        ...portables.map((p?: any) : any => p.archiveName),
        ...portables.map((p?: any) : any => p.zipArchiveName).filter(Boolean),
        bootstrap.scriptName,
        bootstrap.uninstallScriptName,
        bootstrap.localized.zhCN.scriptName,
        bootstrap.localized.zhCN.uninstallScriptName,
        bootstrap.windowsScriptName,
        bootstrap.windowsUninstallScriptName,
        "SHA256SUMS",
        "RELEASE_SHA256SUMS",
        "RELEASE_SHA256SUMS.sigstore.json",
        "meshrix-mcp-release.json",
        "latest.json"
      ]
    }
  };
}
