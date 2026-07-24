import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MCP_PRIORITY_INSTALL_TARGETS } from "../../../packages/protocols/mcp/adapter/mcp-release-targets.mjs";

const execFileAsync = promisify(execFile);
export const projectRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const connectorRoot = path.join(projectRoot, "packages/protocols/mcp/adapter/gateway-installer");
export const PRIORITY_INSTALL_TARGET = MCP_PRIORITY_INSTALL_TARGETS.join(",");

export function normalizeReleaseChannel(value) {
  const channel = String(value ?? "").trim();
  if (
    !/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/u.test(channel)
    || /^v?\d/u.test(channel)
  ) {
    throw new Error("release_channel_dist_tag_invalid");
  }
  return channel;
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function lstatIfPresent(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isStrictChildPath(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return Boolean(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export async function prepareMcpReleaseOutputDirectory(
  requestedOutputDir,
  { repositoryRoot = projectRoot } = {}
) {
  const resolvedRepositoryRoot = path.resolve(repositoryRoot);
  const buildRoot = path.join(resolvedRepositoryRoot, "build");
  const releaseRoot = path.join(buildRoot, "release");
  const outputDir = path.resolve(String(requestedOutputDir || ""));

  if (
    !isStrictChildPath(releaseRoot, outputDir)
    || path.dirname(outputDir) !== releaseRoot
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(path.basename(outputDir))
  ) {
    throw new Error("release_output_directory_out_of_scope");
  }

  for (const ancestor of [buildRoot, releaseRoot]) {
    const stat = await lstatIfPresent(ancestor);
    if (stat?.isSymbolicLink()) {
      throw new Error("release_output_ancestor_symlink_rejected");
    }
    if (stat && !stat.isDirectory()) {
      throw new Error("release_output_ancestor_not_directory");
    }
  }

  await fs.mkdir(releaseRoot, { recursive: true, mode: 0o755 });
  const releaseRootStat = await fs.lstat(releaseRoot);
  if (releaseRootStat.isSymbolicLink() || !releaseRootStat.isDirectory()) {
    throw new Error("release_output_root_invalid");
  }

  const existingOutput = await lstatIfPresent(outputDir);
  if (existingOutput?.isSymbolicLink()) {
    throw new Error("release_output_symlink_rejected");
  }
  if (existingOutput && !existingOutput.isDirectory()) {
    throw new Error("release_output_not_directory");
  }
  if (existingOutput && (await fs.readdir(outputDir)).length > 0) {
    throw new Error("release_output_directory_not_empty");
  }
  if (!existingOutput) {
    await fs.mkdir(outputDir, { mode: 0o755 });
  }

  const [realReleaseRoot, realOutputDir] = await Promise.all([
    fs.realpath(releaseRoot),
    fs.realpath(outputDir)
  ]);
  if (path.dirname(realOutputDir) !== realReleaseRoot) {
    throw new Error("release_output_directory_realpath_out_of_scope");
  }
  return outputDir;
}

export async function writeReleaseChecksumIndex(outputDir, filename = "SHA256SUMS") {
  if (filename !== "SHA256SUMS") {
    throw new Error("release_checksum_filename_invalid");
  }
  const assetNames = [];
  for (const entry of await fs.readdir(outputDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name !== filename) {
      if (/\s/u.test(entry.name)) {
        throw new Error("release_asset_filename_not_checksum_safe");
      }
      assetNames.push(entry.name);
    }
  }
  const lines = [];
  for (const assetName of assetNames.sort()) {
    lines.push(`${await sha256(path.join(outputDir, assetName))}  ${assetName}`);
  }
  if (lines.length === 0) {
    throw new Error("release_checksum_assets_missing");
  }
  const checksumFilePath = path.join(outputDir, filename);
  await fs.writeFile(checksumFilePath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o644 });
  return {
    checksumFilePath,
    checksumFileSha256: await sha256(checksumFilePath),
    assetCount: lines.length
  };
}

export async function writeFlattenedReleaseChecksumAuthority({ assetDirectories, outputPath }) {
  if (
    !Array.isArray(assetDirectories)
    || assetDirectories.length === 0
    || path.basename(outputPath) !== "RELEASE_SHA256SUMS"
  ) {
    throw new Error("release_checksum_authority_arguments_invalid");
  }

  const assetsByName = new Map();
  for (const assetDirectory of assetDirectories) {
    const directoryStat = await fs.lstat(assetDirectory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error("release_asset_directory_invalid");
    }
    for (const entry of await fs.readdir(assetDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("release_asset_directory_contains_non_file_entry");
      }
      if (/\s/u.test(entry.name) || entry.name === path.basename(outputPath)) {
        throw new Error("release_asset_filename_not_checksum_safe");
      }
      if (assetsByName.has(entry.name)) {
        throw new Error("release_asset_flat_name_collision");
      }
      assetsByName.set(entry.name, path.join(assetDirectory, entry.name));
    }
  }
  if (assetsByName.size === 0) {
    throw new Error("release_checksum_assets_missing");
  }

  const lines = [];
  for (const assetName of [...assetsByName.keys()].sort()) {
    lines.push(`${await sha256(assetsByName.get(assetName))}  ${assetName}`);
  }
  await fs.writeFile(outputPath, `${lines.join("\n")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644
  });
  return {
    checksumFilePath: outputPath,
    checksumFileSha256: await sha256(outputPath),
    assetCount: lines.length,
    assetNames: [...assetsByName.keys()].sort()
  };
}

export async function run(command, args = [], options = {}) {
  const resolved = resolveCommand(command, args);
  const timeoutMs = options.timeoutMs ?? 600000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900000) {
    throw new Error("release_child_process_timeout_invalid");
  }
  const result = await execFileAsync(resolved.command, resolved.args, {
    cwd: options.cwd || projectRoot,
    env: {
      ...process.env,
      ...(options.env || {})
    },
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGTERM"
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

export function resolveCommand(command, args = []) {
  if (process.platform === "win32" && (command === "npm" || command === "npx")) {
    return {
      command: process.execPath,
      args: [
        path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", `${command}-cli.js`),
        ...args
      ]
    };
  }
  return { command, args };
}
