import {
  DEFAULT_TOKEN_ENV, packageInfo,
  PRIORITY_INSTALL_TARGETS, SUPPORTED_TARGETS, supportedTargetDetails
} from "./constants.ts";
import { MCP_SERVER_NAME, nativeCapability } from "@meshrix/client-adapter-kit";
import { normalizeBaseUrl, option } from "./basic-utils.ts";
import { explicitBaseUrl } from "./discovery.ts";
import { shellQuote } from "./connector-process.ts";

const priorityTargets = PRIORITY_INSTALL_TARGETS.filter((target: string) => nativeCapability(target).supported);

export function npmPackageCommand(command = ""): string {
  const executable = `npx --yes --package ${packageInfo.name}@${packageInfo.version} meshrix-mcp`;
  return command ? `${executable} ${command}` : executable;
}

export function commandGuidanceBaseUrl(options: Record<string, any> = {}): string {
  return normalizeBaseUrl(option(options, "resolved-url", explicitBaseUrl(options)));
}

export function commandGuidanceContext(options: Record<string, any> = {}): Record<string, any> {
  return {
    baseUrl: commandGuidanceBaseUrl(options),
    tokenEnv: String(option(options, "token-env", DEFAULT_TOKEN_ENV)),
    serverName: String(option(options, "server-name", MCP_SERVER_NAME))
  };
}

export function appendGuidanceContextArgs(parts: string[], { baseUrl = "", tokenEnv = DEFAULT_TOKEN_ENV, serverName = MCP_SERVER_NAME, includeUrl = false }: Record<string, any> = {}): string[] {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (includeUrl && normalizedBaseUrl) parts.push("--url", shellQuote(normalizedBaseUrl));
  if (tokenEnv) parts.push("--token-env", shellQuote(tokenEnv));
  if (serverName !== MCP_SERVER_NAME) parts.push("--server-name", shellQuote(serverName));
  return parts;
}

function contextualCommand(command: string, context: Record<string, any> = {}, args: string[] = []): string {
  const parts = [npmPackageCommand(command), ...args];
  appendGuidanceContextArgs(parts, context);
  parts.push("--json");
  return parts.join(" ");
}

export function shellCommandForInstall({ target = "codex", ...context }: Record<string, any> = {}): string {
  return contextualCommand("install", context, ["--target", shellQuote(target)]);
}
export function shellCommandForScan(context: Record<string, any> = {}): string {
  return contextualCommand("scan", context);
}
export function shellCommandForDiscoverLocal({ includeUrl = false, baseUrl = "" }: Record<string, any> = {}): string {
  return contextualCommand("discover-local", { includeUrl, baseUrl, tokenEnv: "" });
}
export function shellCommandForDoctor({ includeToken = false, ...context }: Record<string, any> = {}): string {
  return contextualCommand("doctor", context, includeToken ? ["--token-stdin"] : []);
}
export function shellCommandForUninstall({ target = "codex", ...context }: Record<string, any> = {}): string {
  return contextualCommand("uninstall", context, ["--target", shellQuote(target)]);
}
export function shellCommandForServerConfig({ baseUrl = "http://127.0.0.1:7228" }: Record<string, any> = {}): string {
  return npmPackageCommand(`server-config --set --url ${shellQuote(normalizeBaseUrl(baseUrl) || "http://127.0.0.1:7228")}`);
}

export function npmInstallGuidance(context: Record<string, any> = {}): Record<string, any> {
  const args = appendGuidanceContextArgs([], context).join(" ");
  return {
    installCommand: `${npmPackageCommand("install")}${args ? ` ${args}` : ""}`,
    clientInstallJsonCommand: shellCommandForInstall({ ...context, target: "codex" }),
    autoInstallCommand: shellCommandForInstall({ ...context, target: "auto" }),
    priorityInstallCommand: shellCommandForInstall({ ...context, target: priorityTargets.join(",") }),
    uninstallCommand: shellCommandForUninstall({ ...context, target: "codex" })
  };
}

export function installGuidanceMetadata(context: Record<string, any> = {}): Record<string, any> {
  return {
    priorityTargets: [...priorityTargets],
    supportedTargets: SUPPORTED_TARGETS.filter((target: string) => nativeCapability(target).supported),
    supportedTargetDetails: supportedTargetDetails().map((detail: any) => ({ ...detail, nativeRegistration: nativeCapability(detail.target) })),
    ...npmInstallGuidance(context),
    discoverCommand: shellCommandForDiscoverLocal(context),
    scanCommand: shellCommandForScan(context),
    doctorCommand: shellCommandForDoctor(context),
    clientInstallJsonCommand: shellCommandForInstall({ ...context, target: "<client>" })
  };
}

