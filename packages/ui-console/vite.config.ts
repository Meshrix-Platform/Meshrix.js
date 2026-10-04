import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const entries = [
  "binary-checkbox",
  "bridge-http",
  "browser-downloads",
  "browser-window",
  "console-client-display-utils",
  "console-format-utils",
  "error-message",
  "option-bar",
  "page-refresh",
  "rpc-client",
  "status-pill",
  "workspaces-view-context",
] as const;

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: resolve(packageRoot, "dist"),
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: Object.fromEntries(entries.map((name) => [name, resolve(packageRoot, "src", `${name}.ts`)])),
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
      cssFileName: "styles",
    },
    rollupOptions: {
      external: ["vue", /^vue\//, "element-plus", /^element-plus\//, "@element-plus/icons-vue"],
    },
  },
});
