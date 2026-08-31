import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MCP_PRIORITY_INSTALL_TARGETS } from "../../../packages/protocols/mcp/adapter/mcp-release-targets.ts";

const execFileAsync: any = promisify(execFile);
export const projectRoot: any = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const connectorRoot: any = path.join(projectRoot, "packages/protocols/mcp/adapter/gateway-installer");
export const PRIORITY_INSTALL_TARGET: any = MCP_PRIORITY_INSTALL_TARGETS.join(",");

export function normalizeReleaseChannel(value?: any) : any {
  const channel: any = String(value ?? "").trim();
  if (
    !/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/u.test(channel)
    || /^v?\d/u.test(channel)
  ) {
    throw new Error("release_channel_dist_tag_invalid");
  }
  return channel;
}

export async function readJson(filePath?: any) : Promise<any> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function sha256(filePath?: any) : Promise<any> {
  const hash: any = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function lstatIfPresent(filePath?: any) : Promise<any> {
  try {
    return await fs.lstat(filePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isStrictChildPath(parentPath?: any, candidatePath?: any) : any {
  const relative: any = path.relative(parentPath, candidatePath);
  return Boolean(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export async function prepareMcpReleaseOutputDirectory(
  requestedOutputDir?: any,
  { repositoryRoot = projectRoot }: Record<string, any> = {}
) : Promise<any> {
  const resolvedRepositoryRoot: any = path.resolve(repositoryRoot);
  const buildRoot: any = path.join(resolvedRepositoryRoot, "build");
  const releaseRoot: any = path.join(buildRoot, "release");
  const outputDir: any = path.resolve(String(requestedOutputDir || ""));

  if (
    !isStrictChildPath(releaseRoot, outputDir)
    || path.dirname(outputDir) !== releaseRoot
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(path.basename(outputDir))
  ) {
    throw new Error("release_output_directory_out_of_scope");
  }

  for (const ancestor of [buildRoot, releaseRoot]) {
    const stat: any = await lstatIfPresent(ancestor);
    if (stat?.isSymbolicLink()) {
      throw new Error("release_output_ancestor_symlink_rejected");
    }
    if (stat && !stat.isDirectory()) {
      throw new Error("release_output_ancestor_not_directory");
    }
  }

  await fs.mkdir(releaseRoot, { recursive: true, mode: 0o755 });
  const releaseRootStat: any = await fs.lstat(releaseRoot);
  if (releaseRootStat.isSymbolicLink() || !releaseRootStat.isDirectory()) {
    throw new Error("release_output_root_invalid");
  }

  const existingOutput: any = await lstatIfPresent(outputDir);
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

export async function writeReleaseChecksumIndex(outputDir?: any, filename: any = "SHA256SUMS") : Promise<any> {
  if (filename !== "SHA256SUMS") {
    throw new Error("release_checksum_filename_invalid");
  }
  const assetNames: any[] = [];
  for (const entry of await fs.readdir(outputDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name !== filename) {
      if (/\s/u.test(entry.name)) {
        throw new Error("release_asset_filename_not_checksum_safe");
      }
      assetNames.push(entry.name);
    }
  }
  const lines: any[] = [];
  for (const assetName of assetNames.sort()) {
    lines.push(`${await sha256(path.join(outputDir, assetName))}  ${assetName}`);
  }
  if (lines.length === 0) {
    throw new Error("release_checksum_assets_missing");
  }
  const checksumFilePath: any = path.join(outputDir, filename);
  await fs.writeFile(checksumFilePath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o644 });
  return {
    checksumFilePath,
    checksumFileSha256: await sha256(checksumFilePath),
    assetCount: lines.length
  };
}

export async function writeFlattenedReleaseChecksumAuthority({ assetDirectories, outputPath }: Record<string, any>) : Promise<any> {
  if (
    !Array.isArray(assetDirectories)
    || assetDirectories.length === 0
    || path.basename(outputPath) !== "RELEASE_SHA256SUMS"
  ) {
    throw new Error("release_checksum_authority_arguments_invalid");
  }

  const assetsByName: any = new Map<any, any>();
  for (const assetDirectory of assetDirectories) {
    const directoryStat: any = await fs.lstat(assetDirectory);
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

  const lines: any[] = [];
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

export async function run(command?: any, args: any = [], options: Record<string, any> = {}) : Promise<any> {
  const resolved: any = resolveCommand(command, args);
  const result: any = await execFileAsync(resolved.command, resolved.args, {
    cwd: options.cwd || projectRoot,
    env: {
      ...process.env,
      ...(options.env || {})
    },
    maxBuffer: 10 * 1024 * 1024
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

export function resolveCommand(command?: any, args: any = []) : any {
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
