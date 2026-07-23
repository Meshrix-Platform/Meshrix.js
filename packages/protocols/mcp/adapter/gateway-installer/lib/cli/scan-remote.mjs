import path from "node:path";

import {
  INSTALL_COMMAND_TIMEOUT_MS,
  REMOTE_SCAN_COMMAND_TIMEOUT_MS,
  SCAN_COMMAND_TIMEOUT_MS
} from "./constants.mjs";
import {
  run,
  runWithInput,
  shellQuote,
  uniqueValues
} from "./connector-process.mjs";
import { baseUrlWithHost, isLoopbackHost, vmBaseUrl } from "./http-json-client.mjs";
import { mcpProbeSupported } from "./mcp-client-probe.mjs";
import { detectHostOs, outputLines, systemPosixPath } from "./scan-local.mjs";

const REMOTE_EXECUTABLE_DIRS = Object.freeze([
  ["usr", "local", "bin"],
  ["usr", "local", "sbin"],
  ["usr", "bin"],
  ["usr", "sbin"],
  ["bin"],
  ["sbin"],
  ["opt", "bin"],
  ["opt", "homebrew", "bin"],
  ["opt", "homebrew", "sbin"],
  ["opt", "local", "bin"],
  ["opt", "local", "sbin"],
  ["opt", "sw", "bin"],
  ["var", "lib", "flatpak", "exports", "bin"],
  ["snap", "bin"]
].map((segments) => systemPosixPath(...segments)));

const REMOTE_DESKTOP_DIRS = Object.freeze([
  ["usr", "share", "applications"],
  ["usr", "local", "share", "applications"],
  ["var", "lib", "flatpak", "exports", "share", "applications"]
].map((segments) => systemPosixPath(...segments)));

function shellExpandedPaths(paths, suffix) {
  return paths.map((directory) => `"${directory}/${suffix}"`).join(" ");
}

export async function detectOrbVms(orbBin) {
  const result = await run(orbBin, ["list"], { allowFailure: true, timeoutMs: SCAN_COMMAND_TIMEOUT_MS });
  if (!result.ok) {
    return [];
  }
  const names = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^NAME\s+/i.test(trimmed)) {
      continue;
    }
    const [name] = trimmed.split(/\s+/);
    if (name && !name.startsWith("-")) {
      names.push(name);
    }
  }
  return uniqueValues(names);
}

