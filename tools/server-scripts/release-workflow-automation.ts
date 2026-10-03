#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { npmCliArgs, resolveNpmCliInvocation } from "./lib/npm-cli-invocation.ts";
import { loadReleaseDefinition } from "./lib/release-metadata.ts";
import {
  decideReleaseBranchDispatch,
  selectExactPromotionArtifact,
  selectSuccessfulPromotionRun,
  validateOriginatingReleaseRun,
  validateReleaseDispatchContext,
  type PromotionRunSelection,
} from "./lib/release-deployment/authority.ts";
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_API_JSON_BYTES = 8 * 1024 * 1024;
const MAX_AUTHORITY_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_AUTHORITY_FILE_BYTES = 4 * 1024 * 1024;
const STABLE_AUTHORITY_FILES = Object.freeze([
  "SOURCE_CANDIDATE.json",
  "accepted-candidate.json",
  "npm-package-installability.json",
  "stable-authority-manifest.json",
]);
const RELEASE_AUTHORITY_FILES = Object.freeze([
  ...STABLE_AUTHORITY_FILES.filter((file) => file !== "stable-authority-manifest.json"),
  "stable-authority-manifest.json",
  "release-authority-manifest.json",
]);

type WorkflowRunSelection = PromotionRunSelection;

async function verifyReleaseDefinition(options: Record<string, unknown> = {}): Promise<any> {
  const verifier = await import("./verify-release-definition.ts");
  return verifier.verifyReleaseDefinition(options);
}

async function runAuthorityCommand(args: string[]): Promise<any> {
  const authority = await import("./resolve-branch-promotion-authority.ts");
  return authority.runAuthorityCommand(args);
}

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function requireText(value: unknown, pattern: RegExp, code: string): string {
  const result = String(value ?? "");
  if (!pattern.test(result)) fail(code);
  return result;
}

function repositoryName(value = process.env.GITHUB_REPOSITORY || ""): string {
  return requireText(value, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, "release_workflow_repository_invalid");
}

function apiRoot(value = process.env.GITHUB_API_URL || "https://api.github.com"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("release_workflow_api_url_invalid");
  }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail("release_workflow_api_url_invalid");
  }
  return url;
}

