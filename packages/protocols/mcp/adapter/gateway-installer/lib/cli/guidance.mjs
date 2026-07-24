import {
  BOOTSTRAP_INSTALL_SCRIPT_ZH_CN,
  DEFAULT_TOKEN_ENV,
  PRIORITY_INSTALL_TARGET,
  PRIORITY_INSTALL_TARGETS,
  SUPPORTED_TARGETS,
  supportedTargetDetails
} from "./constants.mjs";
import { normalizeBaseUrl, option } from "./basic-utils.mjs";
import { explicitBaseUrl } from "./discovery.mjs";
import { githubOneLineMcpInstallCommand, shellQuote } from "./connector-process.mjs";

export function shellCommandForInstall({
  target = "codex",
  includeUrl = false,
  baseUrl = "http://127.0.0.1:7228",
  includeToken = false,
  tokenEnv = ""
} = {}) {
  const parts = ["meshrix-mcp", "install", "--target", target];
  if (includeUrl) {
    parts.push("--url", shellQuote(baseUrl));
  }
  if (tokenEnv && tokenEnv !== DEFAULT_TOKEN_ENV) {
    parts.push("--token-env", shellQuote(tokenEnv));
  }
  if (includeToken) {
    parts.push("--token-stdin");
  }
  parts.push("--json");
  return parts.join(" ");
}

export function commandGuidanceBaseUrl(options = {}) {
  return normalizeBaseUrl(option(options, "resolved-url", explicitBaseUrl(options)));
}

export function commandGuidanceContext(options = {}) {
  return {
    baseUrl: commandGuidanceBaseUrl(options),
    tokenEnv: String(option(options, "token-env", DEFAULT_TOKEN_ENV))
  };
}

export function appendGuidanceContextArgs(parts, { baseUrl = "", tokenEnv = DEFAULT_TOKEN_ENV, includeUrl = false } = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (includeUrl && normalizedBaseUrl) {
    parts.push("--url", shellQuote(normalizedBaseUrl));
  }
  if (tokenEnv && tokenEnv !== DEFAULT_TOKEN_ENV) {
    parts.push("--token-env", shellQuote(tokenEnv));
  }
  return parts;
}

export function shellCommandForScan({ includeUrl = false, baseUrl = "", tokenEnv = DEFAULT_TOKEN_ENV } = {}) {
  const parts = ["meshrix-mcp", "scan"];
  appendGuidanceContextArgs(parts, { includeUrl, baseUrl, tokenEnv });
  parts.push("--json");
  return parts.join(" ");
}

export function shellCommandForDiscoverLocal({ includeUrl = false, baseUrl = "" } = {}) {
  const parts = ["meshrix-mcp", "discover-local"];
  appendGuidanceContextArgs(parts, { includeUrl, baseUrl, tokenEnv: DEFAULT_TOKEN_ENV });
  parts.push("--json");
  return parts.join(" ");
}

export function shellCommandForDoctor({
  includeToken = false,
  includeUrl = false,
  baseUrl = "",
  tokenEnv = DEFAULT_TOKEN_ENV
} = {}) {
  const parts = ["meshrix-mcp", "doctor"];
  appendGuidanceContextArgs(parts, { includeUrl, baseUrl, tokenEnv });
  if (includeToken) {
    parts.push("--token-stdin");
  }
  parts.push("--json");
  return parts.join(" ");
}

export function shellCommandForUninstall({ target = "codex", includeUrl = false, baseUrl = "" } = {}) {
  const parts = ["meshrix-mcp", "uninstall", "--target", target];
  appendGuidanceContextArgs(parts, { includeUrl, baseUrl, tokenEnv: DEFAULT_TOKEN_ENV });
  parts.push("--json");
  return parts.join(" ");
}

export function shellCommandForServerConfig({ baseUrl = "http://127.0.0.1:7228" } = {}) {
  return `meshrix-mcp server-config --set --url ${shellQuote(normalizeBaseUrl(baseUrl) || "http://127.0.0.1:7228")}`;
}

