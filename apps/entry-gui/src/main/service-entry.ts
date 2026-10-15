/**
 * Node backend service entry — the canonical profile writer and loopback API.
 *
 * Three modes:
 *
 *  * service mode (default): starts `EntryProductService` and serves the
 *    closed op set over loopback HTTP (`loopback-server.ts`) on an ephemeral
 *    port, holding the profile's OS-backed SQLite lock until process exit.
 *    A supplied `MESHRIX_ENTRY_SERVICE_TOKEN` is validated; when omitted the
 *    owner generates a random bearer and keeps it only in the private owner
 *    descriptor. GUI launch mode additionally sends it over the private Tauri
 *    pipe. Standalone stdout reports only the port:
 *        {"event":"entry_service_listening","port":12345}
 *
 *  * `--mcp-stdio`: an authenticated local attachment to the one canonical
 *    desktop sidecar owner. It never starts another service or selects a
 *    connection implicitly; the MCP client's stdio channel remains local.
 *
 *  * `--gui-launch`: attaches to an authenticated existing owner, or acquires
 *    the profile lock and becomes the canonical owner. Filesystem notifications
 *    and a capped observation timer only wake the next attach/lock attempt.
 *
 * `MESHRIX_ENTRY_DATA_DIR` selects the owned data dir; unset →
 * `<platform app-data>/com.meshrix.entry/entry-data` — the same dir the
 * shell passes for the GUI sidecar, so every entry point shares one
 * custody/config/connection store. Version/exe env vars feed state + the
 * MCP snippet.
 */
import { randomBytes } from "node:crypto";
import { exit, platform, stderr, stdout } from "node:process";

import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { serveEntryMcpStdio } from "@meshrix/entry-transport";

import { createEntryGuiLoopbackServer } from "./loopback-server.ts";
import { createPersonalApplicationMcpBridge } from "./personal-mcp.ts";
import { createEntryProductService, type EntryProductService } from "./product-service.ts";
import { acquireEntryServiceOwner, readEntryServiceOwner } from "./service-owner.ts";
import { readEntryServiceConfig } from "./service-config.ts";
import { guiBridgeConfig, GuiLoopbackClient } from "../shared/loopback-client.ts";

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
  readonly serviceConfigPath: string | undefined;
}

function readEnvironment(): ServiceEnvironment {
  return {
    token: process.env.MESHRIX_ENTRY_SERVICE_TOKEN,
    dataDir: process.env.MESHRIX_ENTRY_DATA_DIR?.trim() || defaultEntryDataDir(),
    appVersion: process.env.MESHRIX_ENTRY_APP_VERSION?.trim() || "0.1.0",
    appExePath: process.env.MESHRIX_ENTRY_APP_EXE?.trim() || "meshrix-entry",
    serviceConfigPath: process.env.MESHRIX_ENTRY_SERVICE_CONFIG_PATH?.trim() || undefined
  };
}

async function createService(env: ServiceEnvironment): Promise<EntryProductService> {
  return createEntryProductService({
    dataDir: env.dataDir,
    appVersion: env.appVersion,
    appExePath: env.appExePath,
    serviceConfig: await readEntryServiceConfig(env.serviceConfigPath)
  });
}

/** Service mode: loopback API until the owning shell explicitly quits. */
async function runServiceMode(
  env: ServiceEnvironment,
  options: { readonly owner?: Awaited<ReturnType<typeof acquireEntryServiceOwner>>; readonly announceBridge?: boolean } = {}
): Promise<void> {
  const token = env.token ?? randomBytes(32).toString("base64url");
  if (typeof token !== "string" || token.length < 16) {
    stderr.write("entry-gui service: MESHRIX_ENTRY_SERVICE_TOKEN must contain at least 16 characters when provided\n");
    exit(2);
  }
  const owner = options.owner ?? await acquireEntryServiceOwner(env.dataDir);
  let service: EntryProductService | null = null;
  let server: ReturnType<typeof createEntryGuiLoopbackServer> | null = null;
  try {
    service = await createService(env);
    await service.start();
    server = createEntryGuiLoopbackServer({ service, token });
    await server.listen();
    await owner.publish(server.port, token);
  } catch (error) {
    await service?.stop().catch(() => undefined);
    await server?.close().catch(() => undefined);
    throw error;
  }

  let stopping = false;
  let ownerFinishing = false;
  let unsubscribe: () => void = () => {};
  const finishOwner = () => {
    if (ownerFinishing) return;
    ownerFinishing = true;
    unsubscribe();
    void server!.close().then(() => {
      owner.assertActive();
      exit(0);
    }, () => {
      // Do not release profile ownership until the bridge has drained.
      ownerFinishing = false;
      stopping = false;
    });
  };
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void service!.stop().then(finishOwner, () => {
      // Keep the process and its SQLite lock alive if teardown did not finish.
      stopping = false;
    });
  };
  unsubscribe = service.subscribe((state) => {
    if (state.lifecycle.state === "stopped") {
      stopping = true;
      finishOwner();
    }
  });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // This line travels only through the shell's private child-process pipe. It
  // is never logged or placed in a URL; an attached window needs the exact
  // current owner token to authenticate its loopback requests.
  stdout.write(`${JSON.stringify(options.announceBridge
    ? { event: "entry_gui_bridge_ready", port: server.port, token, attached: false }
    : { event: "entry_service_listening", port: server.port })}\n`);
}

