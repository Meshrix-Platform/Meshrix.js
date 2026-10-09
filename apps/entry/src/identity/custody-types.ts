/**
 * Shared custody contract types — a leaf module with no adapter imports so
 * adapters can consume the interface without forming an import cycle with
 * the selector in `custody.ts`.
 */
import { execFile } from "node:child_process";
import { entryError } from "../errors.ts";

/** Ref naming shared by all adapters; doubles as a filename component. */
const CUSTODY_REF_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export function assertCustodyRef(ref: unknown): string {
  if (typeof ref !== "string" || !CUSTODY_REF_PATTERN.test(ref)) {
    throw entryError("custody_invalid_ref", `Custody ref must match ${CUSTODY_REF_PATTERN.source}.`);
  }
  return ref;
}

export interface CustodyAdapter {
  /** Stable adapter kind, e.g. "macos-keychain". */
  readonly kind: string;
  /**
   * Probe the backing store without writing. Never throws: an unavailable
   * backend returns false so selection/fallback logic stays deterministic.
   */
  available(): Promise<boolean>;
  /** Persist secret bytes under `ref`, replacing any prior value. */
  storeSecret(input: { ref: string; secret: Uint8Array }): Promise<void>;
  /** Load secret bytes; null when absent. Backend errors throw. */
  loadSecret(input: { ref: string }): Promise<Uint8Array | null>;
  /** Remove the entry; deleting an absent ref is a no-op. */
  deleteSecret(input: { ref: string }): Promise<void>;
}

/**
 * Narrow process boundary for OS credential CLIs. Argument-array invocation
 * only — no shell string interpolation — and secrets travel over stdin where
 * the tool supports it (documented per adapter when it cannot).
 */
export interface ShellRunnerResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ShellRunner {
  run(
    command: string,
    args: readonly string[],
    options?: { stdin?: string }
  ): Promise<ShellRunnerResult>;
}

/** Default runner: execFile with argument arrays, no shell, hidden window. */
export const execFileRunner: ShellRunner = {
  run(command, args, options = {}) {
    return new Promise((resolve) => {
      const child = execFile(
        command,
        [...args],
        { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          // Spawn failures report a string errno code; map both shapes to a
          // non-zero numeric code so callers stay on one contract.
          const rawCode = (error as { code?: unknown } | null)?.code;
          const code = typeof rawCode === "number" ? rawCode : error ? 1 : 0;
          resolve({
            code,
            stdout: String(stdout ?? ""),
            // execFile puts spawn failures (ENOENT etc.) on error.message,
            // not stderr; surface it so adapters can detect a missing binary.
            stderr: String(stderr ?? "") || (error ? String(error.message ?? "") : "")
          });
        }
      );
      if (options.stdin !== undefined && child.stdin) {
        child.stdin.write(options.stdin, () => child.stdin?.end());
      }
    });
  }
};
