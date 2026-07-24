import os from "node:os";
import path from "node:path";

import { packageJson } from "./constants.mjs";
import { targetLabel } from "./basic-utils.mjs";
import { commandFailureGuidance } from "./guidance.mjs";
import {
  redactInstallerJsonOutput,
  redactSensitiveText,
  sensitiveOptionValues
} from "./installer-output-safety.mjs";

export function yesNo(value) {
  return value ? "yes" : "no";
}

export function formatLocalPathForDisplay(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }
  const normalized = path.normalize(text);
  const home = path.normalize(os.homedir());
  if (home && normalized === home) {
    return "~";
  }
  if (home && normalized.startsWith(`${home}${path.sep}`)) {
    const relativePath = path.relative(home, normalized)
      .split(path.sep)
      .filter(Boolean)
      .join("/");
    return relativePath ? `~/${relativePath}` : "~";
  }
  if (path.isAbsolute(normalized)) {
    return `<local-path>/${path.basename(normalized) || "path"}`;
  }
  return text;
}

export function formatTargetInstallLine(target, item = {}) {
  const failed = item.status === "failed" || item.ok === false || Boolean(item.error);
  const status = failed ? "FAIL" : "OK";
  const lines = [`  [${status}] ${targetLabel(target)} (${target})`];
  if (failed) {
    lines.push(`      Reason: ${item.error || "Install failed."}`);
    return lines;
  }
  if (item.tokenSource || item.tokenPrefix) {
    lines.push(`      Auth: ${item.tokenSource || "provided"}${item.tokenPrefix ? ` (${item.tokenPrefix})` : ""}`);
  }
  if (item.httpVerification) {
    lines.push(
      `      MCP verify: tools=${item.httpVerification.toolCount}, stableTool=${item.httpVerification.stableToolName || ""}, health=${yesNo(item.httpVerification.systemHealthOk)}`
    );
  }
  return lines;
}

export function resultHasInstallRepair(result) {
  const commands = [
    result?.nextCommand,
    ...(Array.isArray(result?.repairCommands) ? result.repairCommands : [])
  ].filter(Boolean);
  return commands.some((command) => /\blico-mcp\s+install\b/.test(String(command)));
}

export function appendInstallShortcutLines(lines, result) {
  const shortcuts = [];
  const pushShortcut = (label, command) => {
    if (!command || shortcuts.some(([, existing]) => existing === command)) {
      return;
    }
    shortcuts.push([label, command]);
  };
  pushShortcut("One-command priority install", result?.oneCommandPriorityInstall || result?.githubOneLinePriorityInstallCommand);
  pushShortcut("One-command auto install", result?.oneCommandAutoInstall || result?.githubOneLineAutoInstallCommand);
  pushShortcut("Priority install", result?.priorityInstallCommand);
  pushShortcut("Auto install", result?.autoInstallCommand);
  if (shortcuts.length === 0 || (result?.ok !== false && !resultHasInstallRepair(result))) {
    return;
  }
  lines.push("", "Install shortcuts:");
  for (const [label, command] of shortcuts) {
    lines.push(`  ${label}: ${command}`);
  }
}

export function appendRepairCommandLines(lines, result) {
  if (!Array.isArray(result?.repairCommands) || result.repairCommands.length === 0) {
    return;
  }
  lines.push("", "Repair commands:");
  for (const command of result.repairCommands) {
    lines.push(`  ${command}`);
  }
}

export function formatInstallResult(result) {
  if (result.skipped) {
    return [
      "Meshrix MCP install skipped.",
      "",
      result.reason || "No client configuration was changed.",
      "Run later: meshrix-mcp server-config --set --url <meshrix-url>"
    ].join("\n");
  }
  if (result.cancelled) {
    return [
      "Meshrix MCP install cancelled.",
      "",
      result.reason || "No client configuration was changed."
    ].join("\n");
  }
  const lines = [
    result.ok ? "Meshrix MCP install completed." : "Meshrix MCP install completed with errors.",
    ""
  ];
  if (result.error) {
    lines.push(`Reason: ${result.error}`, "");
  }
  if (result.nextCommand) {
    lines.push(`Next command: ${result.nextCommand}`);
  }
  if (!result.ok) {
    appendInstallShortcutLines(lines, result);
    appendRepairCommandLines(lines, result);
  }
  if (lines.at(-1) !== "") {
    lines.push("");
  }
  lines.push(
    "Server:",
    `  MCP URL: ${result.baseUrl ? `${result.baseUrl}/mcp` : "unknown"}`
  );
  if (result.discoveryManifest) {
    lines.push(`  Local registry: ${formatLocalPathForDisplay(result.discoveryManifest)}`);
  }
  lines.push("", "Clients:");
  const installed = result.installed || {};
  const targets = result.targets?.length ? result.targets : Object.keys(installed);
  for (const target of targets) {
    lines.push(...formatTargetInstallLine(target, installed[target] || {}));
  }
  lines.push("", "Next:");
  lines.push("  Run: meshrix-mcp doctor");
  lines.push("  Restart any selected agent app that was already running.");
  if (!result.ok) {
    lines.push("  Re-run failed clients after fixing the reason above.");
  }
  return lines.join("\n");
}

export function formatErrorResult(result) {
  const lines = [
    `Meshrix MCP ${result.command || "command"} failed.`,
    "",
    `Reason: ${result.error || "Command failed."}`
  ];
  if (result.nextCommand) {
    lines.push("", "Next:", `  ${result.nextCommand}`);
  }
  appendInstallShortcutLines(lines, result);
  appendRepairCommandLines(lines, result);
  return lines.join("\n");
}

