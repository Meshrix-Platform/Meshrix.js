import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readHeaders } from "../../../apps/server/bin/lib/meshrix-cli-common.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const cliEntrypoint: any = path.join(repoRoot, "apps", "server", "bin", "meshrix.ts");

describe("meshrix public CLI entrypoint", () : any => {
  it("delegates to the canonical command dispatcher", () : any => {
    const result: any = spawnSync(process.execPath, [cliEntrypoint, "--help"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("meshrix rpc-call jobs.list");
    expect(result.stdout).toContain("meshrix tools catalog");
    expect(result.stdout).toContain("meshrix secret init --target-file TARGET.json --json-stdin");
    expect(result.stdout).toContain("--expected-revision N");
    expect(result.stdout).not.toContain("[--api-key KEY]");
  });

  it("renders the packaged interface catalog without a running server", () : any => {
    const result: any = spawnSync(
      process.execPath,
      [cliEntrypoint, "interfaces", "--format", "markdown", "--server-url", "http://127.0.0.1:1"],
      {
        cwd: repoRoot,
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("jobs.list");
  });

  it.each(["Authorization", "Cookie", "Proxy-Authorization", "X-Api-Key", "X-Auth-Token"])(
    "rejects secret-bearing %s headers from argv without echoing their values",
    (headerName?: any) : any => {
      const marker: any = "do-not-echo-this-value";

      expect(() : any => readHeaders({ header: [`${headerName}: ${marker}`] })).toThrowError(
        new RegExp(`敏感请求头 ${headerName}`, "i")
      );

      try {
        readHeaders({ header: [`${headerName}: ${marker}`] });
      } catch (error: any) {
        expect(String(error)).not.toContain(marker);
      }
    }
  );
});