export function githubOneLineInstallGuidance({ includeUrl = false, baseUrl = "", tokenEnv = DEFAULT_TOKEN_ENV } = {}) {
  const command = githubOneLineMcpInstallCommand();
  const commandZhCN = githubOneLineMcpInstallCommand(BOOTSTRAP_INSTALL_SCRIPT_ZH_CN);
  const contextArgs = [
    includeUrl && baseUrl ? ` --url ${shellQuote(baseUrl)}` : "",
    tokenEnv && tokenEnv !== DEFAULT_TOKEN_ENV ? ` --token-env ${shellQuote(tokenEnv)}` : ""
  ].join("");
  const build = (oneLineCommand) => ({
    installCommand: contextArgs ? `${oneLineCommand} --${contextArgs}` : oneLineCommand,
    clientInstallJsonCommand: `${oneLineCommand} -- --target <client>${contextArgs} --json`,
    autoInstallCommand: `${oneLineCommand} -- --target auto${contextArgs} --json`,
    priorityInstallCommand: `${oneLineCommand} -- --target ${PRIORITY_INSTALL_TARGET}${contextArgs} --json`
  });
  const english = build(command);
  const zhCN = build(commandZhCN);
  return {
    githubOneLineCommand: command,
    githubOneLineInstallCommand: english.installCommand,
    githubOneLineClientInstallJsonCommand: english.clientInstallJsonCommand,
    githubOneLineAutoInstallCommand: english.autoInstallCommand,
    githubOneLinePriorityInstallCommand: english.priorityInstallCommand,
    githubOneLineCommandZhCN: commandZhCN,
    githubOneLineInstallCommandZhCN: zhCN.installCommand,
    githubOneLineClientInstallJsonCommandZhCN: zhCN.clientInstallJsonCommand,
    githubOneLineAutoInstallCommandZhCN: zhCN.autoInstallCommand,
    githubOneLinePriorityInstallCommandZhCN: zhCN.priorityInstallCommand,
    oneCommandInstall: english.installCommand,
    oneCommandInstallZhCN: zhCN.installCommand,
    oneCommandClientInstallJson: english.clientInstallJsonCommand,
    oneCommandClientInstallJsonZhCN: zhCN.clientInstallJsonCommand,
    oneCommandAutoInstall: english.autoInstallCommand,
    oneCommandAutoInstallZhCN: zhCN.autoInstallCommand,
    oneCommandPriorityInstall: english.priorityInstallCommand,
    oneCommandPriorityInstallZhCN: zhCN.priorityInstallCommand
  };
}

export function installGuidanceMetadata({ includeUrl = false, baseUrl = "", tokenEnv = DEFAULT_TOKEN_ENV } = {}) {
  const oneLineGuidance = githubOneLineInstallGuidance({ includeUrl, baseUrl, tokenEnv });
  return {
    priorityTargets: [...PRIORITY_INSTALL_TARGETS],
    supportedTargets: [...SUPPORTED_TARGETS],
    supportedTargetDetails: supportedTargetDetails(),
    ...oneLineGuidance,
    discoverCommand: shellCommandForDiscoverLocal({ includeUrl, baseUrl }),
    scanCommand: shellCommandForScan({ includeUrl, baseUrl, tokenEnv }),
    doctorCommand: shellCommandForDoctor({ includeUrl, baseUrl, tokenEnv }),
    clientInstallJsonCommand: shellCommandForInstall({ target: "<client>", includeUrl, baseUrl, tokenEnv }),
    autoInstallCommand: shellCommandForInstall({ target: "auto", includeUrl, baseUrl, tokenEnv }),
    priorityInstallCommand: shellCommandForInstall({
      target: PRIORITY_INSTALL_TARGET,
      includeUrl,
      baseUrl,
      tokenEnv
    })
  };
}

export function commandFailureGuidance({ command = "", message = "", options = {} } = {}) {
  const normalized = String(message || "");
  const lower = normalized.toLowerCase();
  const { baseUrl, tokenEnv } = commandGuidanceContext(options);
  const includeUrl = Boolean(baseUrl);
  if (/unsupported install target/i.test(normalized)) {
    const scanCommand = shellCommandForScan({ includeUrl, baseUrl, tokenEnv });
    return {
      errorCode: "UNSUPPORTED_TARGET",
      nextCommand: scanCommand,
      repairCommands: [
        scanCommand,
        shellCommandForInstall({ target: "auto", includeUrl, baseUrl, tokenEnv })
      ],
      ...installGuidanceMetadata({ includeUrl, baseUrl, tokenEnv })
    };
  }
	if (/no signed meshrix(?:lite)? mcp hub was discovered/.test(lower)) {
    const discoverCommand = shellCommandForDiscoverLocal({ includeUrl, baseUrl });
    const fallbackBaseUrl = baseUrl || "http://127.0.0.1:7228";
    return {
      errorCode: "MESHRIX_HUB_NOT_DISCOVERED",
      nextCommand: discoverCommand,
      repairCommands: [
        discoverCommand,
        shellCommandForServerConfig({ baseUrl: fallbackBaseUrl }),
        shellCommandForInstall({ target: "auto", includeUrl: true, baseUrl: fallbackBaseUrl, tokenEnv })
      ],
      ...installGuidanceMetadata({ includeUrl: true, baseUrl: fallbackBaseUrl, tokenEnv })
    };
  }
  if (lower.includes("missing token")) {
    const target = String(option(options, "target", "codex")) || "codex";
    const urlArgs = baseUrl ? ` --url ${shellQuote(baseUrl)}` : "";
    const tokenEnvArgs = tokenEnv && tokenEnv !== DEFAULT_TOKEN_ENV ? ` --token-env ${shellQuote(tokenEnv)}` : "";
    return {
      errorCode: "MISSING_TOKEN",
      nextCommand: shellCommandForInstall({ target, includeToken: true, includeUrl: Boolean(baseUrl), baseUrl, tokenEnv }),
      repairCommands: [
        shellCommandForInstall({ target, includeToken: true, includeUrl: Boolean(baseUrl), baseUrl, tokenEnv }),
        `${tokenEnv}=your-token meshrix-mcp ${command || "install"} --target ${target}${urlArgs}${tokenEnvArgs} --json`
      ],
      ...installGuidanceMetadata({ includeUrl: Boolean(baseUrl), baseUrl, tokenEnv })
    };
  }
  if (lower.includes("interactive mode requires a tty")) {
    const uninstallCommand = shellCommandForUninstall({ target: "codex", includeUrl, baseUrl });
    return {
      errorCode: "NON_INTERACTIVE_TARGET_REQUIRED",
      nextCommand: uninstallCommand,
      repairCommands: [
        shellCommandForScan({ includeUrl, baseUrl, tokenEnv }),
        uninstallCommand
      ],
      ...installGuidanceMetadata({ includeUrl, baseUrl, tokenEnv })
    };
  }
  return {
    errorCode: "COMMAND_FAILED",
    nextCommand: command === "install"
      ? shellCommandForInstall({ target: "auto", includeUrl, baseUrl, tokenEnv })
      : shellCommandForDoctor({ includeUrl, baseUrl, tokenEnv }),
    repairCommands: [
      shellCommandForDoctor({ includeUrl, baseUrl, tokenEnv }),
      shellCommandForScan({ includeUrl, baseUrl, tokenEnv })
    ],
    ...installGuidanceMetadata({ includeUrl, baseUrl, tokenEnv })
  };
}