export function commandFailureGuidance({ command = "", message = "", options = {} }: Record<string, any> = {}): Record<string, any> {
  const lower = String(message).toLowerCase();
  const context = commandGuidanceContext(options);
  context.includeUrl = Boolean(context.baseUrl);
  const scan = shellCommandForScan(context);
  const install = shellCommandForInstall({ ...context, target: String(option(options, "target", "auto")) });
  const doctor = shellCommandForDoctor(context);
  const metadata = installGuidanceMetadata(context);
  if (lower.includes("unsupported install target")) return { ...metadata, errorCode: "UNSUPPORTED_TARGET", nextCommand: scan, repairCommands: [scan] };
  if (/no signed meshrix(?:lite)? mcp hub was discovered/u.test(lower)) {
    const discover = shellCommandForDiscoverLocal(context);
    return { ...metadata, errorCode: "MESHRIX_HUB_NOT_DISCOVERED", nextCommand: discover, repairCommands: [discover, shellCommandForServerConfig({ baseUrl: context.baseUrl || "http://127.0.0.1:7228" })] };
  }
  if (lower.includes("missing api key") || lower.includes("credential reference")) return {
    ...metadata, errorCode: command === "install" ? "CREDENTIAL_REFERENCE_REQUIRED" : "MISSING_API_KEY",
    nextCommand: command === "install" ? install : shellCommandForDoctor({ ...context, includeToken: true }),
    repairCommands: command === "install" ? [install] : [doctor]
  };
  if (lower.includes("interactive mode requires a tty")) {
    const uninstall = shellCommandForUninstall(context);
    return { ...metadata, errorCode: "NON_INTERACTIVE_TARGET_REQUIRED", nextCommand: uninstall, repairCommands: [scan, uninstall] };
  }
  return { ...metadata, errorCode: "COMMAND_FAILED", nextCommand: command === "install" ? install : doctor, repairCommands: [doctor, scan] };
}

export function commandOptionArgs(options: Record<string, any> = {}): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (key.startsWith("__") || key === "execution-location" || value === undefined || value === null || value === "") continue;
    args.push(`--${key}`, shellQuote(value));
  }
  return args;
}

export function candidateInstallCommand(candidate: any, settings: any): string {
  return contextualCommand("install", { ...settings, includeUrl: Boolean(settings.baseUrl) }, ["--target", shellQuote(candidate.target), ...commandOptionArgs(candidate.optionOverrides || {})]);
}
export function candidateRepairCommand(candidate: any, settings: any): string {
  return shellCommandForInstall({ ...settings, includeUrl: Boolean(settings.baseUrl), target: candidate.target });
}
export function candidateDoctorCommand(settings: any): string {
  return shellCommandForDoctor({ ...settings, includeUrl: Boolean(settings.baseUrl) });
}
export function withInstallCandidateGuidance(candidate: any, settings: any): Record<string, any> {
  const supported = candidate.nativeRegistration?.supported === true;
  return {
    ...candidate,
    installCommand: candidate.status === "detected" && supported ? candidateInstallCommand(candidate, settings) : "",
    repairCommand: candidate.status !== "detected" && supported ? candidateRepairCommand(candidate, settings) : "",
    doctorCommand: candidateDoctorCommand(settings)
  };
}

export function doctorGuidance(checks: Record<string, any> = {}, options: Record<string, any> = {}): Record<string, any> {
  const context = commandGuidanceContext(options);
  context.includeUrl = Boolean(context.baseUrl);
  if (!checks.signedDiscovery?.ok || !checks.discovery?.ok || !checks.discover?.ok) {
    const discover = shellCommandForDiscoverLocal(context);
    return { nextCommand: discover, repairCommands: [discover, shellCommandForServerConfig({ baseUrl: context.baseUrl || "http://127.0.0.1:7228" })] };
  }
  if (!(checks.deviceManifest?.installedTargets || []).length) {
    const scan = shellCommandForScan(context);
    return { nextCommand: scan, repairCommands: [scan, shellCommandForInstall({ ...context, target: "auto" })] };
  }
  if (checks.toolsList?.skipped || checks.systemHealth?.skipped || !checks.toolsList?.ok || !checks.systemHealth?.ok) {
    const doctor = shellCommandForDoctor({ ...context, includeToken: true });
    return { nextCommand: doctor, repairCommands: [doctor] };
  }
  return { nextCommand: "", repairCommands: [] };
}