export function formatRegisterResult(result) {
  return [
    "Meshrix MCP hub registered.",
    "",
    `MCP URL: ${result.mcpUrl || (result.baseUrl ? `${result.baseUrl}/mcp` : "unknown")}`,
    `Verified handshake: ${result.verifiedHandshake || "yes"}`,
    `Local registry: ${formatLocalPathForDisplay(result.discoveryManifest)}`,
    "",
    "Next:",
    "  meshrix-mcp install"
  ].join("\n");
}

export function formatUninstallResult(result) {
  const lines = [
    result.ok ? "Meshrix MCP uninstall completed." : "Meshrix MCP uninstall completed with errors.",
    ""
  ];
  if (result.error) {
    lines.push(`Reason: ${result.error}`, "");
  }
  for (const target of result.targets || []) {
    const item = result.uninstalled?.[target] || {};
    const failed = item.status === "failed" || item.ok === false || Boolean(item.error);
    if (failed) {
      lines.push(`  [FAIL] ${targetLabel(target)} (${target})`);
      lines.push(`      Reason: ${item.error || "Uninstall failed."}`);
      continue;
    }
    lines.push(`  [${item.removedMcp === false ? "WARN" : "OK"}] ${targetLabel(target)} (${target})`);
  }
  if (result.discoveryManifest) {
    lines.push("", `Local registry: ${formatLocalPathForDisplay(result.discoveryManifest)}`);
  }
  return lines.join("\n");
}

export function formatDoctorResult(result) {
  const checks = result.checks || {};
  const lines = [
    result.ok ? "Meshrix MCP doctor passed." : "Meshrix MCP doctor found issues.",
    "",
    `  [${checks.signedDiscovery?.ok ? "OK" : "FAIL"}] Signed discovery${checks.signedDiscovery?.baseUrl ? `: ${checks.signedDiscovery.baseUrl}` : ""}`,
    `  [${checks.discovery?.ok ? "OK" : "FAIL"}] Discovery${checks.discovery?.httpUrl ? `: ${checks.discovery.httpUrl}` : ""}`,
    `  [${checks.initialize?.ok ? "OK" : "FAIL"}] MCP initialize${checks.initialize?.serverVersion ? `: ${checks.initialize.serverVersion}` : ""}`
  ];
  if (checks.toolsList?.skipped) {
    lines.push("  [SKIP] Authenticated tools/list: token not provided");
  } else {
    lines.push(`  [${checks.toolsList?.ok ? "OK" : "FAIL"}] Authenticated tools/list`);
  }
  if (checks.systemHealth?.skipped) {
    lines.push("  [SKIP] Authenticated system.health: token not provided");
  } else {
    lines.push(`  [${checks.systemHealth?.ok ? "OK" : "FAIL"}] Authenticated system.health`);
  }
  lines.push(`  [${checks.deviceManifest?.ok ? "OK" : "WARN"}] Local registry${checks.deviceManifest?.path ? `: ${formatLocalPathForDisplay(checks.deviceManifest.path)}` : ""}`);
  if (result.nextCommand) {
    lines.push("", "Next:", `  ${result.nextCommand}`);
  }
  appendInstallShortcutLines(lines, result);
  appendRepairCommandLines(lines, result);
  return lines.join("\n");
}

export function formatServerConfigResult(result) {
  if (result.reset) {
    return [
      "Meshrix MCP server config reset.",
      "",
      `Local registry: ${formatLocalPathForDisplay(result.path)}`,
      "Next install will scan for a signed Meshrix server again."
    ].join("\n");
  }
  if (result.profiles) {
    const names = Object.keys(result.profiles);
    return [
      "Meshrix MCP server config.",
      "",
      `Active profile: ${result.activeName || "(none)"}`,
      `Profiles: ${names.length ? names.join(", ") : "(none)"}`,
      `Local registry: ${formatLocalPathForDisplay(result.path)}`
    ].join("\n");
  }
  return [
    "Meshrix MCP server config updated.",
    "",
    `Active profile: ${result.activeName || result.profile?.name || "default"}`,
    `MCP URL: ${result.profile?.mcpUrl || (result.profile?.baseUrl ? `${result.profile.baseUrl}/mcp` : "")}`,
    `Local registry: ${formatLocalPathForDisplay(result.path)}`
  ].join("\n");
}

export function formatHumanResult(command, result) {
  if (result?.ok === false && result?.commandFailed) {
    return formatErrorResult(result);
  }
  if (command === "install") {
    return formatInstallResult(result);
  }
  if (command === "register") {
    return formatRegisterResult(result);
  }
  if (command === "uninstall") {
    return formatUninstallResult(result);
  }
  if (command === "doctor") {
    return formatDoctorResult(result);
  }
  if (command === "server-config") {
    return formatServerConfigResult(result);
  }
  return JSON.stringify(result, null, 2);
}

export function emitResult(result, options, command = "") {
  if (options.json) {
    console.log(JSON.stringify(redactInstallerJsonOutput(result), null, options.pretty ? 2 : 0));
  } else {
    console.log(formatHumanResult(command, result));
  }
  if (result?.ok === false) {
    process.exitCode = 1;
  }
}

export function emitCommandError(error, options = {}, command = "") {
  const message = redactSensitiveText(error?.message || String(error), sensitiveOptionValues(options));
  const guidance = commandFailureGuidance({ command, message, options });
  emitResult({
    ok: false,
    commandFailed: true,
    command,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    error: message,
    ...guidance
  }, options, command);
}
