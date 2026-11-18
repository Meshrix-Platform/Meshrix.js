import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { localWorkerTestConfig } from "../../../tools/scripts/lib/local-worker-test-config.ts";
import { repositorySourceFiles } from "../../../tools/scripts/lib/repository-source-files.ts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("engineering source privacy", () => {
  it("selects public tracked and new files without ignored or private runtime inputs", () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "meshrix-public-source-"));
    try {
      execFileSync("git", ["init", "--quiet", root]);
      fs.writeFileSync(path.join(root, ".gitignore"), "private/\n");
      fs.mkdirSync(path.join(root, "private"));
      fs.writeFileSync(path.join(root, "private", "state.json"), "fixture");
      for (const name of [".dev.vars", ".env.production", "state.sqlite", "public.ts", ".env.example"]) {
        fs.writeFileSync(path.join(root, name), "fixture");
      }
      execFileSync("git", ["add", ".dev.vars"], { cwd: root });
      expect(repositorySourceFiles(root)).toEqual([".env.example", ".gitignore", "public.ts"]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("converts actual Wrangler local bindings without private file reads or ambient vars", () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "meshrix-worker-config-"));
    try {
      fs.writeFileSync(path.join(root, "worker.ts"), "export default { fetch() { return new Response('fixture'); } };");
      fs.writeFileSync(path.join(root, "wrangler.toml"), [
        'name = "synthetic-worker"', 'main = "worker.ts"',
        'compatibility_date = "2026-08-15"', '[vars]', 'PUBLIC_FIXTURE = "synthetic"',
      ].join("\n"));
      fs.writeFileSync(path.join(root, ".dev.vars"), "PRIVATE_FIXTURE=must-not-load");
      fs.writeFileSync(path.join(root, ".env"), "PRIVATE_FIXTURE=must-not-load");
      vi.stubEnv("CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV", "true");
      vi.stubEnv("CLOUDFLARE_INCLUDE_PROCESS_ENV", "true");
      vi.stubEnv("CLOUDFLARE_ENV", "must-not-select");
      const original = fs.readFileSync;
      vi.spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
        if (typeof file === "string" && [".dev.vars", ".env"].includes(path.basename(file))) {
          throw new Error("private_env_read_forbidden");
        }
        return (original as any)(file, ...args);
      }) as any);
      const result = localWorkerTestConfig(path.join(root, "wrangler.toml"));
      expect(result.remoteBindings).toBe(false);
      expect(result.main).toBe(path.join(root, "worker.ts"));
      expect(result.miniflare.bindings).toEqual({ PUBLIC_FIXTURE: "synthetic" });
      expect(result.miniflare.workers).toEqual([]);
      expect(process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV).toBe("true");
      expect(process.env.CLOUDFLARE_ENV).toBe("must-not-select");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