export function commandOptionArgs(options = {}) {
  const args = [];
  for (const [key, value] of Object.entries(options)) {
    if (key.startsWith("__") || key === "execution-location" || value === undefined || value === null || value === "") {
      continue;
    }
    args.push(`--${key}`, shellQuote(value));
  }
  return args;
}

export function candidateInstallCommand(candidate, settings) {
  const args = ["meshrix-mcp", "install", "--target", candidate.target];
  if (settings.baseUrl) {
    args.push("--url", shellQuote(settings.baseUrl));
  }
  args.push(...commandOptionArgs(candidate.optionOverrides || {}));
  if (settings.tokenEnv && settings.tokenEnv !== DEFAULT_TOKEN_ENV) {
    args.push("--token-env", shellQuote(settings.tokenEnv));
  }
  args.push("--json");
  return args.join(" ");
}

export function candidateRepairCommand(candidate, settings) {
  return shellCommandForInstall({
    target: candidate.target,
    includeUrl: Boolean(settings.baseUrl),
    baseUrl: settings.baseUrl || "http://127.0.0.1:7228",
    tokenEnv: settings.tokenEnv || DEFAULT_TOKEN_ENV
  });
}

export function candidateDoctorCommand(settings) {
  return shellCommandForDoctor({
    includeUrl: Boolean(settings.baseUrl),
    baseUrl: settings.baseUrl,
    tokenEnv: settings.tokenEnv || DEFAULT_TOKEN_ENV
  });
}

export function withInstallCandidateGuidance(candidate, settings) {
  return {
    ...candidate,
    installCommand: candidate.status === "detected" ? candidateInstallCommand(candidate, settings) : "",
    repairCommand: candidate.status === "detected" ? "" : candidateRepairCommand(candidate, settings),
    doctorCommand: candidateDoctorCommand(settings)
  };
}

export function doctorGuidance(checks = {}, options = {}) {
  const installedTargets = checks.deviceManifest?.installedTargets || [];
  const { baseUrl, tokenEnv } = commandGuidanceContext(options);
  const includeUrl = Boolean(baseUrl);
  const discoverCommand = shellCommandForDiscoverLocal({ includeUrl, baseUrl });
  const scanCommand = shellCommandForScan({ includeUrl, baseUrl, tokenEnv });
  const installAutoCommand = shellCommandForInstall({ target: "auto", includeUrl, baseUrl, tokenEnv });
  const doctorWithTokenCommand = shellCommandForDoctor({ includeToken: true, includeUrl, baseUrl, tokenEnv });
  if (!checks.signedDiscovery?.ok || !checks.discovery?.ok || !checks.initialize?.ok) {
    return {
      nextCommand: discoverCommand,
      repairCommands: [
        discoverCommand,
        shellCommandForServerConfig({ baseUrl: baseUrl || "http://127.0.0.1:7228" })
      ]
    };
  }
  if (installedTargets.length === 0) {
    return {
      nextCommand: scanCommand,
      repairCommands: [
        scanCommand,
        installAutoCommand
      ]
    };
  }
  if (checks.toolsList?.skipped || checks.systemHealth?.skipped) {
    return {
      nextCommand: doctorWithTokenCommand,
      repairCommands: [
        doctorWithTokenCommand
      ]
    };
  }
  if (!checks.toolsList?.ok || !checks.systemHealth?.ok) {
    return {
      nextCommand: installAutoCommand,
      repairCommands: [
        installAutoCommand,
        doctorWithTokenCommand
      ]
    };
  }
  return {
    nextCommand: "",
    repairCommands: []
  };
}
