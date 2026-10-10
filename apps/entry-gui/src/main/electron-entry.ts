/**
 * Electron main-process bootstrap for the installed entry product.
 *
 * Process model: one trusted main process owns custody, secrets, transport
 * and lifecycle; the sandboxed Vue renderer sees only the redacted
 * `GuiState` pushed on `meshrix-entry:state` and may invoke exactly the
 * allowlisted ops on `meshrix-entry`.
 *
 * Hardening choices: `contextIsolation: true`, `sandbox: true`,
 * `nodeIntegration: false`, no `remote` module, navigation locked to the
 * packaged index, new windows denied.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, shell } from "electron";

import {
  GUI_IPC_INVOKE_CHANNEL,
  GUI_IPC_STATE_CHANNEL,
  GUI_OPS,
  type GuiIpcEnvelope,
  type GuiOp
} from "../shared/ipc-contract.ts";
import { createEntryProductService } from "./product-service.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ALLOWED_OPS = new Set<string>(GUI_OPS);

function isGuiOp(value: unknown): value is GuiOp {
  return typeof value === "string" && ALLOWED_OPS.has(value);
}

async function main(): Promise<void> {
  await app.whenReady();
  app.setName("Meshrix Entry");

  const service = createEntryProductService({
    dataDir: join(app.getPath("userData"), "entry-data"),
    appVersion: app.getVersion(),
    appExePath: app.getPath("exe")
  });
  await service.start();

  const rendererIndex = join(HERE, "../renderer/index.html");
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    title: "Meshrix Entry",
    webPreferences: {
      preload: join(HERE, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The renderer is a packaged local file; remote content is denied outright.
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  // Push redacted state; snapshot() runs the secret-free scan each time.
  const unsubscribe = service.subscribe((state) => {
    if (!window.isDestroyed()) window.webContents.send(GUI_IPC_STATE_CHANNEL, state);
  });
  window.on("closed", unsubscribe);

  ipcMain.handle(GUI_IPC_INVOKE_CHANNEL, async (_event, envelope: unknown) => {
    const request = envelope as GuiIpcEnvelope | null;
    if (!request || typeof request !== "object" || !isGuiOp(request.op)) {
      return { ok: false, error: { code: "ipc_op_denied", message: "Unknown or malformed IPC operation." } };
    }
    return service.dispatch(request.op, request.args);
  });

  // Outbound browsing is never part of the product surface — open externally.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => {
    if (event.url !== `file://${rendererIndex}`) event.preventDefault();
  });

  if (app.isPackaged || process.env.ENTRY_GUI_RENDERER_FILE === "1") {
    await window.loadFile(rendererIndex);
  } else {
    await window.loadURL(process.env.ENTRY_GUI_DEV_SERVER ?? "http://127.0.0.1:5173");
  }

  app.on("window-all-closed", () => {
    void service.stop().finally(() => app.quit());
  });
  app.on("before-quit", () => {
    void service.stop();
  });
}

void main().catch((error) => {
  // A failed bootstrap exits non-zero rather than leaving a half-live window.
  console.error("entry-gui bootstrap failed:", error instanceof Error ? error.message : error);
  app.quit();
});
