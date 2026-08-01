// ==============================================================================
// Vite Configuration
//
// Dev server port: 5173
// Backend API proxy target: 7228 (DEFAULT_SERVER_PORT)
//
// Production: Static assets should be served via a web server (e.g., Nginx)
// with HTTPS reverse proxy to the backend API.
// ==============================================================================
import { DEFAULT_SERVER_PORT } from "./packages/foundation/src/config/server-env.ts";

import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const webRoot = path.resolve(__dirname, "apps", "console");

const apiOrigin =
  process.env.VITE_API_ORIGIN || `http://127.0.0.1:${process.env.VITE_API_PORT || DEFAULT_SERVER_PORT}`;

function parseProxyApiOrigin(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const parsedApiOrigin = parseProxyApiOrigin(apiOrigin);
const isLoopbackApiHost = parsedApiOrigin
  ? ["localhost", "127.0.0.1", "::1", "[::1]"].includes(String(parsedApiOrigin.hostname).toLowerCase())
  : false;

// 远端 HTTPS 默认开启证书校验。
// 仅在 loopback 目标并显式设置 VITE_API_PROXY_ALLOW_INSECURE_HTTPS=1 时，才允许跳过。
const isExplicitLocalInsecureCertBypass =
  String(process.env.VITE_API_PROXY_ALLOW_INSECURE_HTTPS || "").trim() === "1" && isLoopbackApiHost;
const proxySecure =
  !parsedApiOrigin ||
  parsedApiOrigin.protocol !== "https:" ||
  !isExplicitLocalInsecureCertBypass;

export default defineConfig({
  root: webRoot,
  plugins: [vue()],
  resolve: {
    conditions: ["source"],
    alias: {
      // Absolute imports from any depth: @/ -> apps/console/
      "@": webRoot,
      // Convenience shorthands
      "@components": path.resolve(webRoot, "components"),
      "@composables": path.resolve(webRoot, "composables"),
      "@views": path.resolve(webRoot, "views"),
      "@lib": path.resolve(webRoot, "lib"),
      "@router": path.resolve(webRoot, "router"),
      "@types": path.resolve(webRoot, "types"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "build", "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(webRoot, "index.html"),
      },
      output: {
        // Split vendor (Vue + vue-router + Element Plus) from app code
        manualChunks: (id) => {
          if (id.includes("node_modules/vue/") || id.includes("node_modules/vue-router/")) {
            return "vue";
          }
          if (id.includes("node_modules/element-plus/")) {
            return "element-plus";
          }
          if (id.includes("node_modules/")) {
            return "vendor";
          }
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: apiOrigin,
        changeOrigin: true,
        secure: proxySecure,
        configure: (proxy) => {
          const targetOrigin = apiOrigin;
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("origin", targetOrigin);
          });
        },
      },
    },
  },
});
