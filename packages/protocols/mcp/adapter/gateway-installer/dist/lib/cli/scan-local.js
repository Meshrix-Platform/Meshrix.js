import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HOST_PLATFORM, PACKAGE_SOURCE_KIND, SCAN_COMMAND_TIMEOUT_MS } from "./constants.js";
import { expandHomePath, run, shellQuote, uniqueValues } from "./connector-process.js";
export function systemPosixPath(...segments) {
    return path.posix.join(path.posix.sep, ...segments);
}
export async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
export function detectHostOs() {
    if (process.platform === HOST_PLATFORM.MACOS || process.platform === HOST_PLATFORM.LINUX || process.platform === HOST_PLATFORM.WINDOWS) {
        return process.platform;
    }
    return process.platform;
}
export function executableNamesForPlatform(command, platform = detectHostOs()) {
    const value = String(command || "").trim();
    if (!value) {
        return [];
    }
    if (platform !== "win32" || path.extname(value)) {
        return [value];
    }
    return [value, `${value}.exe`, `${value}.cmd`, `${value}.bat`, `${value}.ps1`];
}
export async function fileExists(filePath) {
    try {
        const stat = await fs.stat(filePath);
        return stat.isFile() || stat.isSymbolicLink();
    }
    catch {
        return false;
    }
}
export function nodeModulesBinProjectRoot(candidatePath, platform = detectHostOs()) {
    const normalized = String(candidatePath || "").replace(/\\/g, "/");
    const comparable = platform === "win32" ? normalized.toLowerCase() : normalized;
    const marker = "/node_modules/.bin/";
    const index = comparable.lastIndexOf(marker);
    if (index < 0) {
        return "";
    }
    return normalized.slice(0, index);
}
export async function isProjectLocalPackageExecutable(candidatePath, platform = detectHostOs()) {
    const projectDir = nodeModulesBinProjectRoot(candidatePath, platform);
    if (!projectDir) {
        return false;
    }
    return fileExists(path.join(projectDir, "package.json"));
}
export async function filterProjectLocalPackageExecutables(paths, platform = detectHostOs()) {
    const filtered = [];
    for (const item of paths) {
        if (!await isProjectLocalPackageExecutable(item, platform)) {
            filtered.push(item);
        }
    }
    return filtered;
}
export async function collectExecutablePathsFromDirs(dirs, command, platform = detectHostOs()) {
    const paths = [];
    for (const dir of uniqueValues(dirs.map((item) => expandHomePath(item)))) {
        if (!dir || !await directoryExists(dir)) {
            continue;
        }
        for (const executableName of executableNamesForPlatform(command, platform)) {
            const candidate = path.join(dir, executableName);
            if (await fileExists(candidate)) {
                paths.push(candidate);
            }
        }
    }
    return paths;
}
export async function detectPathCommandPaths(command, platform = detectHostOs()) {
    const value = String(command || "").trim();
    if (!value) {
        return [];
    }
    if (path.isAbsolute(value) || value.includes(path.sep)) {
        return await pathExists(value) ? [value] : [];
    }
    if (platform === "win32") {
        const names = executableNamesForPlatform(value, platform);
        const paths = [];
        const whereExecutable = path.join(process.env.SystemRoot || path.win32.join(process.env.SystemDrive || "C:", "Windows"), "System32", "where.exe");
        for (const executableName of names) {
            const result = await run(whereExecutable, [executableName], { allowFailure: true, timeoutMs: SCAN_COMMAND_TIMEOUT_MS });
            if (result.ok) {
                paths.push(...result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
            }
        }
        return uniqueResolvedLocalPaths(await filterProjectLocalPackageExecutables(paths, platform));
    }
    const result = await run("bash", [
        "-c",
        `type -a -p ${shellQuote(value)} 2>/dev/null | awk '!seen[$0]++'`
    ], { allowFailure: true, timeoutMs: SCAN_COMMAND_TIMEOUT_MS });
    if (!result.ok) {
        return [];
    }
    const paths = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return uniqueResolvedLocalPaths(await filterProjectLocalPackageExecutables(paths, platform));
}
export function packageSourceContext(platform = detectHostOs()) {
    const home = os.homedir();
    const userProfile = process.env.USERPROFILE || home;
    const appData = process.env.APPDATA || path.join(userProfile, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, "AppData", "Local");
    return {
        platform,
        home,
        userProfile,
        appData,
        localAppData,
        programData: process.env.ProgramData || path.win32.join(process.env.SystemDrive || "C:", "ProgramData")
    };
}
export function sourceValues(value, context) {
    const resolved = typeof value === "function" ? value(context) : value;
    if (Array.isArray(resolved)) {
        return resolved.flatMap((item) => sourceValues(item, context));
    }
    return resolved ? [resolved] : [];
}
export function outputLines(stdout) {
    return String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
export function lastOutputLine(stdout) {
    return outputLines(stdout).at(-1) || "";
}
export function packageSource(id, kind, options = {}) {
    return { id, kind, ...options };
}
export const POSIX_PACKAGE_DIR_SOURCES = [
    packageSource("homebrew-prefix", PACKAGE_SOURCE_KIND.COMMAND_DIR, {
        executable: "brew",
        args: ["--prefix"],
        mapOutput: (stdout) => {
            const prefix = lastOutputLine(stdout);
            return prefix ? [path.join(prefix, "bin"), path.join(prefix, "sbin")] : [];
        }
    }),
    packageSource("posix-standard-dirs", PACKAGE_SOURCE_KIND.STATIC_DIRS, {
        dirs: [
            systemPosixPath("opt", "homebrew", "bin"),
            systemPosixPath("opt", "homebrew", "sbin"),
            systemPosixPath("usr", "local", "bin"),
            systemPosixPath("usr", "local", "sbin"),
            systemPosixPath("opt", "local", "bin"),
            systemPosixPath("opt", "local", "sbin"),
            systemPosixPath("opt", "sw", "bin")
        ]
    }),
    packageSource("npm-prefix", PACKAGE_SOURCE_KIND.COMMAND_DIR, {
        executable: "npm",
        args: ["prefix", "-g"],
        mapOutput: (stdout) => {
            const prefix = lastOutputLine(stdout);
            return prefix ? path.join(prefix, "bin") : "";
        }
    }),
    packageSource("pnpm-bin", PACKAGE_SOURCE_KIND.COMMAND_DIR, { executable: "pnpm", args: ["bin", "-g"] }),
    packageSource("yarn-global-bin", PACKAGE_SOURCE_KIND.COMMAND_DIR, { executable: "yarn", args: ["global", "bin"] }),
    packageSource("bun-global-bin", PACKAGE_SOURCE_KIND.COMMAND_DIR, { executable: "bun", args: ["pm", "bin", "-g"] }),
    packageSource("uv-tool-bin", PACKAGE_SOURCE_KIND.COMMAND_DIR, { executable: "uv", args: ["tool", "dir", "--bin"] }),
    packageSource("pipx-bin", PACKAGE_SOURCE_KIND.COMMAND_DIR, { executable: "pipx", args: ["environment", "--value", "PIPX_BIN_DIR"] }),
    packageSource("nvm-node-versions", PACKAGE_SOURCE_KIND.VERSIONED_DIRS, {
        root: ({ home }) => path.join(process.env.NVM_DIR || path.join(home, ".nvm"), "versions", "node")
    }),
    packageSource("fnm-node-versions", PACKAGE_SOURCE_KIND.VERSIONED_DIRS, {
        root: ({ home }) => path.join(process.env.FNM_DIR || path.join(home, ".local", "share", "fnm"), "node-versions"),
        toDir: (root, version) => path.join(root, version, "installation", "bin")
    }),
    packageSource("nodenv-versions", PACKAGE_SOURCE_KIND.VERSIONED_DIRS, {
        root: ({ home }) => path.join(home, ".nodenv", "versions")
    }),
    packageSource("asdf-nodejs-versions", PACKAGE_SOURCE_KIND.VERSIONED_DIRS, {
        root: ({ home }) => path.join(home, ".asdf", "installs", "nodejs")
    }),
    packageSource("mise-node-versions", PACKAGE_SOURCE_KIND.VERSIONED_DIRS, {
        root: ({ home }) => [
            path.join(home, ".local", "share", "mise", "installs", "node"),
            path.join(home, ".local", "share", "mise", "installs", "nodejs"),
            path.join(home, ".mise", "installs", "node"),
            path.join(home, ".mise", "installs", "nodejs")
        ]
    }),
    packageSource("language-runtime-bins", PACKAGE_SOURCE_KIND.STATIC_DIRS, {
        dirs: ({ home }) => [
            path.join(process.env.VOLTA_HOME || path.join(home, ".volta"), "bin"),
            path.join(home, ".asdf", "shims"),
            path.join(home, ".local", "share", "mise", "shims"),
            path.join(home, ".mise", "shims"),
            path.join(home, ".nodenv", "shims"),
            path.join(process.env.CARGO_HOME || path.join(home, ".cargo"), "bin"),
            process.env.GOBIN || "",
            path.join(process.env.GOPATH || path.join(home, "go"), "bin"),
            path.join(process.env.DENO_INSTALL || path.join(home, ".deno"), "bin"),
            path.join(home, ".pixi", "bin"),
            path.join(home, ".pkgx", "bin"),
            path.join(home, ".rye", "shims"),
            path.join(home, "miniconda3", "bin"),
            path.join(home, "anaconda3", "bin"),
            path.join(home, ".conda", "bin"),
            path.join(home, ".local", "bin")
        ]
    })
];
export const PLATFORM_PACKAGE_DIR_SOURCES = {
    [HOST_PLATFORM.MACOS]: POSIX_PACKAGE_DIR_SOURCES,
    [HOST_PLATFORM.LINUX]: [
        ...POSIX_PACKAGE_DIR_SOURCES,
        packageSource("linux-system-dirs", PACKAGE_SOURCE_KIND.STATIC_DIRS, {
            dirs: [
                systemPosixPath("usr", "bin"),
                systemPosixPath("usr", "sbin"),
                systemPosixPath("bin"),
                systemPosixPath("sbin"),
                systemPosixPath("opt", "bin")
            ]
        }),
        packageSource("linux-desktop-package-dirs", PACKAGE_SOURCE_KIND.STATIC_DIRS, {
            dirs: ({ home }) => [
                systemPosixPath("snap", "bin"),
                systemPosixPath("var", "lib", "flatpak", "exports", "bin"),
                path.join(home, ".local", "share", "flatpak", "exports", "bin")
            ]
        })
    ],
    [HOST_PLATFORM.WINDOWS]: [
        packageSource("npm-prefix", PACKAGE_SOURCE_KIND.COMMAND_DIR, { executable: "npm.cmd", args: ["prefix", "-g"] }),
        packageSource("pnpm-bin", PACKAGE_SOURCE_KIND.COMMAND_DIR, { executable: "pnpm.cmd", args: ["bin", "-g"] }),
        packageSource("yarn-global-bin", PACKAGE_SOURCE_KIND.COMMAND_DIR, { executable: "yarn.cmd", args: ["global", "bin"] }),
        packageSource("bun-global-bin", PACKAGE_SOURCE_KIND.COMMAND_DIR, { executable: "bun.exe", args: ["pm", "bin", "-g"] }),
        packageSource("pipx-bin", PACKAGE_SOURCE_KIND.COMMAND_DIR, { executable: "pipx.exe", args: ["environment", "--value", "PIPX_BIN_DIR"] }),
        packageSource("uv-tool-bin", PACKAGE_SOURCE_KIND.COMMAND_DIR, { executable: "uv.exe", args: ["tool", "dir", "--bin"] }),
        packageSource("windows-package-manager-dirs", PACKAGE_SOURCE_KIND.STATIC_DIRS, {
            dirs: ({ appData, localAppData, programData, userProfile }) => [
                path.join(userProfile, "scoop", "shims"),
                path.join(programData, "scoop", "shims"),
                process.env.SCOOP ? path.join(process.env.SCOOP, "shims") : "",
                path.join(process.env.ChocolateyInstall || path.join(programData, "chocolatey"), "bin"),
                path.join(localAppData, "Microsoft", "WinGet", "Links"),
                path.join(appData, "npm"),
                path.join(localAppData, "pnpm")
            ]
        }),
        packageSource("windows-node-version-managers", PACKAGE_SOURCE_KIND.STATIC_DIRS, {
            dirs: ({ appData, localAppData, userProfile }) => [
                process.env.NVM_SYMLINK || "",
                process.env.NVM_HOME || "",
                path.join(process.env.VOLTA_HOME || path.join(localAppData, "Volta"), "bin"),
                path.join(appData, "fnm"),
                path.join(appData, "fnm", "aliases", "default"),
                path.join(userProfile, ".nodenv", "shims"),
                path.join(userProfile, ".asdf", "shims"),
                path.join(localAppData, "mise", "shims"),
                path.join(userProfile, ".local", "share", "mise", "shims"),
                path.join(userProfile, ".mise", "shims")
            ]
        }),
        packageSource("windows-language-runtime-bins", PACKAGE_SOURCE_KIND.STATIC_DIRS, {
            dirs: ({ appData, localAppData, programData, userProfile }) => [
                path.join(userProfile, ".cargo", "bin"),
                process.env.GOBIN || "",
                path.join(process.env.GOPATH || path.join(userProfile, "go"), "bin"),
                path.join(process.env.DENO_INSTALL || path.join(userProfile, ".deno"), "bin"),
                path.join(userProfile, ".local", "bin"),
                path.join(userProfile, ".rye", "shims"),
                path.join(userProfile, ".pixi", "bin"),
                path.join(localAppData, "Programs", "Python", "Scripts"),
                path.join(appData, "Python", "Scripts"),
                path.join(programData, "chocolatey", "bin"),
                path.win32.join(process.env.SystemDrive || "C:", "Program Files", "nodejs"),
                path.win32.join(process.env.SystemDrive || "C:", "Program Files (x86)", "Nodist", "bin")
            ]
        }),
        packageSource("fnm-node-versions", PACKAGE_SOURCE_KIND.VERSIONED_DIRS, {
            root: ({ appData }) => path.join(process.env.FNM_DIR || path.join(appData, "fnm"), "node-versions"),
            toDir: (root, version) => path.join(root, version, "installation")
        }),
        packageSource("nodenv-versions", PACKAGE_SOURCE_KIND.VERSIONED_DIRS, {
            root: ({ userProfile }) => path.join(userProfile, ".nodenv", "versions")
        }),
        packageSource("asdf-nodejs-versions", PACKAGE_SOURCE_KIND.VERSIONED_DIRS, {
            root: ({ userProfile }) => path.join(userProfile, ".asdf", "installs", "nodejs")
        }),
        packageSource("mise-node-versions", PACKAGE_SOURCE_KIND.VERSIONED_DIRS, {
            root: ({ localAppData }) => [
                path.join(localAppData, "mise", "installs", "node"),
                path.join(localAppData, "mise", "installs", "nodejs")
            ]
        })
    ]
};
export const PLATFORM_PACKAGE_EXECUTABLE_PATH_SOURCES = {
    [HOST_PLATFORM.MACOS]: [],
    [HOST_PLATFORM.LINUX]: [],
    [HOST_PLATFORM.WINDOWS]: [
        packageSource("scoop-which", PACKAGE_SOURCE_KIND.COMMAND_PATHS, {
            executables: ["scoop.cmd", "scoop"],
            argsForCommand: (command) => ["which", command]
        })
    ]
};
export async function scanStaticDirSource(source, context) {
    return sourceValues(source.dirs, context);
}
export async function scanCommandDirSource(source, context) {
    const result = await run(source.executable, sourceValues(source.args, context), {
        allowFailure: true,
        timeoutMs: source.timeoutMs || SCAN_COMMAND_TIMEOUT_MS
    });
    if (!result.ok || !result.stdout.trim()) {
        return [];
    }
    if (source.mapOutput) {
        return sourceValues(source.mapOutput(result.stdout, context), context);
    }
    return [lastOutputLine(result.stdout)].filter(Boolean);
}
export async function scanVersionedDirSource(source, context) {
    const dirs = [];
    const toDir = source.toDir || ((root, version) => path.join(root, version, "bin"));
    for (const root of sourceValues(source.root, context)) {
        if (!await directoryExists(root)) {
            continue;
        }
        const versions = await fs.readdir(root).catch(() => []);
        dirs.push(...versions.map((version) => toDir(root, version, context)));
    }
    return dirs;
}
export const PACKAGE_SOURCE_SCANNERS = {
    [PACKAGE_SOURCE_KIND.STATIC_DIRS]: scanStaticDirSource,
    [PACKAGE_SOURCE_KIND.COMMAND_DIR]: scanCommandDirSource,
    [PACKAGE_SOURCE_KIND.VERSIONED_DIRS]: scanVersionedDirSource
};
export async function scanPackageSourceDirs(source, context) {
    const scanner = PACKAGE_SOURCE_SCANNERS[source.kind];
    return scanner ? scanner(source, context) : [];
}
export async function packageManagerExecutableDirs(platform = detectHostOs()) {
    const context = packageSourceContext(platform);
    const sources = PLATFORM_PACKAGE_DIR_SOURCES[platform] || [];
    const dirs = [];
    for (const source of sources) {
        dirs.push(...await scanPackageSourceDirs(source, context));
    }
    return uniqueValues(dirs.filter(Boolean));
}
export async function scanCommandSpecificPathSource(source, command, platform) {
    if (source.kind === PACKAGE_SOURCE_KIND.COMMAND_PREFIX_DIRS) {
        const result = await run(source.executable, sourceValues(source.argsForCommand(command), packageSourceContext(platform)), {
            allowFailure: true,
            timeoutMs: source.timeoutMs || SCAN_COMMAND_TIMEOUT_MS
        });
        if (!result.ok || !result.stdout.trim()) {
            return [];
        }
        const dirs = source.mapOutput ? sourceValues(source.mapOutput(result.stdout, packageSourceContext(platform)), packageSourceContext(platform)) : [lastOutputLine(result.stdout)];
        return collectExecutablePathsFromDirs(dirs, command, platform);
    }
    if (source.kind === PACKAGE_SOURCE_KIND.COMMAND_PATHS) {
        const paths = [];
        for (const executable of sourceValues(source.executables, packageSourceContext(platform))) {
            const result = await run(executable, sourceValues(source.argsForCommand(command), packageSourceContext(platform)), {
                allowFailure: true,
                timeoutMs: source.timeoutMs || SCAN_COMMAND_TIMEOUT_MS
            });
            if (result.ok) {
                paths.push(...outputLines(result.stdout));
            }
        }
        return paths;
    }
    return [];
}
export async function packageManagerExecutablePaths(command, platform = detectHostOs()) {
    const paths = await collectExecutablePathsFromDirs(await packageManagerExecutableDirs(platform), command, platform);
    for (const source of PLATFORM_PACKAGE_EXECUTABLE_PATH_SOURCES[platform] || []) {
        paths.push(...await scanCommandSpecificPathSource(source, command, platform));
    }
    return uniqueResolvedLocalPaths(await filterProjectLocalPackageExecutables(paths, platform));
}
export function appNameLooksAgentRelated(name, command = "") {
    const lower = String(name || "").toLowerCase();
    const normalized = lower.replace(/[^a-z0-9]+/g, " ").trim();
    const commandLower = String(command || "").toLowerCase();
    if (commandLower && normalized.includes(commandLower)) {
        return true;
    }
    return false;
}
let macApplicationPathCache = null;
export async function listMacApplicationPaths() {
    if (macApplicationPathCache) {
        return macApplicationPathCache;
    }
    const roots = ["/Applications", path.join(os.homedir(), "Applications")];
    const apps = [];
    for (const root of roots) {
        if (!await directoryExists(root)) {
            continue;
        }
        const found = await run("find", [root, "-maxdepth", "3", "-name", "*.app", "-type", "d"], {
            allowFailure: true,
            timeoutMs: 5000
        });
        if (found.ok) {
            apps.push(...found.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
        }
    }
    macApplicationPathCache = uniqueValues(apps);
    return macApplicationPathCache;
}
export async function macAppExecutablePaths(command) {
    if (process.platform !== "darwin") {
        return [];
    }
    const apps = await listMacApplicationPaths();
    const paths = [];
    for (const appPath of apps) {
        const appName = path.basename(appPath, ".app");
        if (!appNameLooksAgentRelated(appName, command)) {
            continue;
        }
        // Do not probe Contents/MacOS/CFBundleExecutable: that is usually the GUI app
        // and may trigger login/keychain prompts. Only pick embedded CLI helper paths.
        paths.push(...await collectExecutablePathsFromDirs([
            path.join(appPath, "Contents", "Resources"),
            path.join(appPath, "Contents", "Resources", "bin"),
            path.join(appPath, "Contents", "Resources", "app", "bin"),
            path.join(appPath, "Contents", "Helpers")
        ], command, "darwin"));
    }
    return paths;
}
export function parseDesktopExec(value) {
    const text = String(value || "").replace(/%[fFuUdDnNickvm]/g, "").trim();
    const match = text.match(/^"([^"]+)"/) || text.match(/^'([^']+)'/) || text.match(/^(\S+)/);
    return match?.[1] || "";
}
export async function linuxDesktopExecutablePaths(command) {
    if (process.platform !== "linux") {
        return [];
    }
    const roots = [
        systemPosixPath("usr", "share", "applications"),
        systemPosixPath("usr", "local", "share", "applications"),
        path.join(os.homedir(), ".local", "share", "applications"),
        systemPosixPath("var", "lib", "flatpak", "exports", "share", "applications"),
        path.join(os.homedir(), ".local", "share", "flatpak", "exports", "share", "applications")
    ];
    const paths = [];
    for (const root of roots) {
        if (!await directoryExists(root)) {
            continue;
        }
        const found = await run("find", [root, "-maxdepth", "2", "-name", "*.desktop", "-type", "f"], { allowFailure: true, timeoutMs: 5000 });
        for (const filePath of found.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
            const content = await fs.readFile(filePath, "utf8").catch(() => "");
            const nameLine = content.split(/\r?\n/).find((line) => line.startsWith("Name="));
            const execLine = content.split(/\r?\n/).find((line) => line.startsWith("Exec="));
            const executable = parseDesktopExec(execLine?.slice("Exec=".length));
            if (!executable) {
                continue;
            }
            const basename = path.basename(executable).toLowerCase();
            const discoveryName = `${path.basename(filePath, ".desktop")} ${nameLine?.slice("Name=".length) || ""} ${basename}`;
            if (!basename.includes(String(command).toLowerCase()) && !appNameLooksAgentRelated(discoveryName, command)) {
                continue;
            }
            if (path.isAbsolute(executable)) {
                paths.push(executable);
            }
            else {
                paths.push(...await detectPathCommandPaths(executable, "linux"));
            }
        }
    }
    return paths;
}
export async function windowsAppExecutablePaths(command) {
    if (process.platform !== "win32") {
        return [];
    }
    const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        `$needle = ${JSON.stringify(String(command || "").toLowerCase())}`,
        "$paths = @()",
        "$appPathRoots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths')",
        "foreach ($root in $appPathRoots) {",
        "  Get-ChildItem $root | Where-Object { $_.PSChildName.ToLower().Contains($needle) } | ForEach-Object {",
        "    $value = (Get-Item $_.PSPath).GetValue('')",
        "    if ($value) { $paths += $value }",
        "  }",
        "}",
        "$shell = New-Object -ComObject WScript.Shell",
        "$shortcutRoots = @([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'))",
        "foreach ($root in $shortcutRoots) {",
        "  Get-ChildItem $root -Filter *.lnk -Recurse | Where-Object { $_.BaseName.ToLower().Contains($needle) } | ForEach-Object {",
        "    $target = $shell.CreateShortcut($_.FullName).TargetPath",
        "    if ($target) { $paths += $target }",
        "  }",
        "}",
        "$paths | Select-Object -Unique"
    ].join("\n");
    const result = await run("powershell.exe", ["-NoProfile", "-Command", script], { allowFailure: true, timeoutMs: 5000 });
    if (!result.ok) {
        return [];
    }
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
export async function appDesktopExecutablePaths(command, platform = detectHostOs()) {
    if (platform === "darwin") {
        return macAppExecutablePaths(command);
    }
    if (platform === "linux") {
        return linuxDesktopExecutablePaths(command);
    }
    if (platform === "win32") {
        return windowsAppExecutablePaths(command);
    }
    return [];
}
export async function detectLocalCommandPaths(command) {
    const value = String(command || "").trim();
    if (!value) {
        return [];
    }
    const platform = detectHostOs();
    const paths = [
        ...await detectPathCommandPaths(value, platform),
        ...await packageManagerExecutablePaths(value, platform),
        ...await appDesktopExecutablePaths(value, platform)
    ];
    return uniqueResolvedLocalPaths(paths);
}
export async function uniqueResolvedLocalPaths(paths) {
    const seen = new Set();
    const deduped = [];
    for (const item of paths) {
        const key = await fs.realpath(item).catch(() => item);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(item);
    }
    return deduped;
}
export async function directoryExists(dirPath) {
    try {
        const stat = await fs.stat(dirPath);
        return stat.isDirectory();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=scan-local.js.map