export function linuxExecutableScanScript(command) {
  return [
    "set +e",
    "export HOMEBREW_NO_AUTO_UPDATE=\"${HOMEBREW_NO_AUTO_UPDATE:-1}\"",
    "export HOMEBREW_NO_ANALYTICS=\"${HOMEBREW_NO_ANALYTICS:-1}\"",
    "export HOMEBREW_NO_ENV_HINTS=\"${HOMEBREW_NO_ENV_HINTS:-1}\"",
    `command_name=${shellQuote(command)}`,
    "candidate_rows() {",
    "  type -a -p \"$command_name\" 2>/dev/null | while IFS= read -r item; do printf '%s\\n' \"$item\"; done",
    "  for manager in brew npm pnpm yarn bun; do",
    "    if command -v \"$manager\" >/dev/null 2>&1; then",
    "      case \"$manager\" in",
    "        brew) dir=$($manager --prefix 2>/dev/null); [ -n \"$dir\" ] && printf '%s\\n' \"$dir/bin/$command_name\" \"$dir/sbin/$command_name\" ;;",
    "        npm) dir=$($manager prefix -g 2>/dev/null); [ -n \"$dir\" ] && printf '%s\\n' \"$dir/bin/$command_name\" ;;",
    "        pnpm) dir=$($manager bin -g 2>/dev/null); [ -n \"$dir\" ] && printf '%s\\n' \"$dir/$command_name\" ;;",
    "        yarn) dir=$($manager global bin 2>/dev/null | tail -n 1); [ -n \"$dir\" ] && printf '%s\\n' \"$dir/$command_name\" ;;",
    "        bun) dir=$($manager pm bin -g 2>/dev/null | tail -n 1); [ -n \"$dir\" ] && printf '%s\\n' \"$dir/$command_name\" ;;",
    "      esac",
    "    fi",
    "  done",
    `  printf '%s\\n' ${shellExpandedPaths(REMOTE_EXECUTABLE_DIRS, "$command_name")}`,
    "  nvm_dir=${NVM_DIR:-$HOME/.nvm}",
    "  [ -d \"$nvm_dir/versions/node\" ] && find \"$nvm_dir/versions/node\" -maxdepth 3 -type f -path \"*/bin/$command_name\" 2>/dev/null",
    "  fnm_dir=${FNM_DIR:-$HOME/.local/share/fnm}",
    "  [ -d \"$fnm_dir/node-versions\" ] && find \"$fnm_dir/node-versions\" -maxdepth 4 -type f -path \"*/installation/bin/$command_name\" 2>/dev/null",
    "  [ -d \"$HOME/.nodenv/versions\" ] && find \"$HOME/.nodenv/versions\" -maxdepth 3 -type f -path \"*/bin/$command_name\" 2>/dev/null",
    "  [ -d \"$HOME/.asdf/installs/nodejs\" ] && find \"$HOME/.asdf/installs/nodejs\" -maxdepth 3 -type f -path \"*/bin/$command_name\" 2>/dev/null",
    "  [ -d \"$HOME/.local/share/mise/installs/node\" ] && find \"$HOME/.local/share/mise/installs/node\" -maxdepth 3 -type f -path \"*/bin/$command_name\" 2>/dev/null",
    "  [ -d \"$HOME/.local/share/mise/installs/nodejs\" ] && find \"$HOME/.local/share/mise/installs/nodejs\" -maxdepth 3 -type f -path \"*/bin/$command_name\" 2>/dev/null",
    "  [ -d \"$HOME/.mise/installs/node\" ] && find \"$HOME/.mise/installs/node\" -maxdepth 3 -type f -path \"*/bin/$command_name\" 2>/dev/null",
    "  [ -d \"$HOME/.mise/installs/nodejs\" ] && find \"$HOME/.mise/installs/nodejs\" -maxdepth 3 -type f -path \"*/bin/$command_name\" 2>/dev/null",
    "  printf '%s\\n' \"${VOLTA_HOME:-$HOME/.volta}/bin/$command_name\" \"$HOME/.asdf/shims/$command_name\" \"$HOME/.local/share/mise/shims/$command_name\" \"$HOME/.mise/shims/$command_name\" \"$HOME/.nodenv/shims/$command_name\"",
    "  printf '%s\\n' \"${CARGO_HOME:-$HOME/.cargo}/bin/$command_name\" \"${GOPATH:-$HOME/go}/bin/$command_name\" \"${DENO_INSTALL:-$HOME/.deno}/bin/$command_name\"",
    "  [ -n \"${GOBIN:-}\" ] && printf '%s\\n' \"$GOBIN/$command_name\"",
    "  printf '%s\\n' \"$HOME/.local/bin/$command_name\" \"$HOME/.rye/shims/$command_name\" \"$HOME/.pixi/bin/$command_name\" \"$HOME/.pkgx/bin/$command_name\" \"$HOME/miniconda3/bin/$command_name\" \"$HOME/anaconda3/bin/$command_name\" \"$HOME/.conda/bin/$command_name\"",
    "  printf '%s\\n' \"$HOME/.local/share/flatpak/exports/bin/$command_name\"",
    "  if command -v pipx >/dev/null 2>&1; then",
    "    pipx_dir=$(pipx environment --value PIPX_BIN_DIR 2>/dev/null)",
    "    [ -n \"$pipx_dir\" ] && printf '%s\\n' \"$pipx_dir/$command_name\"",
    "  fi",
    "  if command -v uv >/dev/null 2>&1; then",
    "    uv_dir=$(uv tool dir --bin 2>/dev/null)",
    "    [ -n \"$uv_dir\" ] && printf '%s\\n' \"$uv_dir/$command_name\"",
    "  fi",
    `  for desktop_root in ${REMOTE_DESKTOP_DIRS.map(shellQuote).join(" ")} "$HOME/.local/share/applications" "$HOME/.local/share/flatpak/exports/share/applications"; do`,
    "    [ -d \"$desktop_root\" ] || continue",
    "    find \"$desktop_root\" -maxdepth 2 -name '*.desktop' -type f 2>/dev/null | while IFS= read -r desktop_file; do",
    "      exec_line=$(grep -m 1 '^Exec=' \"$desktop_file\" 2>/dev/null | sed 's/^Exec=//' | sed 's/%[fFuUdDnNickvm]//g')",
    "      [ -n \"$exec_line\" ] || continue",
    "      executable=$(printf '%s\\n' \"$exec_line\" | awk '{print $1}' | sed 's/^\"//;s/\"$//')",
    "      base=$(basename \"$executable\")",
    "      case \"$base\" in *\"$command_name\"*) if printf '%s' \"$executable\" | grep -q '^/'; then printf '%s\\n' \"$executable\"; else command -v \"$executable\" 2>/dev/null; fi ;; esac",
    "    done",
    "  done",
    "}",
    "candidate_rows | while IFS= read -r candidate; do",
    "  [ -n \"$candidate\" ] || continue",
    "  [ -f \"$candidate\" ] || [ -L \"$candidate\" ] || continue",
    "  case \"$candidate\" in",
    "    */node_modules/.bin/*) project_dir=${candidate%%/node_modules/.bin/*}; [ -f \"$project_dir/package.json\" ] && continue ;;",
    "  esac",
    "  resolved=$(readlink -f \"$candidate\" 2>/dev/null || printf '%s' \"$candidate\")",
    "  printf '%s\\t%s\\n' \"$candidate\" \"$resolved\"",
    "done | awk -F '\\t' '!seen[$2]++ { print $1 }'"
  ].join("\n");
}

