import { fileURLToPath } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

/**
 * Renderer-only build for the installed entry GUI. The Node sidecar service
 * is plain tsc output bundled by `build:service` (esbuild →
 * `dist/service/entry-service.mjs`); this config owns the Vue bundle the
 * Tauri webview loads (`../dist/renderer` in `src-tauri/tauri.conf.json`).
 */
export default defineConfig({
  plugins: [vue()],
  root: ROOT,
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    // The renderer never ships sourcemaps inside the packaged artifact; debug
    // builds can opt in through the standard vite flag.
    sourcemap: false,
    target: "es2022"
  },
  resolve: {
    alias: {
      "@meshrix/entry-gui/shared": fileURLToPath(new URL("./src/shared", import.meta.url))
    }
  },
  server: {
    // Dev server is loopback-only by default; keep it that way.
    host: "127.0.0.1"
  }
});