async function authenticatedOwner(env: ServiceEnvironment): Promise<Awaited<ReturnType<typeof readEntryServiceOwner>> | null> {
  try {
    const owner = await readEntryServiceOwner(env.dataDir);
    const client = new GuiLoopbackClient(guiBridgeConfig({ port: owner.port, token: owner.token }));
    const result = await client.invoke("state.get");
    return result.ok ? owner : null;
  } catch {
    return null;
  }
}

/** Start a new writer or attach this window to the already running owner. */
async function runGuiLaunchMode(env: ServiceEnvironment): Promise<void> {
  await mkdir(env.dataDir, { recursive: true, mode: 0o700 });
  let retryDelayMs = 250;
  let wakeCurrent: (() => void) | null = null;
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(env.dataDir, { persistent: false }, () => {
      retryDelayMs = 250;
      wakeCurrent?.();
    });
    watcher.on("error", () => wakeCurrent?.());
  } catch {
    // The lock still determines ownership. The observation timer below also
    // detects owner death when platform filesystem watching is unavailable.
  }
  try {
    for (;;) {
      const owner = await authenticatedOwner(env);
      if (owner) {
        stdout.write(`${JSON.stringify({ event: "entry_gui_bridge_ready", port: owner.port, token: owner.token, attached: true })}\n`);
        return;
      }
      try {
        const lease = await acquireEntryServiceOwner(env.dataDir);
        await runServiceMode({ ...env, token: undefined }, { owner: lease, announceBridge: true });
        return;
      } catch (error) {
        if (errorCode(error) !== "entry_service_owner_active") throw error;
      }

      const observedChange = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (changed: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          wakeCurrent = null;
          resolve(changed);
        };
        const timer = setTimeout(() => finish(false), retryDelayMs);
        wakeCurrent = () => finish(true);
      });
      retryDelayMs = observedChange ? 250 : Math.min(retryDelayMs * 2, 4_000);
    }
  } finally {
    watcher?.close();
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

/** `--mcp-stdio`: authenticated thin attachment to the one running profile owner. */
async function runMcpStdioMode(env: ServiceEnvironment): Promise<void> {
  let owner: Awaited<ReturnType<typeof readEntryServiceOwner>>;
  try {
    owner = await readEntryServiceOwner(env.dataDir);
  } catch (error) {
    stderr.write(`meshrix-entry MCP: ${error instanceof Error ? error.message : "The desktop owner is unavailable."}\n`);
    exit(2);
  }
  const client = new GuiLoopbackClient(guiBridgeConfig({ port: owner.port, token: owner.token }));
  const authenticated = await client.invoke("state.get");
  if (!authenticated.ok) {
    stderr.write("meshrix-entry MCP: The desktop owner could not be authenticated. Reopen Meshrix before reconnecting this MCP client.\n");
    exit(2);
  }
  const bridge = createPersonalApplicationMcpBridge({ client });
  const result = await serveEntryMcpStdio({ handle: bridge.handle, registerProcessSignals: true });
  exit(result.cancelled ? 0 : 0);
}

async function main(): Promise<void> {
  const env = readEnvironment();
  if (process.argv.slice(2).includes("--mcp-stdio")) {
    await runMcpStdioMode(env);
    return;
  }
  if (process.argv.slice(2).includes("--gui-launch")) {
    await runGuiLaunchMode(env);
    return;
  }
  await runServiceMode(env);
}

void main().catch((error: unknown) => {
  // A failed bootstrap exits non-zero rather than leaving a half-live sidecar.
  const message = errorCode(error) === "entry_service_owner_active"
    ? "Another Meshrix service already owns this profile."
    : "The Meshrix service could not start for this profile.";
  stderr.write(`entry-gui service bootstrap failed: ${message}\n`);
  exit(1);
});
