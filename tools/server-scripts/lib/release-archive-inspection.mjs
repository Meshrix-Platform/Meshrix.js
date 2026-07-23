import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const MAX_COMMAND_BUFFER = 16 * 1024 * 1024;
const MAX_EXTRACTED_ENTRY_BYTES = 192 * 1024 * 1024;
const ARCHIVE_COMMAND_TIMEOUT_MS = 120_000;

export async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of fsSync.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export function sorted(values) {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function assertExactSet(actual, expected, errorCode) {
  assert.deepEqual(sorted(actual), sorted(expected), errorCode);
}

export async function listFilesRecursively(root, relativeRoot = "") {
  const files = [];
  const start = path.join(root, relativeRoot);
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
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

export async function runArchiveCommand(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    timeout: options.timeout || 120_000,
    maxBuffer: options.maxBuffer || MAX_COMMAND_BUFFER,
    env: options.env || process.env,
    windowsHide: true
  });
}

export async function hashCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const hash = createHash("sha256");
    let stderr = "";
    let streamedBytes = 0;
    let failure = null;
    let settled = false;
    const timeout = setTimeout(() => {
      failure ||= new Error("mcp_release_archive_read_timeout");
      child.kill("SIGKILL");
    }, ARCHIVE_COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      streamedBytes += chunk.length;
      if (streamedBytes > MAX_EXTRACTED_ENTRY_BYTES) {
        failure ||= new Error("mcp_release_archive_entry_size_limit_exceeded");
        child.kill("SIGKILL");
        return;
      }
      if (!failure) hash.update(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 1024 * 1024) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      failure ||= error;
    });
    child.once("close", (code, signal) => {
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

export function validateArchiveNames(names, rootName, label) {
  assert.ok(names.length > 0, `${label}_empty`);
  assert.equal(new Set(names).size, names.length, `${label}_duplicate_path`);
  const normalizedNames = new Set();
  const foldedNames = new Set();
  for (const name of names) {
    assert.equal(name.includes("\0"), false, `${label}_nul_path`);
    assert.equal(/[\\\u0000-\u001f\u007f]/u.test(name), false, `${label}_unsafe_path_character`);
    assert.equal(name.startsWith("/"), false, `${label}_absolute_path`);
    const normalized = name.endsWith("/") ? name.slice(0, -1) : name;
    assert.ok(normalized, `${label}_empty_normalized_path`);
    assert.equal(normalizedNames.has(normalized), false, `${label}_normalized_path_collision`);
    normalizedNames.add(normalized);
    const folded = normalized.normalize("NFC").toLocaleLowerCase("en-US");
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

export async function tarInventory(archivePath, rootName) {
  const [{ stdout: namesText }, { stdout: verboseText }] = await Promise.all([
    runArchiveCommand("tar", ["-tzf", archivePath]),
    runArchiveCommand("tar", ["-tvzf", archivePath])
  ]);
  const names = namesText.split(/\r?\n/u).filter(Boolean);
  validateArchiveNames(names, rootName, "mcp_release_tar");
  const verboseLines = verboseText.split(/\r?\n/u).filter(Boolean);
  assert.equal(verboseLines.length, names.length, "mcp_release_tar_inventory_mismatch");
  assert.equal(
    verboseLines.every((line) => line.startsWith("-") || line.startsWith("d")),
    true,
    "mcp_release_tar_link_or_special_entry"
  );
  return {
    files: names.filter((_name, index) => verboseLines[index].startsWith("-")),
    directories: names
      .filter((_name, index) => verboseLines[index].startsWith("d"))
      .map((name) => name.endsWith("/") ? name.slice(0, -1) : name),
    modes: new Map(names.map((name, index) => [
      name.endsWith("/") ? name.slice(0, -1) : name,
      verboseLines[index].slice(0, 10)
    ]))
  };
}

export async function zipInventory(archivePath, rootName) {
  const [{ stdout: namesText }, { stdout: verboseText }] = await Promise.all([
    runArchiveCommand("unzip", ["-Z1", archivePath]),
    runArchiveCommand("zipinfo", ["-l", archivePath])
  ]);
  const names = namesText.split(/\r?\n/u).filter(Boolean);
  validateArchiveNames(names, rootName, "mcp_release_zip");
  const typedEntries = verboseText
    .split(/\r?\n/u)
    .filter((line) => /^(?:-|d|l)[rwx-]{9}\s/u.test(line));
  assert.equal(typedEntries.length, names.length, "mcp_release_zip_inventory_mismatch");
  assert.equal(
    typedEntries.every((line) => line.startsWith("-") || line.startsWith("d")),
    true,
    "mcp_release_zip_link_or_special_entry"
  );
  return {
    files: names.filter((_name, index) => typedEntries[index].startsWith("-")),
    directories: names
      .filter((_name, index) => typedEntries[index].startsWith("d"))
      .map((name) => name.endsWith("/") ? name.slice(0, -1) : name),
    modes: new Map(names.map((name, index) => [
      name.endsWith("/") ? name.slice(0, -1) : name,
      typedEntries[index].slice(0, 10)
    ]))
  };
}

export async function readTarEntry(archivePath, entryName) {
  const { stdout } = await runArchiveCommand("tar", ["-xOzf", archivePath, entryName], {
    encoding: null,
    maxBuffer: MAX_COMMAND_BUFFER
  });
  return Buffer.from(stdout);
}
