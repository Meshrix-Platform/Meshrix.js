/**
 * Custody adapter selection — deterministic platform mapping.
 *
 * A custody adapter protects one narrow thing: device-private key material at
 * rest. It never sees the user-held recovery secret as a value to store — the
 * recovery text is shown once and remains user-held — and it never talks to a
 * platform escrow service. Each adapter answers availability honestly so the
 * GUI can fall back or surface a precise gap.
 *
 * The shared contract types live in `custody-types.ts` (a leaf module) so
 * adapters don't import this selector — keeping the graph acyclic.
 */
import { entryError } from "../errors.ts";
import { createFileCustodyAdapter } from "./custody-file.ts";
import { createMacosKeychainCustody } from "./custody-macos.ts";
import { createWindowsDpapiCustody } from "./custody-windows.ts";
import { execFileRunner } from "./custody-types.ts";
import type { CustodyAdapter, ShellRunner } from "./custody-types.ts";

export {
  assertCustodyRef,
  execFileRunner,
  type CustodyAdapter,
  type ShellRunner,
  type ShellRunnerResult
} from "./custody-types.ts";

export type CustodyPlatform = "darwin" | "win32" | string;

export interface CustodySelection {
  readonly adapter: CustodyAdapter;
  /** "os" when a protected platform store was selected, "file" for the fallback. */
  readonly tier: "os" | "file";
  /** Human-facing reason recorded for honesty, e.g. "platform win32 → windows-dpapi". */
  readonly reason: string;
}

/**
 * Deterministic custody selection. `os` preference picks the adapter for the
 * current platform and verifies availability lazily at first use; `file`
 * forces the encrypted file fallback (requires `file` options); `auto` picks
 * the platform adapter on macOS/Windows and the file fallback elsewhere.
 * Selection never silently substitutes a weaker store on macOS/Windows: the
 * caller learns `adapter.available() === false` and decides explicitly.
 */
export function selectCustodyAdapter(options: {
  readonly platform?: CustodyPlatform;
  readonly prefer?: "auto" | "os" | "file";
  readonly runner?: ShellRunner;
  readonly file?: { dataDir: string; wrapSecret: Uint8Array };
  readonly macos?: { serviceName?: string };
  readonly windows?: { dataDir: string };
}): CustodySelection {
  const platform = options.platform ?? process.platform;
  const prefer = options.prefer ?? "auto";
  const runner = options.runner ?? execFileRunner;

  const fileAdapter = (): CustodySelection => {
    if (!options.file) {
      throw entryError(
        "custody_unavailable",
        "File custody fallback requires an explicit dataDir and wrap secret."
      );
    }
    const adapter = createFileCustodyAdapter({ ...options.file });
    return { adapter, tier: "file", reason: `platform ${platform} → encrypted file custody` };
  };

  if (prefer === "file") return fileAdapter();

  if (platform === "darwin") {
    return {
      adapter: createMacosKeychainCustody({
        runner,
        serviceName: options.macos?.serviceName
      }),
      tier: "os",
      reason: "platform darwin → macOS Keychain (security CLI)"
    };
  }
  if (platform === "win32") {
    if (!options.windows?.dataDir) {
      throw entryError(
        "custody_unavailable",
        "Windows DPAPI custody requires a dataDir for the protected blob files."
      );
    }
    return {
      adapter: createWindowsDpapiCustody({ runner, dataDir: options.windows.dataDir }),
      tier: "os",
      reason: "platform win32 → Windows DPAPI (ProtectedData, CurrentUser scope)"
    };
  }
  if (prefer === "os") {
    throw entryError(
      "unsupported_platform",
      `No protected OS custody adapter exists for platform "${platform}"; choose the file fallback explicitly.`
    );
  }
  return fileAdapter();
}
