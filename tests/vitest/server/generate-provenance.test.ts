import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const GENERATOR_SOURCE = path.join(REPO_ROOT, "tools/server-scripts/generate-provenance.ts");
const temporaryRoots: string[] = [];

async function createFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-provenance-fixture-"));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, "tools/server-scripts"), { recursive: true });
  await fs.mkdir(path.join(root, "build/reports"), { recursive: true });
  await fs.mkdir(path.join(root, "build"), { recursive: true });
  await fs.copyFile(GENERATOR_SOURCE, path.join(root, "tools/server-scripts/generate-provenance.ts"));

  await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify({
    type: "module",
    name: "fixture-provenance-package",
    version: "1.2.3",
    repository: { type: "git", url: "https://github.com/example/public-package.git" }
  }, null, 2)}\n`);
  await fs.writeFile(path.join(root, "package-lock.json"), `${JSON.stringify({
    name: "fixture-provenance-package",
    version: "1.2.3",
    lockfileVersion: 3,
    packages: { "": { name: "fixture-provenance-package", version: "1.2.3" } }
  }, null, 2)}\n`);
  await fs.writeFile(path.join(root, "build/composition-presets.json"), JSON.stringify({
    fixture: "/Users/fixture-owner/private-composition-marker"
  }));
  await fs.writeFile(path.join(root, "build/reports/private-report-path-marker.json"), JSON.stringify({
    token: "REPORT-CREDENTIAL-MARKER",
    localPath: "/Users/fixture-owner/private-report-marker"
  }));
  await fs.writeFile(path.join(root, "build/reports/ordinary-report.md"), "synthetic local report\n");

  const gitEnvironment = {
    PATH: process.env.PATH ?? process.env.Path ?? "",
    HOME: root,
    USERPROFILE: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(root, ".gitconfig"),
    GIT_AUTHOR_NAME: "Fixture Author Marker",
    GIT_AUTHOR_EMAIL: "fixture-author@example.invalid",
    GIT_COMMITTER_NAME: "Fixture Committer Marker",
    GIT_COMMITTER_EMAIL: "fixture-committer@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {})
  };
  const git = (args: string[]) => execFileSync("git", args, {
    cwd: root,
    env: gitEnvironment,
    stdio: "ignore"
  });
  git(["init", "--quiet"]);
  git(["checkout", "--quiet", "-b", "private-branch-marker"]);
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "fixture"]);
  const httpRemote: any = new URL("https://http-private.invalid/team/repo.git");
  httpRemote.username = "fixture-user";
  httpRemote.password = "HTTP-CREDENTIAL-MARKER";
  const sshRemote: any = new URL("ssh://ssh-private.invalid/team/repo.git");
  sshRemote.username = "fixture-user";
  sshRemote.password = "SSH-CREDENTIAL-MARKER";
  git(["remote", "add", "origin", httpRemote.href]);
  git(["remote", "add", "upstream", sshRemote.href]);
  return root;
}

function cleanTestEnvironment(pathPrefix?: string): NodeJS.ProcessEnv {
  const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
  return {
    PATH: pathPrefix ? `${pathPrefix}${path.delimiter}${inheritedPath}` : inheritedPath,
    HOME: os.tmpdir(),
    USERPROFILE: os.tmpdir(),
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {})
  };
}

function runGenerator(root: string, args: string[], pathPrefix?: string) {
  return spawnSync(process.execPath, [path.join(root, "tools/server-scripts/generate-provenance.ts"), ...args], {
    cwd: root,
    env: cleanTestEnvironment(pathPrefix),
    encoding: "utf8",
    maxBuffer: 64 * 1024
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("local build-input report generator", () => {
  it("reports only bounded public identity, fixed build inputs, revision and observed steps", async () => {
    const root = await createFixture();
    const fakeBin = path.join(root, "fixture-bin");
    await fs.mkdir(fakeBin);
    const fakeNpm = path.join(fakeBin, process.platform === "win32" ? "npm.cmd" : "npm");
    await fs.writeFile(fakeNpm, process.platform === "win32"
      ? "@echo off\necho 11.8.0-TOOL-OUTPUT-MARKER\n"
      : "#!/bin/sh\nprintf '%s\\n' '11.8.0-TOOL-OUTPUT-MARKER'\n");
    if (process.platform !== "win32") await fs.chmod(fakeNpm, 0o755);

    const outputPath = path.join(root, "private-output-path-marker", "build-input-report.json");
    const result = runGenerator(root, ["--output", outputPath], fakeBin);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const generatedText = await fs.readFile(outputPath, "utf8");
    const report = JSON.parse(generatedText);
    const expectedRevision = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: root, encoding: "utf8" }).trim();
    expect(report).toMatchObject({
      schemaVersion: "v0.0.1:meshrix:build-input-report-1",
      reportKind: "unsigned-local-build-input-report",
      project: {
        name: "fixture-provenance-package",
        version: "1.2.3",
        repository: "https://github.com/example/public-package"
      },
      revision: expectedRevision,
      observedBuildSteps: ["hash-registered-build-inputs", "count-local-report-files"],
      localReportFileCount: 2
    });
    expect(report.toolchain.node).toMatch(/^\d+\.\d+\.\d+/u);
    if (process.platform !== "win32") expect(report.toolchain.npm).toBeNull();

    const manifestBytes = await fs.readFile(path.join(root, "package.json"));
    const manifestSubject = report.subjects.find((subject: { path: string }) => subject.path === "package.json");
    expect(manifestSubject).toMatchObject({
      sha256: createHash("sha256").update(manifestBytes).digest("hex"),
      size: manifestBytes.length,
      kind: "package-manifest"
    });
    expect(report.subjects.map((subject: { path: string }) => subject.path)).toEqual([
      "package.json",
      "package-lock.json",
      "tools/server-scripts/generate-provenance.ts",
      "build/composition-presets.json"
    ]);

    const outputText = `${generatedText}\n${result.stdout}\n${result.stderr}`;
    for (const marker of [
      "HTTP-CREDENTIAL-MARKER",
      "SSH-CREDENTIAL-MARKER",
      "http-private.invalid",
      "ssh-private.invalid",
      "private-branch-marker",
      "TOOL-OUTPUT-MARKER",
      "private-npm-marker",
      "/Users/fixture-owner",
      "private-report-marker",
      "private-report-path-marker",
      "REPORT-CREDENTIAL-MARKER",
      "private-composition-marker",
      "private-output-path-marker"
    ]) {
      expect(outputText).not.toContain(marker);
    }
  });

  it("rejects arbitrary command claims without echoing the supplied value", async () => {
    const root = await createFixture();
    const suppliedCommand = "npm test --token COMMAND-CREDENTIAL-MARKER /Users/fixture-owner/private-command-marker";
    const result = runGenerator(root, ["--command", suppliedCommand]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("provenance_generation_failed\n");
    expect(result.stderr).not.toContain("COMMAND-CREDENTIAL-MARKER");
    await expect(fs.access(path.join(root, "build/reports/provenance.json"))).rejects.toBeDefined();
  });

  it("does not publish repository credentials from package metadata", async () => {
    const root = await createFixture();
    const packagePath = path.join(root, "package.json");
    const metadata = JSON.parse(await fs.readFile(packagePath, "utf8"));
    const repositoryUrl: any = new URL("https://github.com/example/private.git");
    repositoryUrl.username = "fixture-user";
    repositoryUrl.password = "METADATA-CREDENTIAL-MARKER";
    metadata.repository.url = repositoryUrl.href;
    await fs.writeFile(packagePath, `${JSON.stringify(metadata, null, 2)}\n`);

    const outputPath = path.join(root, "safe-output.json");
    const result = runGenerator(root, [`--output=${outputPath}`]);
    expect(result.status).toBe(0);
    const generatedText = await fs.readFile(outputPath, "utf8");
    expect(JSON.parse(generatedText).project.repository).toBeNull();
    expect(generatedText).not.toContain("METADATA-CREDENTIAL-MARKER");
    expect(result.stdout).not.toContain("METADATA-CREDENTIAL-MARKER");
  });
});
