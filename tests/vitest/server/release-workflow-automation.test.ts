import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  publishGithubRelease,
  type GithubReleaseAsset,
} from "../../../tools/server-scripts/release-workflow-automation.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const repository = "example/framework";
const tag = "v0.0.1";
const revision = "a".repeat(40);
const execFileAsync = promisify(execFile);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("GitHub release publication", () => {
  let directory: string;
  let assets: GithubReleaseAsset[];
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const uploaded = (asset: GithubReleaseAsset, id = 10) => ({
    id, name: asset.name, size: asset.size, digest: asset.digest, state: "uploaded",
  });
  const release = (draft: boolean, remoteAssets = assets.map(uploaded)) => ({
    id: 1, tag_name: tag, draft, immutable: !draft, assets: remoteAssets,
    upload_url: "https://uploads.github.com/repos/example/framework/releases/1/assets{?name,label}",
  });
  const run = (fetchImplementation: typeof fetch) => publishGithubRelease({
    repository, tag, revision, assets, body: "Apache-2.0 release",
    token: "synthetic-fixture-token", fetchImplementation,
  });
  const transport = (handle: (method: string, url: URL, body?: unknown) => Response | Promise<Response>) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method || "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      calls.push({ method, url: url.href, body });
      expect(init?.redirect).toBe("error");
      return handle(method, url, body);
    }) as typeof fetch;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-release-http-"));
    calls.length = 0;
    assets = [];
    for (const [name, content] of [["framework-0.0.1.tgz", "package"], ["manifest.json", "{}"]]) {
      const filePath = path.join(directory, name);
      await fs.writeFile(filePath, content);
      assets.push({ name, filePath, size: Buffer.byteLength(content),
        digest: "sha256:" + createHash("sha256").update(content).digest("hex") });
    }
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it("uploads exact file bytes to a draft before publishing and checking immutability", async () => {
    const result = await run(transport(async (method, url, body) => {
      if (url.pathname.includes("/tags/")) return json({}, 404);
      if (method === "GET" && url.pathname.endsWith("/releases")) return json([]);
      if (method === "POST" && url.hostname === "api.github.com") {
        expect(body).toMatchObject({ draft: true, target_commitish: revision });
        return json(release(true, []), 201);
      }
      if (method === "POST") {
        const asset = assets.find((entry) => entry.name === url.searchParams.get("name"))!;
        expect(Buffer.from(await (body as Blob).arrayBuffer())).toEqual(await fs.readFile(asset.filePath));
        return json(uploaded(asset), 201);
      }
      if (method === "PATCH") {
        expect(body).toMatchObject({ draft: false, make_latest: "legacy" });
        return json(release(false));
      }
      return json(release(false));
    }));
    expect(result).toEqual({ action: "published", tag, assetCount: 2 });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "POST", "POST", "POST", "PATCH", "GET"]);
  });

  it("resumes a draft and replaces only a mismatching owned asset", async () => {
    await run(transport((method, url) => {
      if (url.pathname.includes("/tags/")) return json(release(true, [
        uploaded(assets[0]), { ...uploaded(assets[1], 11), digest: "sha256:" + "0".repeat(64) },
      ]));
      if (method === "DELETE") {
        expect(url.pathname).toBe("/repos/example/framework/releases/assets/11");
        return new Response(null, { status: 204 });
      }
      if (method === "POST") return json(uploaded(assets[1]), 201);
      return json(release(false));
    }));
    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE", "POST", "PATCH", "GET"]);
  });

  it("reverifies an identical immutable release without mutation", async () => {
    await expect(run(transport(() => json(release(false))))).resolves.toMatchObject({ action: "reverified" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
  });

  it.each(["mutable", "mismatching-assets", "extra-assets"])("rejects a published %s release without mutation", async (reason) => {
    const actual = release(false);
    if (reason === "mutable") actual.immutable = false;
    else if (reason === "mismatching-assets") actual.assets[0].digest = "sha256:" + "0".repeat(64);
    else actual.assets.push({ ...uploaded(assets[0]), name: "unrelated.txt" });
    await expect(run(transport(() => json(actual)))).rejects.toThrow(/release_workflow_github_/u);
    expect(calls).toHaveLength(1);
  });

  it("does not publish a draft after an upload failure", async () => {
    await expect(run(transport((method) => method === "GET"
      ? json(release(true, [])) : json({}, 503)))).rejects.toThrow("release_workflow_github_upload_503");
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
  });

  it("never sends credentials or file bytes to an untrusted upload origin", async () => {
    await expect(run(transport(() => json({ ...release(true, []),
      upload_url: "https://untrusted.invalid/upload" })))).rejects.toThrow("release_workflow_github_upload_origin_invalid");
    expect(calls).toHaveLength(1);
  });

  it("preserves foreign draft assets", async () => {
    await expect(run(transport(() => json(release(true, [
      { ...uploaded(assets[0]), name: "foreign.txt" },
    ]))))).rejects.toThrow("release_workflow_github_asset_set_mismatch");
    expect(calls).toHaveLength(1);
  });
});

it("loads pre-install workflow metadata without resolving an external dependency", async () => {
  const script = `
    import { registerHooks, isBuiltin } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      if (!isBuiltin(specifier) && !specifier.startsWith(".") && !specifier.startsWith("file:") && !specifier.startsWith("/"))
        throw new Error("unexpected_bootstrap_dependency");
      return next(specifier, context);
    }});
    const { runReleaseWorkflowAutomation } = await import("./tools/server-scripts/release-workflow-automation.ts");
    await runReleaseWorkflowAutomation("release-definition-outputs");
  `;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-release-bootstrap-"));
  try {
    const output = path.join(directory, "outputs");
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: root, env: { ...process.env, GITHUB_OUTPUT: output },
    });
    const text = await fs.readFile(output, "utf8");
    expect(text).toContain("npm_cli_version=");
    expect(text).toContain("release_version=");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
