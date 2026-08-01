import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync: any = promisify(execFile);
const repoRoot: any = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const MAX_COMMAND_BUFFER: any = 16 * 1024 * 1024;
const MAX_EXTRACTED_ENTRY_BYTES: any = 192 * 1024 * 1024;
const ARCHIVE_COMMAND_TIMEOUT_MS: any = 120_000;

export async function sha256(filePath?: any) : Promise<any> {
  const hash: any = createHash("sha256");
  for await (const chunk of fsSync.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export function sorted(values?: any) : any {
  return [...values].sort((left?: any, right?: any) : any => left < right ? -1 : left > right ? 1 : 0);
}

export function assertExactSet(actual?: any, expected?: any, errorCode?: any) : any {
  assert.deepEqual(sorted(actual), sorted(expected), errorCode);
}

export async function listFilesRecursively(root?: any, relativeRoot: any = "") : Promise<any> {
  const files: any[] = [];
  const start: any = path.join(root, relativeRoot);
  async function visit(directory?: any) : Promise<any> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute: any = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("mcp_release_source_symlink_rejected");
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(path.relative(root, absolute).split(path.sep).join("/"));
      } else {
        throw new Error("mcp_release_source_special_file_rejected");
      }
    }
  }
  await visit(start);
  return files;
}

export async function runArchiveCommand(command?: any, args?: any, options: Record<string, any> = {}) : Promise<any> {
  return execFileAsync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    timeout: options.timeout || 120_000,
    maxBuffer: options.maxBuffer || MAX_COMMAND_BUFFER,
    env: options.env || process.env,
    windowsHide: true
  });
}

export async function hashCommand(command?: any, args?: any) : Promise<any> {
  return new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const hash: any = createHash("sha256");
    let stderr: any = "";
    let streamedBytes: any = 0;
    let failure: any = null;
    let settled: any = false;
    const timeout: any = setTimeout(() : any => {
      failure ||= new Error("mcp_release_archive_read_timeout");
      child.kill("SIGKILL");
    }, ARCHIVE_COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk?: any) : any => {
      streamedBytes += chunk.length;
      if (streamedBytes > MAX_EXTRACTED_ENTRY_BYTES) {
        failure ||= new Error("mcp_release_archive_entry_size_limit_exceeded");
        child.kill("SIGKILL");
        return;
      }
      if (!failure) hash.update(chunk);
    });
    child.stderr.on("data", (chunk?: any) : any => {
      if (stderr.length < 1024 * 1024) stderr += chunk.toString("utf8");
    });
    child.once("error", (error?: any) : any => {
      failure ||= error;
    });
    child.once("close", (code?: any, signal?: any) : any => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(new Error(`mcp_release_archive_read_failed:${code ?? signal}:${stderr.trim()}`));
        return;
      }
      resolve(hash.digest("hex"));
    });
  });
}

export function validateArchiveNames(names?: any, rootName?: any, label?: any) : any {
  assert.ok(names.length > 0, `${label}_empty`);
  assert.equal(new Set<any>(names).size, names.length, `${label}_duplicate_path`);
  const normalizedNames: any = new Set<any>();
  const foldedNames: any = new Set<any>();
  for (const name of names) {
    assert.equal(name.includes("\0"), false, `${label}_nul_path`);
    assert.equal(/[\\\u0000-\u001f\u007f]/u.test(name), false, `${label}_unsafe_path_character`);
    assert.equal(name.startsWith("/"), false, `${label}_absolute_path`);
    const normalized: any = name.endsWith("/") ? name.slice(0, -1) : name;
    assert.ok(normalized, `${label}_empty_normalized_path`);
    assert.equal(normalizedNames.has(normalized), false, `${label}_normalized_path_collision`);
    normalizedNames.add(normalized);
    const folded: any = normalized.normalize("NFC").toLocaleLowerCase("en-US");
    assert.equal(foldedNames.has(folded), false, `${label}_casefold_path_collision`);
    foldedNames.add(folded);
    assert.equal(
      normalized === rootName || normalized.startsWith(`${rootName}/`),
      true,
      `${label}_root_escape`
    );
    assert.equal(normalized.split("/").includes(".."), false, `${label}_parent_path`);
  }
}

export async function tarInventory(archivePath?: any, rootName?: any) : Promise<any> {
  const [{ stdout: namesText }, { stdout: verboseText }] = await Promise.all([
    runArchiveCommand("tar", ["-tzf", archivePath]),
    runArchiveCommand("tar", ["-tvzf", archivePath])
  ]);
  const names: any = namesText.split(/\r?\n/u).filter(Boolean);
  validateArchiveNames(names, rootName, "mcp_release_tar");
  const verboseLines: any = verboseText.split(/\r?\n/u).filter(Boolean);
  assert.equal(verboseLines.length, names.length, "mcp_release_tar_inventory_mismatch");
  assert.equal(
    verboseLines.every((line?: any) : any => line.startsWith("-") || line.startsWith("d")),
    true,
    "mcp_release_tar_link_or_special_entry"
  );
  return {
    files: names.filter((_name?: any, index?: any) : any => verboseLines[index].startsWith("-")),
    directories: names
      .filter((_name?: any, index?: any) : any => verboseLines[index].startsWith("d"))
      .map((name?: any) : any => name.endsWith("/") ? name.slice(0, -1) : name),
    modes: new Map<any, any>(names.map((name?: any, index?: any) : any => [
      name.endsWith("/") ? name.slice(0, -1) : name,
      verboseLines[index].slice(0, 10)
    ]))
  };
}

export async function zipInventory(archivePath?: any, rootName?: any) : Promise<any> {
  const [{ stdout: namesText }, { stdout: verboseText }] = await Promise.all([
    runArchiveCommand("unzip", ["-Z1", archivePath]),
    runArchiveCommand("zipinfo", ["-l", archivePath])
  ]);
  const names: any = namesText.split(/\r?\n/u).filter(Boolean);
  validateArchiveNames(names, rootName, "mcp_release_zip");
  const typedEntries: any = verboseText
    .split(/\r?\n/u)
    .filter((line?: any) : any => /^(?:-|d|l)[rwx-]{9}\s/u.test(line));
  assert.equal(typedEntries.length, names.length, "mcp_release_zip_inventory_mismatch");
  assert.equal(
    typedEntries.every((line?: any) : any => line.startsWith("-") || line.startsWith("d")),
    true,
    "mcp_release_zip_link_or_special_entry"
  );
  return {
    files: names.filter((_name?: any, index?: any) : any => typedEntries[index].startsWith("-")),
    directories: names
      .filter((_name?: any, index?: any) : any => typedEntries[index].startsWith("d"))
      .map((name?: any) : any => name.endsWith("/") ? name.slice(0, -1) : name),
    modes: new Map<any, any>(names.map((name?: any, index?: any) : any => [
      name.endsWith("/") ? name.slice(0, -1) : name,
      typedEntries[index].slice(0, 10)
    ]))
  };
}

export async function readTarEntry(archivePath?: any, entryName?: any) : Promise<any> {
  const { stdout } = await runArchiveCommand("tar", ["-xOzf", archivePath, entryName], {
    encoding: null,
    maxBuffer: MAX_COMMAND_BUFFER
  });
  return Buffer.from(stdout);
}
