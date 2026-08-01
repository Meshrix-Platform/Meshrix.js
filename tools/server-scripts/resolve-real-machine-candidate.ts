#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  RELEASE_IMAGE_AUTHORITY_SCHEMA,
  RELEASE_IMAGE_PLATFORMS,
} from "./lib/release-image-evidence.ts";

function fail(code?: any) : any {
  const error: Error & Record<string, any> = new Error(code);
  error.code = code;
  throw error;
}

async function readBoundedFile(filePath?: any, maximumBytes?: any) : Promise<any> {
  const resolved: any = path.resolve(String(filePath || ""));
  const stat: any = await fs.lstat(resolved).catch(() : any => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes) {
    fail("real_machine_candidate_file_invalid");
  }
  return fs.readFile(resolved);
}

async function sha256BoundedFile(filePath?: any, maximumBytes?: any) : Promise<any> {
  const resolved: any = path.resolve(String(filePath || ""));
  const linkStat: any = await fs.lstat(resolved).catch(() : any => null);
  if (
    !linkStat?.isFile() ||
    linkStat.isSymbolicLink() ||
    linkStat.size <= 0 ||
    linkStat.size > maximumBytes
  ) {
    fail("real_machine_candidate_file_invalid");
  }
  const handle: any = await fs.open(resolved, "r");
  try {
    const openedStat: any = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== linkStat.dev ||
      openedStat.ino !== linkStat.ino ||
      openedStat.size !== linkStat.size
    ) {
      fail("real_machine_candidate_file_changed");
    }
    const hash: any = crypto.createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await handle.close();
  }
}

const target: any = String(process.env.MESHRIX_REAL_MACHINE_TARGET || "").trim();
const sourceRevision: any = String(process.env.MESHRIX_SOURCE_REVISION || "").trim();
const repository: any = String(process.env.MESHRIX_REPOSITORY || "").trim();
const outputPath: any = String(process.env.GITHUB_OUTPUT || "").trim();
const portable: any = target === "native-macos-arm64" || target === "native-windows-x64";
let digest: any;
let image: any = "";

if (!/^[a-f0-9]{40}$/u.test(sourceRevision) || !outputPath) {
  fail("real_machine_candidate_context_invalid");
}
if (portable) {
  digest = await sha256BoundedFile(
    process.env.MESHRIX_CANDIDATE_ARTIFACT,
    1024 ** 3,
  );
} else {
  const bytes: any = await readBoundedFile(process.env.MESHRIX_CANDIDATE_AUTHORITY, 16 * 1024 * 1024);
  let authority: any;
  try {
    authority = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("real_machine_candidate_authority_invalid");
  }
  if (
    authority?.schemaVersion !== RELEASE_IMAGE_AUTHORITY_SCHEMA ||
    authority?.repository !== repository ||
    authority?.sourceCommit !== sourceRevision ||
    authority?.workflowRef !==
      `${repository}/.github/workflows/release.yml@${authority?.sourceRef || ""}` ||
    !/^refs\/tags\/v[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(authority?.sourceRef || "") ||
    !/^ghcr\.io\/[a-z0-9_.-]+\/meshrix$/u.test(authority?.image || "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(authority?.digest || "") ||
    JSON.stringify(authority?.platforms) !== JSON.stringify(RELEASE_IMAGE_PLATFORMS) ||
    authority?.provenanceVerified !== true ||
    authority?.sbomVerified !== true
  ) {
    fail("real_machine_candidate_authority_invalid");
  }
  digest = authority.digest;
  image = `${authority.image}@${authority.digest}`;
}

await fs.appendFile(outputPath, `digest=${digest}\nimage=${image}\n`, { encoding: "utf8" });
process.stdout.write(`${JSON.stringify({ ok: true, target, digest })}\n`);