function githubHeaders(token = process.env.GH_TOKEN || ""): Headers {
  const credential = requireText(token, /^\S{1,8192}$/u, "release_workflow_token_missing");
  return new Headers({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${credential}`,
    "x-github-api-version": "2022-11-28",
  });
}

async function responseBytes(response: Response, maximum: number, code: string): Promise<Uint8Array> {
  if (!response.body) fail(code);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        fail(code);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function githubJson<T>(
  url: URL,
  { token, fetchImplementation = fetch }: { token?: string; fetchImplementation?: typeof fetch } = {},
): Promise<T> {
  if (url.origin !== apiRoot().origin) fail("release_workflow_api_origin_invalid");
  const response = await fetchImplementation(url, {
    headers: githubHeaders(token),
    redirect: "error",
  });
  if (!response.ok) fail(`release_workflow_github_api_${response.status}`);
  const bytes = await responseBytes(response, MAX_API_JSON_BYTES, "release_workflow_github_response_too_large");
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
  } catch {
    fail("release_workflow_github_json_invalid");
  }
}

function nextPage(link: string | null, base: URL): URL | null {
  if (!link) return null;
  for (const item of link.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/u.exec(item);
    if (!match) continue;
    let url: URL;
    try {
      url = new URL(match[1], base);
    } catch {
      fail("release_workflow_pagination_invalid");
    }
    if (url.origin !== base.origin || url.username || url.password) {
      fail("release_workflow_pagination_invalid");
    }
    return url;
  }
  return null;
}

async function githubPages<T>(
  url: URL,
  { token, fetchImplementation = fetch }: { token?: string; fetchImplementation?: typeof fetch } = {},
): Promise<T[]> {
  const records: T[] = [];
  let current: URL | null = url;
  while (current) {
    if (current.origin !== apiRoot().origin) fail("release_workflow_api_origin_invalid");
    const response = await fetchImplementation(current, {
      headers: githubHeaders(token),
      redirect: "error",
    });
    if (!response.ok) fail(`release_workflow_github_api_${response.status}`);
    const bytes = await responseBytes(response, MAX_API_JSON_BYTES, "release_workflow_github_response_too_large");
    let page: any;
    try {
      page = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      fail("release_workflow_github_json_invalid");
    }
    const items = Array.isArray(page) ? page : page?.workflow_runs || page?.artifacts;
    if (!Array.isArray(items)) fail("release_workflow_github_page_invalid");
    records.push(...items as T[]);
    current = nextPage(response.headers.get("link"), current);
  }
  return records;
}

function repositoryApiPath(repository: string): string {
  return `/repos/${repository}`;
}

export function selectStableAuthorityRun(
  workflowRuns: unknown,
  headSha: string,
): WorkflowRunSelection {
  return selectSuccessfulPromotionRun({ workflow_runs: workflowRuns }, {
    workflowPath: ".github/workflows/ci.yml",
    branch: "stable",
    headSha,
  });
}

export function extractAuthorityArchive(
  archive: Uint8Array,
  { files = STABLE_AUTHORITY_FILES, expectedDigest = "" }: { files?: readonly string[]; expectedDigest?: string } = {},
): ReadonlyMap<string, Uint8Array> {
  if (!(archive instanceof Uint8Array) || archive.byteLength === 0 || archive.byteLength > MAX_AUTHORITY_ARCHIVE_BYTES) {
    fail("release_workflow_authority_archive_invalid");
  }
  if (expectedDigest) {
    const expected = requireText(expectedDigest, /^sha256:[a-f0-9]{64}$/u, "release_workflow_artifact_digest_invalid");
    const actual = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
    if (actual !== expected) fail("release_workflow_artifact_digest_mismatch");
  }
  const allowed = new Set(files);
  const entries = new Map<string, Uint8Array>();
  let totalUncompressed = 0;
  let decoded: Record<string, Uint8Array>;
  try {
    const { unzipSync } = require("fflate") as typeof import("fflate");
    decoded = unzipSync(archive, {
      filter(file) {
        const name = file.name;
        if (name.endsWith("/")) return false;
        if (!name || name.includes("\\") || name.startsWith("/") || name.split("/").some((part) => part === ".." || part === "." || !part)) {
          fail("release_workflow_authority_archive_path_invalid");
        }
        if (!allowed.has(name) || file.originalSize > MAX_AUTHORITY_FILE_BYTES) {
          fail("release_workflow_authority_archive_contents_invalid");
        }
        totalUncompressed += file.originalSize;
        if (totalUncompressed > files.length * MAX_AUTHORITY_FILE_BYTES) {
          fail("release_workflow_authority_archive_contents_invalid");
        }
        return true;
      },
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    fail("release_workflow_authority_archive_invalid");
  }
  for (const [name, bytes] of Object.entries(decoded)) entries.set(name, bytes);
  const actual = [...entries.keys()].sort();
  const expected = [...files].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("release_workflow_authority_archive_contents_invalid");
  }
  return entries;
}

export async function waitForOriginatingRun({
  repository,
  runId,
  runAttempt,
  sourceRevision,
  event,
  token,
  fetchImplementation = fetch,
  wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}: {
  repository: string;
  runId: string;
  runAttempt: number | string;
  sourceRevision: string;
  event: "push" | "workflow_dispatch";
  token: string;
  fetchImplementation?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<WorkflowRunSelection> {
  const repo = repositoryName(repository);
  const runUrl = new URL(
    `${repositoryApiPath(repo)}/actions/runs/${encodeURIComponent(runId)}`,
    apiRoot(),
  );
  while (true) {
    const run = await githubJson<any>(runUrl, { token, fetchImplementation });
    const result = validateOriginatingReleaseRun(run, {
      repository: repo,
      runId,
      runAttempt,
      sourceRevision,
      event,
    });
    if (!result.pending) return result.selection;
    await wait(5_000);
  }
}

async function writeAuthorityFiles(
  archive: Uint8Array,
  outputDirectory: string,
  { files, expectedDigest = "" }: { files: readonly string[]; expectedDigest?: string },
): Promise<void> {
  const entries = extractAuthorityArchive(archive, { files, expectedDigest });
  await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of entries) {
    const destination = path.join(outputDirectory, name);
    await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
}

async function apiGetPages<T>(pathName: string, token: string): Promise<T[]> {
  const url = new URL(`${repositoryApiPath(repositoryName())}${pathName}`, apiRoot());
  url.searchParams.set("per_page", "100");
  return githubPages<T>(url, { token });
}

async function downloadAuthorityArtifact(
  { runId, artifactName, outputDirectory, files, token }: {
    runId: string;
    artifactName: string;
    outputDirectory: string;
    files: readonly string[];
    token: string;
  },
): Promise<void> {
  const artifactList = await apiGetPages<any>(`/actions/runs/${encodeURIComponent(runId)}/artifacts`, token);
  const selected = selectExactPromotionArtifact({ artifacts: artifactList }, { artifactName });
  const artifact = artifactList.find((item) => String(item?.id) === selected.artifactId);
  const artifactUrl = new URL(
    `${repositoryApiPath(repositoryName())}/actions/artifacts/${selected.artifactId}/zip`,
    apiRoot(),
  );
  const response = await fetch(artifactUrl, {
    headers: new Headers({
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    }),
    redirect: "follow",
  });
  if (!response.ok) fail(`release_workflow_artifact_download_${response.status}`);
  const archive = await responseBytes(response, MAX_AUTHORITY_ARCHIVE_BYTES, "release_workflow_authority_archive_invalid");
  await writeAuthorityFiles(archive, outputDirectory, {
    files,
    expectedDigest: typeof artifact?.digest === "string" ? artifact.digest : "",
  });
}

async function selectStableSourceRun(sha: string, token: string): Promise<WorkflowRunSelection> {
  const url = new URL(`${repositoryApiPath(repositoryName())}/actions/workflows/ci.yml/runs`, apiRoot());
  url.searchParams.set("event", "push");
  url.searchParams.set("branch", "stable");
  url.searchParams.set("head_sha", sha);
  url.searchParams.set("per_page", "100");
  return selectStableAuthorityRun(await githubPages<any>(url, { token }), sha);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const absolute = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, absolute);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function gitRevision(revision: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      windowsHide: true,
    });
    return String(result.stdout).trim();
  } catch {
    fail("release_workflow_git_revision_invalid");
  }
}

async function appendOutputs(values: Record<string, string | boolean>): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const lines = Object.entries(values).map(([key, value]) => {
    const text = String(value);
    if (!/^[a-z_]+$/u.test(key) || /[\r\n]/u.test(text)) fail("release_workflow_output_invalid");
    return `${key}=${text}`;
  });
  await fs.appendFile(outputPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

async function writeReleaseDefinitionOutputs(): Promise<void> {
  const definition = await loadReleaseDefinition(repoRoot);
  await appendOutputs({
    npm_cli_version: definition.github.npmCliVersion,
    node_version: definition.github.nodeVersion,
    release_tag: definition.release.tag,
    release_version: definition.release.version,
  });
}

async function pinNpmCli(): Promise<void> {
  const definition = await loadReleaseDefinition(repoRoot);
  const invocation = resolveNpmCliInvocation();
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-release-npm-cli-"));
  const userConfigPath = path.join(temporaryRoot, "user.npmrc");
  const globalConfigPath = path.join(temporaryRoot, "global.npmrc");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_/iu.test(key) || /^(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_CONFIG_USERCONFIG|NPM_CONFIG_GLOBALCONFIG)$/iu.test(key)) {
      delete env[key];
    }
  }
  Object.assign(env, {
    npm_config_userconfig: userConfigPath,
    npm_config_globalconfig: globalConfigPath,
  });
  await fs.writeFile(userConfigPath, "", { mode: 0o600, flag: "wx" });
  await fs.writeFile(globalConfigPath, "", { mode: 0o600, flag: "wx" });
  try {
    const installArgs = npmCliArgs(invocation, [
      "install", "--global", "--no-audit", "--no-fund", "--ignore-scripts",
      "--registry=https://registry.npmjs.org/", `npm@${definition.github.npmCliVersion}`,
    ]);
    await execFileAsync(invocation.command, installArgs, {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const versionResult = await execFileAsync(
      invocation.command,
      npmCliArgs(invocation, ["--version"]),
      { cwd: repoRoot, env, encoding: "utf8", maxBuffer: 16 * 1024, windowsHide: true },
    );
    if (String(versionResult.stdout).trim() !== definition.github.npmCliVersion) {
      fail("release_workflow_npm_cli_version_mismatch");
    }
  } catch {
    fail("release_workflow_npm_cli_install_failed");
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function prepareBranchAuthority(): Promise<void> {
  const event = requireText(process.env.GITHUB_EVENT_NAME, /^(push|workflow_dispatch)$/u, "release_workflow_event_invalid");
  const refType = requireText(process.env.GITHUB_REF_TYPE, /^branch$/u, "release_workflow_ref_type_invalid");
  const refName = requireText(process.env.GITHUB_REF_NAME, /^release$/u, "release_workflow_ref_invalid");
  const sourceRevision = requireText(process.env.GITHUB_SHA, /^[a-f0-9]{40}$/u, "release_workflow_revision_invalid");
  const bootstrapCandidate = String(process.env.BOOTSTRAP_CANDIDATE || "");
  const definition = await verifyReleaseDefinition();
  const dispatch = decideReleaseBranchDispatch({
    event,
    refType,
    refName,
    releaseVersion: definition.release.version,
    bootstrapCandidate,
  });
  const checkoutRevision = await gitRevision("HEAD");
  const stableRevision = await gitRevision("refs/remotes/origin/stable");
  if (checkoutRevision !== sourceRevision || stableRevision !== sourceRevision) {
    fail("release_workflow_source_not_stable_tip");
  }
  const token = process.env.GH_TOKEN || "";
  const stableRun = await selectStableSourceRun(sourceRevision, token);
  const stableRunPath = "build/release/control/stable-run.json";
  const stableBundle = "build/release/control/stable-authority";
  const releaseBundle = "build/release/control/release-authority";
  await fs.rm(stableBundle, { recursive: true, force: true });
  await fs.rm(releaseBundle, { recursive: true, force: true });
  await writeJsonAtomic(stableRunPath, stableRun);
  await downloadAuthorityArtifact({
    runId: stableRun.runId,
    artifactName: `stable-authority-${sourceRevision}`,
    outputDirectory: stableBundle,
    files: STABLE_AUTHORITY_FILES,
    token,
  });
  await runAuthorityCommand([
    "verify-stable-bundle",
    "--bundle", stableBundle,
    "--expected-candidate", "build/release/control/expected/SOURCE_CANDIDATE.json",
    "--run", stableRunPath,
  ]);
  await runAuthorityCommand([
    "create-release-bundle",
    "--stable-bundle", stableBundle,
    "--expected-candidate", "build/release/control/expected/SOURCE_CANDIDATE.json",
    "--stable-run", stableRunPath,
    "--run-id", process.env.GITHUB_RUN_ID || "",
    "--run-attempt", process.env.GITHUB_RUN_ATTEMPT || "",
    "--event", event,
    "--bundle", releaseBundle,
  ]);
  await appendOutputs({
    action: dispatch.action,
    release_tag: definition.release.tag,
    release_version: definition.release.version,
    dispatch_release: dispatch.dispatchRelease,
  });
}

async function resolveReleaseAuthority(): Promise<void> {
  const tag = requireText(process.env.GITHUB_REF_NAME, /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u, "release_workflow_tag_invalid");
  if (process.env.GITHUB_REF_TYPE !== "tag") fail("release_workflow_ref_type_invalid");
  const definition = await verifyReleaseDefinition({ expectedTag: tag });
  const sha = requireText(process.env.GITHUB_SHA, /^[a-f0-9]{40}$/u, "release_workflow_revision_invalid");
  if (await gitRevision(`refs/tags/${tag}`) !== sha || await gitRevision("refs/remotes/origin/release") !== sha) {
    fail("release_workflow_tag_source_mismatch");
  }
  const token = process.env.GH_TOKEN || "";
  const event = process.env.GITHUB_EVENT_NAME;
  let selection: WorkflowRunSelection;
  if (event === "workflow_dispatch") {
    const sourceRevision = requireText(process.env.SOURCE_REVISION, /^[a-f0-9]{40}$/u, "release_workflow_source_revision_invalid");
    if (sourceRevision !== sha) fail("release_workflow_dispatch_source_mismatch");
    const dispatch = validateReleaseDispatchContext({
      tag,
      canonicalTag: definition.release.tag,
      sourceRevision,
      tagRevision: sha,
      sourceRunId: process.env.ORIGINATING_RUN_ID,
      sourceRunAttempt: process.env.ORIGINATING_RUN_ATTEMPT,
      sourceEvent: process.env.ORIGINATING_EVENT,
      repository: repositoryName(),
      bootstrapCandidate: process.env.BOOTSTRAP_CANDIDATE || "",
      releaseVersion: definition.release.version,
    });
    selection = await waitForOriginatingRun({
      repository: repositoryName(),
      runId: dispatch.runId,
      runAttempt: dispatch.runAttempt,
      sourceRevision: dispatch.sourceRevision,
      event: dispatch.event,
      token,
    });
  } else if (event === "push") {
    selection = await selectSuccessfulPromotionRun({
      workflow_runs: await apiGetPages<any>(`/actions/workflows/release-branch.yml/runs?event=push&branch=release&head_sha=${sha}`, token),
    }, {
      workflowPath: ".github/workflows/release-branch.yml",
      branch: "release",
      headSha: sha,
    });
  } else {
    fail("release_workflow_event_invalid");
  }

  const selectionPath = "build/release/control/originating-run.json";
  const expectedCandidate = "build/release/control/expected/SOURCE_CANDIDATE.json";
  const authorityBundle = "build/release/control/release-authority";
  await fs.rm(authorityBundle, { recursive: true, force: true });
  await writeJsonAtomic(selectionPath, selection);
  await downloadAuthorityArtifact({
    runId: selection.runId,
    artifactName: `release-authority-${sha}`,
    outputDirectory: authorityBundle,
    files: RELEASE_AUTHORITY_FILES,
    token,
  });
  await runAuthorityCommand([
    "verify-release-bundle",
    "--bundle", authorityBundle,
    "--expected-candidate", expectedCandidate,
    "--run", selectionPath,
  ]);
  await appendOutputs({ authority_directory: authorityBundle });
}

async function ensureReleaseTag(): Promise<void> {
  const { ensureImmutableReleaseTag } = await import("./resolve-branch-promotion-authority.ts");
  const definition = await verifyReleaseDefinition();
  const revision = requireText(process.env.GITHUB_SHA, /^[a-f0-9]{40}$/u, "release_workflow_revision_invalid");
  const result = await ensureImmutableReleaseTag({
    repository: repositoryName(),
    tag: definition.release.tag,
    sourceRevision: revision,
    token: process.env.GH_TOKEN || "",
  });
  await appendOutputs({
    tag: result.tag,
    tag_action: result.action,
    source_revision: result.sourceRevision,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, action: result.action, tag: result.tag, sourceRevision: result.sourceRevision })}\n`);
}

async function dispatchRelease(): Promise<void> {
  const { dispatchReleaseWorkflow } = await import("./resolve-branch-promotion-authority.ts");
  const definition = await verifyReleaseDefinition();
  const result = await dispatchReleaseWorkflow({
    repository: repositoryName(),
    tag: definition.release.tag,
    sourceRevision: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    sourceEvent: process.env.GITHUB_EVENT_NAME,
    bootstrapCandidate: process.env.BOOTSTRAP_CANDIDATE || "",
    releaseVersion: definition.release.version,
    token: process.env.GH_TOKEN || "",
  });
  process.stdout.write(`${JSON.stringify({ ok: true, tag: result.tag, sourceRevision: result.sourceRevision })}\n`);
}

export function assertPreparedQualification(prepared: any, report: any): void {
  const qualified = report?.candidate?.artifacts;
  const packages = prepared?.packages;
  const coordinates = (item: any): string => JSON.stringify([
    item?.name, item?.version, item?.filename, item?.integrity,
  ]);
  if (!Array.isArray(packages) || packages.length === 0 || !Array.isArray(qualified)
    || prepared.version !== report?.candidate?.version || qualified.length !== packages.length
    || new Set(packages.map((item: any) => item?.name)).size !== packages.length
    || new Set(qualified.map((item: any) => item?.name)).size !== qualified.length
    || packages.some((item: any) => [item?.name, item?.version, item?.filename, item?.integrity]
      .some((value) => typeof value !== "string" || !value))) {
    fail("release_workflow_prepared_qualification_mismatch");
  }
  const expected = new Set(qualified.map(coordinates));
  if (packages.some((item: any) => !expected.has(coordinates(item)))) {
    fail("release_workflow_prepared_qualification_mismatch");
  }
}

async function verifyPreparedQualification(): Promise<void> {
  const { loadPreparedReleaseSet } = await import("./publish-release-set.ts");
  const prepared = await loadPreparedReleaseSet({ rootDir: repoRoot,
    artifactDirectory: path.join(repoRoot, "build/release/npm-set") });
  const report = JSON.parse(await fs.readFile(path.join(repoRoot,
    "build/release/control/release-authority/npm-package-installability.json"), "utf8"));
  assertPreparedQualification(prepared, report);
}

export interface GithubReleaseAsset {
  name: string;
  filePath: string;
  size: number;
  digest: string;
}

function assetMatches(actual: any, expected: GithubReleaseAsset): boolean {
  return actual?.name === expected.name && actual.state === "uploaded"
    && actual.size === expected.size && actual.digest === expected.digest;
}

export function assertPublishedGithubRelease(release: any, tag: string, assets: readonly GithubReleaseAsset[]): void {
  if (release?.tag_name !== tag || release.draft !== false || release.immutable !== true) {
    fail("release_workflow_github_release_not_immutable");
  }
  const actual = Array.isArray(release.assets) ? release.assets : [];
  const byName = new Map(actual.map((asset: any) => [asset.name, asset]));
  if (actual.length !== assets.length || byName.size !== actual.length
    || assets.some((asset) => !assetMatches(byName.get(asset.name), asset))) {
    fail("release_workflow_github_asset_set_mismatch");
  }
}

export async function publishGithubRelease({
  repository, tag, revision, assets, body,
  token = process.env.GH_TOKEN || "", fetchImplementation = fetch,
}: {
  repository: string; tag: string; revision: string; assets: readonly GithubReleaseAsset[]; body: string;
  token?: string; fetchImplementation?: typeof fetch;
}): Promise<{ action: "published" | "reverified"; tag: string; assetCount: number }> {
  const repo = repositoryName(repository);
  requireText(tag, /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u, "release_workflow_tag_invalid");
  requireText(revision, /^[a-f0-9]{40}$/u, "release_workflow_revision_invalid");
  if (!assets.length || new Set(assets.map((asset) => asset.name)).size !== assets.length
    || assets.some((asset) => !asset.name || /[/\\]/u.test(asset.name)
      || !Number.isSafeInteger(asset.size) || asset.size < 0 || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest))) {
    fail("release_workflow_github_assets_invalid");
  }
  const base = `${repositoryApiPath(repo)}/releases`;
  const request = async (url: URL, method = "GET", payload?: unknown, allowMissing = false): Promise<any> => {
    const headers = githubHeaders(token);
    if (payload !== undefined) headers.set("content-type", "application/json");
    const response = await fetchImplementation(url, {
      method, headers, redirect: "error", ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (allowMissing && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); fail(`release_workflow_github_api_${response.status}`); }
    if (response.status === 204) return null;
    return JSON.parse(Buffer.from(await responseBytes(response, MAX_API_JSON_BYTES,
      "release_workflow_github_response_too_large")).toString("utf8"));
  };
  let release = await request(new URL(`${base}/tags/${encodeURIComponent(tag)}`, apiRoot()), "GET", undefined, true);
  if (!release) {
    const releases = await githubPages<any>(new URL(`${base}?per_page=100`, apiRoot()), { token, fetchImplementation });
    release = releases.find((entry) => entry.tag_name === tag);
  }
  if (release && release.draft === false) {
    assertPublishedGithubRelease(release, tag, assets);
    return { action: "reverified", tag, assetCount: assets.length };
  }
  if (release && (release.draft !== true || release.immutable === true)) {
    fail("release_workflow_github_draft_invalid");
  }
  if (!release) {
    release = await request(new URL(base, apiRoot()), "POST", {
      tag_name: tag, target_commitish: revision, name: `Meshrix.js ${tag}`, body,
      draft: true, prerelease: tag.includes("-"),
    });
  }
  const id = requireText(release.id, /^\d+$/u, "release_workflow_github_release_id_invalid");
  const expected = new Map(assets.map((asset) => [asset.name, asset]));
  const remoteAssets: any[] = Array.isArray(release.assets) ? release.assets : [];
  if (remoteAssets.some((asset) => !expected.has(asset.name))) fail("release_workflow_github_asset_set_mismatch");
  const uploadUrl = new URL(String(release.upload_url || "").replace(/\{.*\}$/u, ""));
  const uploadOrigin = apiRoot().origin === "https://api.github.com" ? "https://uploads.github.com" : apiRoot().origin;
  if (uploadUrl.origin !== uploadOrigin || uploadUrl.username || uploadUrl.password) {
    fail("release_workflow_github_upload_origin_invalid");
  }
  for (const asset of assets) {
    const existing = remoteAssets.find((item) => item.name === asset.name);
    if (assetMatches(existing, asset)) continue;
    if (existing) {
      const assetId = requireText(existing.id, /^\d+$/u, "release_workflow_github_asset_id_invalid");
      await request(new URL(`${base}/assets/${assetId}`, apiRoot()), "DELETE");
    }
    const url = new URL(uploadUrl);
    url.searchParams.set("name", asset.name);
    const headers = githubHeaders(token);
    headers.set("content-type", "application/octet-stream");
    const response = await fetchImplementation(url, {
      method: "POST", headers, redirect: "error", body: await openAsBlob(asset.filePath),
    });
    if (!response.ok) { await response.body?.cancel(); fail(`release_workflow_github_upload_${response.status}`); }
    const uploaded = JSON.parse(Buffer.from(await responseBytes(response, MAX_API_JSON_BYTES,
      "release_workflow_github_response_too_large")).toString("utf8"));
    if (!assetMatches(uploaded, asset)) fail("release_workflow_github_uploaded_asset_mismatch");
  }
  await request(new URL(`${base}/${id}`, apiRoot()), "PATCH", {
    name: `Meshrix.js ${tag}`, body, draft: false, prerelease: tag.includes("-"), make_latest: "legacy",
  });
  const published = await request(new URL(`${base}/${id}`, apiRoot()));
  assertPublishedGithubRelease(published, tag, assets);
  return { action: "published", tag, assetCount: assets.length };
}

async function publishGithubReleaseAssets(): Promise<void> {
  const { loadPreparedReleaseSet, PREPARED_RELEASE_SET_FILENAME } = await import("./publish-release-set.ts");
  const { SUPPLY_CHAIN_FILES } = await import("../generators/generate-supply-chain-artifacts.ts");
  const definition = await verifyReleaseDefinition({ expectedTag: process.env.GITHUB_REF_NAME });
  const revision = requireText(process.env.GITHUB_SHA, /^[a-f0-9]{40}$/u, "release_workflow_revision_invalid");
  if (await gitRevision(definition.release.tag) !== revision) fail("release_workflow_git_revision_invalid");
  const prepared = await loadPreparedReleaseSet({ rootDir: repoRoot,
    artifactDirectory: path.join(repoRoot, "build/release/npm-set") });
  const assetPaths = [
    ...prepared.packages.map((item: any) => path.join(repoRoot, "build/release/npm-set", item.filename)),
    path.join(repoRoot, "build/release/npm-set", PREPARED_RELEASE_SET_FILENAME),
    ...Object.values(SUPPLY_CHAIN_FILES).map((name) => path.join(repoRoot, "build/release/supply-chain", String(name))),
  ];
  const assets: GithubReleaseAsset[] = [];
  for (const filePath of assetPaths) {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) fail("release_workflow_github_assets_invalid");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    assets.push({ name: path.basename(filePath), filePath, size: stat.size, digest: `sha256:${hash.digest("hex")}` });
  }
  const body = [
    `Meshrix.js ${definition.release.version}`, "", "Apache-2.0.", "", "npm packages:",
    ...prepared.packages.map((item: any) => `- \`${item.name}@${item.version}\``), "",
    "The attached archives match the npm release set. The release includes the production dependency SBOM and third-party notices.",
  ].join("\n");
  const result = await publishGithubRelease({ repository: repositoryName(), tag: definition.release.tag, revision, assets, body });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

export async function runReleaseWorkflowAutomation(command: string): Promise<void> {
  if (command === "release-definition-outputs") return writeReleaseDefinitionOutputs();
  if (command === "pin-npm-cli") return pinNpmCli();
  if (command === "prepare-branch-authority") return prepareBranchAuthority();
  if (command === "resolve-release-authority") return resolveReleaseAuthority();
  if (command === "ensure-release-tag") return ensureReleaseTag();
  if (command === "dispatch-release") return dispatchRelease();
  if (command === "verify-prepared-qualification") return verifyPreparedQualification();
  if (command === "publish-github-release") return publishGithubReleaseAssets();
  fail("release_workflow_command_invalid");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runReleaseWorkflowAutomation(process.argv[2] || "").catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "release_workflow_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
