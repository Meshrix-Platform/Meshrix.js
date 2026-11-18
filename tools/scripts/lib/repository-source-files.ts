import { execFileSync } from "node:child_process";
import path from "node:path";

/** Private environment/runtime files are never engineering source inputs. */
export function isPrivateRuntimePath(relativePath: string): boolean {
  const parts = relativePath.replaceAll("\\", "/").split("/");
  const name = parts.at(-1) || "";
  if (parts.some((part) => [".wrangler", ".meshrix-server-data", ".meshrix-data", ".meshrix-agent-history", "meshrix-data"].includes(part))) return true;
  if (/\.(?:log|sqlite3?|db|key|p12|pfx)$/iu.test(name)) return true;
  const envFile = name === ".env" || name.startsWith(".env.") || name === ".dev.vars" || name.startsWith(".dev.vars.");
  return envFile && !/\.(?:example|sample|template)$/u.test(name);
}

/** Git selects tracked and unignored new source; no private tree is walked. */
export function repositorySourceFiles(root: string): string[] {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return [...new Set(output.split("\0").filter((file) => {
    if (!file || path.isAbsolute(file) || file.split("/").includes("..")) return false;
    return !isPrivateRuntimePath(file);
  }))].sort();
}
