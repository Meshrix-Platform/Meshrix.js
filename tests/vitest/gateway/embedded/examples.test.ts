import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The documented run command from `docs/examples/gateway/README.md`. */
const EXAMPLES = [
  { path: "docs/examples/gateway/faithful-tool-proxy.ts", observed: /kind: 'complete'[\s\S]*value: 'kept'/ },
  { path: "docs/examples/gateway/mrtr-input.ts", observed: /kind: 'complete'[\s\S]*accepted/ },
  { path: "docs/examples/gateway/shared-artifact.ts", observed: /shared bytes/ }
] as const;

function runExample(relativePath: string): string {
  return execFileSync(process.execPath, ["--conditions=source", relativePath], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024
  });
}

describe("public gateway examples", () => {
  for (const example of EXAMPLES) {
    it(`[CASE-U02] runs ${example.path} with the documented command and no paid model`, () => {
      const output = runExample(example.path);
      expect(output).toMatch(example.observed);
    }, 120_000);
  }
});