export async function detectOrbCommand({ orbBin, vmName, vmUser, command }) {
  const paths = await detectOrbCommandPaths({ orbBin, vmName, vmUser, command });
  return {
    ok: paths.length > 0,
    path: paths[0] || ""
  };
}

export async function detectOrbCommandPaths({ orbBin, vmName, vmUser, command }) {
  const value = String(command || "").trim();
  if (!value || !vmName || !vmUser) {
    return [];
  }
  const probe = path.isAbsolute(value) || value.includes("/")
    ? `command -v ${shellQuote(value)}`
    : linuxExecutableScanScript(value);
  const result = await run(orbBin, [
    "-m",
    vmName,
    "-u",
    vmUser,
    "bash",
    "-lc",
    probe
  ], { allowFailure: true, timeoutMs: REMOTE_SCAN_COMMAND_TIMEOUT_MS });
  if (!result.ok) {
    return [];
  }
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function detectDockerContainers(runtimeBin, kind) {
  const result = await run(runtimeBin, ["ps", "--format", "{{.ID}}\t{{.Names}}"], { allowFailure: true, timeoutMs: SCAN_COMMAND_TIMEOUT_MS });
  if (!result.ok) {
    return [];
  }
  return result.stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name] = line.split(/\t/);
      return { kind, id, name: name || id, bin: runtimeBin };
    })
    .filter((item) => item.id);
}

export function parseRunningTableRows(stdout, { skipHeaderPattern = /^NAME\s+/i } = {}) {
  return outputLines(stdout)
    .filter((line) => !skipHeaderPattern.test(line))
    .map((line) => line.trim())
    .filter(Boolean);
}

