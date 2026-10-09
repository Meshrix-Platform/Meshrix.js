/**
 * Windows DPAPI custody adapter.
 *
 * Protects each secret with `System.Security.Cryptography.ProtectedData`
 * (DPAPI, `CurrentUser` scope) invoked through a minimal PowerShell call, and
 * persists the returned blob as a per-ref file under `dataDir`.
 *
 *   store:  powershell -NoProfile -NonInteractive -Command <Protect script>
 *           stdin: base64 plaintext → stdout: base64 ProtectedData blob
 *   load:   powershell -NoProfile -NonInteractive -Command <Unprotect script>
 *           stdin: base64 blob      → stdout: base64 plaintext
 *
 * Why this shape: Node has no DPAPI binding without a native module, and the
 * documented minimal path for .NET-free hosts is the CLR `ProtectedData` API
 * reachable from PowerShell. The secret never travels through argv — only
 * stdin/stdout — so nothing sensitive lands in process lists or transcripts.
 *
 * Documented gap (honest, not faked): this requires `powershell` (Windows
 * PowerShell 5.1, always on supported Windows) or `pwsh` on PATH with .NET's
 * ProtectedData implementation. `available()` probes for the interpreter;
 * absence reports `custody_unavailable` and the caller picks the file
 * fallback explicitly.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { entryError } from "../errors.ts";
import { assertCustodyRef, type CustodyAdapter, type ShellRunner } from "./custody-types.ts";

const BLOB_SUFFIX = ".dpapi.b64";

/**
 * One-liner scripts. `-Command` receives the script text as a single argument;
 * plaintext only ever crosses stdin/stdout as base64.
 */
const PROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  ";$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
  ";$e=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,"
    + "[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  ";[Console]::Out.Write([Convert]::ToBase64String($e))"
].join("");

const UNPROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  ";$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
  ";$d=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,"
    + "[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  ";[Console]::Out.Write([Convert]::ToBase64String($d))"
].join("");

const PROBE_SCRIPT = "Add-Type -AssemblyName System.Security;[Console]::Out.Write('ok')";

/** Candidate interpreter names, in documented preference order. */
const INTERPRETERS = ["powershell", "pwsh"] as const;

export class WindowsDpapiCustody implements CustodyAdapter {
  readonly kind = "windows-dpapi";
  readonly #runner: ShellRunner;
  readonly #dataDir: string;

  constructor(options: { runner: ShellRunner; dataDir: string }) {
    this.#runner = options.runner;
    this.#dataDir = options.dataDir;
  }

  #blobPath(ref: string): string {
    return path.join(this.#dataDir, `${assertCustodyRef(ref)}${BLOB_SUFFIX}`);
  }

  async #interpret(script: string, stdin: string): Promise<ShellRunnerResultLike> {
    let last: ShellRunnerResultLike | null = null;
    for (const interpreter of INTERPRETERS) {
      const result = await this.#runner.run(interpreter, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script
      ], { stdin });
      last = result;
      if (result.code === 0) return result;
      // Missing interpreter → try the next candidate; a present interpreter
      // that failed the script writes real stderr and is reported instead.
      if (!/ENOENT|spawn|not recognized|is not recognized|command not found/iu.test(result.stderr)) {
        return result;
      }
    }
    return last ?? { code: 1, stdout: "", stderr: "no powershell interpreter" };
  }

  async available(): Promise<boolean> {
    try {
      for (const interpreter of INTERPRETERS) {
        const result = await this.#runner.run(interpreter, [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          PROBE_SCRIPT
        ]);
        if (result.code === 0 && result.stdout.trim() === "ok") return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async storeSecret(input: { ref: string; secret: Uint8Array }): Promise<void> {
    const ref = assertCustodyRef(input.ref);
    const result = await this.#interpret(
      PROTECT_SCRIPT,
      Buffer.from(input.secret).toString("base64")
    );
    if (result.code !== 0) {
      throw entryError(
        "custody_backend_error",
        "DPAPI Protect invocation failed.",
        { stderr: result.stderr.trim() || undefined }
      );
    }
    const blob = result.stdout.trim();
    if (!/^[A-Za-z0-9+/=]+$/u.test(blob)) {
      throw entryError("custody_backend_error", "DPAPI Protect returned a non-base64 blob.");
    }
    await fs.mkdir(this.#dataDir, { recursive: true, mode: 0o700 });
    const file = this.#blobPath(ref);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${blob}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async loadSecret(input: { ref: string }): Promise<Uint8Array | null> {
    const ref = assertCustodyRef(input.ref);
    let blob: string;
    try {
      blob = (await fs.readFile(this.#blobPath(ref), "utf8")).trim();
    } catch (error) {
      if ((error as { code?: unknown })?.code === "ENOENT") return null;
      throw error;
    }
    const result = await this.#interpret(UNPROTECT_SCRIPT, blob);
    if (result.code !== 0) {
      throw entryError(
        "custody_backend_error",
        "DPAPI Unprotect invocation failed.",
        { stderr: result.stderr.trim() || undefined }
      );
    }
    const decoded = Buffer.from(result.stdout.trim(), "base64");
    if (decoded.byteLength === 0) {
      throw entryError("custody_payload_invalid", `DPAPI blob for ${ref} decoded empty.`);
    }
    return new Uint8Array(decoded);
  }

  async deleteSecret(input: { ref: string }): Promise<void> {
    await fs.rm(this.#blobPath(input.ref), { force: true });
  }
}

interface ShellRunnerResultLike {
  code: number;
  stdout: string;
  stderr: string;
}

export function createWindowsDpapiCustody(options: {
  runner: ShellRunner;
  dataDir: string;
}): WindowsDpapiCustody {
  return new WindowsDpapiCustody(options);
}
