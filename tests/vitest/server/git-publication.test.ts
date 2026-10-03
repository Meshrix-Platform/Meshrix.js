import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const verifier = path.join(root, "tools/scripts/verify-git-publication.ts");
const vendorPath = "vendor/pactium-0.8.0.tgz";

async function repository(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "meshrix-publication-fixture-"));
  try {
    git(directory, ["init", "--quiet"]);
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function git(directory: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Synthetic Fixture",
    "-c", "user.email=fixture@example.invalid", ...args], { cwd: directory, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function verify(directory: string, argument: string, input?: string) {
  return spawnSync(process.execPath, [verifier, argument], { cwd: directory, input, encoding: "utf8" });
}

describe("Git publication object scanning", () => {
  it("accepts a full index across batch boundaries, repeated objects, and newline filenames", async () => {
    await repository(async (directory) => {
      await Promise.all(Array.from({ length: 260 }, (_, index) =>
        writeFile(path.join(directory, `module-${index}.ts`), `export const value = ${index % 3};\n`)));
      await writeFile(path.join(directory, "line\nbreak.ts"), "export {};\n");
      git(directory, ["add", "."]);
      expect(verify(directory, "--index").status).toBe(0);
      expect(verify(directory, "--staged").status).toBe(0);
    });
  });

  it("retains private-path, binary, oversized-object and absolute-symlink refusals", async () => {
    await repository(async (directory) => {
      await writeFile(path.join(directory, ".env"), "synthetic fixture only");
      await writeFile(path.join(directory, "binary.dat"), Buffer.from([0, 1, 2, 10]));
      await writeFile(path.join(directory, "oversized.txt"), Buffer.alloc(5 * 1024 * 1024 + 1, 97));
      await symlink("/synthetic-fixture-target", path.join(directory, "absolute-link"));
      git(directory, ["add", "."]);
      const result = verify(directory, "--index");
      expect(result.status).toBe(1);
      for (const rule of ["private-publication-path .env", "binary-publication-candidate binary.dat",
        "oversized-publication-candidate oversized.txt", "absolute-symbolic-link absolute-link"]) {
        expect(result.stderr).toContain(rule);
      }
    });
  });

  it("does not let an authorized vendored object hide the same bytes at another historical path", async () => {
    await repository(async (directory) => {
      await mkdir(path.join(directory, "vendor"));
      await copyFile(path.join(root, vendorPath), path.join(directory, vendorPath));
      await copyFile(path.join(root, vendorPath), path.join(directory, "undeclared-copy.tgz"));
      git(directory, ["add", "."]);
      git(directory, ["commit", "--quiet", "-m", "Synthetic historical fixture"]);
      await rm(path.join(directory, "undeclared-copy.tgz"));
      git(directory, ["add", "-u"]);
      git(directory, ["commit", "--quiet", "-m", "Synthetic current fixture"]);
      expect(verify(directory, "--index").status).toBe(0);
      const head = git(directory, ["rev-parse", "HEAD"]);
      const result = verify(directory, "--pre-push", `refs/heads/fixture ${head} refs/heads/fixture ${"0".repeat(40)}\n`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("binary-publication-candidate undeclared-copy.tgz");
    });
  });
});