export function contextListDedup(contexts) {
  const seen = new Set();
  return contexts.filter((context) => {
    const key = `${context.kind}:${context.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function detectLimaInstances(limactlBin) {
  const formatted = await run(limactlBin, ["list", "--format", "{{.Name}}\t{{.Status}}"], {
    allowFailure: true,
    timeoutMs: SCAN_COMMAND_TIMEOUT_MS
  });
  const rows = formatted.ok
    ? outputLines(formatted.stdout)
    : [];
  const contexts = rows
    .map((line) => {
      const [name, status = ""] = line.split(/\t/);
      return { name: String(name || "").trim(), status: String(status || "").trim() };
    })
    .filter((item) => item.name && /^running$/i.test(item.status))
    .map((item) => ({ kind: "lima", id: item.name, name: item.name, bin: limactlBin }));
  if (contexts.length > 0 || formatted.ok) {
    return contexts;
  }
  const fallback = await run(limactlBin, ["list"], { allowFailure: true, timeoutMs: SCAN_COMMAND_TIMEOUT_MS });
  if (!fallback.ok) {
    return [];
  }
  return parseRunningTableRows(fallback.stdout)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[0] && parts.some((part) => /^running$/i.test(part)))
    .map((parts) => ({ kind: "lima", id: parts[0], name: parts[0], bin: limactlBin }));
}

export async function detectColimaInstances(colimaBin) {
  const json = await run(colimaBin, ["list", "--json"], { allowFailure: true, timeoutMs: SCAN_COMMAND_TIMEOUT_MS });
  if (json.ok) {
    try {
      const payload = JSON.parse(json.stdout || "[]");
      const profiles = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.profiles)
        ? payload.profiles
        : Object.values(payload?.profiles || payload || {});
      return profiles
        .map((profile) => ({
          name: String(profile?.name || profile?.profile || "default"),
          status: String(profile?.status || profile?.state || "")
        }))
        .filter((profile) => profile.name && /^running$/i.test(profile.status))
        .map((profile) => ({ kind: "colima", id: profile.name, name: profile.name, bin: colimaBin }));
    } catch {
      // Fall through to the table parser below.
    }
  }
  const table = await run(colimaBin, ["list"], { allowFailure: true, timeoutMs: SCAN_COMMAND_TIMEOUT_MS });
  if (!table.ok) {
    return [];
  }
  return parseRunningTableRows(table.stdout, { skipHeaderPattern: /^(PROFILE|NAME)\s+/i })
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[0] && parts.some((part) => /^running$/i.test(part)))
    .map((parts) => ({ kind: "colima", id: parts[0], name: parts[0], bin: colimaBin }));
}

export async function detectMultipassInstances(multipassBin) {
  const json = await run(multipassBin, ["list", "--format", "json"], { allowFailure: true, timeoutMs: SCAN_COMMAND_TIMEOUT_MS });
  if (json.ok) {
    try {
      const payload = JSON.parse(json.stdout || "{}");
      const instances = Array.isArray(payload?.list) ? payload.list : [];
      return instances
        .map((item) => ({ name: String(item?.name || ""), state: String(item?.state || "") }))
        .filter((item) => item.name && /^running$/i.test(item.state))
        .map((item) => ({ kind: "multipass", id: item.name, name: item.name, bin: multipassBin }));
    } catch {
      // Fall through to the table parser below.
    }
  }
  const table = await run(multipassBin, ["list"], { allowFailure: true, timeoutMs: SCAN_COMMAND_TIMEOUT_MS });
  if (!table.ok) {
    return [];
  }
  return parseRunningTableRows(table.stdout)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[0] && parts.some((part) => /^running$/i.test(part)))
    .map((parts) => ({ kind: "multipass", id: parts[0], name: parts[0], bin: multipassBin }));
}

export async function detectLxdLikeInstances(runtimeBin, kind) {
  const result = await run(runtimeBin, ["list", "--format", "csv", "-c", "ns"], {
    allowFailure: true,
    timeoutMs: SCAN_COMMAND_TIMEOUT_MS
  });
  if (!result.ok) {
    return [];
  }
  return outputLines(result.stdout)
    .map((line) => line.split(",").map((part) => part.trim()))
    .filter(([name, state]) => name && /^running$/i.test(state || ""))
    .map(([name]) => ({ kind, id: name, name, bin: runtimeBin }));
}

export async function detectVagrantInstances(vagrantBin) {
  const result = await run(vagrantBin, ["global-status", "--prune"], {
    allowFailure: true,
    timeoutMs: SCAN_COMMAND_TIMEOUT_MS
  });
  if (!result.ok) {
    return [];
  }
  return outputLines(result.stdout)
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{7,}\s+/i.test(line))
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[0] && parts.some((part) => /^running$/i.test(part)))
    .map((parts) => ({
      kind: "vagrant",
      id: parts[0],
      name: parts[1] || parts[0],
      bin: vagrantBin
    }));
}

export async function detectParallelsVms(prlctlBin) {
  const json = await run(prlctlBin, ["list", "-a", "--json"], {
    allowFailure: true,
    timeoutMs: SCAN_COMMAND_TIMEOUT_MS
  });
  if (json.ok) {
    try {
      const payload = JSON.parse(json.stdout || "[]");
      const vms = Array.isArray(payload) ? payload : Object.values(payload || {});
      return vms
        .map((vm) => ({
          id: String(vm?.ID || vm?.id || vm?.uuid || vm?.UUID || ""),
          name: String(vm?.Name || vm?.name || ""),
          status: String(vm?.Status || vm?.status || "")
        }))
        .filter((vm) => vm.id && /^running$/i.test(vm.status))
        .map((vm) => ({ kind: "parallels", id: vm.id, name: vm.name || vm.id, bin: prlctlBin }));
    } catch {
      // Fall through to the table parser below.
    }
  }
  const table = await run(prlctlBin, ["list", "-a", "-o", "uuid,name,status", "--no-header"], {
    allowFailure: true,
    timeoutMs: SCAN_COMMAND_TIMEOUT_MS
  });
  if (!table.ok) {
    return [];
  }
  return outputLines(table.stdout)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const status = parts[parts.length - 1] || "";
      const id = parts[0] || "";
      const name = parts.slice(1, -1).join(" ") || id;
      return { id, name, status };
    })
    .filter((vm) => vm.id && /^running$/i.test(vm.status))
    .map((vm) => ({ kind: "parallels", id: vm.id, name: vm.name, bin: prlctlBin }));
}

export async function detectWslDistros(wslBin) {
  if (detectHostOs() !== "win32") {
    return [];
  }
  const result = await run(wslBin, ["-l", "-q"], { allowFailure: true, timeoutMs: SCAN_COMMAND_TIMEOUT_MS });
  if (!result.ok) {
    return [];
  }
  return result.stdout.split(/\r?\n/)
    .map((line) => line.replace(/\0/g, "").trim())
    .filter(Boolean)
    .map((name) => ({ kind: "wsl", id: name, name, bin: wslBin }));
}

export async function remoteLinuxShell(context, script, options = {}) {
  if (["docker", "podman", "nerdctl"].includes(context.kind)) {
    return run(context.bin, ["exec", context.id, "sh", "-lc", script], { allowFailure: true, timeoutMs: options.timeoutMs });
  }
  if (context.kind === "wsl") {
    return run(context.bin, ["-d", context.id, "--", "bash", "-lc", script], { allowFailure: true, timeoutMs: options.timeoutMs });
  }
  if (context.kind === "lima") {
    return run(context.bin, ["shell", context.id, "bash", "-lc", script], { allowFailure: true, timeoutMs: options.timeoutMs });
  }
  if (context.kind === "colima") {
    return run(context.bin, ["ssh", context.id, "--", "bash", "-lc", script], { allowFailure: true, timeoutMs: options.timeoutMs });
  }
  if (["multipass", "lxc", "incus"].includes(context.kind)) {
    return run(context.bin, ["exec", context.id, "--", "bash", "-lc", script], { allowFailure: true, timeoutMs: options.timeoutMs });
  }
  if (context.kind === "vagrant") {
    return run(context.bin, ["ssh", context.id, "-c", `bash -lc ${shellQuote(script)}`], { allowFailure: true, timeoutMs: options.timeoutMs });
  }
  if (context.kind === "parallels") {
    return run(context.bin, ["exec", context.id, "bash", "-lc", script], { allowFailure: true, timeoutMs: options.timeoutMs });
  }
  return { ok: false, stdout: "", stderr: `Unsupported remote context: ${context.kind}` };
}

export async function remoteLinuxShellWithInput(context, script, input = "", env = {}, options = {}) {
  const envArgs = Object.entries(env).map(([name, value]) => `${name}=${value}`);
  const runOptions = {
    allowFailure: true,
    timeoutMs: options.timeoutMs || INSTALL_COMMAND_TIMEOUT_MS
  };
  if (["docker", "podman", "nerdctl"].includes(context.kind)) {
    const runtimeEnvArgs = Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
    return runWithInput(context.bin, ["exec", "-i", ...runtimeEnvArgs, context.id, "sh", "-lc", script], input, runOptions);
  }
  if (context.kind === "wsl") {
    return runWithInput(context.bin, ["-d", context.id, "--", "env", ...envArgs, "bash", "-lc", script], input, runOptions);
  }
  if (context.kind === "lima") {
    return runWithInput(context.bin, ["shell", context.id, "env", ...envArgs, "bash", "-lc", script], input, runOptions);
  }
  if (context.kind === "colima") {
    return runWithInput(context.bin, ["ssh", context.id, "--", "env", ...envArgs, "bash", "-lc", script], input, runOptions);
  }
  if (["multipass", "lxc", "incus"].includes(context.kind)) {
    return runWithInput(context.bin, ["exec", context.id, "--", "env", ...envArgs, "bash", "-lc", script], input, runOptions);
  }
  if (context.kind === "vagrant") {
    const command = `env ${envArgs.map(shellQuote).join(" ")} bash -lc ${shellQuote(script)}`;
    return runWithInput(context.bin, ["ssh", context.id, "-c", command], input, runOptions);
  }
  if (context.kind === "parallels") {
    return runWithInput(context.bin, ["exec", context.id, "env", ...envArgs, "bash", "-lc", script], input, runOptions);
  }
  return { ok: false, stdout: "", stderr: `Unsupported remote context: ${context.kind}` };
}

export async function runRemoteLinuxCommand(context, args = [], options = {}) {
  const timeoutMs = options.timeoutMs || INSTALL_COMMAND_TIMEOUT_MS;
  const runOptions = {
    allowFailure: options.allowFailure,
    timeoutMs
  };
  if (["docker", "podman", "nerdctl"].includes(context.kind)) {
    return run(context.bin, ["exec", context.id, ...args], runOptions);
  }
  if (context.kind === "wsl") {
    return run(context.bin, ["-d", context.id, "--", ...args], runOptions);
  }
  if (context.kind === "lima") {
    return run(context.bin, ["shell", context.id, ...args], runOptions);
  }
  if (context.kind === "colima") {
    return run(context.bin, ["ssh", context.id, "--", ...args], runOptions);
  }
  if (["multipass", "lxc", "incus"].includes(context.kind)) {
    return run(context.bin, ["exec", context.id, "--", ...args], runOptions);
  }
  if (context.kind === "vagrant") {
    return run(context.bin, ["ssh", context.id, "-c", args.map(shellQuote).join(" ")], runOptions);
  }
  if (context.kind === "parallels") {
    return run(context.bin, ["exec", context.id, ...args], runOptions);
  }
  const message = `Unsupported remote context: ${context.kind}`;
  if (options.allowFailure) {
    return { ok: false, stdout: "", stderr: message };
  }
  throw new Error(message);
}

export async function detectRemoteLinuxCommandPaths(context, command) {
  const value = String(command || "").trim();
  if (!value) {
    return [];
  }
  const probe = path.isAbsolute(value) || value.includes("/")
    ? `command -v ${shellQuote(value)}`
    : linuxExecutableScanScript(value);
  const result = await remoteLinuxShell(context, probe, { timeoutMs: REMOTE_SCAN_COMMAND_TIMEOUT_MS });
  if (!result.ok) {
    return [];
  }
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function remoteLinuxCommandSupportsMcp(context, command) {
  const result = await runRemoteLinuxCommand(context, [command, "mcp", "--help"], { allowFailure: true, timeoutMs: SCAN_COMMAND_TIMEOUT_MS });
  return mcpProbeSupported(result);
}

export async function remoteClientBaseUrl(context, baseUrl) {
  if (context.kind === "orb") {
    return vmBaseUrl(baseUrl);
  }
  const parsed = new URL(baseUrl);
  if (!isLoopbackHost(parsed.hostname)) {
    return baseUrl;
  }
  if (context.kind === "podman") {
    return baseUrlWithHost(baseUrl, "host.containers.internal");
  }
  if (context.kind === "docker" || context.kind === "nerdctl") {
    if (detectHostOs() === "linux") {
      const gateway = await run(context.bin, [
        "inspect",
        "-f",
        "{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}",
        context.id
      ], { allowFailure: true });
      const host = gateway.stdout.trim().split(/\s+/).find(Boolean);
      if (host) {
        return baseUrlWithHost(baseUrl, host);
      }
    }
    return baseUrlWithHost(baseUrl, "host.docker.internal");
  }
  if (context.kind === "lima" || context.kind === "colima") {
    return baseUrlWithHost(baseUrl, "host.lima.internal");
  }
  if (context.kind === "wsl") {
    const nameserver = await remoteLinuxShell(
      context,
      `awk '/^nameserver / { print $2; exit }' ${systemPosixPath("etc", "resolv.conf")} 2>/dev/null`,
      { timeoutMs: SCAN_COMMAND_TIMEOUT_MS }
    );
    const host = nameserver.stdout.trim().split(/\s+/).find(Boolean);
    return host ? baseUrlWithHost(baseUrl, host) : baseUrl;
  }
  if (["multipass", "lxc", "incus", "vagrant", "parallels"].includes(context.kind)) {
    const gateway = await remoteLinuxShell(context, "ip route show default 2>/dev/null | awk '{ print $3; exit }'", { timeoutMs: SCAN_COMMAND_TIMEOUT_MS });
    const host = gateway.stdout.trim().split(/\s+/).find(Boolean);
    return host ? baseUrlWithHost(baseUrl, host) : baseUrl;
  }
  return baseUrl;
}
