/**
 * Node backend service entry — the sidecar the Tauri shell spawns and kills.
 *
 * Two modes:
 *
 *  * service mode (default): starts `EntryProductService` and serves the
 *    closed op set over loopback HTTP (`loopback-server.ts`) on an ephemeral
 *    port. The per-launch bearer token arrives through
 *    `MESHRIX_ENTRY_SERVICE_TOKEN` (env — argv is visible to other local
 *    processes); the shell learns the port from a single machine-readable
 *    stdout line, which never carries the token:
 *        {"event":"entry_service_listening","port":12345}
 *
 *  * `--mcp-stdio`: the standard-MCP face the emitted `mcpServers` snippet
 *    points at (`meshrix-entry --mcp-stdio`, forwarded here by the app
 *    binary). No listener and no token — the MCP client's stdio channel is
 *    the whole transport. The first enrolled connection is refreshed and
 *    bridged; before the channel establishes, calls fail honestly as
 *    `endpoint_unreachable`.
 *
 * `MESHRIX_ENTRY_DATA_DIR` selects the owned data dir; unset →
 * `<platform app-data>/com.meshrix.entry/entry-data` — the same dir the
 * shell passes for the GUI sidecar, so every entry point shares one
 * custody/config/connection store. Version/exe env vars feed state + the
 * MCP snippet.
 */
import { exit, platform, stderr, stdout } from "node:process";

import { homedir } from "node:os";
import { join } from "node:path";

import { entryError } from "@meshrix/entry";
import { createEntryMcpBridge, serveEntryMcpStdio, type EntryMcpBridge } from "@meshrix/entry-transport";

import { createEntryGuiLoopbackServer } from "./loopback-server.ts";
import { createEntryProductService, type EntryProductService } from "./product-service.ts";

/** Tauri `identifier` — the app-data dir convention the shell also resolves. */
const APP_IDENTIFIER = "com.meshrix.entry";
/**
 * Product data subdir under the platform app-data dir. The shell passes the
 * same `<app_data>/<identifier>/entry-data` through `MESHRIX_ENTRY_DATA_DIR`;
 * this default keeps the no-env path (`--mcp-stdio`, `dev:service`) on the
 * same directory so custody/config/connections are shared, not split.
 */
const DATA_DIR_NAME = "entry-data";

/** Platform app-data dir, matching Tauri `path.app_data_dir()` resolution. */
export function defaultEntryDataDir(): string {
  switch (platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", APP_IDENTIFIER, DATA_DIR_NAME);
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP_IDENTIFIER, DATA_DIR_NAME);
    default:
      return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), APP_IDENTIFIER, DATA_DIR_NAME);
  }
}

interface ServiceEnvironment {
  readonly token: string | undefined;
  readonly dataDir: string;
  readonly appVersion: string;
  readonly appExePath: string;
}

function readEnvironment(): ServiceEnvironment {
  return {
    token: process.env.MESHRIX_ENTRY_SERVICE_TOKEN,
    dataDir: process.env.MESHRIX_ENTRY_DATA_DIR?.trim() || defaultEntryDataDir(),
    appVersion: process.env.MESHRIX_ENTRY_APP_VERSION?.trim() || "0.1.0",
    appExePath: process.env.MESHRIX_ENTRY_APP_EXE?.trim() || "meshrix-entry"
  };
}

function createService(env: ServiceEnvironment): EntryProductService {
  return createEntryProductService({
    dataDir: env.dataDir,
    appVersion: env.appVersion,
    appExePath: env.appExePath
  });
}

/** Service mode: loopback API until the shell kills the process. */
async function runServiceMode(env: ServiceEnvironment): Promise<void> {
  if (typeof env.token !== "string" || env.token.length < 16) {
    stderr.write("entry-gui service: MESHRIX_ENTRY_SERVICE_TOKEN is required (>= 16 chars)\n");
    exit(2);
  }
  const service = createService(env);
  await service.start();
  const server = createEntryGuiLoopbackServer({ service, token: env.token });
  await server.listen();

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void service.stop()
      .catch(() => undefined)
      .finally(() => void server.close().catch(() => undefined))
      .finally(() => exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  // The ONLY stdout line in service mode — the shell parses this for the port.
  // The token is never printed, never logged, never in a URL.
  stdout.write(`${JSON.stringify({ event: "entry_service_listening", port: server.port })}\n`);
}

/** A session surface that answers every call as honestly unreachable. */
const UNREACHABLE_SESSION = {
  get acceptsNewWork(): boolean {
    return false;
  },
  request(): Promise<never> {
    return Promise.reject(Object.assign(
      entryError("endpoint_unreachable", "No enrolled endpoint connection is reachable."),
      { effectOutcome: "not_started" }
    ));
  }
};

/** `--mcp-stdio`: newline-framed MCP over stdin/stdout — no listener at all. */
async function runMcpStdioMode(env: ServiceEnvironment): Promise<void> {
  const service = createService(env);
  await service.start();
  const connectionId = service.snapshot().connections[0]?.connectionId;
  let bridge: EntryMcpBridge;
  if (connectionId) {
    // Refresh lands asynchronously; the bridge reads session state per call,
    // so early calls answer endpoint_unreachable instead of lying.
    await service.refreshConnection(connectionId).catch(() => service.snapshot());
    bridge = service.bridgeFor(connectionId) ?? createEntryMcpBridge({ session: UNREACHABLE_SESSION });
  } else {
    bridge = createEntryMcpBridge({ session: UNREACHABLE_SESSION });
  }
  const result = await serveEntryMcpStdio({ handle: bridge.handle, registerProcessSignals: true });
  await service.stop().catch(() => undefined);
  exit(result.cancelled ? 0 : 0);
}

async function main(): Promise<void> {
  const env = readEnvironment();
  if (process.argv.slice(2).includes("--mcp-stdio")) {
    await runMcpStdioMode(env);
    return;
  }
  await runServiceMode(env);
}

void main().catch((error: unknown) => {
  // A failed bootstrap exits non-zero rather than leaving a half-live sidecar.
  stderr.write(`entry-gui service bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
});
