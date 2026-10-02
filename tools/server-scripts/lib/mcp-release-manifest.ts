import {
  MCP_INTERFACE_VERSION,
  MCP_NPM_PACKAGE_NAME,
  MCP_NPM_PACKAGE_VERSION,
  MCP_SERVER_VERSION,
  MCP_STABLE_TOOL_NAME,
  MCP_TOOLSET_VERSION
} from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-constants.ts";
import {
  MCP_CLIENT_TARGETS,
  MCP_PRIORITY_INSTALL_TARGET,
  MCP_PRIORITY_INSTALL_TARGETS,
  mcpSupportedTargetDetails
} from "../../../packages/protocols/mcp/adapter/mcp-release-targets.ts";

function sharedHubContract(): any {
  return {
    clientPolicy: "discover-shared-hub-then-opt-in",
    defaultClientMutation: "none",
    directHttp: true
  };
}

export function releaseGeneratedAtFromSourceDateEpoch(value?: any): string {
  const normalized = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d{0,11})$/u.test(normalized)) {
    throw new Error("release_source_date_epoch_invalid");
  }
  const milliseconds = Number(normalized) * 1000;
  const date = new Date(milliseconds);
  if (!Number.isSafeInteger(milliseconds) || Number.isNaN(date.getTime())) {
    throw new Error("release_source_date_epoch_invalid");
  }
  return date.toISOString();
}

function packageCommand(packageJson: Record<string, any>, command: string): string {
  return `npx --yes --package ${packageJson.name}@${packageJson.version} meshrix-mcp ${command}`;
}

function portableAsset(portable: Record<string, any>): Record<string, any> {
  return {
    platform: portable.platform,
    archive: portable.archiveName,
    sha256: portable.sha256,
    sizeBytes: portable.sizeBytes,
    zipArchive: portable.zipArchiveName || null,
    zipSha256: portable.zipSha256 || null,
    zipSizeBytes: portable.zipSizeBytes ?? null,
    launcher: portable.platform.startsWith("windows-") ? "meshrix-mcp.ps1" : "meshrix-mcp",
    executable: portable.executable,
    includesNodeRuntime: portable.includesNodeRuntime,
    bundledNodeVersion: portable.bundledNodeVersion,
    nodeRuntimeLockPath: portable.nodeRuntimeLockPath
  };
}

export function releaseManifest({
  channel,
  packageJson,
  tarballName,
  npmIntegrity,
  checksum,
  sizeBytes,
  portables,
  generatedAt
}: Record<string, any>): any {
  const minimumNodeVersion = String(packageJson?.engines?.node || "").trim();
  if (!minimumNodeVersion) throw new Error("connector_node_engine_missing");
  if (packageJson?.name !== MCP_NPM_PACKAGE_NAME || packageJson?.version !== MCP_NPM_PACKAGE_VERSION) {
    throw new Error("connector_package_identity_mismatch");
  }
  const normalizedGeneratedAt = String(generatedAt || "");
  const generatedDate = new Date(normalizedGeneratedAt);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(normalizedGeneratedAt)
    || Number.isNaN(generatedDate.getTime())
    || generatedDate.toISOString() !== normalizedGeneratedAt
  ) {
    throw new Error("release_generated_at_invalid");
  }
  const portableAssets = (Array.isArray(portables) ? portables : []).map(portableAsset);
  const npmCommand = packageCommand(packageJson, "install");
  const npmUninstallCommand = packageCommand(packageJson, "uninstall --target codex");
  const npmDoctorCommand = packageCommand(packageJson, "doctor --json");
  const npmDiscoverCommand = packageCommand(packageJson, "discover-local --json");
  const npmScanCommand = packageCommand(packageJson, "scan --json");
  const releaseFiles = [
    tarballName,
    ...portableAssets.flatMap((asset: Record<string, any>) => [asset.archive, asset.zipArchive].filter(Boolean)),
    "SHA256SUMS",
    "RELEASE_SHA256SUMS",
    "RELEASE_SHA256SUMS.sigstore.json",
    "meshrix-mcp-release.json",
    "latest.json"
  ];

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
      npmIntegrity,
      tarball: tarballName,
      sha256: checksum,
      sizeBytes,
      userDeviceInstaller: "node-bin"
    },
    portable: {
      strategy: "verified-portable-connector",
      requiresInstalledNode: false,
      preferredArchive: "versioned-portable-archive",
      artifacts: portableAssets,
      releaseChecksumFile: "RELEASE_SHA256SUMS",
      releaseChecksumSigstoreBundleFile: "RELEASE_SHA256SUMS.sigstore.json",
      checksumAuthorityVerificationOrder: "sigstore-bundle-then-asset-digest",
      checksumVerificationRequired: true,
      installCommand: "meshrix-mcp install",
      clientInstallCommand: "meshrix-mcp install --target codex",
      clientInstallJsonCommand: "meshrix-mcp install --target codex --json",
      autoInstallCommand: "meshrix-mcp install --target auto --json",
      priorityInstallCommand: `meshrix-mcp install --target ${MCP_PRIORITY_INSTALL_TARGET} --json`,
      priorityTargets: [...MCP_PRIORITY_INSTALL_TARGETS],
      supportedTargetDetails: mcpSupportedTargetDetails(),
      uninstallCommand: "meshrix-mcp uninstall --target codex",
      doubleClickEntry: ""
    },
    install: {
      registryCommand: npmCommand,
      installCommand: npmCommand,
      interactiveInstallCommand: npmCommand,
      autoInstallCommand: packageCommand(packageJson, "install --target auto --json"),
      priorityInstallCommand: packageCommand(packageJson, `install --target ${MCP_PRIORITY_INSTALL_TARGET} --json`),
      clientInstallCommand: packageCommand(packageJson, "install --target codex"),
      clientInstallJsonCommand: packageCommand(packageJson, "install --target codex --json"),
      uninstallCommand: npmUninstallCommand,
      doctorCommand: npmDoctorCommand,
      discoverCommand: npmDiscoverCommand,
      scanCommand: npmScanCommand,
      priorityTargets: [...MCP_PRIORITY_INSTALL_TARGETS],
      supportedTargets: MCP_CLIENT_TARGETS.map(({ target }: Record<string, any>) => target),
      supportedTargetDetails: mcpSupportedTargetDetails()
    },
    upgrade: {
      listChanged: true,
      notification: "notifications/tools/list_changed",
      reinstallCommand: npmCommand,
      clientInstallJsonCommand: packageCommand(packageJson, "install --target codex --json"),
      autoInstallCommand: packageCommand(packageJson, "install --target auto --json"),
      priorityInstallCommand: packageCommand(packageJson, `install --target ${MCP_PRIORITY_INSTALL_TARGET} --json`),
      priorityTargets: [...MCP_PRIORITY_INSTALL_TARGETS]
    },
    publish: { releaseFiles }
  };
}
