import { TARGET_LOCATIONS, msg } from "./constants.ts";
import { normalizeTarget, option, targetLabel } from "./basic-utils.ts";
import { writeServerConfigProfile } from "./device-config.ts";
import { discoverMeshrixHub, resolveApiKey } from "./discovery.ts";
import { canUseInstallTui, installerOptions } from "./installer-options.ts";
import { isGenericRemoteLocation } from "./scan-candidates.ts";

export function statusGlyph(status?: any) : any {
  if (status === "detected") return "ok";
  if (status === "not-detected") return "--";
  return "??";
}

export function selectionGlyph(selected?: any) : any {
  return selected ? "x" : " ";
}

export function renderInstallMenu({ candidates, index, selectedIds, baseUrl, message = "", mode = "install" }: Record<string, any>) : any {
  const action: any = mode === "uninstall" ? "uninstall" : "install";
  const title: any = mode === "uninstall" ? msg("Meshrix MCP uninstall", "Meshrix MCP 卸载") : msg("Meshrix MCP install", "Meshrix MCP 安装");
  const mcpLine: any = baseUrl ? `MCP: ${baseUrl}/mcp` : msg("MCP: no server URL required for local client removal", "MCP: 本地卸载无需服务端 URL");
  const rows: any[] = [
    "\x1b[2J\x1b[H",
    title,
    "",
    mcpLine,
    msg(`Use Up/Down or j/k, Space to toggle, a to toggle detected, Enter to ${action}, q to cancel.`, `使用上下键或 j/k 移动，空格键选择/取消，按 a 全选检测到的客户端，Enter 键确认${action === "uninstall" ? "卸载" : "安装"}，q 键取消。`),
    "",
    ...candidates.map((candidate?: any, candidateIndex?: any) : any => {
      const pointer: any = candidateIndex === index ? ">" : " ";
      const label: any = `${candidate.label}`.padEnd(28, " ");
      const installed: any = candidate.installed ? msg("[installed] ", "[已安装] ") : "";
      return `${pointer} [${selectionGlyph(selectedIds.has(candidate.id))}] ${installed}${label} ${candidate.detail || ""}`;
    }),
    "",
    message
  ];
  process.stdout.write(rows.join("\n"));
}

export function renderAutoUpdateMenu({ enabled }: Record<string, any>) : any {
  const rows: any[] = [
    "\x1b[2J\x1b[H",
    msg("Meshrix MCP Auto-Update Preference", "Meshrix MCP 自动推送更新设置"),
    "",
    msg("Do you want to enable automatic push updates?", "您是否希望启用自动推送更新？"),
    msg("If enabled, your local AI agent will automatically download and install updates when the server pushes them.", "如果启用，当服务端推送更新时，您的本地 AI 智能体将自动下载和安装更新。"),
    msg("(This is disabled by default for security).", "（出于安全考虑，此功能默认禁用）。"),
    "",
    enabled ? msg("> [x] Enable automatic push updates", "> [x] 启用自动推送更新") : msg("  [ ] Enable automatic push updates", "  [ ] 启用自动推送更新"),
    enabled ? msg("  [ ] Disable automatic push updates (Recommended)", "  [ ] 禁用自动推送更新 (推荐)") : msg("> [x] Disable automatic push updates (Recommended)", "> [x] 禁用自动推送更新 (推荐)"),
    "",
    msg("Use Up/Down to toggle, Enter to confirm.", "使用上下键切换，Enter 键确认。")
  ];
  process.stdout.write(`${rows.join("\n")}\n`);
}

function interactiveSelection({ candidates, baseUrl, mode = "install" }: Record<string, any>) : Promise<any> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Interactive ${mode} requires a TTY. Pass --target for non-interactive use.`);
  }
  let index: any = Math.max(0, candidates.findIndex((candidate?: any) : any => candidate.status === "detected"));
  const selectedIds: any = new Set<any>();
  let message: any = mode === "uninstall"
    ? msg("Space selects one or more clients. Enter removes Meshrix MCP from selected clients.", "空格键选择一个或多个客户端，Enter 键确认移除所选客户端的 Meshrix MCP 服务。")
    : msg("Space selects one or more clients. Enter installs selected clients.", "空格键选择一个或多个客户端，Enter 键确认安装。");
  return new Promise((resolve?: any, reject?: any) : any => {
    const stdin: any = process.stdin;
    const wasRaw: any = stdin.isRaw;
    const cleanup: any = () : any => {
      stdin.off("data", onData);
      if (stdin.setRawMode) stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      process.stdout.write("\x1b[?25h\n");
    };
    const onData: any = (chunk?: any) : any => {
      const key: any = chunk.toString("utf8");
      if (key === "\u0003") {
        cleanup();
        reject(new Error(`Interactive ${mode} cancelled.`));
        return;
      }
      if (key === "q" || key === "Q" || key === "\u001b") {
        cleanup();
        resolve(null);
        return;
      }
      if (key === "\r" || key === "\n") {
        const selected: any = candidates.filter((candidate?: any) : any => selectedIds.has(candidate.id));
        if (selected.length > 0) {
          cleanup();
          resolve(selected);
          return;
        }
        message = msg("No clients selected. Press Space to select at least one client.", "未选中任何客户端，请按空格键至少选择一个。");
      } else if (key === " ") {
        const candidate: any = candidates[index];
        if (selectedIds.has(candidate.id)) selectedIds.delete(candidate.id);
        else selectedIds.add(candidate.id);
        message = selectedIds.size === 1 ? msg("1 client selected.", "已选择 1 个客户端。") : msg(`${selectedIds.size} clients selected.`, `已选择 ${selectedIds.size} 个客户端。`);
      } else if (key === "a" || key === "A") {
        const detected: any = candidates.filter((candidate?: any) : any => candidate.status === "detected");
        const shouldSelect: any = detected.some((candidate?: any) : any => !selectedIds.has(candidate.id));
        for (const candidate of detected) {
          if (shouldSelect) selectedIds.add(candidate.id);
          else selectedIds.delete(candidate.id);
        }
      } else if (key === "\u001b[A" || key === "k" || key === "K") {
        index = (index - 1 + candidates.length) % candidates.length;
      } else if (key === "\u001b[B" || key === "j" || key === "J") {
        index = (index + 1) % candidates.length;
      }
      renderInstallMenu({ candidates, index, selectedIds, baseUrl, message, mode });
    };
    stdin.setEncoding("utf8");
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    process.stdout.write("\x1b[?25l");
    renderInstallMenu({ candidates, index, selectedIds, baseUrl, message, mode });
  });
}

export async function chooseAutoUpdate() : Promise<any> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  let enabled: any = false;
  return new Promise((resolve?: any, reject?: any) : any => {
    const stdin: any = process.stdin;
    const wasRaw: any = stdin.isRaw;
    const cleanup: any = () : any => {
      stdin.off("data", onData);
      if (stdin.setRawMode) stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      process.stdout.write("\x1b[?25h\n");
    };
    const onData: any = (chunk?: any) : any => {
      const key: any = chunk.toString("utf8");
      if (key === "\u0003") {
        cleanup();
        reject(new Error("Interactive install cancelled."));
      } else if (key === "\r" || key === "\n") {
        cleanup();
        resolve(enabled);
      } else if (["\u001b[A", "k", "K", "\u001b[B", "j", "J", " "].includes(key)) {
        enabled = !enabled;
        renderAutoUpdateMenu({ enabled });
      }
    };
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    process.stdout.write("\x1b[?25l");
    renderAutoUpdateMenu({ enabled });
  });
}

export async function chooseInstallCandidates(input: Record<string, any>) : Promise<any> {
  return interactiveSelection({ ...input, mode: "install" });
}

export async function chooseUninstallCandidates(input: Record<string, any>) : Promise<any> {
  return interactiveSelection({ ...input, mode: "uninstall" });
}

export async function promptLine(prompt?: any) : Promise<any> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive prompt requires a TTY.");
  return new Promise((resolve?: any, reject?: any) : any => {
    const stdin: any = process.stdin;
    const wasRaw: any = stdin.isRaw;
    let value: any = "";
    const cleanup: any = () : any => {
      stdin.off("data", onData);
      if (stdin.setRawMode) stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData: any = (chunk?: any) : any => {
      const key: any = chunk.toString("utf8");
      if (key === "\u0003") {
        cleanup();
        reject(new Error("Interactive install cancelled."));
      } else if (key === "\r" || key === "\n") {
        cleanup();
        resolve(value.trim());
      } else if (key === "\u007f") {
        value = value.slice(0, -1);
      } else if (key >= " ") {
        value += key;
        process.stdout.write(key);
      }
    };
    process.stdout.write(prompt);
    stdin.setEncoding("utf8");
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function canonicalInstallLocation(settings?: any) : any {
  const location: any = String(settings.remoteKind || settings.executionLocation || "local").trim().toLowerCase();
  if (!location || location === "local") return "local";
  if (location === "orb" || location === "orbstack") return "orbstack";
  if (isGenericRemoteLocation(location)) return "remote-linux";
  return location;
}

export function assertSupportedInstallLocation(options?: any, targets: any = []) : any {
  const location: any = canonicalInstallLocation(installerOptions(options));
  for (const target of [...new Set<any>(targets.map(normalizeTarget).filter(Boolean))]) {
    if (!(TARGET_LOCATIONS[target] || []).includes(location)) {
      throw new Error(`${targetLabel(target)} installation at ${location} is not supported by this release. Use a supported connector-managed client location.`);
    }
  }
}

export async function resolveInstallToken(options?: any) : Promise<any> {
  return { token: await resolveApiKey(options, { required: true }), source: "provided" };
}

export async function resolveHubForInstall(options?: any) : Promise<any> {
  const discovered: any = await discoverMeshrixHub(options);
  if (discovered.ok) {
    return { ...options, "resolved-url": discovered.baseUrl, __meshrixDiscovery: discovered };
  }
  if (!canUseInstallTui(options)) {
    throw new Error(`${discovered.reason} Run meshrix-mcp server-config --set --url <meshrix-url>, or rerun install in a TTY and choose manual configuration.`);
  }
  console.log("No signed Meshrix MCP service was discovered on this device.");
  console.log("The installer will not write any agent client config until a server identity signature is verified.\n");
  const answer: any = await promptLine("Choose: [c]onfigure server URL now, [s]kip, manually configure later [s]: ");
  if (!answer || answer.toLowerCase().startsWith("s")) {
    return { ...options, __meshrixSkippedDiscovery: { ok: false, skipped: true, attempts: discovered.attempts, reason: "Skipped. Manually configure later with meshrix-mcp server-config --set --url <meshrix-url>." } };
  }
  if (!answer.toLowerCase().startsWith("c")) return resolveHubForInstall(options);
  const url: any = await promptLine("Meshrix server URL: ");
  const manual: any = await discoverMeshrixHub({ ...options, url });
  if (!manual.ok) throw new Error(`Failed to verify ${url}: ${manual.reason}`);
  await writeServerConfigProfile({
    options: { ...options, url },
    name: String(option(options, "name", "manual")).trim() || "manual",
    discovered: manual,
    publishEnv: !options["no-env"]
  });
  return { ...options, "resolved-url": manual.baseUrl, __meshrixDiscovery: manual };
}

export function remoteContextFromSettings(settings?: any) : any {
  const kind: any = settings.remoteKind || settings.executionLocation;
  if (!isGenericRemoteLocation(kind)) return null;
  const remoteBins: Record<string, any> = {
    docker: settings.dockerBin,
    podman: settings.podmanBin,
    nerdctl: settings.nerdctlBin,
    wsl: settings.wslBin,
    lima: settings.limaBin,
    colima: settings.colimaBin,
    multipass: settings.multipassBin,
    lxc: settings.lxcBin,
    incus: settings.incusBin,
    vagrant: settings.vagrantBin,
    parallels: settings.parallelsBin
  };
  const bin: any = settings.remoteBin || remoteBins[kind] || "";
  if (!settings.remoteId || !bin) throw new Error(`${kind} install requires a discovered remote context.`);
  return { kind, id: settings.remoteId, name: settings.remoteName || settings.remoteId, bin };
}
